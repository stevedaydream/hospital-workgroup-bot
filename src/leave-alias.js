import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { getAttendingRoster } from './medbase.js';

const PAGE_SIZE = 6;
const action = (token, operation) => 'leavealias:' + JSON.stringify({ token, ...operation });

export function leaveRegistrationReply(result, trip, travelUrl) {
  if (result.status === 'duplicate') return { silent: true };
  const t = result.registration;
  const alias = result.status !== 'overlap' && trip.deputy && trip.deputy !== t.deputy ? `（${trip.deputy}）` : '';
  const link = travelUrl + (travelUrl.includes('?') ? '&' : '?') + `edit=${t.id}`;
  const heading = result.status === 'created' ? '已自動登記休假' : result.status === 'exists' ? '已有相同休假登記，未重複新增' : '已有重疊休假，未新增或覆寫，請確認原登記';
  return { type: 'text', text: `${heading}\n${t.traveler}｜${t.depart_date}～${t.return_date}｜${t.leave_period}${t.deputy ? `\n代理／代看：${t.deputy}${alias}` : ''}\n查看／修改：\n${link}` };
}

export function leaveAliasMenu(pending, page = 0) {
  const pages = Math.ceil(pending.choices.length / PAGE_SIZE);
  if (!Number.isInteger(page) || page < 0 || page >= pages) return { type: 'text', text: '頁碼無效，請使用原選單的翻頁按鈕。' };
  const buttons = pending.choices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((choice, i) => ({
    type: 'button', style: 'secondary', height: 'sm',
    action: { type: 'postback', label: `${choice.name}｜${choice.department || '未分科'}`.slice(0, 40), data: action(pending.token, { select: page * PAGE_SIZE + i }) }
  }));
  const footer = [];
  if (page > 0) footer.push({ type: 'button', height: 'sm', action: { type: 'postback', label: '上一頁', data: action(pending.token, { page: page - 1 }) } });
  if (page + 1 < pages) footer.push({ type: 'button', height: 'sm', action: { type: 'postback', label: '下一頁', data: action(pending.token, { page: page + 1 }) } });
  footer.push({ type: 'button', height: 'sm', action: { type: 'postback', label: '取消這次登記', data: action(pending.token, { select: 'cancel' }) } });
  return { type: 'flex', altText: `請選擇「${pending.trip.deputy}」對應的正式姓名`, contents: {
    type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: `「${pending.trip.deputy}」是哪位醫師？`, weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: `尚未登記休假。請原公告發送者選擇正式姓名，確認後記住此群組的代稱。第 ${page + 1}/${pages} 頁，24 小時內有效。`, size: 'sm', wrap: true },
      ...buttons
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer }
  } };
}

/** Unknown deputies require an explicit choice before writing any leave entry. */
export async function prepareLeaveAlias(trip, meta, travelUrl) {
  if (db.travels.importedMessage(meta.messageId) || db.pending_leave_aliases.forMessage(meta.messageId)) return { silent: true };
  if (!trip.deputy || db.person_aliases.resolve(trip.deputy, meta.sourceId) !== trip.deputy) return null;
  let doctors;
  try { doctors = await getAttendingRoster(); } catch {
    return { type: 'text', text: `尚未登記休假：目前無法載入 MedBase 醫師名單以確認「${trip.deputy}」。請稍後重新傳送公告，或使用登記頁：\n${travelUrl}` };
  }
  const counts = new Map();
  doctors.forEach(d => counts.set(d.name, (counts.get(d.name) || 0) + 1));
  if (counts.get(trip.deputy) === 1) return null;
  if (counts.get(trip.deputy) > 1) return { type: 'text', text: `尚未登記休假：「${trip.deputy}」在不同科別有同名資料，請先確認人員並使用登記頁。\n${travelUrl}` };
  const hint = trip.deputy.replace(/^(老|小|大)/, '').slice(0, 1);
  const choices = doctors.filter(d => d.name.length <= 30 && counts.get(d.name) === 1)
    .sort((a, b) => Number(b.name.startsWith(hint)) - Number(a.name.startsWith(hint)));
  if (!choices.length) return { type: 'text', text: `尚未登記休假：MedBase 沒有可選的主治醫師，請先確認通訊錄名單或手動登記。\n${travelUrl}` };
  const pending = db.pending_leave_aliases.create(randomBytes(12).toString('hex'), trip, choices, meta);
  return pending ? leaveAliasMenu(pending) : { silent: true };
}

export function leaveAliasPostback(data, source, travelUrl) {
  let request;
  try { request = JSON.parse(data.slice('leavealias:'.length)); } catch { return { type: 'text', text: '代稱選單無效，請重新傳送休假公告。' }; }
  if (!request || typeof request.token !== 'string') return { type: 'text', text: '代稱選單無效，請重新傳送休假公告。' };
  const pending = db.pending_leave_aliases.get(request.token);
  if (!pending || pending.expires_at < Date.now() || pending.status !== 'pending') return { type: 'text', text: '這份選單已處理或過期，請查看原登記或重新傳送公告。' };
  if (source.type !== 'group' || pending.source_group_id !== source.groupId || pending.source_user_id !== source.userId) return { type: 'text', text: '僅原公告發送者可在原群組確認這個代稱。' };
  if (Object.hasOwn(request, 'page')) return leaveAliasMenu(pending, request.page);
  const result = db.pending_leave_aliases.confirm(request.token, source.groupId, source.userId, request.select);
  if (result.error) return { type: 'text', text: result.error };
  if (result.cancelled) return { type: 'text', text: '已取消這次登記，沒有記錄代稱或新增休假。' };
  return leaveRegistrationReply(result.result, result.trip, travelUrl);
}
