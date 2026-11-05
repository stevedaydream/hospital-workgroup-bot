import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile, extractLink, publicAddress, publicDownload, directPublicUrl, MAX_FILE_BYTES } from '../src/announcement-files.js';

process.env.SQLITE_PATH = ':memory:';
const { sqlite, db } = await import('../src/db.js');
const { sharedStore, validateDraft, reminderTimes, deadlineReminderTimes } = await import('../src/shared-announcement-store.js');
const { collectShared, sharedInputs, materializeShared, sharedPreview, handleSharedCommand, handleSharedPostback, runCourseReminders } = await import('../src/shared-announcement.js');
const draft = () => ({ title: '教育課程', content: '2030 年課程，請帶識別證。', events: [{ title: '課程 A', date: '2030-11-05', time: '14:00', location: '會議室', description: '請帶識別證' }] });
const text = (id, value = '課程資料') => ({ id, type: 'text', text: value });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('background work did not finish'); }

test('collection isolates sender and group, expires, deduplicates, and refuses overflow', () => {
  const now = Date.now();
  collectShared('Cscope', 'Ua', text('a'), now);
  collectShared('Cscope', 'Ua', text('a'), now);
  collectShared('Cscope', 'Ub', text('b'), now);
  collectShared('Cother', 'Ua', text('c'), now);
  assert.deepEqual(sharedInputs('Cscope', 'Ua', now).map(i => i.id), ['a']);
  assert.equal(sharedInputs('Cscope', 'Ua', now + 16 * 60000).length, 0);
  for (let i = 0; i < 21; i++) collectShared('Coverflow', 'U', text(String(i)));
  assert.throws(() => sharedInputs('Coverflow', 'U'), /20 則/);
});

test('real TXT, DOCX, multi-sheet XLSX and PDF text extraction; rejects unreadable files', async () => {
  assert.equal(await extractFile(Buffer.from('課程注意事項'), '資料.txt'), '課程注意事項');
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>上課請帶識別證</w:t></w:r></w:p></w:body></w:document>');
  assert.match(await extractFile(await docx.generateAsync({ type: 'nodebuffer' }), '課程.docx'), /上課請帶識別證/);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('排程').addRow(['課程 A', '2030-11-05', '14:00']);
  workbook.addWorksheet('注意事項').addRow(['請帶識別證']);
  const sheetText = await extractFile(Buffer.from(await workbook.xlsx.writeBuffer()), '課程.xlsx');
  assert.match(sheetText, /課程 A/);
  assert.match(sheetText, /請帶識別證/);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 49 >>\nstream\nBT /F1 12 Tf 50 700 Td (Course schedule) Tj ET\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  assert.match(await extractFile(Buffer.from(pdf), 'course.pdf'), /Course schedule/);
  await assert.rejects(extractFile(Buffer.from('fake'), '課程.doc'), /支援/);
  await assert.rejects(extractFile(Buffer.from('broken'), '課程.pdf'));
  await assert.rejects(extractFile(Buffer.alloc(MAX_FILE_BYTES + 1), 'large.txt'), /10 MB/);
});

test('links block private networks and credentials, read public documents, fail closed on inaccessible links', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1', '192.168.1.1', 'fc00::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(publicDownload('http://127.0.0.1/test'), /內網/);
  await assert.rejects(publicDownload('https://user:pass@example.com/test'), /公開/);
  await assert.rejects(publicDownload('file:///etc/passwd'), /公開/);
  assert.match(directPublicUrl('https://docs.google.com/spreadsheets/d/abc/edit'), /format=xlsx/);
  assert.equal(await extractLink('https://example.com/a', async () => ({ buffer: Buffer.from('上課通知'), type: 'text/plain', url: 'https://example.com/a' })), '上課通知');
  await assert.rejects(materializeShared([{ type: 'text', text: '請看 https://example.com/a' }], { link: async () => { throw new Error('需要登入'); } }), /需要登入/);
  const value = await materializeShared([{ type: 'text', text: '說明 https://example.com/a' }, { type: 'file', name: '課表.pdf' }], { file: async () => '課表', link: async () => '網頁內容' });
  assert.match(value, /課表.pdf/); assert.match(value, /網頁內容/);
});

test('draft validation and reminder times never invent missing times or accept invalid dates', () => {
  assert.throws(() => validateDraft({ ...draft(), events: [{ title: '錯誤', date: '2030-02-30' }] }), /日期/);
  assert.deepEqual(reminderTimes({ date: '2030-11-05', time: '' }), []);
  assert.deepEqual(reminderTimes(draft().events[0], Date.parse('2030-11-01T00:00:00Z')), ['2030-11-04T01:00:00.000Z', '2030-11-05T05:00:00.000Z']);
  assert.deepEqual(reminderTimes(draft().events[0], Date.parse('2030-11-05T05:30:00Z')), []);
});

test('organize produces preview only; authorized confirmation atomically creates once; reminder retries and deletion work', async () => {
  const replies = [], pushes = [];
  collectShared('Cflow', 'Uflow', text('flow-message'));
  const services = { reply: async m => replies.push(m), push: async (_, m) => pushes.push(m), organize: async () => draft(), materialize: async () => '課程' };
  await handleSharedCommand('整理公告', 'Cflow', 'Uflow', services);
  await waitFor(() => pushes.length > 0);
  const row = sharedStore.latest('Cflow', 'Uflow');
  assert.equal(row.status, 'ready');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM general_notes').get().n, 0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM course_reminders').get().n, 0);
  await handleSharedPostback(`sharednotice:${row.id}:all`, 'Cflow', 'Uintruder', services.reply);
  assert.match(replies.at(-1).text, /原傳送者/);
  await handleSharedPostback(`sharednotice:${row.id}:all`, 'Cwrong', 'Uflow', services.reply);
  assert.match(replies.at(-1).text, /原傳送者/);
  await handleSharedPostback(`sharednotice:${row.id}:all`, 'Cflow', 'Uflow', services.reply);
  assert.match(replies.at(-1).text, /1 筆行程及 2 筆提醒/);
  assert.match(replies.at(-1).text, /行事曆：https:\/\/liff\.line\.me\/[^\s]+\?groupId=Cflow/);
  await handleSharedPostback(`sharednotice:${row.id}:all`, 'Cflow', 'Uflow', services.reply);
  assert.match(replies.at(-1).text, /未重複建立/);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM general_notes').get().n, 1);
  const due = Date.parse('2030-11-04T01:01:00Z');
  await runCourseReminders(async () => { throw new Error('test offline'); }, due);
  assert.equal(sharedStore.due(due).length, 1);
  const deliveries = [];
  await runCourseReminders(async r => deliveries.push(r.id), due);
  await runCourseReminders(async r => deliveries.push(r.id), due);
  assert.equal(deliveries.length, 1);
  const event = (await db.group_events.getAll('Cflow'))[0];
  await db.group_events.delete(event.id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM course_reminders').get().n, 0);
});

test('cancellation blocks late AI, failure publishes nothing, and disabled features are checked on confirmation', async () => {
  const replies = [], pushes = [];
  let complete;
  const services = { reply: async m => replies.push(m), push: async (_, m) => pushes.push(m), materialize: async () => 'data', organize: () => new Promise(resolve => { complete = resolve; }) };
  collectShared('Ccancel', 'U', text('cancel-message'));
  await handleSharedCommand('整理公告', 'Ccancel', 'U', services);
  await waitFor(() => complete);
  const row = sharedStore.latest('Ccancel', 'U');
  await handleSharedCommand('取消整理公告', 'Ccancel', 'U', services);
  complete(draft()); await tick(); await tick();
  assert.equal(sharedStore.get(row.id, 'Ccancel', 'U').status, 'cancelled');
  assert.equal(pushes.length, 0);
  collectShared('Cfailed', 'U', text('failed-message'));
  await handleSharedCommand('整理公告', 'Cfailed', 'U', { ...services, materialize: async () => { throw new Error('檔案需要權限'); } });
  await waitFor(() => pushes.length);
  assert.equal(sharedStore.latest('Cfailed', 'U').status, 'failed');
  assert.match(pushes[0][0].text, /檔案需要權限/);
  const created = sharedStore.begin('Cdisabled', 'U', 'key');
  sharedStore.ready(created.row.id, draft());
  db.group_features.save('Cdisabled', { calendar: false }, 'test');
  await handleSharedPostback(`sharednotice:${created.row.id}:all`, 'Cdisabled', 'U', services.reply);
  assert.match(replies.at(-1).text, /行事曆已關閉/);
  await handleSharedPostback(`sharednotice:${created.row.id}:note`, 'Cdisabled', 'U', services.reply);
  assert.match(replies.at(-1).text, /0 筆行程及 0 筆提醒/);
  const preview = sharedPreview(sharedStore.get(created.row.id, 'Cdisabled', 'U'));
  assert.match(preview[0].text, /未重複新增/);
});

test('webhook buffers file metadata without downloading and routes commands without @all', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {handleWebhookEvent} = await import('./src/line.js');
    const {sharedInputs} = await import('./src/shared-announcement.js');
    const calls=[];
    globalThis.fetch=async(url,options)=>{calls.push(url);assert.ok(url.endsWith('/message/reply'));return new Response('{}');};
    const source={type:'group',groupId:'Cwebhook',userId:'U'};
    await handleWebhookEvent({type:'message',source,replyToken:'x',message:{type:'text',id:'a',text:'課程資料 https://example.com/course.pdf'}});
    await handleWebhookEvent({type:'message',source,replyToken:'x',message:{type:'file',id:'b',fileName:'課程.pdf',fileSize:100}});
    assert.equal(sharedInputs('Cwebhook','U').length,2);
    assert.equal(calls.length,1);
    await handleWebhookEvent({type:'message',source,replyToken:'x',message:{type:'text',id:'c',text:'取消整理公告'}});
    assert.equal(sharedInputs('Cwebhook','U').length,0);
  `], { env: { ...process.env, SQLITE_PATH: ':memory:' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('SQLite drafts and reminders survive restart; interrupted jobs become retryable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-announcement-'));
  const database = path.join(directory, 'test.db');
  const run = code => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SQLITE_PATH: database }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  try {
    run(`
      const {sharedStore}=await import('./src/shared-announcement-store.js');
      const first=sharedStore.begin('Crestart','U','first');
      sharedStore.ready(first.row.id,${JSON.stringify(draft())});
      sharedStore.confirm(first.row.id,'Crestart','U','all');
      const pending=sharedStore.begin('Crestart','U','second');
      sharedStore.ready(pending.row.id,${JSON.stringify(draft())});
      sharedStore.begin('Crestart','U','interrupted');
    `);
    run(`
      import assert from 'node:assert/strict';
      const {sharedStore}=await import('./src/shared-announcement-store.js');
      const {sqlite}=await import('./src/db.js');
      assert.equal(sqlite.prepare('SELECT count(*) n FROM course_reminders').get().n,2);
      assert.equal(sqlite.prepare("SELECT status FROM shared_announcement_drafts WHERE input_key='second'").get().status,'ready');
      const retry=sharedStore.begin('Crestart','U','interrupted');
      assert.equal(retry.started,true);
      const old=sharedStore.begin('Crestart','U','first');
      assert.equal(old.started,false);
      assert.equal(old.row.status,'confirmed');
    `);
  } finally {
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(database + suffix, { force: true });
    fs.rmdirSync(directory);
  }
});

test('deadline-only announcements preview and schedule one week before at 09:00 Taiwan without inventing a cutoff time', async () => {
  const notice = { title: '報名及繳交期限', content: '請按時報名、繳交。', events: [], deadlines: [
    { title: '課程報名截止', date: '2030-11-20', time: '', description: '請填報名表' },
    { title: '繳交心得', date: '2030-11-21', time: '17:00', description: '寄至教學部' }
  ] };
  const now = Date.parse('2030-11-01T00:00:00Z');
  assert.deepEqual(deadlineReminderTimes(notice.deadlines[0], now), ['2030-11-13T01:00:00.000Z']);
  assert.deepEqual(deadlineReminderTimes(notice.deadlines[1], now), ['2030-11-14T01:00:00.000Z']);
  assert.deepEqual(deadlineReminderTimes(notice.deadlines[0], Date.parse('2030-11-13T01:00:00Z')), []);
  assert.deepEqual(deadlineReminderTimes(notice.deadlines[0], Date.parse('2030-11-18T00:00:00Z')), []);
  assert.throws(() => validateDraft({ ...notice, deadlines: [{ title: '錯誤日期', date: '2030-02-30' }] }), /日期/);
  assert.throws(() => validateDraft({ ...notice, deadlines: {} }), /格式/);
  assert.deepEqual(validateDraft(draft()).deadlines, []); // Existing drafts remain valid.
  const row = sharedStore.begin('Cdeadline', 'U', 'deadline-only').row;
  sharedStore.ready(row.id, notice);
  const preview = sharedPreview(sharedStore.get(row.id, 'Cdeadline', 'U')).map(m => m.text).join('');
  assert.match(preview, /2030-11-13 09:00/);
  assert.match(preview, /繳交心得/);
  const result = sharedStore.confirm(row.id, 'Cdeadline', 'U', 'all');
  assert.equal(result.events, 2);
  assert.equal(result.reminders, 2);
  assert.equal(sharedStore.confirm(row.id, 'Cdeadline', 'U', 'all').duplicate, true);
  const events = await db.group_events.getAll('Cdeadline');
  assert.equal(events[0].title, '【期限】課程報名截止');
  assert.equal(events[0].time, null);
  const due = Date.parse('2030-11-13T01:01:00Z');
  assert.match(sharedStore.due(due).find(r => r.source_id === 'Cdeadline').text, /期限一週前提醒/);
  const delivered = [];
  await runCourseReminders(async reminder => delivered.push(reminder), due);
  assert.equal(delivered.filter(r => r.source_id === 'Cdeadline').length, 1);
  await db.group_events.delete(events[1].id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM course_reminders WHERE source_id = ? AND sent_at IS NULL').get('Cdeadline').n, 0);
});

test('mixed course and deadline reminders stay separate; past week-ahead times are skipped and calendar-only never schedules', () => {
  const notice = { ...draft(), deadlines: [{ title: '報名截止', date: '2030-11-04', time: '' }] };
  const row = sharedStore.begin('Cmixed', 'U', 'mixed').row;
  sharedStore.ready(row.id, notice);
  const result = sharedStore.confirm(row.id, 'Cmixed', 'U', 'all');
  assert.equal(result.events, 2);
  assert.equal(result.reminders, 3);
  const calendar = sharedStore.begin('Cdeadline-calendar', 'U', 'calendar').row;
  sharedStore.ready(calendar.id, notice);
  assert.equal(sharedStore.confirm(calendar.id, 'Cdeadline-calendar', 'U', 'calendar').reminders, 0);
  const past = sharedStore.begin('Cdeadline-past', 'U', 'past').row;
  sharedStore.ready(past.id, { title: '期限已過', content: '過去公告', events: [], deadlines: [{ title: '過去截止', date: '2001-01-01' }] });
  assert.match(sharedPreview(sharedStore.get(past.id, 'Cdeadline-past', 'U')).map(m => m.text).join(''), /一週前時點已過/);
  const skipped = sharedStore.confirm(past.id, 'Cdeadline-past', 'U', 'all');
  assert.equal(skipped.events, 1);
  assert.equal(skipped.reminders, 0);
});
