import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db } = await import('../src/db.js');
const { featureEnabled } = await import('../src/features.js');
const { handleWebhookEvent } = await import('../src/line.js');
const { runDailyDispatch } = await import('../src/scheduler.js');
const { todayInTaipei } = await import('../src/util/date.js');

test('saving A switches from another chat immediately gates A but leaves B enabled', async () => {
  const a = 'C' + 'a'.repeat(32), b = 'C' + 'b'.repeat(32);
  db.group_features.save(a, { image_ai: false, dispatch: false }, 'admin from B');
  assert.equal(featureEnabled(a, 'image_ai'), false);
  assert.equal(featureEnabled(b, 'image_ai'), true);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(!url.includes('/content'));
    calls.push(JSON.parse(options.body));
    return new Response('{}');
  };
  await handleWebhookEvent({ type: 'message', replyToken: 'test', source: { type: 'group', groupId: a, userId: 'Utest' }, message: {type: 'image', id: 'disabled'} });
  assert.equal(calls[0].messages[0].text, '照片 AI 辨識功能目前開發測試中...');
  await db.daily_dispatch_cache.add(a, 'photo', true, todayInTaipei());
  const before = calls.length;
  const result = await runDailyDispatch();
  assert.equal(result.count, 0);
  assert.equal(calls.length, before, 'disabled scheduled dispatch must not send anything');
});
