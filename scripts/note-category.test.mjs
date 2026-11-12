import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// A database from before notes had a category.
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'note-category-')), 'old.db');
const old = new Database(file);
old.exec(`CREATE TABLE general_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`);
const insert = old.prepare('INSERT INTO general_notes (title, content, updated_at, updated_by) VALUES (?, ?, ?, ?)');
insert.run('藥物', 'Heparin 10 mg', '2026-01-01', 'a');
insert.run('新進人員報到流程', '週一 8:00', '2026-01-02', 'b');
old.close();

process.env.SQLITE_PATH = file;
const { db } = await import('../src/db.js');
const { startDraftAi, draftAiStatus } = await import('../src/review-ai.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('old notes keep their title; a title that was a category chip becomes the category', async () => {
  const notes = await db.general_notes.getAll();
  const byTitle = Object.fromEntries(notes.map(n => [n.title, n.category]));
  assert.deepEqual(byTitle, { '藥物': '藥物', '新進人員報到流程': '其他' });
});

test('notes are saved with a category, and an update without one keeps it', async () => {
  const note = await db.general_notes.create('MRI 預約', '先填單', 'tester', '檢查');
  assert.equal(note.category, '檢查');
  const updated = await db.general_notes.update(note.id, 'MRI 預約流程', '先填單再排程', 'tester');
  assert.equal(updated.category, '檢查');
  assert.equal((await db.general_notes.update(note.id, 'MRI 預約流程', '先填單再排程', 'tester', '其他')).category, '其他');
  assert.equal((await db.general_notes.create('沒分類', '內容', 'tester')).category, '其他');
});

test('an AI draft fills title, category and content but saves nothing', async () => {
  const before = (await db.general_notes.getAll()).length;
  let seen;
  const organize = async (note, categories) => {
    seen = { note, categories };
    return { title: 'Heparin 新劑量', category: '藥物', content: '• Heparin 10 mg' };
  };
  const started = startDraftAi({ title: '', content: 'heparin 改 10mg' }, ['藥物', '其他'], organize, { prepare: async () => {} });
  assert.equal(started.status, 'running');
  await flush(); await flush();
  const result = draftAiStatus(started.id);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.draft, { title: 'Heparin 新劑量', category: '藥物', content: '• Heparin 10 mg' });
  assert.deepEqual(seen, { note: { title: '', content: 'heparin 改 10mg' }, categories: ['藥物', '其他'] });
  assert.equal((await db.general_notes.getAll()).length, before);
  assert.equal(draftAiStatus('no-such-job').status, 'missing');
});

test('a failed draft reports the error and only one draft runs at a time', async () => {
  let finish;
  const slow = () => new Promise(resolve => { finish = resolve; });
  const first = startDraftAi({ content: 'x' }, ['其他'], slow, { prepare: async () => {} });
  assert.throws(() => startDraftAi({ content: 'y' }, ['其他'], slow, { prepare: async () => {} }), /另一則公告正在整理/);
  await flush();
  finish({ title: 't', category: '其他', content: 'x' });
  await flush(); await flush();
  assert.equal(draftAiStatus(first.id).status, 'done');

  const failed = startDraftAi({ content: 'z' }, ['其他'], async () => { throw new Error('模型沒有回應'); }, { prepare: async () => {} });
  await flush(); await flush();
  assert.deepEqual([draftAiStatus(failed.id).status, draftAiStatus(failed.id).error], ['failed', '模型沒有回應']);
});
