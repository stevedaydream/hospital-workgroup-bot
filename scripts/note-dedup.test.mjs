import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db } = await import('../src/db.js');

test('repeated image imports and equivalent OCR create only one notice', async () => {
  const notes = [{ title: '藥物', content: '限制使用科別\nCiprofloxacin針劑 (PC68)' }];
  const first = db.general_notes.importFromImages(notes, ['hash-a']);
  assert.equal(first.created.length, 1);
  assert.equal(db.general_notes.importFromImages([{ title: '不同辨識標題', content: 'OCR variation' }], ['hash-a']).created.length, 0);
  assert.equal(db.general_notes.importFromImages([{ title: ' 藥物 ', content: '限制使用科別  Ciprofloxacin針劑 (PC68)' }], ['hash-b']).created.length, 0);
  assert.equal((await db.general_notes.getAll()).length, 1);
  assert.equal(db.general_notes.importFromImages([{ title: '藥物', content: '已修改的規定' }], ['hash-c']).created.length, 1);
  await db.general_notes.delete(first.created[0].id);
  assert.equal(db.general_notes.importFromImages(notes, ['hash-a']).created.length, 1);
});
