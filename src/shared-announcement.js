import { createHash } from 'node:crypto';
import { sharedStore, validateDraft, deadlineReminderTimes } from './shared-announcement-store.js';
import { extractFile, extractLink, readLimited, MAX_FILE_BYTES, SUPPORTED_FILES } from './announcement-files.js';
import { organizeSharedAnnouncement } from './local-ai.js';
import { featureEnabled, disabledFeatureMessage } from './features.js';
import { todayInTaipei } from './util/date.js';

const inboxes = new Map();
const running = new Map();
const TTL = 15 * 60000;
const pruneInbox = setInterval(() => {
  for (const [key, box] of inboxes) {
    box.items = box.items.filter(item => item.at > Date.now() - TTL);
    if (box.updated <= Date.now() - TTL) inboxes.delete(key);
  }
}, 60000);
pruneInbox.unref();
const keyOf = (source, user) => JSON.stringify([source, user]);
export const SHARED_COMMANDS = ['整理公告', '查看公告草稿', '取消整理公告'];
const linksIn = text => [...new Set(text.match(/https?:\/\/[^\s<>"「」『』]+/g) || [])].map(url => url.replace(/[。，、；！？）)]+$/, ''));

export function collectShared(source, user, message, now = Date.now()) {
  if (!source || !user || !message.id || !['text', 'file'].includes(message.type)) return;
  for (const [key, item] of inboxes) if (item.updated <= now - TTL) inboxes.delete(key);
  const key = keyOf(source, user);
  if (!inboxes.has(key) && inboxes.size >= 500) return;
  const box = inboxes.get(key) || { items: [], updated: now, overflow: false };
  box.items = box.items.filter(item => item.at > now - TTL);
  if (box.items.some(item => item.id === message.id)) return;
  if (box.items.length >= 20) box.overflow = true;
  else box.items.push({ id: message.id, type: message.type, text: message.text || '', name: message.fileName || '', size: message.fileSize || 0, at: now });
  box.updated = now;
  inboxes.set(key, box);
}

export function sharedInputs(source, user, now = Date.now()) {
  const box = inboxes.get(keyOf(source, user));
  if (box?.overflow && box.updated > now - TTL) throw new Error('收集內容超過 20 則。請輸入「取消整理公告」，再分批傳送資料');
  return box?.items.filter(item => item.at > now - TTL) || [];
}

async function lineFile(item) {
  if (!SUPPORTED_FILES.test(item.name)) throw new Error('支援 PDF、DOCX、XLSX、TXT、CSV；其他格式請轉存或改傳截圖使用圖片辨識');
  if (item.size > MAX_FILE_BYTES) throw new Error('檔案超過 10 MB');
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(item.id)}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(30000)
  });
  return extractFile(await readLimited(response), item.name);
}

export async function materializeShared(items, { file = lineFile, link = extractLink } = {}) {
  const parts = [];
  const links = new Set();
  let total = 0;
  for (const item of items) {
    try {
      const text = item.type === 'file' ? await file(item) : item.text;
      parts.push(`【${item.type === 'file' ? `檔案：${item.name}` : '轉傳文字'}】\n${text}`);
      total += text.length;
      if (item.type === 'text') for (const url of linksIn(item.text)) links.add(url);
    } catch (error) { throw new Error(`${item.name || '文字'}：${error.message}`); }
    if (total > 100000) throw new Error('資料總文字超過 10 萬字，請分批整理');
  }
  if (links.size > 5) throw new Error('一次最多讀取 5 個連結，請分批整理');
  for (const url of links) {
    try {
      const text = await link(url);
      total += text.length;
      parts.push(`【來源連結：${url}】\n${text}`);
    } catch (error) { throw new Error(`連結 ${url}：${error.message}`); }
    if (total > 100000) throw new Error('資料總文字超過 10 萬字，請分批整理');
  }
  if (!parts.length) throw new Error('沒有可整理的內容');
  return parts.join('\n\n');
}

export function sharedPreview(row) {
  if (row.status === 'processing') return [{ type: 'text', text: '正在下載及整理資料，完成後會在本群組顯示草稿。' }];
  if (row.status === 'failed') return [{ type: 'text', text: `尚未建立公告或提醒：${row.error}\n修正資料後重新輸入「整理公告」。可先輸入「取消整理公告」清空收集內容。` }];
  if (row.status !== 'ready' || row.expires_at <= new Date().toISOString()) return [{ type: 'text', text: '這份草稿已處理或到期，未重複新增。' }];
  const draft = validateDraft(JSON.parse(row.draft));
  let text = `📝 公告草稿（尚未發布）\n${draft.title}\n\n${draft.content}\n\n📅 待建立行程（台灣時間）：\n`;
  text += draft.events.length ? draft.events.map((e, i) => `${i + 1}. ${e.date} ${e.time || '時間待確認'} ${e.title}${e.location ? `｜${e.location}` : ''}${e.description ? `\n${e.description}` : ''}`).join('\n') : '沒有可確定日期的課程。';
  text += '\n\n⏰ 待建立期限與一週前提醒（台灣時間）：\n';
  text += draft.deadlines.length ? draft.deadlines.map((e, i) => {
    const due = deadlineReminderTimes(e)[0];
    const schedule = due ? new Date(due).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16) : '一週前時點已過，不補設提醒';
    return `${i + 1}. ${e.title}｜截止 ${e.date}${e.time ? ` ${e.time}` : ''}\n提醒：${schedule}${e.description ? `\n${e.description}` : ''}`;
  }).join('\n') : '未辨識到明確期限。';
  text += '\n\n提醒規則：課程前一天 09:00、上課前 1 小時；期限前 7 天 09:00。只建立未來時點；期限只有日期也可提醒，課程沒有明確開始時間則不設提醒。\n請核對日期、時間與注意事項；有誤請取消後補充資料重傳。草稿保留 7 天。';
  const messages = [];
  // Bound each message in LINE's UTF-16 length units, avoiding a split surrogate.
  while (text.length) {
    let length = Math.min(4500, text.length);
    if (/[\uD800-\uDBFF]/.test(text[length - 1])) length--;
    messages.push({ type: 'text', text: text.slice(0, length) });
    text = text.slice(length);
  }
  messages.at(-1).quickReply = { items: [
    ['確認含提醒', 'all'], ['僅公告與行程', 'calendar'], ['僅建立公告', 'note'], ['取消', 'cancel']
  ].map(([label, mode]) => ({ type: 'action', action: { type: 'postback', label, data: `sharednotice:${row.id}:${mode}` } })) };
  return messages;
}

export async function handleSharedCommand(text, source, user, { reply, push, organize = organizeSharedAnnouncement, materialize = materializeShared }) {
  if (!SHARED_COMMANDS.includes(text)) return false;
  if (!featureEnabled(source, 'notes')) { await reply(disabledFeatureMessage('notes')); return true; }
  if (!user) { await reply({ type: 'text', text: '無法識別傳送者，請重新傳送。' }); return true; }
  const key = keyOf(source, user);
  const latest = sharedStore.latest(source, user);
  if (text === '取消整理公告') {
    inboxes.delete(key);
    if (latest) sharedStore.cancel(latest.id, source, user);
    await reply({ type: 'text', text: '已清空收集內容並取消最近的公告草稿。' });
    return true;
  }
  if (text === '查看公告草稿') {
    await reply(latest ? sharedPreview(latest) : { type: 'text', text: '尚無草稿，請先轉傳資料，再輸入「整理公告」。' });
    return true;
  }
  if (running.has(key)) { await reply({ type: 'text', text: '上一批仍在處理，請稍候；完成後可再整理新一批。' }); return true; }
  let items;
  try { items = sharedInputs(source, user); } catch (error) { await reply({ type: 'text', text: error.message }); return true; }
  if (!items.length) {
    await reply(latest ? sharedPreview(latest) : { type: 'text', text: '請先在本群組轉傳文字、檔案或檔案連結，15 分鐘內輸入「整理公告」。只收集您本人傳送的最近 20 則資料。支援 PDF、DOCX、XLSX、TXT／CSV，每檔 10 MB。圖片請使用圖片的「新增公告」選項。' });
    return true;
  }
  const inputKey = createHash('sha256').update(JSON.stringify(items.map(i => i.id))).digest('hex');
  const { row, started } = sharedStore.begin(source, user, inputKey);
  if (!started) { await reply(sharedPreview(row)); return true; }
  // Reserve before awaiting reply so concurrent webhook deliveries cannot start another batch.
  running.set(key, true);
  await reply({ type: 'text', text: `已收集您最近 15 分鐘的 ${items.length} 則資料，開始讀取及 AI 整理；完成後會顯示草稿供確認。輸入「取消整理公告」可取消。` });
  const work = Promise.resolve().then(async () => {
    const content = await materialize(items);
    if (sharedStore.get(row.id, source, user)?.status !== 'processing') return;
    const draft = validateDraft(await organize(content, todayInTaipei()));
    const sources = items.filter(i => i.type === 'file').map(i => `檔案：${i.name}`);
    for (const item of items.filter(i => i.type === 'text')) sources.push(...linksIn(item.text));
    if (sources.length) draft.content += `\n\n來源：\n${[...new Set(sources)].join('\n')}`;
    if (!featureEnabled(source, 'notes')) throw new Error('本群組注意事項功能已關閉');
    if (!sharedStore.ready(row.id, draft)) return;
    const box = inboxes.get(key);
    if (box) box.items = box.items.filter(i => !items.some(old => old.id === i.id));
    await push(source, sharedPreview(sharedStore.get(row.id, source, user)));
  }).catch(async error => {
    sharedStore.fail(row.id, error.message);
    const current = sharedStore.get(row.id, source, user);
    if (current?.status === 'failed') await push(source, sharedPreview(current));
  }).finally(() => running.delete(key));
  running.set(key, work);
  return true;
}

export async function handleSharedPostback(data, source, user, reply) {
  if (!data.startsWith('sharednotice:')) return false;
  const [, id, mode] = data.split(':');
  try {
    if (!featureEnabled(source, 'notes')) { await reply(disabledFeatureMessage('notes')); return true; }
    const row = sharedStore.get(id, source, user || '');
    if (!row) throw new Error('只有原傳送者能在原群組確認這份草稿');
    if (mode === 'cancel') {
      const cancelled = sharedStore.cancel(id, source, user);
      await reply({ type: 'text', text: cancelled ? '已取消這份草稿。' : '草稿已處理或到期。' });
      return true;
    }
    if (mode !== 'note' && !featureEnabled(source, 'calendar')) throw new Error('本群組行事曆已關閉，請改選「僅建立公告」');
    if (mode === 'all' && !featureEnabled(source, 'course_reminder')) throw new Error('本群組課程提醒已關閉，請改選「僅公告與行程」');
    const result = sharedStore.confirm(id, source, user, mode);
    await reply({ type: 'text', text: result.duplicate ? '這份公告已確認，未重複建立。'
      : `✅ 已建立公告、${result.events} 筆行程及 ${result.reminders} 筆提醒。\n公告：https://liff.line.me/${process.env.LIFF_NOTES_ID}?groupId=${source}\n行事曆：https://liff.line.me/${process.env.LIFF_CALENDAR_ID || 'placeholder_calendar_liff_id'}?groupId=${encodeURIComponent(source)}\n輸入「行事曆」可查看或刪除行程，刪除行程也會取消其提醒。` });
  } catch (error) { await reply({ type: 'text', text: `尚未新增：${error.message}` }); }
  return true;
}

let sending = false;
export async function runCourseReminders(send = sendReminder, now = Date.now()) {
  if (sending) return;
  sending = true;
  try {
    sharedStore.prune();
    let count = 0;
    for (const reminder of sharedStore.due(now)) {
      if (!featureEnabled(reminder.source_id, 'notes') || !featureEnabled(reminder.source_id, 'calendar') || !featureEnabled(reminder.source_id, 'course_reminder')) continue;
      if (++count > 50) break;
      try {
        sharedStore.attempted(reminder.id);
        await send(reminder);
        sharedStore.sent(reminder.id);
      } catch (error) { console.error('[Course reminder] delivery failed:', error.message); }
    }
  } finally { sending = false; }
}

async function sendReminder(reminder) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': reminder.id },
    body: JSON.stringify({ to: reminder.source_id, messages: [{ type: 'text', text: reminder.text }] }), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok && !(response.status === 409 && response.headers.get('x-line-accepted-request-id'))) throw new Error(`LINE HTTP ${response.status}`);
}
