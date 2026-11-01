import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('photos offer consent without downloading; consent buttons are sender-bound', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {handleWebhookEvent} = await import('./src/line.js');
    const source = {type:'group',groupId:'Ctest',userId:'Utest'};
    const replies = [];
    globalThis.fetch = async (url, options) => {
      assert.ok(!url.includes('/content'), 'unconfirmed photos must not download');
      replies.push(JSON.parse(options.body).messages[0]);
      return new Response('{}');
    };
    const photo = id => handleWebhookEvent({type:'message',replyToken:'test',source,message:{type:'image',id}});
    await photo('one');
    assert.equal(replies[0].text,'要如何處理這張圖片？不處理無須理會');
    assert.deepEqual(replies[0].quickReply.items.map(item=>item.action.label), ['新增公告','連續圖片公告','辨識 Case 表／行程']);
    await photo('two');
    assert.equal(replies.length,2);
    const data = replies[1].quickReply.items[1].action.data;
    await handleWebhookEvent({type:'postback',replyToken:'test',source:{...source,userId:'other'},postback:{data}});
    assert.match(replies.at(-1).text,/非您/);
    await handleWebhookEvent({type:'postback',replyToken:'test',source,postback:{data}});
    assert.match(replies.at(-1).text,/完成並建立/);
    await photo('three');
    assert.match(replies.at(-1).text,/2 張/);
    const cancel = replies.at(-1).quickReply.items[1].action.data;
    await handleWebhookEvent({type:'postback',replyToken:'test',source,postback:{data:cancel}});
    assert.match(replies.at(-1).text,/已取消/);
    const {db} = await import('./src/db.js');
    db.group_features.save('Ctest',{image_ai:false},'test');
    const count = replies.length;
    await photo('disabled');
    assert.equal(replies.length,count + 1);
    assert.equal(replies.at(-1).text,'照片 AI 辨識功能目前開發測試中...');
  `], {env:{...process.env,SQLITE_PATH:':memory:'},encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
