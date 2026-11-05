import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-log-')), 'test.db');
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
const { db } = await import('../src/db.js');
const { pushMessage } = await import('../src/line.js');

const realFetch = globalThis.fetch;
function fakeLine({ pushOk = true, members = 12 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/message/push')) {
      return pushOk ? new Response('{}', { status: 200 }) : new Response('{"message":"quota exceeded"}', { status: 429 });
    }
    if (String(url).includes('/members/count')) return Response.json({ count: members });
    return new Response('{}', { status: 404 });
  };
  return calls;
}

test('a group push is logged with its reason and billed per member; the count is cached', async () => {
  const calls = fakeLine({ members: 12 });
  try {
    await pushMessage('C' + 'a'.repeat(32), [{ type: 'image' }, { type: 'text', text: 'x' }], 'Case 表轉發');
    await pushMessage('C' + 'a'.repeat(32), { type: 'text', text: 'y' }, 'Case 表轉發');
  } finally { globalThis.fetch = realFetch; }
  const [last] = db.push_log.recent(1);
  assert.equal(last.reason, 'Case 表轉發');
  assert.equal(last.cost, 12);
  assert.equal(last.ok, true);
  assert.equal(calls.filter(u => u.includes('/members/count')).length, 1);
  const row = db.push_log.summarySince('2000-01-01T00:00:00Z').find(r => r.reason === 'Case 表轉發');
  assert.deepEqual({ sent: row.sent, cost: row.cost }, { sent: 2, cost: 24 });
});

test('a private push costs one; a rejected push is logged as failed and not billed', async () => {
  fakeLine();
  try { await pushMessage('U' + 'b'.repeat(32), { type: 'text', text: 'x' }, '我的班私訊'); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(db.push_log.recent(1)[0].cost, 1);

  fakeLine({ pushOk: false });
  try { await pushMessage('U' + 'c'.repeat(32), { type: 'text', text: 'x' }); }
  finally { globalThis.fetch = realFetch; }
  const [failed] = db.push_log.recent(1);
  assert.equal(failed.reason, '其他');
  assert.equal(failed.ok, false);
  assert.equal(failed.cost, null);
  assert.match(failed.error, /429/);
});
