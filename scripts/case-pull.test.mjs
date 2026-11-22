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
const { casePullReply } = await import('../src/case-pull.js');
const { todayInTaipei, addDays } = await import('../src/util/date.js');

const group = 'C' + '3'.repeat(32), other = 'C' + '4'.repeat(32), third = 'C' + '5'.repeat(32);
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.writeFileSync(path.join(IMAGES_DIR, '555.jpg'), 'jpg');
const src = groupId => ({ type: 'group', groupId });
const at = (time) => new Date(`2030-03-10T${time}:00+08:00`);

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
  const today = todayInTaipei();
  await db.daily_dispatch_cache.add(group, '555', true, today);
  await db.daily_dispatch_cache.add(group, '555', true, addDays(today, 1));
  const calls = await say('今日 Case', group);
  assert.equal(calls.some(c => c.url.endsWith('/message/push')), false);
  const reply = calls.find(c => c.url.endsWith('/message/reply'));
  assert.ok(reply, 'answered with a reply');
  const image = reply.body.messages.find(m => m.type === 'image');
  assert.match(image.originalContentUrl, /\/images\/555\.jpg\?exp=\d+&sig=/);
});

test('until 20:00 today\'s table, after 20:00 tomorrow\'s, or that it is still to be uploaded', async () => {
  await db.daily_dispatch_cache.add(other, '555', true, '2030-03-10');
  assert.match((await casePullReply('今日 Case', src(other), at('08:00')))[0].text, /今日（3\/10）/);
  assert.match((await casePullReply('今日 Case', src(other), at('20:00')))[0].text, /今日（3\/10）/);
  assert.equal((await casePullReply('今日 Case', src(other), at('20:01'))).text, '明日（3/11）的分配表尚待上傳。');

  await db.daily_dispatch_cache.add(other, '555', true, '2030-03-11');
  const evening = await casePullReply('Case', src(other), at('21:30'));
  assert.match(evening[0].text, /明日（3\/11）/);
  assert.equal(evening[1].type, 'image');
  assert.match((await casePullReply('明天 case表', src(other), at('09:00')))[0].text, /明日（3\/11）/);
});

test('a group without a doctor mapping still gets the table, with a reminder to set one up', async () => {
  const reply = await casePullReply('今日 Case', src(third), at('09:00'));
  assert.equal(reply[1].type, 'image');
  assert.match(reply[0].text, /今日（3\/10）Case 分配表/);
  assert.match(reply[0].text, /尚未設定醫師對照/);
  assert.match(reply[0].text, new RegExp(`groupId=${third}`));
});

test('the reply tells the group which NP and extension to call for each of its doctors', async () => {
  await db.doctor_group_mapping.create('王小明', '測試群', group, 'DIRECT');
  db.case_tables.save('555', '2030-03-12', [
    { ward: '9B', np: '林小美', tel: '60001', shift: '', doctors: [{ name: '王小明', cases: 5 }, { name: '李大華', cases: 3 }] },
    { ward: '', np: '陳小芳', tel: '60002', shift: '夜八', doctors: [] }
  ]);
  await db.daily_dispatch_cache.add(group, '555', true, '2030-03-12');
  const [header] = await casePullReply('今日 Case', src(group), new Date('2030-03-12T10:00:00+08:00'));
  assert.match(header.text, /王小明（5 床） → 9B 林小美 分機 60001/);
  assert.doesNotMatch(header.text, /李大華/, 'only this group\'s doctors');
  assert.match(header.text, /值班 NP：夜八 陳小芳 60002/);
});

test('the latest table uploaded for the day is the one given, to every group', async () => {
  fs.writeFileSync(path.join(IMAGES_DIR, '777.jpg'), 'jpg');
  db.case_tables.save('777', '2030-03-12', [
    { ward: '9A', np: '林小美', tel: '60001', shift: '', doctors: [{ name: '李大華', cases: 2 }] }
  ]);
  const mapped = await casePullReply('今日 Case', src(group), new Date('2030-03-12T10:00:00+08:00'));
  assert.match(mapped[1].originalContentUrl, /\/images\/777\.jpg/);
  assert.match(mapped[0].text, /本群組對應的醫師不在這張分配表上/);
  const unmapped = await casePullReply('今日 Case', src(third), new Date('2030-03-12T10:00:00+08:00'));
  assert.match(unmapped[1].originalContentUrl, /\/images\/777\.jpg/);
});
test('a re-uploaded table drops the groups it no longer lists, and keeps the ones it does', async () => {
  const date = '2030-04-01';
  await db.daily_dispatch_cache.add(group, 'old', true, date);
  await db.daily_dispatch_cache.add(other, 'old', true, date);
  await db.daily_dispatch_cache.add(third, 'old', true, '2030-04-02'); // another day is untouched
  await db.daily_dispatch_cache.add(group, 'new', true, date);       // still on the new table
  assert.deepEqual(await db.daily_dispatch_cache.dropOtherTables(date, 'new'), [other]);
  const rows = await db.daily_dispatch_cache.getForDate(date);
  assert.deepEqual(rows.map(r => [r.target_line_group_id, r.source_image_message_id]), [[group, 'new']]);
  assert.equal((await db.daily_dispatch_cache.getForDate('2030-04-02')).length, 1);
  assert.deepEqual(await db.daily_dispatch_cache.dropOtherTables(date, 'new'), []);
});
