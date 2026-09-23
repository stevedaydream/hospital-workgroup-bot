/**
 * Vision pipeline orchestration.
 *
 * Single image  : classify -> type-specific extraction (two short prompts).
 * Several images: map-reduce -- each image is digested on its own, then the
 *                 digests are merged by a text-only call. Merging in text
 *                 keeps peak RAM constant instead of growing with the number
 *                 of photos, which matters on a 12GB box with the model
 *                 already resident.
 *
 * Local inference is primary; Gemini is an automatic fallback whose use is
 * reported back to the caller so the group can be told the photograph was
 * uploaded to Google.
 */

import dotenv from 'dotenv';
import * as local from './local.js';
import * as gemini from './gemini.js';
import * as mock from './mock.js';
import { runExclusive } from './queue.js';
import { prepareForInference, toBase64 } from '../util/image.js';
import {
  CLASSIFY_SCHEMA,
  CASE_TABLE_SCHEMA,
  WARD_NOTE_SCHEMA,
  CALENDAR_SCHEMA,
  IMAGE_DIGEST_SCHEMA,
  normaliseType,
  normaliseCaseTable,
  normaliseNotes,
  normaliseEvents
} from './schemas.js';
import {
  CLASSIFY_PROMPT,
  CASE_TABLE_PROMPT,
  WARD_NOTE_PROMPT,
  CALENDAR_PROMPT,
  IMAGE_DIGEST_PROMPT,
  buildMergePrompt
} from './prompts.js';

dotenv.config();

const AI_PROVIDER = process.env.AI_PROVIDER || 'auto';
const PROVIDERS = { local, gemini, mock };

const emptyResult = () => ({
  type: 'UNKNOWN',
  date: null,
  assignments: [],
  notes: [],
  events: []
});

async function resolvePrimary() {
  if (AI_PROVIDER !== 'auto') {
    const chosen = PROVIDERS[AI_PROVIDER];
    if (!chosen) throw new Error(`Unknown AI_PROVIDER: ${AI_PROVIDER}`);
    return chosen;
  }
  if (await local.isAvailable()) return local;
  if (await gemini.isAvailable()) return gemini;
  return mock;
}

/**
 * A result that parsed cleanly but is empty still counts as a failure for the
 * two types where emptiness is meaningless -- a case table with nobody on it,
 * or a calendar with no events, means the model did not read the page. Ward
 * notes and UNKNOWN are left alone: an unreadable snapshot should not be
 * shipped to the cloud just because it contained nothing.
 */
function isEmptyFailure(result) {
  if (result.type === 'CASE_TABLE') return result.assignments.length === 0;
  if (result.type === 'CALENDAR') return result.events.length === 0;
  return false;
}

async function runPipeline(provider, images, onProgress) {
  const call = (request) =>
    provider === local ? runExclusive(() => provider.complete(request)) : provider.complete(request);

  // ---- Several images: map-reduce into a consolidated ward note ----
  if (images.length > 1) {
    const digests = [];
    for (let index = 0; index < images.length; index++) {
      onProgress?.({ stage: 'digest', index: index + 1, total: images.length });
      const { data } = await call({
        prompt: IMAGE_DIGEST_PROMPT,
        images: [images[index]],
        schema: IMAGE_DIGEST_SCHEMA
      });
      digests.push(String(data?.summary || '').trim());
    }

    onProgress?.({ stage: 'merge', index: images.length, total: images.length });
    const { data } = await call({
      prompt: buildMergePrompt(digests.filter(Boolean)),
      images: [], // text only -- the expensive part is already done
      schema: WARD_NOTE_SCHEMA
    });

    return { ...emptyResult(), type: 'WARD_NOTE', notes: normaliseNotes(data) };
  }

  // ---- Single image: classify, then extract ----
  onProgress?.({ stage: 'classify', index: 1, total: 1 });
  const classification = await call({
    prompt: CLASSIFY_PROMPT,
    images,
    schema: CLASSIFY_SCHEMA
  });
  const type = normaliseType(classification.data);

  if (type === 'UNKNOWN') {
    return { ...emptyResult(), type };
  }

  onProgress?.({ stage: 'extract', type, index: 1, total: 1 });

  if (type === 'CASE_TABLE') {
    const { data } = await call({ prompt: CASE_TABLE_PROMPT, images, schema: CASE_TABLE_SCHEMA });
    const { date, assignments } = normaliseCaseTable(data);
    return { ...emptyResult(), type, date, assignments };
  }

  if (type === 'CALENDAR') {
    const { data } = await call({ prompt: CALENDAR_PROMPT, images, schema: CALENDAR_SCHEMA });
    return { ...emptyResult(), type, events: normaliseEvents(data) };
  }

  const { data } = await call({ prompt: WARD_NOTE_PROMPT, images, schema: WARD_NOTE_SCHEMA });
  return { ...emptyResult(), type, notes: normaliseNotes(data) };
}

/**
 * @param {Buffer[]} buffers original images as uploaded to LINE
 * @param {{onProgress?: (p: object) => void}} [options]
 * @returns {Promise<object>} normalised result plus `engine` and `fallback`
 */
export async function analyzeImages(buffers, { onProgress } = {}) {
  const startedAt = Date.now();

  const prepared = [];
  for (const buffer of buffers) {
    const image = await prepareForInference(buffer);
    prepared.push(toBase64(image.buffer));
  }

  const primary = await resolvePrimary();
  let fallbackReason = null;

  try {
    const result = await runPipeline(primary, prepared, onProgress);

    if (primary === local && isEmptyFailure(result)) {
      fallbackReason =
        result.type === 'CASE_TABLE'
          ? '本地模型判定為分配表，但一位醫師都沒有讀出來'
          : '本地模型判定為行事曆，但沒有讀出任何活動';
    } else {
      return { ...result, engine: primary.name, fallback: { used: false, reason: null }, elapsedMs: Date.now() - startedAt };
    }
  } catch (error) {
    if (primary !== local) throw error;
    fallbackReason = error.reason === 'timeout' ? '本地推論逾時' : `本地推論失敗（${error.message}）`;
    console.warn(`[AI] Local inference failed: ${error.message}`);
  }

  if (!(await gemini.isAvailable())) {
    throw new Error(`${fallbackReason}，且雲端備援未設定 GEMINI_API_KEY。`);
  }

  console.warn(`[AI] Falling back to Gemini: ${fallbackReason}`);
  onProgress?.({ stage: 'fallback', reason: fallbackReason });

  const result = await runPipeline(gemini, prepared, onProgress);
  return {
    ...result,
    engine: gemini.name,
    fallback: { used: true, reason: fallbackReason },
    elapsedMs: Date.now() - startedAt
  };
}

/** Exposed for the status endpoint and for start-up logging. */
export async function describeEngines() {
  return {
    configured: AI_PROVIDER,
    local: await local.isAvailable(),
    gemini: await gemini.isAvailable()
  };
}
