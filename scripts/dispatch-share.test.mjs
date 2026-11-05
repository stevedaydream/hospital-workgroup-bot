import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-share-')), 'test.db');
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
const { db } = await import('../src/db.js');
const { runDailyDispatch } = await import('../src/scheduler.js');
const { todayInTaipei } = await import('../src/util/date.js');

test('07:30 pushes only to groups with auto-push on; the rest are left to be shared by hand', async () => {
  const pushed = 'C' + '1'.repeat(32), shared = 'C' + '2'.repeat(32);
  db.group_features.save(pushed, { dispatch_push: true }, 'test');
  await db.daily_dispatch_cache.add(pushed, '123', true, todayInTaipei());
  await db.daily_dispatch_cache.add(shared, '123', true, todayInTaipei());

  const targets = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/message/push')) targets.push(JSON.parse(options.body).to);
    if (String(url).includes('/members/count')) return Response.json({ count: 16 });
    return new Response('{}');
  };
  try {
    assert.deepEqual(await runDailyDispatch(), { success: true, count: 1 });
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(targets, [pushed]);
  assert.equal(db.push_log.recent(1)[0].reason, 'Case 表轉發');
});
