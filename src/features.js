import { db } from './db.js';

// Every bot feature that can be switched per LINE group on the admin page.
//
// A group without its own setting follows the '*' (default) row, and without
// that the feature's `defaultOn`. Features under development are declared with
// `defaultOn: false`: they stay off in every working group and are switched on
// only in a test group, so they can be tried on the live bot without anyone
// else seeing them. Once ready, flip `defaultOn` (or the '*' row) to roll out.
//
// Rooms and 1:1 chats are not configurable; only groups (C...) and rooms (R...)
// are, and everything is on in a 1:1 chat.
export const FEATURES = [
  { key: 'menu', label: '選單／主選單', hint: '「選單」「主選單」「說明」等指令', defaultOn: true },
  { key: 'image_ai', label: '照片 AI 辨識', hint: '傳圖後選新增公告、連續圖片公告或辨識 Case 表／行程；未點選不處理；含「取消今日轉發」', defaultOn: true },
  { key: 'dispatch', label: '接收 Case 分配表轉發', hint: '每日 07:30 推播分配表到此群組；含「取消轉發」', defaultOn: true },
  { key: 'calendar', label: '行事曆', hint: '「行事曆」「今日行程」「明日行程」', defaultOn: true },
  { key: 'notes', label: '注意事項', hint: '「編輯筆記」連結與選單按鈕', defaultOn: true },
  { key: 'travel', label: '休假／出國', hint: '「休假」「出國」查詢與登記連結', defaultOn: true },
  { key: 'leave_autoreg', label: '群組休假訊息自動登記', hint: '辨識「姓名 11/4-11/8 請假，代理人代看」並回覆登記結果', defaultOn: false },
  { key: 'duty', label: '值班查詢（MedBase）', hint: '「近期值班」「今天值班」「明天值班」', defaultOn: true },
  { key: 'my_schedule', label: '我的班（MedBase）', hint: '在群組輸入「我的班」改以私訊回覆', defaultOn: true },
  { key: 'medbase_lookup', label: 'MedBase 功能查詢', hint: '「自費 關鍵字」私訊查詢與複製；「MedBase 查詢」功能入口', defaultOn: true },
  { key: 'report_reminder', label: '晨會報告提醒', hint: '報告前 28／7／1 天推播提醒到此群組', defaultOn: true }
];

const FEATURE_KEYS = new Set(FEATURES.map(f => f.key));
const DEFAULT_ON = Object.fromEntries(FEATURES.map(f => [f.key, f.defaultOn]));

export const isFeatureKey = (key) => FEATURE_KEYS.has(key);

export const disabledFeatureMessage = feature => ({ type: 'text', text: `${FEATURES.find(f => f.key === feature)?.label || feature}功能目前開發測試中...` });

const isConfigurable = (sourceId) => typeof sourceId === 'string' && /^[CR]/.test(sourceId);

/** Whether `feature` is on for a LINE source (group, room or user ID). */
export function featureEnabled(sourceId, feature) {
  if (!isConfigurable(sourceId)) return true;
  return db.group_features.lookup(sourceId, feature) ?? DEFAULT_ON[feature] ?? true;
}

/** The effective switches for a group: its own, then '*', then each feature's default. */
export function effectiveFeatures(lineGroupId) {
  const defaults = { ...DEFAULT_ON, ...db.group_features.get('*') };
  return lineGroupId === '*' ? defaults : { ...defaults, ...db.group_features.get(lineGroupId) };
}
