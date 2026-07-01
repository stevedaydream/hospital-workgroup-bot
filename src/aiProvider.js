import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// ----------------------------------------------------
// Configuration
// ----------------------------------------------------
// AI_PROVIDER_ORDER: comma-separated priority list. The first configured
// provider is the primary; the rest act as fallbacks when the primary keeps
// failing on transient errors. e.g. "gemini,ollama" or "ollama,gemini".
const AI_PROVIDER_ORDER = (process.env.AI_PROVIDER_ORDER || 'gemini')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Max retry attempts per provider on transient errors (429/5xx/network).
const AI_MAX_RETRIES = parseInt(process.env.AI_MAX_RETRIES || '3', 10);
// Base backoff in ms; grows exponentially (base, base*2, base*4 ...) capped below.
const AI_RETRY_BASE_MS = parseInt(process.env.AI_RETRY_BASE_MS || '1000', 10);
const AI_RETRY_CAP_MS = parseInt(process.env.AI_RETRY_CAP_MS || '8000', 10);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash';

// Self-hosted local model (e.g. Ollama running gemma3n:e4b behind a public
// HTTPS endpoint / Cloudflare Tunnel). Leave OLLAMA_BASE_URL unset to disable.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_MODEL_NAME = process.env.OLLAMA_MODEL_NAME || 'gemma3n:e4b';

// Self-hosted OpenAI-compatible endpoint (vLLM / LM Studio / llama.cpp server
// serving e.g. a Qwen*-VL vision model). OPENAI_BASE_URL should be the API base
// that exposes /chat/completions, e.g. "https://host/v1". Must be reachable
// from the backend (use a public HTTPS endpoint / Cloudflare Tunnel for a local
// machine). Leave OPENAI_BASE_URL unset to disable.
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // optional for local servers
const OPENAI_MODEL_NAME = process.env.OPENAI_MODEL_NAME || 'qwen2.5-vl';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ----------------------------------------------------
// Gemini provider
// ----------------------------------------------------
let geminiClient = null;
function getGeminiClient() {
  if (geminiClient) return geminiClient;
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('placeholder')) return null;
  try {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (error) {
    console.error('AI Provider [gemini]: Failed to initialize client:', error.message);
    return null;
  }
  return geminiClient;
}

async function geminiGenerate({ imageBuffers, prompt }) {
  const ai = getGeminiClient();
  const contents = imageBuffers.map(buffer => ({
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: 'image/jpeg'
    }
  }));
  contents.push(prompt);

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL_NAME,
    contents,
    config: { responseMimeType: 'application/json' }
  });
  return response.text;
}

// ----------------------------------------------------
// Ollama (self-hosted local model) provider
// ----------------------------------------------------
async function ollamaGenerate({ imageBuffers, prompt }) {
  const url = `${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/generate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL_NAME,
      prompt,
      images: imageBuffers.map(buffer => buffer.toString('base64')),
      format: 'json',
      stream: false
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // Ollama /api/generate returns { response: "<json string>", ... }
  return data.response;
}

// ----------------------------------------------------
// OpenAI-compatible provider (vLLM / LM Studio / llama.cpp, e.g. Qwen*-VL)
// ----------------------------------------------------
async function openaiGenerate({ imageBuffers, prompt }) {
  const url = `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const content = [
    { type: 'text', text: prompt },
    ...imageBuffers.map(buffer => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
    }))
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (OPENAI_API_KEY) headers['Authorization'] = `Bearer ${OPENAI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: OPENAI_MODEL_NAME,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      stream: false
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`OpenAI-compatible HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('OpenAI-compatible response missing choices[0].message.content');
  }
  return text;
}

// ----------------------------------------------------
// Provider registry
// ----------------------------------------------------
const PROVIDERS = {
  gemini: {
    name: 'gemini',
    isConfigured: () => !!getGeminiClient(),
    generate: geminiGenerate
  },
  ollama: {
    name: 'ollama',
    isConfigured: () => !!OLLAMA_BASE_URL,
    generate: ollamaGenerate
  },
  openai: {
    name: 'openai',
    isConfigured: () => !!OPENAI_BASE_URL,
    generate: openaiGenerate
  }
};

/**
 * Returns the ordered list of configured providers (primary first).
 * @returns {Array<{name: string, generate: Function}>}
 */
export function getActiveProviders() {
  return AI_PROVIDER_ORDER
    .map(name => PROVIDERS[name])
    .filter(p => p && p.isConfigured());
}

/**
 * Whether at least one AI provider is configured. When false, callers should
 * fall back to MOCK mode.
 */
export function hasActiveProvider() {
  return getActiveProviders().length > 0;
}

// ----------------------------------------------------
// Retry + fallback orchestration
// ----------------------------------------------------
/**
 * Heuristically decides whether an error is transient (worth retrying) vs.
 * a hard failure (bad request, auth, etc.) that retrying won't fix.
 */
function isTransientError(error) {
  const status = error?.status ?? error?.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = String(error?.message || '').toLowerCase();
  return /\b(429|500|502|503|504)\b|rate.?limit|resource_exhausted|quota|unavailable|overloaded|too many requests|timeout|timed out|econnreset|etimedout|enotfound|econnrefused|fetch failed|network|socket hang up/.test(msg);
}

async function callWithRetry(provider, payload) {
  let lastError;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      return await provider.generate(payload);
    } catch (error) {
      lastError = error;
      const canRetry = isTransientError(error) && attempt < AI_MAX_RETRIES;
      if (!canRetry) throw error;

      const backoff = Math.min(AI_RETRY_BASE_MS * 2 ** attempt, AI_RETRY_CAP_MS);
      const jitter = Math.floor(Math.random() * 300);
      const delay = backoff + jitter;
      console.warn(
        `AI Provider [${provider.name}]: transient error on attempt ` +
        `${attempt + 1}/${AI_MAX_RETRIES + 1}, retrying in ${delay}ms — ${error.message}`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Runs the given multimodal prompt through the configured providers, retrying
 * each on transient errors and falling back to the next provider on hard
 * failure. Returns the raw (expected-JSON) text from whichever provider wins.
 *
 * @param {{imageBuffers: Buffer[], prompt: string}} payload
 * @returns {Promise<string>} Raw response text (JSON string).
 */
export async function generateStructured(payload) {
  const providers = getActiveProviders();
  if (providers.length === 0) {
    throw new Error('No AI provider configured');
  }

  let lastError;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const text = await callWithRetry(provider, payload);
      if (i > 0) {
        console.log(`AI Provider: recovered via fallback provider [${provider.name}]`);
      }
      return text;
    } catch (error) {
      lastError = error;
      const next = providers[i + 1];
      console.error(
        `AI Provider [${provider.name}] failed after retries: ${error.message}` +
        (next ? ` — falling back to [${next.name}]` : ' — no fallback left')
      );
    }
  }

  throw new Error(`所有 AI provider 皆辨識失敗: ${lastError?.message || 'unknown error'}`);
}
