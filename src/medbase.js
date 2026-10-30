import crypto from 'crypto';
import dotenv from 'dotenv';
import { db } from './db.js';
import { todayInTaipei, addDays, dayOfWeek } from './util/date.js';

dotenv.config();

// MedBase scheduling system (H:\project\medbase). The bot only talks to its
// read-only /api/bot entry on medbase-mobile; contacts, credentials and
// schedule documents are out of reach by design.
//
// LINE pushes are billed per group member (200/month on the free plan), so
// every query here is answered with a free reply; only swap notices (one
// person), publish notices and opt-in reminders (one group each) are pushed.

const MEDBASE_API_URL = (process.env.MEDBASE_API_URL || 'https://medbase-mobile.vercel.app').replace(/\/+$/, '');
const MEDBASE_API_KEY = process.env.MEDBASE_API_KEY || '';
const MEDBASE_NOTIFY_SECRET = process.env.MEDBASE_NOTIFY_SECRET || '';
export const MEDBASE_APP_URL = `${MEDBASE_API_URL}/schedule`;
export const DEFAULT_MEDBASE_GROUP = '9A9B';

const NOTIFY_MAX_SKEW_MS = 5 * 60 * 1000;
const MY_SCHEDULE_DAYS = 7;

export const medbaseEnabled = Boolean(MEDBASE_API_KEY);
if (medbaseEnabled) console.log(`MedBase: integration enabled (${MEDBASE_API_URL})`);

async function callMedbase(action, args = {}) {
  const res = await fetch(`${MEDBASE_API_URL}/api/bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEDBASE_API_KEY}` },
    body: JSON.stringify({ action, ...args }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ----------------------------------------------------
// Formatting
// ----------------------------------------------------
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${dayOfWeek(date).slice(1)}）`;

/** "D：甲、乙" per shift, in the order shifts first appear; days off are left out. */
function formatDuty(items) {
  const byShift = new Map();
  for (const { name, shift } of items) {
    if (/^off$/i.test(shift)) continue;
    if (!byShift.has(shift)) byShift.set(shift, []);
    byShift.get(shift).push(name);
  }
  if (!byShift.size) return '（沒有排班）';
  return [...byShift].map(([shift, names]) => `${shift}：${names.join('、')}`).join('\n');
}

async function dutyText(date, group, label) {
  const r = await callMedbase('day', { date, group });
  if (!r.published) return `📅 ${label} ${shortDate(date)}\n${Number(date.slice(5, 7))} 月班表尚未發布。`;
  return `📅 ${label} ${shortDate(date)} 值班（${group}）\n${formatDuty(r.items)}`;
}

// ----------------------------------------------------
// Text commands (all answered by reply)
// ----------------------------------------------------
const DAY_COMMANDS = [
  { re: /^(今天|今日)(值班|班表|誰值班)?$|^誰值班$|^值班$/, offset: 0, label: '今天' },
  { re: /^(明天|明日)(值班|班表|誰值班)?$/, offset: 1, label: '明天' },
  { re: /^後天(值班|班表|誰值班)?$/, offset: 2, label: '後天' }
];

function linkHelp() {
  return `🔗 尚未綁定 MedBase。\n請在 MedBase 手機版「設定 → LINE 通知」按「綁定 LINE」，送出自動帶入的訊息即可。\n${MEDBASE_API_URL}/settings`;
}

/**
 * Handles MedBase commands. Returns the reply message, or null when `text`
 * is not a MedBase command (the caller then tries its own commands).
 */
export async function medbaseCommand(text, source) {
  if (!medbaseEnabled) return null;
  const userId = source.userId;

  const link = text.match(/^綁定\s+(\S+)$/);
  if (link) {
    if (source.type !== 'user') {
      return { type: 'text', text: '🔒 綁定碼等同你的身分，請改在與「醫院群組助手」的私訊中傳送，並不要轉傳。' };
    }
    try {
      const r = await callMedbase('redeem', { code: link[1] });
      db.medbase_links.upsert(userId, { his: r.his, name: r.name, group: r.group || DEFAULT_MEDBASE_GROUP });
      return { type: 'text', text: `✅ 已綁定 MedBase：${r.name}（${r.group || DEFAULT_MEDBASE_GROUP}）\n\n可以輸入「我的班」「明天值班」查詢，換班申請與回覆也會私訊通知你。` };
    } catch (error) {
      return { type: 'text', text: `❌ 綁定失敗：${error.message}` };
    }
  }

  if (text === '解除綁定') {
    const removed = userId && db.medbase_links.remove(userId);
    return { type: 'text', text: removed ? '已解除 MedBase 綁定，之後不會再收到換班通知。' : '你目前沒有綁定 MedBase。' };
  }

  if (/^(我的班|我的班表|我的值班)$/.test(text)) {
    const me = userId && db.medbase_links.get(userId);
    if (!me) return { type: 'text', text: linkHelp() };
    try {
      const from = todayInTaipei();
      const r = await callMedbase('person', { his: me.his, from, to: addDays(from, MY_SCHEDULE_DAYS - 1) });
      if (!r.found) return { type: 'text', text: '在 MedBase 排班名單中找不到你，請確認帳號仍為啟用狀態。' };
      const lines = r.days.map(d => `${shortDate(d.date)}  ${d.published ? (d.shift || '—') : '未發布'}`);
      return { type: 'text', text: `🗓 ${r.name} 接下來 ${MY_SCHEDULE_DAYS} 天\n${lines.join('\n')}\n\n完整班表：${MEDBASE_APP_URL}` };
    } catch (error) {
      return { type: 'text', text: `❌ 查詢班表失敗：${error.message}` };
    }
  }

  const day = DAY_COMMANDS.find(c => c.re.test(text));
  if (day) {
    // In a group: the MedBase group configured for it. In a DM: the asker's own group.
    const chatId = source.groupId || source.roomId;
    const group = chatId
      ? db.medbase_groups.get(chatId)?.medbase_group
      : userId && db.medbase_links.get(userId)?.medbase_group;
    if (!group) {
      return {
        type: 'text',
        text: chatId
          ? '⚙️ 這個群組還沒對應 MedBase 排班群組，請管理者到管理頁「MedBase 串接」設定。'
          : linkHelp()
      };
    }
    try {
      return { type: 'text', text: await dutyText(addDays(todayInTaipei(), day.offset), group, day.label) };
    } catch (error) {
      return { type: 'text', text: `❌ 查詢班表失敗：${error.message}` };
    }
  }

  return null;
}

// ----------------------------------------------------
// Swap notices pushed from medbase-mobile /api/swap
// ----------------------------------------------------
/** HMAC-SHA256 over `${timestamp}.${rawBody}`, as sent by medbase mobile/api/_lib/botNotify.ts. */
export function verifyNotifySignature(rawBody, timestamp, signature, now = Date.now()) {
  if (!MEDBASE_NOTIFY_SECRET || !timestamp || !signature) return false;
  if (Math.abs(now - Number(timestamp)) > NOTIFY_MAX_SKEW_MS) return false;
  const expected = crypto.createHmac('sha256', MEDBASE_NOTIFY_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pushes a notice to every LINE account linked to `toHis`; returns how many were sent. */
export async function deliverNotice({ toHis, text }, pushMessage) {
  const links = db.medbase_links.getByHis(String(toHis || '').trim());
  for (const link of links) {
    await pushMessage(link.line_user_id, { type: 'text', text });
  }
  return links.length;
}

// ----------------------------------------------------
// Scheduled jobs
// ----------------------------------------------------
/** Pushes tomorrow's duty to each group whose reminder time has come (once a day). */
export async function sendDueReminders(pushMessage, now = new Date()) {
  if (!medbaseEnabled) return;
  const today = todayInTaipei();
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  for (const g of db.medbase_groups.getAll()) {
    if (!g.remind_enabled || g.last_reminded === today || hhmm < g.remind_time) continue;
    // Mark first: a failure must not turn into a push every minute.
    db.medbase_groups.markReminded(g.line_group_id, today);
    try {
      const text = await dutyText(addDays(today, 1), g.medbase_group, '明天');
      await pushMessage(g.line_group_id, { type: 'text', text });
      console.log(`[MedBase] reminder sent to ${g.group_name || g.line_group_id}`);
    } catch (error) {
      console.error(`[MedBase] reminder for ${g.line_group_id} failed:`, error.message);
    }
  }
}

/**
 * Detects newly published / updated schedules for this and next month by
 * comparing sheet versions. The first check of a group only records a baseline.
 */
export async function checkPublished(pushMessage) {
  if (!medbaseEnabled) return;
  const thisYm = todayInTaipei().slice(0, 7).replace('-', '');
  const nextYm = addDays(`${todayInTaipei().slice(0, 7)}-28`, 7).slice(0, 7).replace('-', '');
  const watched = [thisYm, nextYm].map(ym => `Schedule_${ym}`);

  const versionsByGroup = new Map();
  for (const g of db.medbase_groups.getAll()) {
    if (!g.notify_publish) continue;
    try {
      if (!versionsByGroup.has(g.medbase_group)) {
        versionsByGroup.set(g.medbase_group, (await callMedbase('versions', { group: g.medbase_group })).sheets || {});
      }
      const sheets = versionsByGroup.get(g.medbase_group);
      const current = Object.fromEntries(watched.filter(k => sheets[k]).map(k => [k, sheets[k]]));
      const baseline = Object.keys(g.last_versions).length === 0;
      const changed = watched.filter(k => current[k] && current[k] !== g.last_versions[k]);
      db.medbase_groups.setVersions(g.line_group_id, current);
      if (baseline || !changed.length) continue;

      const months = changed.map(k => {
        const ym = k.slice(-6);
        return `${Number(ym.slice(4))} 月${g.last_versions[k] ? '班表已更新' : '班表已發布'}`;
      });
      await pushMessage(g.line_group_id, { type: 'text', text: `📢 ${months.join('、')}（${g.medbase_group}）\n查看：${MEDBASE_APP_URL}` });
      console.log(`[MedBase] publish notice sent to ${g.group_name || g.line_group_id}: ${changed.join(', ')}`);
    } catch (error) {
      console.error(`[MedBase] publish check for ${g.line_group_id} failed:`, error.message);
    }
  }
}
