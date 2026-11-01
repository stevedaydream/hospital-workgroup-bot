import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const { db, sqlite } = await import('../src/db.js');

test('suspected duplicates persist original OCR and can be approved exactly once without AI', async () => {
  const content = '開放血液腫瘤科、胸腔內科、感染科、一般外科、腎臟科、泌尿科使用，其他科別需經感染科授權。';
  const old = await db.general_notes.create('既有規定', content, 'manual');
  const incoming = { title: '新的辨識標題', content: content + '本週公告。' };
  db.general_notes.importFromImages([incoming], ['review-image'], { sourceId: 'Csource', userId: 'Usender' });
  db.general_notes.importFromImages([incoming], ['review-image']);
  const reviews = db.note_reviews.list();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].content, incoming.content);
  assert.equal(reviews[0].candidate_content, content);
  assert.equal(reviews[0].source_user_id, 'Usender');
  assert.equal(db.general_notes.hasImportedImage('review-image'), false);
  // Recovery still works if the original comparison notice has been deleted.
  await db.general_notes.delete(old.id);
  const result = db.note_reviews.resolve(reviews[0].id, 'approve', 'reviewer');
  assert.equal(result.status, 'approved');
  assert.deepEqual(db.note_reviews.resolve(reviews[0].id, 'approve', 'reviewer'), result);
  const note = await db.general_notes.getById(result.note_id);
  assert.equal(note.content, incoming.content);
  assert.equal(note.updated_by, 'reviewer');
  assert.equal(db.general_notes.hasImportedImage('review-image'), true);
  assert.equal(db.note_reviews.list().length, 0);
  assert.equal((await db.general_notes.getAll()).length, 1);
  assert.equal(sqlite.prepare('SELECT status FROM note_reviews').get().status, 'approved');
});

test('dismissal creates no notice and retains an audit record', () => {
  const content = '開放血液腫瘤科、胸腔內科、感染科、一般外科、腎臟科、泌尿科使用，其他科別需經感染科授權。本週公告。';
  db.general_notes.importFromImages([{ title: '待捨棄', content: content + '下週適用。' }], ['discard-image']);
  const review = db.note_reviews.list()[0];
  assert.equal(db.note_reviews.resolve(review.id, 'dismiss', 'reviewer').status, 'dismissed');
  assert.equal(db.note_reviews.resolve(review.id, 'approve', 'reviewer').status, 'dismissed');
  assert.equal(db.note_reviews.list().length, 0);
  assert.equal(db.general_notes.hasImportedImage('discard-image'), false);
  assert.throws(() => db.note_reviews.resolve(review.id, 'invalid', 'reviewer'));
});
