import { randomUUID } from 'node:crypto';
import { sqlite } from './db.js';

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS shared_announcement_drafts (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, user_id TEXT NOT NULL,
    input_key TEXT NOT NULL, status TEXT NOT NULL, draft TEXT, error TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, note_id INTEGER,
    UNIQUE(source_id, user_id, input_key)
  );
  CREATE TABLE IF NOT EXISTS course_reminders (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES group_events(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, due_at TEXT NOT NULL, text TEXT NOT NULL,
    sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE(draft_id, event_id, due_at)
  );
  CREATE INDEX IF NOT EXISTS course_reminders_due ON course_reminders(due_at, sent_at);
`);
// Interrupted jobs are retryable after a process restart, without losing their identity.
sqlite.prepare("UPDATE shared_announcement_drafts SET status = 'failed', error = '服務重啟，請重新傳送資料後輸入整理公告' WHERE status = 'processing'").run();

export function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) >= 2000
    && Number(date.slice(0, 4)) <= 2200 && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
export function validateDraft(draft) {
  if (!draft || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 100
    || typeof draft.content !== 'string' || !draft.content.trim() || draft.content.length > 8000
    || !Array.isArray(draft.events) || draft.events.length > 20
    || (draft.deadlines !== undefined && (!Array.isArray(draft.deadlines) || draft.deadlines.length > 20))
    || JSON.stringify(draft).length > 18000) throw new Error('AI 草稿格式不完整或過長，請分批整理後重試');
  const normalizeItems = items => items.map(event => {
    if (!event || typeof event.title !== 'string' || !event.title.trim() || event.title.length > 150 || !validDate(event.date)
      || (event.time && (typeof event.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)))
      || (event.location && (typeof event.location !== 'string' || event.location.length > 300))
      || (event.description && (typeof event.description !== 'string' || event.description.length > 1000))) throw new Error('AI 課程／期限日期或欄位無效，尚未建立任何公告或提醒');
    return { title: event.title.trim(), date: event.date, time: event.time || '', location: event.location || '', description: event.description || '' };
  });
  const unique = items => [...new Map(normalizeItems(items).map(e => [JSON.stringify(e), e])).values()];
  return { title: draft.title.trim(), content: draft.content.trim(), events: unique(draft.events), deadlines: unique(draft.deadlines || []) };
}

export function deadlineReminderTimes(deadline, now = Date.now()) {
  const due = Date.parse(`${deadline.date}T09:00:00+08:00`) - 7 * 86400000;
  return due > now ? [new Date(due).toISOString()] : [];
}

export function reminderTimes(event, now = Date.now()) {
  // No time guess: date-only courses enter the calendar but have no timed reminders.
  if (!event.time) return [];
  const start = Date.parse(`${event.date}T${event.time}:00+08:00`);
  const previousMorning = Date.parse(`${event.date}T09:00:00+08:00`) - 86400000;
  return [previousMorning, start - 3600000].filter(t => t > now).map(t => new Date(t).toISOString());
}

export const sharedStore = {
  begin(sourceId, userId, inputKey) {
    const previous = sqlite.prepare('SELECT * FROM shared_announcement_drafts WHERE source_id = ? AND user_id = ? AND input_key = ?').get(sourceId, userId, inputKey);
    if (previous && previous.status !== 'failed') return { row: previous, started: false };
    const id = previous?.id || randomUUID();
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    sqlite.prepare(`INSERT INTO shared_announcement_drafts (id, source_id, user_id, input_key, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'processing', ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'processing', error = NULL, expires_at = excluded.expires_at`)
      .run(id, sourceId, userId, inputKey, now, expires);
    return { row: this.get(id, sourceId, userId), started: true };
  },
  get(id, sourceId, userId) {
    return sqlite.prepare('SELECT * FROM shared_announcement_drafts WHERE id = ? AND source_id = ? AND user_id = ?').get(id, sourceId, userId);
  },
  latest(sourceId, userId) {
    return sqlite.prepare("SELECT * FROM shared_announcement_drafts WHERE source_id = ? AND user_id = ? AND expires_at > ? AND status IN ('processing','ready','failed') ORDER BY created_at DESC LIMIT 1")
      .get(sourceId, userId, new Date().toISOString());
  },
  ready(id, draft) {
    return sqlite.prepare("UPDATE shared_announcement_drafts SET draft = ?, status = 'ready', error = NULL WHERE id = ? AND status = 'processing'")
      .run(JSON.stringify(validateDraft(draft)), id).changes > 0;
  },
  fail(id, error) { sqlite.prepare("UPDATE shared_announcement_drafts SET status = 'failed', error = ? WHERE id = ? AND status = 'processing'").run(String(error).slice(0, 500), id); },
  cancel(id, sourceId, userId) { return sqlite.prepare("UPDATE shared_announcement_drafts SET status = 'cancelled', draft = NULL WHERE id = ? AND source_id = ? AND user_id = ? AND status IN ('processing','ready','failed')").run(id, sourceId, userId).changes; },
  confirm(id, sourceId, userId, mode, now = Date.now()) {
    if (!['all', 'calendar', 'note'].includes(mode)) throw new Error('無效操作');
    return sqlite.transaction(() => {
      const row = this.get(id, sourceId, userId);
      if (!row || row.expires_at <= new Date(now).toISOString()) throw new Error('草稿已到期或不是您在本群組建立的草稿');
      if (row.status === 'confirmed') return { duplicate: true, noteId: row.note_id };
      if (row.status !== 'ready') throw new Error('草稿尚未完成或已取消');
      const draft = validateDraft(JSON.parse(row.draft));
      const timestamp = new Date(now).toISOString();
      const noteId = Number(sqlite.prepare('INSERT INTO general_notes (title, content, updated_at, updated_by) VALUES (?, ?, ?, ?)')
        .run(draft.title, draft.content, timestamp, 'LINE 轉傳公告確認').lastInsertRowid);
      let events = 0, reminders = 0;
      if (mode !== 'note') for (const event of [...draft.events, ...draft.deadlines.map(e => ({ ...e, deadline: true }))]) {
        const eventId = Number(sqlite.prepare(`INSERT INTO group_events (title,date,time,location,description,source_group_id,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)`)
          .run(event.deadline ? `【期限】${event.title}` : event.title, event.date, event.time || null, event.location || null, event.description || null, sourceId, timestamp, 'LINE 轉傳公告確認').lastInsertRowid);
        events++;
        if (mode === 'all') for (const due of (event.deadline ? deadlineReminderTimes(event, now) : reminderTimes(event, now))) {
          sqlite.prepare('INSERT INTO course_reminders (id,draft_id,event_id,source_id,due_at,text) VALUES (?,?,?,?,?,?)')
            .run(randomUUID(), id, eventId, sourceId, due, `${event.deadline ? '⏰ 期限一週前提醒' : '📚 課程提醒'}\n${event.title}\n${event.deadline ? '截止：' : ''}${event.date}${event.time ? ` ${event.time}` : ''}（台灣時間）${event.location ? `\n地點：${event.location}` : ''}${event.description ? `\n${event.description}` : ''}`);
          reminders++;
        }
      }
      sqlite.prepare("UPDATE shared_announcement_drafts SET status = 'confirmed', note_id = ? WHERE id = ?").run(noteId, id);
      return { noteId, events, reminders };
    })();
  },
  due(now = Date.now()) {
    return sqlite.prepare(`SELECT r.* FROM course_reminders r JOIN group_events e ON e.id = r.event_id
      WHERE r.sent_at IS NULL AND r.due_at <= ? AND r.due_at > ? AND julianday(e.date || 'T' || COALESCE(e.time, '23:59') || ':00+08:00') > julianday(?) ORDER BY r.attempts, r.due_at`)
      .all(new Date(now).toISOString(), new Date(now - 86400000).toISOString(), new Date(now).toISOString());
  },
  sent(id) { sqlite.prepare('UPDATE course_reminders SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), id); },
  attempted(id) { sqlite.prepare('UPDATE course_reminders SET attempts = attempts + 1 WHERE id = ?').run(id); },
  prune() {
    sqlite.prepare('DELETE FROM shared_announcement_drafts WHERE expires_at <= ?').run(new Date().toISOString());
    sqlite.prepare('DELETE FROM course_reminders WHERE due_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString());
  }
};
