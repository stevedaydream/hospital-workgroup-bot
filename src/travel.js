import { addDays } from './util/date.js';

const PERIODS = new Set(['全天', '上午', '下午']);
const PURPOSES = new Set(['開會研習', '休假旅遊', '其他']);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function parseTravel(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '登記資料格式錯誤' };
  const text = (value, max) => String(value ?? '').trim().slice(0, max) || null;
  if (body.kind && !['出國', '休假', '長假'].includes(body.kind)) return { error: '登記類型錯誤' };
  const leave = body.kind === '休假' || body.kind === '長假';
  const trip = {
    kind: leave ? '休假' : '出國',
    traveler: text(body.traveler, 30), destination: text(body.destination, 50) || '',
    purpose: text(body.purpose, 10),
    depart_date: text(body.departDate, 10), return_date: text(body.returnDate, 10),
    depart_time: leave ? null : text(body.departTime, 5), return_time: leave ? null : text(body.returnTime, 5),
    depart_flight: leave ? null : text(body.departFlight, 30), return_flight: leave ? null : text(body.returnFlight, 30),
    leave_period: leave ? (body.leavePeriod ?? '全天') : '全天',
    deputy: text(body.deputy, 30), note: text(body.note, 300)
  };
  if (!trip.traveler) return { error: '請填寫 NP 或醫師姓名' };
  if (!validDate(trip.depart_date) || !validDate(trip.return_date)) return { error: '請填寫有效的起訖日期' };
  if (trip.return_date < trip.depart_date) return { error: '結束日期不能早於開始日期' };
  if (!PERIODS.has(trip.leave_period)) return { error: '請選擇全天、上午或下午' };
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if ((trip.depart_time && !hhmm.test(trip.depart_time)) || (trip.return_time && !hhmm.test(trip.return_time))) return { error: '時間需為 HH:MM' };
  if (trip.purpose && !PURPOSES.has(trip.purpose)) return { error: '事由選項錯誤' };
  return { trip };
}

/** Derived view only: absence registrations never become scheduled reminders. */
export function calendarAbsences(trips, events, today) {
  const horizon = addDays(today, 90);
  const rows = [];
  for (const t of trips) {
    if (!validDate(t.depart_date) || !validDate(t.return_date) || t.return_date < t.depart_date) continue;
    const dates = new Set(events.filter(e => e.date >= t.depart_date && e.date <= t.return_date).map(e => e.date));
    // Show each day of the next 90 days, plus any other dates with scheduled events.
    const start = t.depart_date > today ? t.depart_date : today;
    const stop = t.return_date < horizon ? t.return_date : horizon;
    for (let date = start; date <= stop;) {
      dates.add(date);
      date = addDays(date, 1);
    }
    const leave = t.kind !== '出國';
    const period = leave ? (t.leave_period || '全天') : '全天';
    for (const date of [...dates].sort()) {
      const name = t.traveler.replace(/醫師$/, '').trim();
      const conflicts = events.filter(e => e.date === date && e.title.includes('報告') &&
        !/停開|院務會議/.test(e.title) && name && `${e.title} ${e.description || ''}`.includes(name) &&
        (!e.time || period === '全天' || (period === '上午' ? e.time < '12:00' : e.time >= '12:00')));
      rows.push({
        id: `absence-${t.id}-${date}`, absence: true, registration_id: t.id, date,
        title: `${t.traveler}${leave ? ` ${period}休假` : ' 出國'}`,
        description: `${t.depart_date}～${t.return_date}${leave ? `・每日${period}` : ''}${t.deputy ? `｜代理：${t.deputy}` : ''}${t.note ? `｜${t.note}` : ''}`,
        conflicts: conflicts.map(e => e.title), created_by: t.updated_by, time: null
      });
    }
  }
  return rows;
}
