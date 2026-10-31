import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseLeaveMessage } from '../src/leave-message.js';

test('complete group announcements capture name, inclusive dates, period and original deputy alias', () => {
  const {trip}=parseLeaveMessage('王小明11/4-11/8請假老何代看','2026-10-31');
  assert.equal(trip.traveler,'王小明');
  assert.equal(trip.depart_date,'2026-11-04');assert.equal(trip.return_date,'2026-11-08');
  assert.equal(trip.deputy,'老何');assert.equal(trip.leave_period,'全天');
  const np=parseLeaveMessage('NP林小美 2026年11月4日至2026年11月8日 下午休假，何醫師代理。','2026-10-31');
  assert.equal(np.trip.traveler,'林小美');assert.equal(np.trip.leave_period,'下午');assert.equal(np.trip.deputy,'何醫師');
  assert.equal(parseLeaveMessage('林小美 11/4 請假上午','2026-10-31').trip.depart_date,'2026-11-04');
  assert.equal(parseLeaveMessage('王小明 12/30～1/2 請假','2026-10-31').trip.return_date,'2027-01-02');
  assert.equal(parseLeaveMessage('王小明 2026-11-04 請假','2026-10-31').trip.return_date,'2026-11-04');
});

test('ambiguous dates, invalid ranges and conflicting periods never become registrations', () => {
  for(const text of ['王小明2/30請假','王小明11/8-11/4請假','王小明11/4上午請假下午']) {
    assert.ok(parseLeaveMessage(text,'2026-10-31').error);
  }
  assert.match(parseLeaveMessage('王小明1/4請假','2026-12-31').error,/年份/);
});

test('questions, cancellations, quotes and incomplete chatter are ignored', () => {
  for(const text of ['王小明11/4請假嗎？','取消王小明11/4請假','王小明11/4預計請假',
    '「王小明11/4請假」','王小明請假','大家11/4請假','王醫師11/4請假',
    '聽說王小明11/4請假','王小明11/4請假，林小美11/5請假','王小明11/4請假但還不確定']) {
    assert.equal(parseLeaveMessage(text,'2026-10-31'),null,text);
  }
});

test('webhook opt-in, durable message deduplication, overlap checks and delete replay work together', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    const {db}=await import('./src/db.js');
    const {handleWebhookEvent}=await import('./src/line.js');
    const {tomorrowInTaipei}=await import('./src/util/date.js');
    const date=tomorrowInTaipei().replaceAll('-','/');
    const announcement='王小明'+date+'請假老何代看';
    let replies=[];
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.line.me/v2/bot/message/reply');
      replies.push(JSON.parse(options.body));
      return new Response('{}',{status:200});
    };
    const event=id=>({type:'message',replyToken:'test',source:{type:'group',groupId:'Ctest',userId:'Utest'},message:{type:'text',id,text:announcement}});
    await handleWebhookEvent(event('1'));
    assert.equal(db.travels.list().length,0);assert.equal(replies.length,0);
    db.group_features.save('Ctest',{leave_autoreg:true},'test');
    db.person_aliases.set('老何','何小明','test');
    db.person_aliases.set('張醫師','張小明','test');
    await db.users.createOrUpdate('Utest','測試同仁');
    await handleWebhookEvent(event('1'));
    assert.equal(db.travels.list().length,1);
    assert.match(replies[0].messages[0].text,/已自動登記/);
    const record=db.travels.list()[0];assert.equal(record.created_by,'測試同仁');
    await handleWebhookEvent(event('1'));assert.equal(replies.length,1);
    await handleWebhookEvent(event('2'));assert.equal(db.travels.list().length,1);
    assert.match(replies[1].messages[0].text,/已有相同/);
    await handleWebhookEvent({...event('3'),message:{...event('3').message,text:'王小明'+date+'請假張醫師代看'}});
    assert.equal(db.travels.list().length,1);assert.equal(db.travels.list()[0].deputy,'何小明');
    assert.match(replies[2].messages[0].text,/已有重疊/);
    db.travels.remove(record.id);await handleWebhookEvent(event('1'));
    assert.equal(db.travels.list().length,0);
    const {parseLeaveMessage}=await import('./src/leave-message.js');
    const morning=parseLeaveMessage('王小明'+date+'上午請假',tomorrowInTaipei()).trip;
    const afternoon={...morning,leave_period:'下午'};
    const meta=id=>({messageId:id,sourceId:'Ctest',userId:'Utest',by:'測試同仁'});
    assert.equal(db.travels.importFromLine(morning,meta('am')).status,'created');
    assert.equal(db.travels.importFromLine(afternoon,meta('pm')).status,'created');
    db.group_features.save('Ctest',{travel:false},'test');
    await handleWebhookEvent(event('4'));assert.equal(db.travels.list().length,2);
    assert.equal(replies.length,3);
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,SQLITE_PATH:':memory:',MEDBASE_API_KEY:''},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

test('explicit name aliases use canonical names, retain original text and deduplicate both spellings', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    const {db}=await import('./src/db.js');
    const {parseLeaveMessage}=await import('./src/leave-message.js');
    db.person_aliases.set('老甲','何小明','測試維護者');
    assert.equal(db.person_aliases.resolve('老甲'),'何小明');
    assert.equal(db.person_aliases.resolve('老乙'),'老乙');
    assert.throws(()=>db.person_aliases.set('何小明','其他人','test'),/不可串接/);
    assert.throws(()=>db.person_aliases.set('老乙','老甲','test'),/不可串接/);
    const parsed=parseLeaveMessage('王小明11/4-11/8請假老甲代看','2026-10-31');
    const meta=id=>({messageId:id,sourceId:'Ctest',userId:'Utest',by:'測試同仁'});
    const first=db.travels.importFromLine(parsed.trip,meta('1'));
    assert.equal(first.registration.deputy,'何小明');
    assert.match(first.registration.note,/老甲＝何小明/);
    assert.equal(parsed.trip.deputy,'老甲');
    assert.equal(db.travels.importFromLine({...parsed.trip,deputy:'何小明'},meta('2')).status,'exists');
    assert.equal(db.travels.list({includePast:true}).length,1);
    const {handleWebhookEvent}=await import('./src/line.js');
    db.group_features.save('Ctest',{leave_autoreg:true},'test');
    let reply;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.line.me/v2/bot/message/reply');
      reply=JSON.parse(options.body).messages[0].text;
      return new Response('{}',{status:200});
    };
    await handleWebhookEvent({type:'message',timestamp:Date.parse('2026-10-31T01:00:00Z'),replyToken:'test',source:{type:'group',groupId:'Ctest',userId:'Utest'},message:{type:'text',id:'3',text:'王小明11/4-11/8請假老甲代看'}});
    assert.match(reply,/代理／代看：何小明（老甲）/);
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,SQLITE_PATH:':memory:',MEDBASE_API_KEY:''},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
