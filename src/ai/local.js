/**
 * Local inference against llama.cpp's llama-server.
 *
 * Started with a text GGUF plus the matching multimodal projector:
 *   llama-server -m gemma-4-E4B-Q4_K_M.gguf --mmproj mmproj-gemma-4-E4B.gguf \
 *                --host 127.0.0.1 --port 8080 -c 8192 --parallel 1
 *
 * Uses the OpenAI-compatible endpoint, which accepts images as data: URIs and
 * compiles `response_format.json_schema` into a GBNF grammar -- structurally
 * invalid JSON becomes impossible at the sampling layer rather than merely
 * unlikely. llama-server nevertheless fails *open* when a schema cannot be
 * compiled, so every response is still parsed and validated by the caller.
 */

import dotenv from 'dotenv';

dotenv.config();

const BASE = (process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const TIMEOUT_MS = parseInt(process.env.LOCAL_INFERENCE_TIMEOUT_MS || '360000', 10);
const MAX_TOKENS = parseInt(process.env.LOCAL_MAX_TOKENS || '2048', 10);

export const name = 'local';

export class LocalInferenceError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'LocalInferenceError';
    this.reason = reason; // 'unreachable' | 'timeout' | 'http' | 'malformed'
  }
}

/** Quick liveness probe so the pipeline can fail over before spending minutes. */
export async function isAvailable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function buildContent(prompt, images) {
  const content = images.map((base64) => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${base64}` }
  }));
  content.push({ type: 'text', text: prompt });
  return content;
}

/**
 * @param {{prompt: string, images?: string[], schema?: object, temperature?: number}} request
 * @returns {Promise<object|string>} parsed JSON when a schema is supplied, raw text otherwise
 */
export async function complete({ prompt, images = [], schema, temperature = 0 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  const body = {
    messages: [{ role: 'user', content: buildContent(prompt, images) }],
    temperature,
    max_tokens: MAX_TOKENS,
    stream: false
  };

  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema }
    };
  }

  let response;
  try {
    response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new LocalInferenceError(`本地推論超過 ${Math.round(TIMEOUT_MS / 1000)} 秒未完成`, 'timeout');
    }
    throw new LocalInferenceError(`無法連線至 llama-server (${BASE}): ${error.message}`, 'unreachable');
  }
  clearTimeout(timer);

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LocalInferenceError(`llama-server 回應 ${response.status}: ${detail.slice(0, 200)}`, 'http');
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content ?? '';
  const elapsedMs = Date.now() - startedAt;
  console.log(`[AI:local] completed in ${(elapsedMs / 1000).toFixed(1)}s (${images.length} image(s), ${payload?.usage?.completion_tokens ?? '?'} output tokens)`);

  if (!schema) return { text, elapsedMs };

  try {
    return { data: JSON.parse(text), elapsedMs };
  } catch {
    // Grammar compilation failed open, or the model was cut off by max_tokens.
    throw new LocalInferenceError(`本地模型輸出不是合法 JSON：${text.slice(0, 200)}`, 'malformed');
  }
}
