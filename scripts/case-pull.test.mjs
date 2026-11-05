import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-pull-'));
process.chdir(dir); // images live under ./data/images
process.env.SQLITE_PATH = path.join(dir, 'test.db');
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
const { db } = await import('../src/db.js');
const { IMAGES_DIR } = await import('../src/images.js');
const { handleWebhookEvent } = await import('../src/line.js');
const { todayInTaipei, addDays } = await import('../src/util/date.js');

const group = 'C' + '3'.repeat(32), other = 'C' + '4'.repeat(32);
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.writeFileSync(path.join(IMAGES_DIR, '555.jpg'), 'jpg');

async function say(text, groupId) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    return new Response('{}');
  };
  try {
    await handleWebhookEvent({
      type: 'message', replyToken: 'rt', timestamp: Date.now(),
      source: { type: 'group', groupId, userId: 'U' + '9'.repeat(32) },
      message: { type: 'text', id: String(Math.random()).slice(2), text }
    });
  } finally { globalThis.fetch = realFetch; }
  return calls;
}

test('a group gets its own case table by reply, never by a billed push', async () => {
  await db.daily_dispatch_cache.add(group, '555', true, todayInTaipei());
  const calls = await say('今日 Case', group);
  assert.equal(calls.some(c => c.url.endsWith('/message/push')), false);
  const reply = calls.find(c => c.url.endsWith('/message/reply'));
  assert.ok(reply, 'answered with a reply');
  const image = reply.body.messages.find(m => m.type === 'image');
  assert.match(image.originalContentUrl, /\/images\/555\.jpg\?exp=\d+&sig=/);
});

test('a group without a table is told so, and 明日 looks at tomorrow only', async () => {
  const none = (await say('今日case', other)).find(c => c.url.endsWith('/message/reply'));
  assert.match(none.body.messages[0].text, /今日沒有分配給本群組/);

  await db.daily_dispatch_cache.add(other, '555', true, addDays(todayInTaipei(), 1));
  const tomorrow = (await say('明天 case表', other)).find(c => c.url.endsWith('/message/reply'));
  assert.match(tomorrow.body.messages[0].text, /明日/);
  assert.equal(tomorrow.body.messages[1].type, 'image');
});
