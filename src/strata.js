import dotenv from 'dotenv';
import { SINGLE_IMAGE_PROMPT, MULTI_IMAGE_PROMPT, normalizeSingleResult, normalizeMultiResult } from './prompts.js';

dotenv.config();

// Strata runs on the home PC and speaks the OpenAI chat-completions API. The
// server reaches it over Tailscale (`tailscale serve` on the PC), so the URL is
// a *.ts.net address that only resolves inside the tailnet.
const STRATA_BASE_URL = (process.env.STRATA_BASE_URL || '').replace(/\/+$/, '');
const STRATA_MODEL = process.env.STRATA_MODEL || '';
const STRATA_API_KEY = process.env.STRATA_API_KEY || '';
// A single image takes ~20-30s on the PC; reasoning models can run much longer
// on dense tables, so the default leaves plenty of room before falling back.
const STRATA_TIMEOUT_MS = Number(process.env.STRATA_TIMEOUT_MS) || 240000;

export const strataEnabled = Boolean(STRATA_BASE_URL);

if (strataEnabled) {
  console.log(`AI Engine: Strata enabled at ${STRATA_BASE_URL}${STRATA_MODEL ? ` (model ${STRATA_MODEL})` : ''}`);
}

async function chatJson(imageBuffers, prompt) {
  const content = imageBuffers.map(buffer => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
  }));
  content.push({ type: 'text', text: prompt });

  const body = {
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    temperature: 0
  };
  if (STRATA_MODEL) body.model = STRATA_MODEL;

  const headers = { 'Content-Type': 'application/json' };
  if (STRATA_API_KEY) headers.Authorization = `Bearer ${STRATA_API_KEY}`;

  const res = await fetch(`${STRATA_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STRATA_TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Strata 回傳內容為空');
  console.log('AI Engine [STRATA RAW RESPONSE]:', text);

  // json_object mode should give bare JSON, but tolerate a ```json fence.
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

/**
 * Same contract as gemini.js analyzeCaseImage, executed on the home PC.
 * @param {Buffer} imageBuffer
 */
export async function analyzeCaseImage(imageBuffer) {
  return normalizeSingleResult(await chatJson([imageBuffer], SINGLE_IMAGE_PROMPT));
}

/**
 * Same contract as gemini.js analyzeMultipleImages, executed on the home PC.
 * @param {Buffer[]} imageBuffers
 */
export async function analyzeMultipleImages(imageBuffers) {
  return normalizeMultiResult(await chatJson(imageBuffers, MULTI_IMAGE_PROMPT));
}
