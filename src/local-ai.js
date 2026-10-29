import dotenv from 'dotenv';
import { SINGLE_IMAGE_PROMPT, MULTI_IMAGE_PROMPT, normalizeSingleResult, normalizeMultiResult } from './prompts.js';

dotenv.config();

// Local models on this PC, reached through the Local AI Gateway
// (C:\AI\gateway, OpenAI-compatible). Models are tried in order: Strata
// (`local`) normally, and Qwen3.6 when Strata cannot start for lack of VRAM --
// the two share the GPUs and never run together. A model whose provider is
// stopped is rejected by the gateway within seconds, so walking the list is cheap.
const LOCAL_AI_BASE_URL = (process.env.LOCAL_AI_BASE_URL || '').replace(/\/+$/, '');
const LOCAL_AI_MODELS = (process.env.LOCAL_AI_MODELS || 'local,qwen3.6')
  .split(',').map(m => m.trim()).filter(Boolean);
const LOCAL_AI_API_KEY = process.env.LOCAL_AI_API_KEY || '';
// A single image takes ~20-35s; reasoning models can run much longer on dense
// tables, so each model gets plenty of room before the next one is tried.
const LOCAL_AI_TIMEOUT_MS = Number(process.env.LOCAL_AI_TIMEOUT_MS) || 240000;

export const localAiEnabled = Boolean(LOCAL_AI_BASE_URL);

if (localAiEnabled) {
  console.log(`AI Engine: Local AI at ${LOCAL_AI_BASE_URL}, models in order: ${LOCAL_AI_MODELS.join(' → ')}`);
}

const MODEL_LABELS = { local: 'Strata', 'qwen3.6': 'Qwen3.6' };
export const modelLabel = model => MODEL_LABELS[model] || model;

async function chatJson(model, imageBuffers, prompt) {
  const content = imageBuffers.map(buffer => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
  }));
  content.push({ type: 'text', text: prompt });

  const headers = { 'Content-Type': 'application/json' };
  if (LOCAL_AI_API_KEY) headers.Authorization = `Bearer ${LOCAL_AI_API_KEY}`;

  const res = await fetch(`${LOCAL_AI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0
    }),
    signal: AbortSignal.timeout(LOCAL_AI_TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('回傳內容為空');
  console.log(`AI Engine [LOCAL ${model} RAW RESPONSE]:`, text);

  // json_object mode should give bare JSON, but tolerate a ```json fence.
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

async function firstAvailable(imageBuffers, prompt) {
  const failures = [];
  for (const model of LOCAL_AI_MODELS) {
    try {
      return { parsed: await chatJson(model, imageBuffers, prompt), model };
    } catch (error) {
      console.error(`AI Engine [LOCAL ${model} FAILED]:`, error.message);
      failures.push(`${modelLabel(model)}: ${error.message}`);
    }
  }
  throw new Error(failures.join('；'));
}

/**
 * Same contract as gemini.js analyzeCaseImage; also returns which local model answered.
 * @param {Buffer} imageBuffer
 */
export async function analyzeCaseImage(imageBuffer) {
  const { parsed, model } = await firstAvailable([imageBuffer], SINGLE_IMAGE_PROMPT);
  return { ...normalizeSingleResult(parsed), model };
}

/**
 * Same contract as gemini.js analyzeMultipleImages; also returns which local model answered.
 * @param {Buffer[]} imageBuffers
 */
export async function analyzeMultipleImages(imageBuffers) {
  const { parsed, model } = await firstAvailable(imageBuffers, MULTI_IMAGE_PROMPT);
  return { ...normalizeMultiResult(parsed), model };
}
