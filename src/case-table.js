import { todayInTaipei, addDays, nextDispatchDate } from './util/date.js';

// What a case table says beyond who is on it: the date printed on it and which
// NP (and extension) looks after each doctor's patients.

const md = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

const taipeiMinutes = (at) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(at).split(':').map(Number);
  return h * 60 + m;
};

/** '2026/11/16', '2026-11-16', '115/11/16' or '11/16' as YYYY-MM-DD; null if unreadable. */
export function normalizeTableDate(raw, today) {
  const parts = String(raw ?? '').trim().split(/[\/\-.年月日\s]+/).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  let [y, m, d] = parts.length >= 3 ? parts : [Number(today.slice(0, 4)), ...parts];
  if (y < 1000) y += 1911;
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  // A year-less 1/2 read on 12/31 is next year's table.
  if (parts.length === 2 && date < addDays(today, -180)) return `${y + 1}${date.slice(4)}`;
  return date;
}

/**
 * The date a freshly uploaded table is for: the date printed on it when that
 * is today or tomorrow, else the next 07:30 morning with a warning.
 */
export function resolveTableDate(ocrDate, now = new Date()) {
  const today = todayInTaipei(now);
  const tomorrow = addDays(today, 1);
  const printed = ocrDate ? normalizeTableDate(ocrDate, today) : null;
  if (printed === today || printed === tomorrow) return { date: printed, warning: null };
  const fallback = nextDispatchDate(now);
  const warning = ocrDate
    ? `分配表日期為 ${ocrDate}，不是今日（${md(today)}）或明日（${md(tomorrow)}），暫定為 ${md(fallback)} 的表，請確認是否上傳正確！`
    : `看不出分配表上的日期，暫定為 ${md(fallback)} 的表，請確認。`;
  return { date: fallback, warning };
}

/** Whether the 07:30 push for `date` has already run. */
export const pushSlotPassed = (date, now = new Date()) =>
  date < todayInTaipei(now) || (date === todayInTaipei(now) && taipeiMinutes(now) >= 7 * 60 + 30);

/** 00:00–20:00 asks for today's table, after 20:00 for tomorrow's. */
export function caseWindowDate(now = new Date()) {
  const today = todayInTaipei(now);
  return taipeiMinutes(now) <= 20 * 60 ? today : addDays(today, 1);
}

const text = (value, max) => (typeof value === 'string' || typeof value === 'number') ? String(value).trim().slice(0, max) : '';

/** The AI's NP rows, cleaned: [{ward, np, tel, shift, doctors: [{name, cases}]}]. */
export function normalizeAssignments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map(row => ({
    ward: text(row?.ward, 10),
    np: text(row?.np, 20),
    tel: text(row?.tel, 20),
    shift: text(row?.shift, 10),
    doctors: (Array.isArray(row?.doctors) ? row.doctors : []).slice(0, 30)
      .map(d => (typeof d === 'string' ? { name: text(d, 20), cases: null } : { name: text(d?.name, 20), cases: Number.isFinite(Number(d?.cases)) && d?.cases !== null && d?.cases !== '' ? Number(d.cases) : null }))
      .filter(d => d.name)
  })).filter(row => row.np || row.doctors.length);
}

/**
 * OCR sometimes misreads one character of an NP's name (霙 read as 霖).
 * Swap each NP name for the MedBase name that differs from it in exactly one
 * character, when exactly one such name exists. Names already on the list,
 * and names with no single close match, are left as they are.
 */
export function correctNpNames(assignments, knownNames) {
  const names = [...new Set((knownNames || []).map(n => String(n).trim()).filter(Boolean))];
  if (!names.length) return assignments;
  const fix = np => {
    if (!np || names.includes(np)) return np;
    const close = names.filter(n => n.length === np.length && [...n].filter((c, i) => c !== np[i]).length === 1);
    return close.length === 1 ? close[0] : np;
  };
  return assignments.map(row => ({ ...row, np: fix(row.np) }));
}

const same = (a, b) => a.replace(/\s/g, '').toUpperCase() === b.replace(/\s/g, '').toUpperCase();

/**
 * Lines telling a group which NP to call for each of its doctors on the
 * table, plus the NPs on duty. `matchKeys` are the group's doctor / department
 * names from the admin mapping.
 */
export function npGuide(assignments, matchKeys) {
  const lines = [];
  for (const key of matchKeys) {
    for (const row of assignments) {
      const doctor = row.doctors.find(d => same(d.name, key));
      if (!doctor || !row.np) continue;
      const cases = doctor.cases !== null ? `（${doctor.cases} 床）` : '';
      lines.push(`• ${doctor.name}${cases} → ${[row.ward, row.np].filter(Boolean).join(' ')}${row.tel ? ` 分機 ${row.tel}` : ''}`);
    }
  }
  const duty = assignments.filter(r => r.shift && r.np).map(r => `${r.shift} ${r.np}${r.tel ? ` ${r.tel}` : ''}`);
  const parts = [];
  if (lines.length) parts.push(`本群組醫師請找：\n${[...new Set(lines)].join('\n')}`);
  if (duty.length) parts.push(`值班 NP：${duty.join('／')}`);
  return parts.join('\n\n');
}
