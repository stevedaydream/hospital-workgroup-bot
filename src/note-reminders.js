import { randomUUID } from 'node:crypto';
import { sqlite } from './db.js';

// "Class starts soon" reminders for a notice: LEAD_MINUTES before the start the
// bot pushes the notice title and every link in it to one group. Set by hand on
// the notes page, or by the AI when it reads an explicit start time.
export const LEAD_MINUTES = 10;
const MAX_ATTEMPTS = 5;

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS note_reminders (
    id TEXT PRIMARY KEY,
    note_id INTEGER NOT NULL REFERENCES general_notes(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    start_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS note_reminders_due ON note_reminders(sent_at, due_at);
`);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Milliseconds for a Taiwan-time date and HH:MM, or null when either is not valid. */
export function taipeiTime(date, time) {
  if (typeof date !== 'string' || typeof time !== 'string' || !DATE.test(date) || !TIME.test(time)) return null;
  const ms = Date.parse(`${date}T${time}:00+08:00`);
  // Reject dates such as 2026-02-31 that Date.parse rolls over.
  if (Number.isNaN(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

const TRAILING = /[.,;:!?。，、；：！？)）\]】」』>]+$/;
/** http(s) links in a text, in order, without duplicates or trailing punctuation. */
export function linksIn(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'「」『』（）【】，。]+/g) || [];
  return [...new Set(found.map(url => url.replace(TRAILING, '')).filter(url => url.length > 10))];
}

/** "YYYY-MM-DD HH:MM" in Taiwan time. */
export function formatTaipei(ms) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16);
}

export const noteReminders = {
  /**
   * Sets (or moves) the reminder of a notice for one group. The start must be in
   * the future; when it is less than LEAD_MINUTES away the reminder goes out at once.
   */
  set(noteId, sourceId, date, time, createdBy, now = Date.now()) {
    if (!sourceId) throw new Error('缺少要通知的群組');
    const start = taipeiTime(date, time);
    if (start === null) throw new Error('開始時間格式需為 YYYY-MM-DD HH:MM');
    if (start <= now) throw new Error('開始時間已過，未設定提醒');
    if (!sqlite.prepare('SELECT 1 FROM general_notes WHERE id = ?').get(noteId)) throw new Error('找不到這則公告');
    const due = Math.max(start - LEAD_MINUTES * 60000, now);
    sqlite.prepare(`INSERT INTO note_reminders (id, note_id, source_id, start_at, due_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id, source_id) DO UPDATE SET start_at = excluded.start_at, due_at = excluded.due_at,
        created_by = excluded.created_by, created_at = excluded.created_at, sent_at = NULL, attempts = 0`)
      .run(randomUUID(), Number(noteId), sourceId, new Date(start).toISOString(), new Date(due).toISOString(), String(createdBy || '未知人員').slice(0, 50), new Date(now).toISOString());
    return this.get(noteId, sourceId);
  },
  get(noteId, sourceId) {
    return sqlite.prepare('SELECT * FROM note_reminders WHERE note_id = ? AND source_id = ?').get(Number(noteId), sourceId) || null;
  },
  remove(noteId, sourceId) {
    return sqlite.prepare('DELETE FROM note_reminders WHERE note_id = ? AND source_id = ?').run(Number(noteId), sourceId).changes > 0;
  },
  /** Reminders of one group whose class has not started yet, plus ones sent in the last day. */
  forGroup(sourceId, now = Date.now()) {
    return sqlite.prepare('SELECT note_id, start_at, due_at, sent_at FROM note_reminders WHERE source_id = ? AND start_at > ? ORDER BY start_at')
      .all(sourceId, new Date(now - 86400000).toISOString());
  },
  /** Unsent and due, and the class has not started yet (a late reminder is noise). */
  due(now = Date.now()) {
    const iso = new Date(now).toISOString();
    return sqlite.prepare(`SELECT r.*, n.title, n.content FROM note_reminders r JOIN general_notes n ON n.id = r.note_id
      WHERE r.sent_at IS NULL AND r.attempts < ? AND r.due_at <= ? AND r.start_at > ? ORDER BY r.due_at`).all(MAX_ATTEMPTS, iso, iso);
  },
  sent(id) { sqlite.prepare('UPDATE note_reminders SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), id); },
  attempted(id) { sqlite.prepare('UPDATE note_reminders SET attempts = attempts + 1 WHERE id = ?').run(id); },
  prune(now = Date.now()) {
    sqlite.prepare('DELETE FROM note_reminders WHERE start_at < ?').run(new Date(now - 30 * 86400000).toISOString());
  }
};

/**
 * Reminders for notices the AI just created from a photo: each AI note that
 * carries an explicit future start_date/start_time gets one for `sourceId`.
 * Returns what was set, as { note, startAt }. A bad or past time is skipped.
 */
export function autoRemindersForNotes(createdRows, aiNotes, sourceId, now = Date.now()) {
  const set = [];
  if (!sourceId) return set;
  for (const row of createdRows) {
    const ai = aiNotes.find(note => note && note.content === row.content && note.title === row.title)
      || aiNotes.find(note => note && note.content === row.content);
    if (!ai || taipeiTime(ai.start_date, ai.start_time) === null) continue;
    try {
      const reminder = noteReminders.set(row.id, sourceId, ai.start_date, ai.start_time, 'AI 自動', now);
      set.push({ note: row, startAt: reminder.start_at });
    } catch (error) {
      console.log(`[Note reminder] not set for note ${row.id}: ${error.message}`);
    }
  }
  return set;
}

/** The message for a due reminder: title, start time and every link in the notice. */
export function reminderMessage(row, now = Date.now()) {
  const start = Date.parse(row.start_at);
  const minutes = Math.max(1, Math.round((start - now) / 60000));
  const links = linksIn(row.content);
  const notesLiff = process.env.LIFF_NOTES_ID ? `https://liff.line.me/${process.env.LIFF_NOTES_ID}?note=${row.note_id}` : '';
  let text = `🔔 ${minutes} 分鐘後開始：${row.title}\n開始：${formatTaipei(start)}（台灣時間）`;
  if (links.length) text += `\n\n連結：\n${links.slice(0, 5).join('\n')}`;
  if (notesLiff) text += `\n\n公告全文：${notesLiff}`;
  return { type: 'text', text: text.slice(0, 4900) };
}

let running = false;
/** Called every minute by the scheduler. `send(to, message)` resolves to true when LINE accepted it. */
export async function runNoteReminders(send, { enabled = () => true, now = Date.now() } = {}) {
  if (running) return;
  running = true;
  try {
    noteReminders.prune(now);
    for (const row of noteReminders.due(now).slice(0, 50)) {
      if (!enabled(row.source_id)) continue;
      noteReminders.attempted(row.id);
      try {
        if (await send(row.source_id, reminderMessage(row, now))) noteReminders.sent(row.id);
      } catch (error) { console.error('[Note reminder] delivery failed:', error.message); }
    }
  } finally { running = false; }
}
