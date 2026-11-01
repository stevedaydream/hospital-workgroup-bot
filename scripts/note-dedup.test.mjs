import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db } = await import('../src/db.js');

test('legacy notices block rewritten OCR across groups as a review candidate', async () => {
  const original = '決議：限制使用科別權限\nCiprofloxacin針劑 (PC68)\nLevofloxacin針劑 (PL22)\n開放血液腫瘤科、胸腔內科、感染科、一般外科、腎臟科、泌尿科使用，其他科別需經感染科授權';
  const rewritten = '- 針對 Ciprofloxacin 針劑 (PC68) 與 Levofloxacin 針劑 (PL22) 實施限制使用科別權限。\n- 開放以下科別直接使用：血液腫瘤科、胸腔內科、感染科、一般外科、腎臟科、泌尿科。\n- 其他科別需經感染科授權方可使用。';
  const old = await db.general_notes.create('藥物', original, 'manual');
  const imported = db.general_notes.importFromImages([{ title: '晨會公告：限制使用科別權限', content: rewritten }], ['cross-group-reencoded']);
  assert.equal(imported.created.length, 0);
  assert.deepEqual(imported.similar, [{ id: old.id, title: old.title }]);
  assert.equal(db.general_notes.hasImportedImage('cross-group-reencoded'), false, 'a candidate is not a confirmed identical image');
  const different = db.general_notes.importFromImages([{ title: '環境清消', content: '明天下午病房進行全面環境清消，請提前將走廊設備移至指定位置並通知所有住院病人與家屬。' }], ['unrelated']);
  assert.equal(different.created.length, 1);
  await db.general_notes.delete(old.id);
});

test('a photo imported in a batch remains recognized when resent alone', () => {
  db.general_notes.importFromImages([{ title: '測試公告', content: '批次公告內容' }], ['batch-a', 'batch-b']);
  assert.equal(db.general_notes.hasImportedImage('batch-a'), true);
  assert.equal(db.general_notes.hasImportedImage('unseen'), false);
});

test('same notice content with a different OCR heading is still a duplicate', () => {
  const note = { title: '用藥規定', content: '藥品限定感染科使用。' };
  assert.equal(db.general_notes.importFromImages([note], ['heading-a']).created.length, 1);
  assert.equal(db.general_notes.importFromImages([{ ...note, title: '藥物', content: '藥品限定感染科使用。' }], ['heading-b']).created.length, 0);
});

test('repeated image imports and equivalent OCR create only one notice', async () => {
  const notes = [{ title: '藥物', content: '限制使用科別\nCiprofloxacin針劑 (PC68)' }];
  const first = db.general_notes.importFromImages(notes, ['hash-a']);
  assert.equal(first.created.length, 1);
  assert.equal(db.general_notes.importFromImages([{ title: '不同辨識標題', content: 'OCR variation' }], ['hash-a']).created.length, 0);
  assert.equal(db.general_notes.importFromImages([{ title: ' 藥物 ', content: '限制使用科別  Ciprofloxacin針劑 (PC68)' }], ['hash-b']).created.length, 0);
  assert.equal((await db.general_notes.getAll()).filter(n => n.content.includes('Ciprofloxacin')).length, 1);
  assert.equal(db.general_notes.importFromImages([{ title: '藥物', content: '已修改的規定' }], ['hash-c']).created.length, 1);
  await db.general_notes.delete(first.created[0].id);
  assert.equal(db.general_notes.importFromImages(notes, ['hash-a']).created.length, 1);
});
