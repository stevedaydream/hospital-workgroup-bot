/**
 * Centralised date helpers.
 *
 * The whole system operates on Taiwan local dates (UTC+8, no DST). Previously
 * "today" was derived from `new Date().toISOString().split('T')[0]`, which is a
 * UTC date and therefore rolls over at 08:00 Taiwan time -- right in the middle
 * of the 07:30 dispatch / 08:00 morning meeting window. Every date in this
 * project must go through the helpers below.
 */

const TAIPEI_TZ = 'Asia/Taipei';

// en-CA formats as YYYY-MM-DD, which is what every table stores.
const taipeiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Current date in Taiwan, as YYYY-MM-DD. */
export function todayInTaipei(at = new Date()) {
  return taipeiDateFormatter.format(at);
}

/** Shift a YYYY-MM-DD string by whole days. Pure string in, string out. */
export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Tomorrow in Taiwan -- the default dispatch date for a freshly uploaded case table. */
export function tomorrowInTaipei() {
  return addDays(todayInTaipei(), 1);
}

/**
 * The morning the next 07:30 dispatch runs: today while it is still before
 * 07:30 in Taiwan (a table uploaded after midnight is for this morning), else
 * tomorrow.
 */
export function nextDispatchDate(at = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TAIPEI_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(at).split(':').map(Number);
  const today = todayInTaipei(at);
  return h * 60 + m < 7 * 60 + 30 ? today : addDays(today, 1);
}

/** '今早' or '明早' for a dispatch date, as the user sees it now. */
export function dispatchMorningLabel(dispatchDate, at = new Date()) {
  return dispatchDate === todayInTaipei(at) ? '今早' : '明早';
}

/** Whole days from `fromDateStr` to `toDateStr` (both YYYY-MM-DD). */
export function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00Z`).getTime();
  const to = new Date(`${toDateStr}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86400000);
}

/** '週一' .. '週日' for a YYYY-MM-DD string. */
export function dayOfWeek(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return '週' + ['日', '一', '二', '三', '四', '五', '六'][date.getUTCDay()];
}

/** Timestamp for audit columns. */
export function nowIso() {
  return new Date().toISOString();
}
