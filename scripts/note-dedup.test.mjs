import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db } = await import('../src/db.js');

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
