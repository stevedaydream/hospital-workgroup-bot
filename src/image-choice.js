import { randomUUID } from 'node:crypto';

const pending = new Map();
const TTL = 5 * 60 * 1000;
const actions = (token, labels) => ({ items: labels.map(([label, mode]) => ({
  type: 'action', action: { type: 'postback', label, data: `imagechoice:${token}:${mode}` }
})) });

export function cancelImages(sourceId, userId) {
  for (const [token, item] of pending) if (item.sourceId === sourceId && item.userId === userId) pending.delete(token);
}

export function offerImage(sourceId, userId, messageId, allowRecognition = false) {
  for (const [key, item] of pending) if (item.expires <= Date.now()) pending.delete(key);
  let item = [...pending.values()].find(item => item.sourceId === sourceId && item.userId === userId);
  if (item?.ids.includes(messageId)) return null;
  // Only an explicit multi-image choice may collect subsequent photos.
  // A new photo supersedes an ignored prompt, including its old buttons.
  if (item?.mode === 'pending') {
    pending.delete(item.token);
    item = undefined;
  }
  if (item) {
    if (!item.ids.includes(messageId)) item.ids.push(messageId);
    item.expires = Date.now() + TTL;
    return item.mode === 'multi'
      ? { type: 'text', text: `已收集 ${item.ids.length} 張圖片。`, quickReply: actions(item.token, [['完成並建立', 'finish'], ['取消', 'cancel']]) }
      : null;
  }
  item = { token: randomUUID(), sourceId, userId, ids: [messageId], expires: Date.now() + TTL, mode: 'pending', allowRecognition };
  pending.set(item.token, item);
  return { type: 'text', text: '要將圖片新增為公告嗎？不新增無須理會',
    quickReply: actions(item.token, [['單張新增', 'single'], ['連續圖片', 'multi'], ...(allowRecognition ? [['辨識分配表／行程', 'recognize']] : [])]) };
}

export function chooseImage(data, sourceId, userId) {
  const [, token, mode] = data.split(':');
  const item = pending.get(token);
  if (!item || item.sourceId !== sourceId || item.userId !== userId || item.expires <= Date.now()) return { message: { type: 'text', text: '圖片選項已過期或非您上傳的圖片，請重新傳送。' } };
  if (mode === 'multi' && item.mode === 'pending') {
    item.mode = 'multi';
    item.expires = Date.now() + TTL;
    return { message: { type: 'text', text: '請繼續傳送圖片，傳完按「完成並建立」。', quickReply: actions(token, [['完成並建立', 'finish'], ['取消', 'cancel']]) } };
  }
  if (mode === 'cancel') {
    pending.delete(token);
    return { message: { type: 'text', text: '已取消新增公告。' } };
  }
  if (((mode === 'single' || (mode === 'recognize' && item.allowRecognition)) && item.mode === 'pending') || (mode === 'finish' && item.mode === 'multi')) {
    pending.delete(token);
    return { ids: mode === 'finish' ? item.ids : item.ids.slice(0, 1), announcementOnly: mode !== 'recognize' };
  }
  return { message: { type: 'text', text: '請使用目前圖片的選項。' } };
}
