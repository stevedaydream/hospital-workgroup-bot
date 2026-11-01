import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('unsolicited group photos are silently ignored before download or AI', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {handleWebhookEvent} = await import('./src/line.js');
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
    await handleWebhookEvent({type:'message',replyToken:'test',source:{type:'group',groupId:'Ctest',userId:'Utest'},message:{type:'image',id:'casual-photo'}});
    assert.equal(calls, 0, 'casual photo must not download, reply or start AI');
    const source = {type:'group',groupId:'Ctest',userId:'Utest'};
    const send = (text, who=source) => handleWebhookEvent({type:'message',replyToken:'test',source:who,message:{type:'text',text}});
    const photo = (who=source) => handleWebhookEvent({type:'message',replyToken:'test',source:who,message:{type:'image',id:'image-intent-test'}});
    const replies = [];
    let downloads = 0;
    globalThis.fetch = async (url, options) => {
      if (url.includes('/content')) { downloads++; return new Response(new Uint8Array([1,2,3])); }
      replies.push(JSON.parse(options.body).messages[0]);
      return new Response('{}');
    };
    globalThis.setTimeout = () => 1;
    await send('辨識照片');
    await photo({...source,userId:'Uother'});
    await photo({...source,groupId:'Cother'});
    assert.equal(downloads,0,'request is bound to sender and chat');
    await photo();
    await photo();
    assert.equal(downloads,2);
    assert.match(replies.at(-1).text,/第 2 張/);
    await send('取消照片辨識');
    const count = replies.length;
    await photo();
    assert.equal(downloads,2);
    assert.equal(replies.length,count,'cancelled request stays silent');
    await send('辨識照片');
    const now = Date.now;
    Date.now = () => now() + 120001;
    await photo();
    assert.equal(downloads,2,'unused request expires after two minutes');
    Date.now = now;
    const {db} = await import('./src/db.js');
    db.group_features.save('Ctest',{image_ai:false},'test');
    const before = replies.length;
    await send('辨識照片');
    await photo();
    assert.equal(replies.length,before);
    assert.equal(downloads,2);
    await (await import('node:fs/promises')).unlink('public/images/image-intent-test.jpg');
  `], {env:{...process.env,SQLITE_PATH:':memory:'},encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
