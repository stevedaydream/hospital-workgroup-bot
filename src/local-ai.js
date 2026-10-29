import dotenv from 'dotenv';
import { SINGLE_IMAGE_PROMPT, MULTI_IMAGE_PROMPT, normalizeSingleResult, normalizeMultiResult } from './prompts.js';

dotenv.config();

// Local models on this PC, tried in the order of LOCAL_AI_MODELS: Strata
// (`local`) normally, Qwen3.6 when Strata cannot get the VRAM -- the two share
// the GPUs and never run together.
//
// Two routes, same OpenAI-compatible API:
// 1. Port Monitor (43922, needs a project key). It starts a model that is not
//    loaded, queueing by project priority and closing idle models to make
//    room; when Strata cannot fit it fails fast and the next model is tried.
// 2. Local AI Gateway (4000). Its providers do not autostart, so it only
//    serves whichever model is already running. Used when Port Monitor is not
//    configured, not running, or could not serve any model.
const LOCAL_AI_MODELS = (process.env.LOCAL_AI_MODELS || 'local,qwen3.6')
  .split(',').map(m => m.trim()).filter(Boolean);

const routes = [];
if (process.env.PORT_MONITOR_API_KEY) {
  routes.push({
    name: 'Port Monitor',
    baseUrl: (process.env.PORT_MONITOR_BASE_URL || 'http://127.0.0.1:43922').replace(/\/+$/, ''),
    apiKey: process.env.PORT_MONITOR_API_KEY,
    // Covers queueing (up to 120s), a Strata cold start (~183s) and inference.
    timeoutMs: Number(process.env.PORT_MONITOR_TIMEOUT_MS) || 600000
  });
}
if (process.env.LOCAL_AI_BASE_URL) {
  routes.push({
    name: 'gateway',
    baseUrl: process.env.LOCAL_AI_BASE_URL.replace(/\/+$/, ''),
    apiKey: process.env.LOCAL_AI_API_KEY || '',
    // A single image takes ~20-130s depending on the model.
    timeoutMs: Number(process.env.LOCAL_AI_TIMEOUT_MS) || 240000
  });
}

export const localAiEnabled = routes.length > 0;

if (localAiEnabled) {
  console.log(`AI Engine: Local AI via ${routes.map(r => `${r.name} (${r.baseUrl})`).join(' → ')}, models in order: ${LOCAL_AI_MODELS.join(' → ')}`);
}

const MODEL_LABELS = { local: 'Strata', 'qwen3.6': 'Qwen3.6' };
export const modelLabel = model => MODEL_LABELS[model] || model;

// fetch() rejects with a TypeError only when no HTTP response came back at all.
const isUnreachable = error => error.name === 'TypeError';

async function chatJson(route, model, imageBuffers, prompt) {
  const content = imageBuffers.map(buffer => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
  }));
  content.push({ type: 'text', text: prompt });

  const headers = { 'Content-Type': 'application/json' };
  if (route.apiKey) headers.Authorization = `Bearer ${route.apiKey}`;

  const res = await fetch(`${route.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0
    }),
    signal: AbortSignal.timeout(route.timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('回傳內容為空');
  console.log(`AI Engine [${route.name} ${model} RAW RESPONSE]:`, text);

  // json_object mode should give bare JSON, but tolerate a ```json fence.
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

async function firstAvailable(imageBuffers, prompt, onAttempt) {
  const failures = [];
  for (const route of routes) {
    for (const model of LOCAL_AI_MODELS) {
      try {
        onAttempt?.(model);
        return { parsed: await chatJson(route, model, imageBuffers, prompt), model };
      } catch (error) {
        console.error(`AI Engine [${route.name} ${model} FAILED]:`, error.message);
        failures.push(`${route.name}/${modelLabel(model)}: ${error.message}`);
        // Nothing is listening (e.g. Port Monitor not started): the other
        // models on this route would fail the same way.
        if (isUnreachable(error)) break;
      }
    }
  }
  throw new Error(failures.join('；'));
}

/**
 * Same contract as gemini.js analyzeCaseImage; also returns which local model answered.
 * @param {Buffer} imageBuffer
 * @param {(model: string) => void} [onAttempt] - called before each model is tried
 */
export async function analyzeCaseImage(imageBuffer, onAttempt) {
  const { parsed, model } = await firstAvailable([imageBuffer], SINGLE_IMAGE_PROMPT, onAttempt);
  return { ...normalizeSingleResult(parsed), model };
}

/**
 * Same contract as gemini.js analyzeMultipleImages; also returns which local model answered.
 * @param {Buffer[]} imageBuffers
 * @param {(model: string) => void} [onAttempt] - called before each model is tried
 */
export async function analyzeMultipleImages(imageBuffers, onAttempt) {
  const { parsed, model } = await firstAvailable(imageBuffers, MULTI_IMAGE_PROMPT, onAttempt);
  return { ...normalizeMultiResult(parsed), model };
}

// The gateway knows every model's provider and whether it is up, even when
// Port Monitor started it, so it answers "loading or recognizing?" for the
// progress page. Resolves to null when that cannot be determined.
const GATEWAY_URL = (process.env.LOCAL_AI_BASE_URL || '').replace(/\/+$/, '');
let modelOwners = null;

export async function isModelLoaded(model) {
  if (!GATEWAY_URL) return null;
  try {
    if (!modelOwners) {
      const res = await fetch(`${GATEWAY_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
      const { data } = await res.json();
      modelOwners = Object.fromEntries(data.map(m => [m.id, m.owned_by]));
    }
    const provider = modelOwners[model];
    if (!provider) return null;
    const res = await fetch(`${GATEWAY_URL}/providers`, { signal: AbortSignal.timeout(3000) });
    return Boolean((await res.json())[provider]?.ready);
  } catch {
    return null;
  }
}
