/**
 * Prompts, split by stage.
 *
 * The previous single prompt asked the model to pick one of four types AND
 * apply one of three extraction schemas in the same pass, in ~600 tokens of
 * English instructions. A 4B model follows that unreliably: it tends to get
 * the type right but then fill in fields belonging to a different type. Each
 * stage below therefore does exactly one job with a short instruction.
 */

export const CLASSIFY_PROMPT = `Classify this photograph into exactly one type.

CASE_TABLE - a duty/case assignment grid, often a photo of an Excel sheet, with doctor names arranged in rows or columns.
WARD_NOTE  - a memo, announcement, bulletin, projected slide or list of clinical instructions.
CALENDAR   - a schedule of meetings, lectures or duty shifts, where rows carry dates.
UNKNOWN    - anything else.

Answer with the type only.`;

/**
 * The hard part of a real case table: below the daily assignment block there is
 * usually a full departmental roster (PS / ortho / URO / CVS / CS ...) listing
 * every doctor of each department. Those people are NOT on duty today, and
 * pulling them in makes the bot forward the table to practically every group.
 */
export const CASE_TABLE_PROMPT = `This is a hospital daily case assignment table.

Extract ONLY the doctors listed in the daily assignment rows at the top of the table -- the rows that represent today's actual case allocation.

CRITICAL: Ignore the departmental name roster usually printed at the bottom of the sheet (columns headed PS, ortho, URO, CVS, CS, ENT, OPH, NS and similar, each listing every doctor of that department). Those are reference lists, not today's assignments. If you are unsure whether a name belongs to the daily rows or to the bottom roster, leave it out.

For each doctor on duty, return their name exactly as printed and the department code shown on the same row (e.g. Uro, ortho, PS). If no department is shown for that row, use an empty string.

Also return the date printed on the table, normalised to YYYY/MM/DD. Convert ROC years (民國) to AD: 115 -> 2026. If there is no date, return an empty string.`;

export const WARD_NOTE_PROMPT = `This is a ward announcement, memo or briefing slide.

Extract every distinct announcement as a separate note. For each one:
- title: use one of 會診 / 藥物 / 手術 / 檢查 when it clearly fits, otherwise a short custom title of 2-6 characters.
- content: the complete instruction, kept in Traditional Chinese, with the original meaning and any dates, times, bed numbers or drug names preserved verbatim.`;

export const CALENDAR_PROMPT = `This is a schedule of meetings, lectures, reports or duty shifts.

Extract every scheduled item. For each one:
- title: the name of the meeting, class or report. If a presenter is named, keep the name in the title.
- date: YYYY-MM-DD. Convert ROC years (民國) to AD: 115 -> 2026.
- time: HH:MM in 24-hour form, or an empty string if not stated.
- location: the room, or an empty string.
- description: presenters, departments or topic details, or an empty string.

Handwritten annotations on a printed schedule are real data -- include them.`;

/** Map step: one image at a time, cheap prose output. */
export const IMAGE_DIGEST_PROMPT = `This is one slide or page from a morning meeting or ward briefing.

Summarise everything it announces in Traditional Chinese, as a plain bulleted list. Preserve dates, times, bed numbers, drug names and department codes verbatim. Do not add anything that is not shown.`;

/** Reduce step: text only, no images -- cheap even on a 2-core box. */
export function buildMergePrompt(digests) {
  const sections = digests
    .map((digest, index) => `【第 ${index + 1} 張】\n${digest}`)
    .join('\n\n');

  return `以下是同一場晨會／交班中連續多張照片各自的內容摘要。

${sections}

請理解它們之間的邏輯順序，移除重複的敘述，整併成 1 到 2 則結構清楚的病房公告。每一則需要：
- title：例如「晨會公告」「晨會宣導事項」，或更貼切的分類名稱。
- content：合併後的完整條列內容，使用繁體中文，保留所有日期、時間、床號、藥名與科別代號。

不要加入照片中沒有出現的資訊。`;
}
