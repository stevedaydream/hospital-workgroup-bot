import { parseTravel } from './travel.js';
import { daysBetween } from './util/date.js';

const DATE = '(?:20\\d{2}[年/-])?\\d{1,2}[月/-]\\d{1,2}日?';
const NAME = '(?:NP\\s*)?[\\p{Script=Han}]{2,4}(?:醫師|\\s*NP)?';
const PATTERN = new RegExp(`^(${NAME})\\s*(${DATE})(?:\\s*(?:-|~|～|至|到|—)\\s*(${DATE}))?\\s*(全天|全日|上午|下午)?\\s*(?:請假|休假)\\s*(全天|全日|上午|下午)?[，,、\\s]*(.*?)\\s*[。！!]?\\s*$`, 'iu');

/** Accept only a complete announcement, never infer from questions or conversation. */
export function parseLeaveMessage(text, today) {
  if (typeof text !== 'string' || text.length > 200 || /取消|更正|改期|改成|不請假|不休假|請問|聽說|如果|預計|打算|可能|嗎|？|\?|轉傳|轉貼/.test(text)) return null;
  const match = text.trim().match(PATTERN);
  if (!match) return null;
  const [, rawName, startText, endText, beforePeriod, afterPeriod, rawTail] = match;
  const name = rawName.replace(/^NP\s*|醫師$|\s*NP$/giu, '').trim();
  if (name.length < 2 || /^(大家|全員|全科|同仁|同事|本人|我們|有人|主任|學長|學姐|今天|明天)$/.test(name)) return null;
  if (beforePeriod && afterPeriod && beforePeriod !== afterPeriod) return { error: '休假時段不一致，請分筆登記。' };
  const tail = rawTail.replace(/[。！!]$/, '').trim();
  let deputy = null;
  if (tail) {
    const proxy = tail.match(/^(?:由)?([\p{Script=Han}]{2,8}(?:\s*NP)?)(?:代看|代理|代班)$/iu)
      || tail.match(/^(?:代理人?|代看)[：:\s]*([\p{Script=Han}]{2,8}(?:\s*NP)?)$/iu);
    if (!proxy) return null;
    deputy = proxy[1].trim();
  }
  const parts = value => value.replace(/[年月]/g, '/').replace(/日$/, '').split(/[/-]/).map(Number);
  const start = parts(startText);
  const explicitYear = start.length === 3;
  const year = explicitYear ? start[0] : Number(today.slice(0, 4));
  const sm = start[start.length - 2], sd = start[start.length - 1];
  const end = endText ? parts(endText) : start;
  const em = end[end.length - 2], ed = end[end.length - 1];
  let endYear = end.length === 3 ? end[0] : year;
  if (endText && end.length === 2 && sm >= 11 && em <= 2 && em < sm) endYear++;
  const date = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const departDate = date(year, sm, sd), returnDate = date(endYear, em, ed);
  const period = beforePeriod || afterPeriod || '全天';
  const result = parseTravel({
    kind: '休假', traveler: name,
    departDate, returnDate, leavePeriod: period === '全日' ? '全天' : period, deputy,
    note: '由 LINE 群組訊息自動登記'
  });
  if (result.error) return { error: result.error + '，請使用「姓名 YYYY/M/D-YYYY/M/D 請假，代理人代看」。' };
  if (!explicitYear && daysBetween(departDate, today) > 30) return { error: '未填年份且日期已過，請補上西元年份再傳一次。' };
  return result;
}
