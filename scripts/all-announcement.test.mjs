import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { allAnnouncement } from '../src/all-announcement.js';

test('only real all mentions record original text; plain text and user mentions stay untouched', () => {
  const message = { type: 'text', text: '@All PPN 套組放在備物櫃第二層\n內容請依現場標示確認。', mention: { mentionees: [{type:'all',index:0,length:4}] } };
  assert.deepEqual(allAnnouncement(message), { title:'PPN 套組放在備物櫃第二層',content:'PPN 套組放在備物櫃第二層\n內容請依現場標示確認。' });
  assert.equal(allAnnouncement({type:'text',text:'請問 @all 怎麼使用'}), null);
  assert.equal(allAnnouncement({...message,mention:{mentionees:[{type:'user',index:0,length:4}]}}), null);
  assert.equal(allAnnouncement({...message,text:'@All'}), null);
  assert.equal(allAnnouncement({...message,mention:{mentionees:[{type:'all',index:-1,length:4}]}}), null);
});

test('all mention webhook saves globally once, stages similarities, and respects notes switch', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {db} = await import('./src/db.js');
    const {handleWebhookEvent} = await import('./src/line.js');
    const replies=[];
    globalThis.fetch=async(url,options)=>{assert.ok(url.endsWith('/message/reply'));replies.push(JSON.parse(options.body).messages[0]);return new Response('{}');};
    const send = (id, text, groupId='Ctest', real=true) => handleWebhookEvent({type:'message',replyToken:'test',source:{type:'group',groupId,userId:'Usender'},message:{id,type:'text',text,...(real?{mention:{mentionees:[{type:'all',index:0,length:4}]}}:{})}});
    const content='@All PPN 套組放在備物櫃第二層，使用後請確認內容物並補充耗材，相關內容依現場標示與最新規定確認。';
    await send('plain','普通聊天', 'Ctest',false);
    assert.equal(replies.length,0);
    await send('one',content);
    assert.equal((await db.general_notes.getAll()).length,1);
    assert.equal((await db.general_notes.getAll())[0].updated_by,'LINE @all 公告');
    await send('one',content);
    await send('two',content,'Cother');
    assert.equal((await db.general_notes.getAll()).length,1);
    assert.match(replies.at(-1).text,/未重複新增/);
    await send('three',content+'另請留意更新。');
    assert.equal(db.note_reviews.list().length,1);
    assert.match(replies.at(-1).text,/待確認公告/);
    db.group_features.save('Ctest',{notes:false},'test');
    await send('four','@All 全新公告');
    assert.match(replies.at(-1).text,/注意事項功能目前開發測試中/);
    assert.equal((await db.general_notes.getAll()).length,1);
  `], { env:{...process.env,SQLITE_PATH:':memory:'},encoding:'utf8' });
  assert.equal(child.status,0,child.stderr||child.stdout);
});
