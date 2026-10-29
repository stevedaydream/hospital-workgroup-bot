import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { SINGLE_IMAGE_PROMPT, MULTI_IMAGE_PROMPT, normalizeSingleResult, normalizeMultiResult } from './prompts.js';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash';

let ai = null;
if (GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('placeholder')) {
  try {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log(`AI Engine: Initialized Google GenAI with model ${GEMINI_MODEL_NAME}`);
  } catch (error) {
    console.error('AI Engine: Failed to initialize Google GenAI client:', error.message);
  }
} else {
  console.log('AI Engine: GEMINI_API_KEY is placeholder or not configured. Running in MOCK OCR mode.');
}

export const geminiMockMode = !ai;

/**
 * Analyzes uploaded image buffer, classifies its content type, and extracts case table data or ward notes.
 * @param {Buffer} imageBuffer - The image buffer of the uploaded file.
 * @returns {Promise<{type: string, doctors: string[], departments: string[], date: string|null, notes: Array<{title: string, content: string}>}>}
 */
export async function analyzeCaseImage(imageBuffer) {
  // If running in Mock Mode, return a preconfigured result for testing
  if (!ai) {
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
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_NAME,
      contents: [
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/jpeg'
          }
        },
        SINGLE_IMAGE_PROMPT
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const text = response.text;
    console.log('AI Engine [RAW RESPONSE]:', text);
    
    return normalizeSingleResult(JSON.parse(text));
  } catch (error) {
    console.error('AI Engine [ERROR]: Failed to analyze image with Gemini:', error);
    throw new Error(`Gemini AI 辨識失敗: ${error.message}`);
  }
}

/**
 * Consolidates and analyzes multiple consecutive ward/briefing images using Gemini.
 * @param {Buffer[]} imageBuffers - Array of image buffers to process.
 * @returns {Promise<{type: string, notes: Array<{title: string, content: string}>}>}
 */
export async function analyzeMultipleImages(imageBuffers) {
  if (!ai) {
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
    // Map buffers into inlineData parts for Gemini multimodel input
    const contents = imageBuffers.map(buffer => ({
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: 'image/jpeg'
      }
    }));

    // Append prompt instructions
    contents.push(MULTI_IMAGE_PROMPT);

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_NAME,
      contents: contents,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const text = response.text;
    console.log('AI Engine [RAW BATCH RESPONSE]:', text);
    return normalizeMultiResult(JSON.parse(text));
  } catch (error) {
    console.error('AI Engine [MULTI-ERROR]: Failed to analyze batch images:', error);
    throw new Error(`多圖整併辨識失敗: ${error.message}`);
  }
}
