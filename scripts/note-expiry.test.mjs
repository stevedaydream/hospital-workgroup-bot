import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db } = await import('../src/db.js');
const { withExpiry, parseExpiry } = await import('../src/note-expiry.js');

test('a note is shown through its expiry date and is permanent without one', () => {
  assert.equal(withExpiry({ expires_on: '2026-11-12' }, '2026-11-12').expired, false, 'still shown on the last day');
  assert.equal(withExpiry({ expires_on: '2026-11-11' }, '2026-11-12').expired, true);
  assert.equal(withExpiry({ expires_on: null }, '2099-01-01').expired, false);
});

test('expiry input: a real date, empty for permanent, missing to keep', () => {
  assert.deepEqual(parseExpiry('2026-12-31'), { value: '2026-12-31' });
  assert.deepEqual(parseExpiry(''), { value: null });
  assert.deepEqual(parseExpiry(null), { value: null });
  assert.deepEqual(parseExpiry(undefined), { value: undefined });
  for (const bad of ['2026-02-30', '12/31', 20261231, '2026-13-01']) assert.ok(parseExpiry(bad).error, String(bad));
});

test('expiry is saved, kept when an edit leaves it out, and cleared to make a note permanent', async () => {
  const note = await db.general_notes.create('門禁', '夜間改走側門', 'tester', '其他', '2026-12-01');
  assert.equal(note.expires_on, '2026-12-01');
  assert.equal((await db.general_notes.update(note.id, '門禁', '夜間改走側門', 'tester', '其他')).expires_on, '2026-12-01');
  assert.equal((await db.general_notes.update(note.id, '門禁', '夜間改走側門', 'tester', '其他', null)).expires_on, null);
  assert.equal((await db.general_notes.create('常駐', '內容', 'tester')).expires_on, null, 'permanent by default');
});
