import dotenv from 'dotenv';
import { generateStructured, hasActiveProvider, getActiveProviders } from './aiProvider.js';

dotenv.config();

// Log the active provider chain once at startup for observability.
const _active = getActiveProviders();
if (_active.length > 0) {
  console.log(`AI Engine: active providers (primary → fallback): ${_active.map(p => p.name).join(' → ')}`);
} else {
  console.log('AI Engine: no AI provider configured. Running in MOCK OCR mode.');
}

// ----------------------------------------------------
// Prompts (shared across providers)
// ----------------------------------------------------
const CASE_IMAGE_PROMPT = `You are a clinical ward coordinator assistant. Analyze this uploaded image and classify its primary content type.
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

const MULTI_IMAGE_PROMPT = `You are a clinical ward coordinator assistant. Read these consecutive images (slides, boards, or notes) from a morning meeting or ward briefing.
Understand the logical flow between them, remove duplicated text, and consolidate all the key announcements into a single, cohesive, and well-structured ward note.

Return the consolidated result as a JSON object containing:
- type: "WARD_NOTE"
- notes: Array of objects. Since these are parts of the same meeting/topic, you should merge them into 1 or 2 high-level notes. Each object must have:
  - "title": String. E.g., "晨會公告", "晨會宣導事項" or a specific category.
  - "content": String. The detailed bulleted list of all summarized points from all the slides/images combined. Keep it in Traditional Chinese.`;

/**
 * Analyzes uploaded image buffer, classifies its content type, and extracts case table data or ward notes.
 * @param {Buffer} imageBuffer - The image buffer of the uploaded file.
 * @returns {Promise<{type: string, doctors: string[], departments: string[], date: string|null, notes: Array<{title: string, content: string}>, events: Array<object>}>}
 */
export async function analyzeCaseImage(imageBuffer) {
  // If no provider is configured, return a preconfigured mock result for testing
  if (!hasActiveProvider()) {
    console.log('AI Engine [MOCK]: Simulating OCR extraction on uploaded image...');
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Get today's date in YYYY/MM/DD Taiwan format to simulate a correct upload
    const now = new Date();
    const tzOffset = 8 * 60 * 60 * 1000;
    const todayStr = new Date(now.getTime() + tzOffset).toISOString().split('T')[0].replace(/-/g, '/');
    const todayDashStr = new Date(now.getTime() + tzOffset).toISOString().split('T')[0];

    // For testing: determine mock type based on buffer length mod 3
    const mockTypeIdx = imageBuffer.length % 3;

    if (mockTypeIdx === 0) {
      console.log('AI Engine [MOCK]: Simulating CALENDAR extraction...');
      return {
        type: "CALENDAR",
        doctors: [],
        departments: [],
        date: null,
        notes: [],
        events: [
          {
            title: "週四晨會報告輪序",
            date: todayDashStr,
            time: "08:00",
            location: "第二會議室",
            description: "陳鍾沛醫師及黃郁芳專科護理師報告"
          }
        ]
      };
    } else if (mockTypeIdx === 1) {
      console.log('AI Engine [MOCK]: Simulating WARD_NOTE extraction...');
      return {
        type: "WARD_NOTE",
        doctors: [],
        departments: [],
        date: null,
        notes: [
          {
            title: "藥物",
            content: "病房今日新增管制藥品備量，請各班同仁交班時務必確實清點並登記。"
          },
          {
            title: "會診",
            content: "泌尿科 URO 今日下午 14:00 有緊急會診，請值班護理師協助聯繫備妥病歷。"
          }
        ],
        events: []
      };
    } else {
      console.log('AI Engine [MOCK]: Simulating CASE_TABLE extraction...');
      // Default mock response: includes direct mapped doctor "陳鍾沛" and flexible department "URO"
      return {
        type: "CASE_TABLE",
        doctors: ["陳鍾沛"],
        departments: ["URO"],
        date: todayStr,
        notes: [],
        events: []
      };
    }
  }

  try {
    const text = await generateStructured({
      imageBuffers: [imageBuffer],
      prompt: CASE_IMAGE_PROMPT
    });
    console.log('AI Engine [RAW RESPONSE]:', text);

    const parsed = JSON.parse(text);
    return {
      type: parsed.type || "UNKNOWN",
      doctors: Array.isArray(parsed.doctors) ? parsed.doctors : [],
      departments: Array.isArray(parsed.departments) ? parsed.departments : [],
      date: parsed.date || null,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch (error) {
    console.error('AI Engine [ERROR]: Failed to analyze image:', error);
    throw new Error(`AI 辨識失敗: ${error.message}`);
  }
}

/**
 * Consolidates and analyzes multiple consecutive ward/briefing images.
 * @param {Buffer[]} imageBuffers - Array of image buffers to process.
 * @returns {Promise<{type: string, notes: Array<{title: string, content: string}>}>}
 */
export async function analyzeMultipleImages(imageBuffers) {
  if (!hasActiveProvider()) {
    console.log(`AI Engine [MOCK]: Simulating consolidation of ${imageBuffers.length} images...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    return {
      type: "WARD_NOTE",
      notes: [
        {
          title: "晨會公告",
          content: `【晨會公告整併結果（共 ${imageBuffers.length} 張簡報）】\n1. 病房清消：明日 09:00 起進行全區大掃除，請各床護理師協助備妥清消用具。\n2. 會診規範：即日起非緊急會診請於 17:00 前送出，逾時件將延至隔日處理。`
        }
      ]
    };
  }

  try {
    const text = await generateStructured({
      imageBuffers,
      prompt: MULTI_IMAGE_PROMPT
    });
    console.log('AI Engine [RAW BATCH RESPONSE]:', text);

    const parsed = JSON.parse(text);
    return {
      type: parsed.type || "WARD_NOTE",
      notes: Array.isArray(parsed.notes) ? parsed.notes : []
    };
  } catch (error) {
    console.error('AI Engine [MULTI-ERROR]: Failed to analyze batch images:', error);
    throw new Error(`多圖整併辨識失敗: ${error.message}`);
  }
}
