// Prompts and result normalisation shared by every AI provider, so Strata and
// Gemini are asked the same question and return the same shape.

export const SINGLE_IMAGE_PROMPT = `You are a clinical ward coordinator assistant. Analyze this uploaded image and classify its primary content type.
Choose one of the following types:
- "CASE_TABLE": A table, grid, spreadsheet, or list showing patient cases assigned to doctors, surgery schedules, or ward duties.
- "WARD_NOTE": A memo, notice, bulleted list of warnings, clinical instructions, announcement, or general guidelines.
- "CALENDAR": A schedule of meetings, reporting schedules, duty shifts, academic lectures, or activities that contain specific dates and event descriptions.
- "UNKNOWN": Any other image type.

Based on the type, extract the following information in JSON format:

For "CASE_TABLE":
1. "doctors": Array of Doctor Names (e.g., 陳鍾沛, 王彥傑, 王世峰, etc. - extract only the names).
2. "departments": Array of Department Codes (e.g. URO, ORTHO, etc.).
3. "date": The date of the case table (e.g. 5/28, 2026/05/28, 115/05/28. Normalize to YYYY/MM/DD. Convert ROC calendar to AD year, e.g. 115 -> 2026. If no date is found, return null).

For "WARD_NOTE":
1. "notes": Array of objects representing notes/announcements found in the image. Each object must have:
   - "title": String. Choose one of the standard category titles: "會診", "藥物", "手術", "檢查" if it matches well. Otherwise, provide a short custom title (2-6 words, e.g., "交班注意事項", "病房清消").
   - "content": String. The complete instruction or warning details extracted from the image. Keep paragraphs intact.

For "CALENDAR":
1. "events": Array of objects representing calendar schedule items detected in the image. Each object must have:
   - "title": String. The name/title of the meeting, class, report, or event.
   - "date": String. The date of the event formatted as YYYY-MM-DD. Convert ROC years if needed.
   - "time": String or null. The start time formatted as HH:MM (24-hour). If not specified, return null.
   - "location": String or null. The room or location if specified.
   - "description": String or null. Any additional details (such as presenters' names like "陳鍾沛醫師及黃郁芳專科護理師報告" or topic descriptions).

Return the result as a JSON object containing:
- type: "CASE_TABLE" | "WARD_NOTE" | "CALENDAR" | "UNKNOWN"
- doctors: Array of strings (only if type is CASE_TABLE, else empty array)
- departments: Array of strings (only if type is CASE_TABLE, else empty array)
- date: String or null (only if type is CASE_TABLE, else null)
- notes: Array of objects (only if type is WARD_NOTE, else empty array)
- events: Array of objects (only if type is CALENDAR, else empty array)`;

export const MULTI_IMAGE_PROMPT = `You are a clinical ward coordinator assistant. Read these consecutive images (slides, boards, or notes) from a morning meeting or ward briefing.
Understand the logical flow between them, remove duplicated text, and consolidate all the key announcements into a single, cohesive, and well-structured ward note.

Return the consolidated result as a JSON object containing:
- type: "WARD_NOTE"
- notes: Array of objects. Since these are parts of the same meeting/topic, you should merge them into 1 or 2 high-level notes. Each object must have:
  - "title": String. E.g., "晨會公告", "晨會宣導事項" or a specific category.
  - "content": String. The detailed bulleted list of all summarized points from all the slides/images combined. Keep it in Traditional Chinese.`;

export function normalizeSingleResult(parsed) {
  return {
    type: parsed.type || "UNKNOWN",
    doctors: Array.isArray(parsed.doctors) ? parsed.doctors : [],
    departments: Array.isArray(parsed.departments) ? parsed.departments : [],
    date: parsed.date || null,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    events: Array.isArray(parsed.events) ? parsed.events : []
  };
}

export function normalizeMultiResult(parsed) {
  return {
    type: parsed.type || "WARD_NOTE",
    notes: Array.isArray(parsed.notes) ? parsed.notes : []
  };
}

// Doctor roster import (admin page). Only names and section headers: which
// LINE group each doctor goes to is decided by a person, never by the model.
export const ROSTER_PROMPT = `You are reading a photo of a hospital roster: a list or table of doctors grouped under department / section headers (e.g. PS, Ortho, URO, CVS, CS, GS, ENT, OPH, NS).
Extract every doctor's name exactly as written (Traditional Chinese characters, do not translate or romanise), together with the department header the name appears under.
Rules:
- One entry per person; if the same name appears under several departments, keep the first.
- Skip column headers, ward/bed numbers, phone extensions, dates and shift labels.
- If a name has no visible department, use null.
- Department codes keep the spelling shown in the photo (e.g. "Ortho", "URO").

Return a JSON object: {"doctors": [{"name": "陳鍾沛", "department": "Ortho"}, ...]}`;

export function normalizeRosterResult(parsed) {
  const seen = new Set();
  const doctors = [];
  for (const d of Array.isArray(parsed.doctors) ? parsed.doctors : []) {
    const name = typeof d?.name === 'string' ? d.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const department = typeof d.department === 'string' && d.department.trim() ? d.department.trim() : null;
    doctors.push({ name, department });
  }
  return { doctors };
}
