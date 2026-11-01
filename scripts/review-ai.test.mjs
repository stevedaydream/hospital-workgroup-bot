import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SQLITE_PATH = ':memory:';
const {db} = await import('../src/db.js');
const {startReviewAi, reviewAiStatus} = await import('../src/review-ai.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('AI draft preserves original, waits for confirmation and publishes edited text once', async () => {
  db.general_notes.importFromImages([{title:'原標題',content:'原文藥物 10 mg，不可擅自更改。'}],['draft-test'],{reviewOnly:true});
  const review=db.note_reviews.list()[0];
  let calls=0, finish;
  const organize=()=>{calls++;return new Promise(resolve=>finish=resolve);};
  startReviewAi(review.id,organize);
  startReviewAi(review.id,organize);
  await flush();
  assert.equal(calls,1);
  finish({title:'整理標題',content:'整理後：藥物 10 mg，不可擅自更改。'});
  await flush();
  assert.equal(reviewAiStatus(review.id).status,'done');
  const draft=db.note_reviews.list()[0];
  assert.equal(draft.content,review.content);
  assert.equal(draft.draft_title,'整理標題');
  assert.equal((await db.general_notes.getAll()).length,0);
  const result=db.note_reviews.resolve(review.id,'approve','reviewer',{title:'人工確認標題',content:'人工確認內容 10 mg。'});
  assert.equal((await db.general_notes.getById(result.note_id)).content,'人工確認內容 10 mg。');
  db.note_reviews.resolve(review.id,'approve','reviewer');
  assert.equal((await db.general_notes.getAll()).length,1);
});

test('failed AI retains the source and can be retried without publishing', async () => {
  db.general_notes.importFromImages([{title:'失敗測試',content:'待整理原文'}],['failed-test'],{reviewOnly:true});
  const review=db.note_reviews.list()[0];
  startReviewAi(review.id,async()=>{throw new Error('model unavailable');});
  await flush();
  assert.equal(reviewAiStatus(review.id).status,'failed');
  assert.equal(db.note_reviews.list()[0].content,'待整理原文');
  startReviewAi(review.id,async()=>({title:'重試',content:'整理結果'}));
  await flush();
  assert.equal(reviewAiStatus(review.id).status,'done');
  assert.equal((await db.general_notes.getAll()).length,1);
});
