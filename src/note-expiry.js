import { todayInTaipei } from './util/date.js';

// A note is shown through its expiry date (Taiwan time); no date means permanent.
export const withExpiry = (note, today = todayInTaipei()) => ({
  ...note, expired: Boolean(note.expires_on && note.expires_on < today)
});

// Body field `expiresOn`: 'YYYY-MM-DD', or null/'' for permanent. Missing leaves it unchanged.
export function parseExpiry(value) {
  if (value === undefined) return { value: undefined };
  if (value === null || value === '') return { value: null };
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Rejects dates that roll over, such as 2026-02-30.
  const valid = !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
  return valid ? { value } : { error: '到期日格式錯誤' };
}
