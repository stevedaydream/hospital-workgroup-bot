/**
 * Cloud inference via Google Gemini.
 *
 * Phase 1 used this as the only engine. It is now the automatic fallback for
 * when local inference fails -- and, as decided, a fallback that announces
 * itself in the group, because it means the photograph left the building.
 */

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash';

let client = null;
if (GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('placeholder')) {
  try {
    client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log(`AI Engine: Gemini fallback ready (${GEMINI_MODEL_NAME}).`);
  } catch (error) {
    console.error('AI Engine: Failed to initialise Gemini client:', error.message);
  }
} else {
  console.log('AI Engine: GEMINI_API_KEY not configured -- cloud fallback is unavailable.');
}

export const name = 'gemini';

export async function isAvailable() {
  return client !== null;
}

/**
 * Mirrors the local provider's signature so the orchestrator can swap them.
 * @param {{prompt: string, images?: string[], schema?: object}} request
 */
export async function complete({ prompt, images = [], schema }) {
  if (!client) {
    throw new Error('Gemini 未設定 API Key，無法作為備援。');
  }

  const startedAt = Date.now();
  const contents = images.map((base64) => ({
    inlineData: { data: base64, mimeType: 'image/jpeg' }
  }));

  contents.push(
    schema
      ? `${prompt}\n\nReturn a JSON object matching exactly this schema:\n${JSON.stringify(schema)}`
      : prompt
  );

  const response = await client.models.generateContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: schema ? { responseMimeType: 'application/json' } : {}
  });

  const text = response.text ?? '';
  const elapsedMs = Date.now() - startedAt;
  console.log(`[AI:gemini] completed in ${(elapsedMs / 1000).toFixed(1)}s (${images.length} image(s))`);

  if (!schema) return { text, elapsedMs };

  try {
    return { data: JSON.parse(text), elapsedMs };
  } catch {
    throw new Error(`Gemini 輸出不是合法 JSON：${text.slice(0, 200)}`);
  }
}
