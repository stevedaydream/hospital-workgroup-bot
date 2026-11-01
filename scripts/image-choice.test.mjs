import test from 'node:test';
import assert from 'node:assert/strict';
import { offerImage, chooseImage } from '../src/image-choice.js';

test('ignoring a chat photo does not suppress the next photo or include it in a batch', () => {
  const wedding = offerImage('new-chat', 'sender', 'wedding');
  const notice = offerImage('new-chat', 'sender', 'notice');
  assert.ok(notice?.quickReply, 'the next photo must get its own confirmation');
  assert.equal(chooseImage(wedding.quickReply.items[0].action.data, 'new-chat', 'sender').ids, undefined);
  const start = notice.quickReply.items[1].action.data;
  chooseImage(start, 'new-chat', 'sender');
  const next = offerImage('new-chat', 'sender', 'notice-2');
  assert.deepEqual(chooseImage(next.quickReply.items[0].action.data, 'new-chat', 'sender').ids, ['notice', 'notice-2']);
});

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
