import fs from 'node:fs';
import { db } from './db.js';
import { imagePath, signedImageUrl } from './images.js';
import { todayInTaipei, addDays } from './util/date.js';
import { caseWindowDate, npGuide } from './case-table.js';

// 「今日 Case」「明日case表」「分配表」: any group gets the day's case table,
// plus which NP to call for its own doctors when it has a doctor mapping.
// Answered with a reply, which LINE does not bill, unlike the 07:30 push
// that costs one message per group member.
export const CASE_PULL_COMMAND = /^(今日|今天|明日|明天)?\s*(case\s*表?|分配表)$/i;

const md = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const adminUrl = groupId => `https://liff.line.me/${process.env.LIFF_ADMIN_ID || 'placeholder_admin_liff_id'}?groupId=${groupId}`;

/** The photo for `date`: the latest table uploaded for it, else one filed before tables were dated. */
async function tablePhoto(date, groupId) {
  const latest = db.case_tables.latestForDate(date);
  if (latest) return latest.message_id;
  const rows = await db.daily_dispatch_cache.getForDate(date);
  return (rows.find(r => r.target_line_group_id === groupId) || rows[0])?.source_image_message_id || null;
}

export async function casePullReply(text, source, now = new Date()) {
  const groupId = source.groupId || source.roomId;
  if (!groupId) return { type: 'text', text: '請在要看分配表的群組裡輸入「今日 Case」。' };

  const today = todayInTaipei(now);
  // Until 20:00 the day's own table; after that, tomorrow's. 「明日 Case」 always asks for tomorrow.
  const date = /^(明日|明天)/.test(text.trim()) ? addDays(today, 1) : caseWindowDate(now);
  const day = `${date === today ? '今日' : '明日'}（${md(date)}）`;

  const messageId = await tablePhoto(date, groupId);
  if (!messageId) return { type: 'text', text: `${day}的分配表尚待上傳。` };
  const file = imagePath(messageId);
  if (!file || !fs.existsSync(file)) return { type: 'text', text: `${day}的分配表圖片已過期或被刪除。` };

  const matchKeys = (await db.doctor_group_mapping.getAll())
    .filter(m => m.line_group_id === groupId).map(m => m.match_key);
  let note;
  if (!matchKeys.length) {
    note = `⚙️ 本群組尚未設定醫師對照，無法列出要找的 NP。\n請到管理後台「醫師對照」加入本群組的醫師：\n${adminUrl(groupId)}`;
  } else {
    const assignments = db.case_tables.get(messageId)?.assignments || [];
    note = npGuide(assignments, matchKeys);
    if (assignments.length && !note.includes('本群組醫師請找')) note = `本群組對應的醫師不在這張分配表上。${note ? `\n\n${note}` : ''}`;
  }
  const url = signedImageUrl(messageId, now.getTime());
  return [
    { type: 'text', text: `📋 ${day}Case 分配表${note ? `\n\n${note}` : ''}` },
    { type: 'image', originalContentUrl: url, previewImageUrl: url }
  ];
}
