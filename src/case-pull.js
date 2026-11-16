import fs from 'node:fs';
import { db } from './db.js';
import { imagePath, signedImageUrl } from './images.js';
import { todayInTaipei, addDays } from './util/date.js';
import { caseWindowDate, npGuide } from './case-table.js';

// 「今日 Case」「明日case表」「分配表」: a group fetches its own case table.
// Answered with a reply, which LINE does not bill, unlike the 07:30 push
// that costs one message per group member.
export const CASE_PULL_COMMAND = /^(今日|今天|明日|明天)?\s*(case\s*表?|分配表)$/i;

const md = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export async function casePullReply(text, source, now = new Date()) {
  const groupId = source.groupId || source.roomId;
  if (!groupId) return { type: 'text', text: '請在要看分配表的群組裡輸入「今日 Case」。' };

  const today = todayInTaipei(now);
  // Until 20:00 the day's own table; after that, tomorrow's. 「明日 Case」 always asks for tomorrow.
  const date = /^(明日|明天)/.test(text.trim()) ? addDays(today, 1) : caseWindowDate(now);
  const day = `${date === today ? '今日' : '明日'}（${md(date)}）`;

  const rows = await db.daily_dispatch_cache.getForDate(date);
  const row = rows.find(r => r.target_line_group_id === groupId);
  if (!row) {
    return { type: 'text', text: rows.length ? `${day}的分配表沒有本群組的醫師。` : `${day}的分配表尚待上傳。` };
  }

  const file = imagePath(row.source_image_message_id);
  if (!file || !fs.existsSync(file)) return { type: 'text', text: `${day}的分配表圖片已過期或被刪除。` };

  const matchKeys = (await db.doctor_group_mapping.getAll())
    .filter(m => m.line_group_id === groupId).map(m => m.match_key);
  const guide = npGuide(db.case_tables.get(row.source_image_message_id)?.assignments || [], matchKeys);
  const url = signedImageUrl(row.source_image_message_id, now.getTime());
  return [
    { type: 'text', text: `📋 ${day}Case 分配表${guide ? `\n\n${guide}` : ''}` },
    { type: 'image', originalContentUrl: url, previewImageUrl: url }
  ];
}
