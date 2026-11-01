import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('unknown deputy selection is explicit, sender-bound, scoped, cancellable and reusable', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    const {db}=await import('./src/db.js');
    const {handleWebhookEvent}=await import('./src/line.js');
    const {tomorrowInTaipei}=await import('./src/util/date.js');
    db.group_features.save('Ctest',{leave_autoreg:true},'test');
    let replies=[],rosterCalls=0,rosterFails=false;
    const doctors=['張小明','何小明','李小明','王小明','陳小明','林小明','吳小明','蔡小明'].map(name=>({name,department:'骨科',title:'主治醫師'}));
    globalThis.fetch=async(url,options)=>{
      if(url.endsWith('/api/bot')) {
        assert.equal(JSON.parse(options.body).action,'attendingRoster');rosterCalls++;
        return new Response(JSON.stringify(rosterFails?{ok:false,error:'offline'}:{ok:true,items:doctors}),{status:rosterFails?502:200});
      }
      assert.equal(url,'https://api.line.me/v2/bot/message/reply');
      replies.push(JSON.parse(options.body).messages[0]);return new Response('{}',{status:200});
    };
    const source={type:'group',groupId:'Ctest',userId:'Utest'};
    const date=tomorrowInTaipei().replaceAll('-','/');
    const message=(id,deputy)=>({type:'message',replyToken:'test',source,message:{id,type:'text',text:'王小明'+date+'請假'+deputy+'代看'}});
    const post=(data,who=source)=>handleWebhookEvent({type:'postback',replyToken:'test',source:who,postback:{data}});
    const firstAction=card=>card.contents.body.contents[2].action.data;
    await handleWebhookEvent(message('unknown','老張'));
    const menu=replies.at(-1);assert.equal(menu.type,'flex');
    assert.equal(db.travels.list().length,0);assert.equal(db.person_aliases.resolve('老張','Ctest'),'老張');
    const selection=firstAction(menu),token=JSON.parse(selection.slice('leavealias:'.length)).token;
    const pending=db.pending_leave_aliases.get(token);assert.equal(pending.choices[0].name,'張小明');
    const count=replies.length;await handleWebhookEvent(message('unknown','老張'));assert.equal(replies.length,count);
    await post(selection,{...source,userId:'Uother'});assert.match(replies.at(-1).text,/僅原公告/);
    await post(selection,{...source,groupId:'Cother'});assert.match(replies.at(-1).text,/功能目前開發測試中/);
    await post('leavealias:'+JSON.stringify({token,select:999}));assert.match(replies.at(-1).text,/人選無效/);
    assert.equal(db.travels.list().length,0);
    const next=menu.contents.footer.contents.find(b=>b.action.label==='下一頁').action.data;
    await post(next);assert.ok(JSON.stringify(replies.at(-1)).includes('第 2/2 頁'));
    await post(selection);assert.match(replies.at(-1).text,/張小明（老張）/);
    assert.equal(db.travels.list().length,1);assert.equal(db.travels.list()[0].deputy,'張小明');
    assert.equal(db.person_aliases.resolve('老張','Ctest'),'張小明');
    assert.equal(db.person_aliases.resolve('老張','Cother'),'老張');
    await post(selection);assert.match(replies.at(-1).text,/已處理/);assert.equal(db.travels.list().length,1);
    const calls=rosterCalls;await handleWebhookEvent(message('known','老張'));assert.equal(rosterCalls,calls);
    assert.match(replies.at(-1).text,/已有相同/);
    await handleWebhookEvent(message('cancel','老李'));const cancel=replies.at(-1).contents.footer.contents.find(b=>b.action.label==='取消這次登記').action.data;
    await post(cancel);assert.match(replies.at(-1).text,/已取消/);assert.equal(db.person_aliases.resolve('老李','Ctest'),'老李');
    await handleWebhookEvent(message('expire','老何'));const expired=firstAction(replies.at(-1));
    const now=Date.now;Date.now=()=>now()+86400001;await post(expired);Date.now=now;
    assert.match(replies.at(-1).text,/過期/);assert.equal(db.person_aliases.resolve('老何','Ctest'),'老何');
    rosterFails=true;await handleWebhookEvent(message('offline','老吳'));assert.match(replies.at(-1).text,/尚未登記.*無法載入/);
    assert.equal(db.travels.list().length,1);
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,SQLITE_PATH:':memory:',MEDBASE_API_KEY:'test-only',MEDBASE_API_URL:'https://medbase.example'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
