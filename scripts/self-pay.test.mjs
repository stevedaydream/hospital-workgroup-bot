import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { selfPayRequest, selfPayPage, selfPayResults } from '../src/self-pay.js';

const item = { hospital_code: '00123', name_zh: '測試自費品項', name_en: 'Sample', price: 0, unit: '個', depts: ['骨科'] };

test('query and pagination parsing preserve search and reject forged offsets', () => {
  assert.deepEqual(selfPayRequest('MedBase 自費項目：骨科 A&B'), {query: '骨科 A&B', offset: 0});
  assert.equal(selfPayRequest('請問自費多少'), null);
  assert.deepEqual(selfPayRequest('自費'), {query: '', offset: 0});
  assert.deepEqual(selfPayPage('mbitems:' + JSON.stringify({query:'骨科',offset:5,his:'ignored'})), {query:'骨科',offset:5});
  for (const data of ['mbitems:{', 'mbitems:{"query":"骨科","offset":-1}', 'mbitems:{"query":"骨科","offset":1.5}', 'other']) assert.equal(selfPayPage(data), null);
});

test('cards copy exact names and leading-zero codes, with pagination and details', () => {
  const message = selfPayResults({items:[item],total:8},{query:'骨科',offset:0},'https://medbase.example');
  const [card, summary] = message.contents.contents;
  const actions = card.footer.contents.map(b => b.action);
  assert.equal(actions[0].clipboardText, '00123');
  assert.equal(actions[1].clipboardText, '測試自費品項\n院內碼：00123');
  assert.match(actions[2].clipboardText, /NT\$ 0／個/);
  assert.equal(new URL(actions[3].uri).searchParams.get('q'), '00123');
  assert.deepEqual(selfPayPage(summary.footer.contents[0].action.data), {query:'骨科',offset:5});
  assert.ok(actions.filter(a=>a.type==='clipboard').every(a=>a.clipboardText.length<=1000));
  const empty = selfPayResults({items:[],total:0},{query:'不存在',offset:0},'https://medbase.example');
  assert.equal(empty.contents.type,'bubble');
  assert.match(JSON.stringify(empty),/查無符合/);
  const noPrice = selfPayResults({items:[{...item,price:null,name_zh:''}],total:1},{query:'Sample',offset:0},'https://medbase.example');
  assert.match(JSON.stringify(noPrice),/價格未登錄/);
  assert.match(JSON.stringify(noPrice),/Sample/);
});

test('handler authorizes private queries from the binding and rechecks every page', () => {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    const {db}=await import('./src/db.js');
    const {medbaseCommand,selfPayCommand}=await import('./src/medbase.js');
    const source={type:'user',userId:'Utest'};
    let calls=[];
    globalThis.fetch=async(url,init)=>{
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ok:true,items:[${JSON.stringify(item)}],total:6}),{status:200});
    };
    assert.match((await medbaseCommand('自費 骨科',source)).text,/尚未綁定/);
    assert.equal(calls.length,0);
    db.medbase_links.upsert('Utest',{his:'trusted-his',name:'測試人員',group:''});
    assert.equal((await medbaseCommand('自費 骨科',source)).type,'flex');
    assert.equal(calls[0].his,'trusted-his');
    assert.equal(calls[0].action,'items');
    const groupReply=await medbaseCommand('自費 骨科 A&B',{...source,type:'group'});
    assert.match(groupReply.text,/私訊/);
    const chatUrl=new URL(groupReply.quickReply.items[0].action.uri);
    assert.equal(chatUrl.pathname,'/R/oaMessage/%40270auclk/');
    assert.equal(decodeURIComponent(chatUrl.search.slice(1)),'自費 骨科 A&B');
    assert.ok(groupReply.text.includes(chatUrl.toString()));
    assert.ok((await medbaseCommand('自費',{...source,type:'room'})).quickReply);
    assert.deepEqual(await medbaseCommand('自費 骨科',source,()=>false),{type:'text',text:'MedBase 功能查詢功能目前開發測試中...'});
    assert.equal(calls.length,1);
    await selfPayCommand({query:'骨科',offset:5,his:'forged'},source);
    assert.equal(calls[1].his,'trusted-his');
    assert.equal(calls[1].offset,5);
    globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error:'你的 MedBase 帳號沒有自費品項查詢權限'}),{status:403});
    assert.match((await selfPayCommand({query:'骨科',offset:5},source)).text,/沒有自費品項查詢權限/);
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,SQLITE_PATH:':memory:',MEDBASE_API_KEY:'test-only',MEDBASE_API_URL:'https://medbase.example'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
