import test from 'node:test';
import assert from 'node:assert/strict';
import { offerImage, chooseImage } from '../src/image-choice.js';

test('single consent is consumed once; multi collects unique IDs and expires', () => {
  const prompt = offerImage('chat', 'user', '1');
  const single = prompt.quickReply.items[0].action.data;
  assert.equal(chooseImage(single, 'other', 'user').ids, undefined);
  assert.deepEqual(chooseImage(single, 'chat', 'user').ids, ['1']);
  assert.equal(chooseImage(single, 'chat', 'user').ids, undefined);
  const multi = offerImage('chat', 'user', '2').quickReply.items[1].action.data;
  chooseImage(multi, 'chat', 'user');
  offerImage('chat', 'user', '2');
  const next = offerImage('chat', 'user', '3');
  assert.deepEqual(chooseImage(next.quickReply.items[0].action.data, 'chat', 'user').ids, ['2', '3']);
  const expired = offerImage('chat', 'user', '4').quickReply.items[0].action.data;
  const now = Date.now;
  try {
    Date.now = () => now() + 300001;
    assert.equal(chooseImage(expired, 'chat', 'user').ids, undefined);
  } finally { Date.now = now; }
});
