import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SQLITE_PATH = ':memory:';
process.env.LIFF_NOTES_ID = 'notes-liff';
const { db } = await import('../src/db.js');
const { noteReminders, linksIn, taipeiTime, reminderMessage, runNoteReminders, autoRemindersForNotes, LEAD_MINUTES } = await import('../src/note-reminders.js');
const { sharedStore } = await import('../src/shared-announcement-store.js');

const WEBEX = 'https://cghmeet.webex.com/cghmeet-tc/j.php?MTID=ma999eeb931f99f94ddb1be1f7a432411';
const content = `舉辦「郵件系統轉換操作步驟說明」Webex會議。\n• 會議時間：115年11月23日（一）13:00\n- Webex 連結：${WEBEX}\n- 會議號：2517 172 8154`;
const at = (date, time) => taipeiTime(date, time);

test('links are found without trailing punctuation or duplicates', () => {
  assert.deepEqual(linksIn(`連結：${WEBEX}。另見（${WEBEX}）與 https://example.com/a).`), [WEBEX, 'https://example.com/a']);
  assert.deepEqual(linksIn('沒有連結'), []);
});

test('Taiwan time parsing rejects malformed and impossible dates', () => {
  assert.equal(new Date(at('2026-11-23', '13:00')).toISOString(), '2026-11-23T05:00:00.000Z');
  assert.equal(at('2026-02-31', '13:00'), null);
  assert.equal(at('2026-11-23', '25:00'), null);
  assert.equal(at(null, '13:00'), null);
});

test('reminder is due ten minutes before, sent once with the link, and not after the class starts', async () => {
  const note = await db.general_notes.create('Webex 說明會', content, '測試');
  const now = at('2026-11-23', '09:00');
  const row = noteReminders.set(note.id, 'G1', '2026-11-23', '13:00', '測試者', now);
  assert.equal(row.due_at, new Date(at('2026-11-23', '13:00') - LEAD_MINUTES * 60000).toISOString());
  assert.throws(() => noteReminders.set(note.id, 'G1', '2026-11-23', '08:00', '測試者', now), /已過/);

  const sent = [];
  const send = async (to, message) => { sent.push({ to, message }); return true; };
  await runNoteReminders(send, { now: at('2026-11-23', '12:49') });
  assert.equal(sent.length, 0);
  await runNoteReminders(send, { now: at('2026-11-23', '12:50') });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'G1');
  assert.match(sent[0].message.text, /10 分鐘後開始：Webex 說明會/);
  assert.ok(sent[0].message.text.includes(WEBEX));
  assert.match(sent[0].message.text, /liff\.line\.me\/notes-liff\?note=/);
  await runNoteReminders(send, { now: at('2026-11-23', '12:51') });
  assert.equal(sent.length, 1, 'sent only once');

  // Moving the start time re-arms it; a failed push is retried; nothing goes out once class has begun.
  noteReminders.set(note.id, 'G1', '2026-11-24', '13:00', '測試者', now);
  let fail = true;
  const flaky = async (to, message) => { if (fail) { fail = false; return false; } sent.push({ to, message }); return true; };
  await runNoteReminders(flaky, { now: at('2026-11-24', '12:55') });
  await runNoteReminders(flaky, { now: at('2026-11-24', '12:56') });
  assert.equal(sent.length, 2);
  noteReminders.set(note.id, 'G1', '2026-11-25', '13:00', '測試者', now);
  await runNoteReminders(send, { now: at('2026-11-25', '13:01') });
  assert.equal(sent.length, 2);
});

test('disabled groups are skipped, removal and note deletion cancel the reminder', async () => {
  const note = await db.general_notes.create('另一場', `連結 ${WEBEX}`, '測試');
  const now = at('2026-12-01', '08:00');
  noteReminders.set(note.id, 'G2', '2026-12-01', '10:00', '測試者', now);
  const sent = [];
  await runNoteReminders(async (to, m) => { sent.push(m); return true; }, { enabled: () => false, now: at('2026-12-01', '09:55') });
  assert.equal(sent.length, 0);
  assert.equal(noteReminders.forGroup('G2', now).length, 1);
  assert.equal(noteReminders.remove(note.id, 'G2'), true);
  assert.equal(noteReminders.forGroup('G2', now).length, 0);
  noteReminders.set(note.id, 'G2', '2026-12-01', '10:00', '測試者', now);
  await db.general_notes.delete(note.id);
  assert.equal(noteReminders.get(note.id, 'G2'), null);
});

test('a reminder set less than ten minutes ahead goes out at once and says how long is left', async () => {
  const note = await db.general_notes.create('臨時會議', '無連結', '測試');
  const now = at('2026-12-02', '09:55');
  const row = noteReminders.set(note.id, 'G3', '2026-12-02', '10:00', '測試者', now);
  assert.equal(row.due_at, new Date(now).toISOString());
  const text = reminderMessage({ ...row, title: note.title, content: note.content }, now).text;
  assert.match(text, /5 分鐘後開始/);
  assert.doesNotMatch(text, /連結：/);
});

test('AI start times create reminders only for valid future times', async () => {
  const a = await db.general_notes.create('Webex 說明會', content, 'AI');
  const b = await db.general_notes.create('一般公告', '請洗手', 'AI');
  const c = await db.general_notes.create('過去會議', `已結束 ${WEBEX}`, 'AI');
  const aiNotes = [
    { title: a.title, content: a.content, start_date: '2027-11-23', start_time: '13:00' },
    { title: b.title, content: b.content, start_date: null, start_time: null },
    { title: c.title, content: c.content, start_date: '2020-01-01', start_time: '13:00' }
  ];
  const set = autoRemindersForNotes([a, b, c], aiNotes, 'G4', at('2027-11-01', '08:00'));
  assert.deepEqual(set.map(s => s.note.id), [a.id]);
  assert.equal(noteReminders.get(a.id, 'G4').created_by, 'AI 自動');
  assert.equal(autoRemindersForNotes([a], aiNotes, '', Date.now()).length, 0);
});

test('forwarded courses with a link get an extra reminder ten minutes before', () => {
  // Drafts expire after 7 days of real time, so the course sits three days from now.
  const day = new Date(Date.now() + 3 * 86400000).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10);
  const draft = { title: '說明會', content: `線上會議 ${WEBEX}`, events: [{ title: 'Webex 說明會', date: day, time: '13:00', location: '', description: '' }] };
  const { row } = sharedStore.begin('G5', 'U5', 'link-test');
  sharedStore.ready(row.id, draft);
  const result = sharedStore.confirm(row.id, 'G5', 'U5', 'all');
  assert.equal(result.reminders, 3);
  const due = sharedStore.due(at(day, '12:50')).filter(r => r.source_id === 'G5');
  const lastCall = due.find(r => r.due_at === new Date(at(day, '12:50')).toISOString());
  assert.ok(lastCall, 'ten-minute reminder exists');
  assert.ok(lastCall.text.includes(WEBEX));

  const { row: plain } = sharedStore.begin('G6', 'U6', 'no-link');
  sharedStore.ready(plain.id, { ...draft, content: '實體課程' });
  assert.equal(sharedStore.confirm(plain.id, 'G6', 'U6', 'all').reminders, 2);
});
