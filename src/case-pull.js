import fs from 'node:fs';
import { db } from './db.js';
import { imagePath, signedImageUrl } from './images.js';
import { todayInTaipei, addDays } from './util/date.js';

// 「今日 Case」「明日case表」「分配表」: a group fetches its own case table.
// Answered with a reply, which LINE does not bill, unlike the 07:30 push
// that costs one message per group member.
export const CASE_PULL_COMMAND = /^(今日|今天|明日|明天)?\s*(case\s*表?|分配表)$/i;

const label = (date, today) => (date === today ? '今日' : '明日');
const md = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export async function casePullReply(text, source, now = new Date()) {
  const groupId = source.groupId || source.roomId;
  if (!groupId) return { type: 'text', text: '請在要看分配表的群組裡輸入「今日 Case」。' };

  const today = todayInTaipei(now);
  const tomorrow = addDays(today, 1);
  const askedTomorrow = /^(明日|明天)/.test(text.trim());
  // Asked for today, a table queued in the evening for tomorrow is shown too.
  const dates = askedTomorrow ? [tomorrow] : [today, tomorrow];

  const messages = [];
  for (const date of dates) {
    const rows = await db.daily_dispatch_cache.getForDate(date);
    const row = rows.find(r => r.target_line_group_id === groupId);
    if (!row) continue;
    const file = imagePath(row.source_image_message_id);
    if (!file || !fs.existsSync(file)) {
      messages.push({ type: 'text', text: `${label(date, today)}（${md(date)}）的分配表圖片已過期或被刪除。` });
      continue;
    }
    const url = signedImageUrl(row.source_image_message_id, now.getTime());
    messages.push({ type: 'text', text: `📋 ${label(date, today)}（${md(date)}）Case 分配表` });
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  }
  if (messages.length) return messages;
  return { type: 'text', text: `${askedTomorrow ? '明日' : '今日'}沒有分配給本群組的 Case 表。` };
}
