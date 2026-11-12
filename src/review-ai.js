import { db } from './db.js';
import { randomUUID } from 'node:crypto';
import { organizeNotice, organizeNoteDraft } from './local-ai.js';
import { REVIEW_MODELS, prepareReviewModel } from './model-switch.js';

const jobs = new Map();
export function reviewAiStatus(id) {
  const job = jobs.get(String(id));
  return job ? { status: job.status, error: job.error, model: job.model, stage: job.stage } : { status: 'idle' };
}
export function startReviewAi(id, organize = organizeNotice, { model = 'qwen3.6', switchModel = false, prepare = prepareReviewModel } = {}) {
  if (!Object.hasOwn(REVIEW_MODELS, model)) throw new Error('不支援的模型');
  id = String(id);
  const note = db.note_reviews.list().find(row => String(row.id) === id);
  if (!note) return null;
  if ([...jobs.entries()].some(([key, job]) => key !== id && job.status === 'running')) throw new Error('其他公告正在整理，請待完成後再切換模型。');
  const previous = jobs.get(id);
  if (previous?.status === 'running' && !switchModel) return reviewAiStatus(id);
  if (previous?.status === 'running') previous.controller.abort();
  const controller = new AbortController();
  const job = { status: 'running', error: null, model, stage: 'preparing', controller };
  jobs.set(id, job);
  job.work = Promise.resolve().then(async () => {
    if (previous?.work) await previous.work;
    await prepare(model, { signal: controller.signal, previousModel: previous?.model });
    controller.signal.throwIfAborted();
    if (jobs.get(id) !== job) return;
    job.stage = 'organizing';
    return organize({ title: note.title, content: note.content }, { model, signal: controller.signal });
  }).then(draft => {
    if (jobs.get(id) !== job || controller.signal.aborted) return;
    if (!db.note_reviews.saveDraft(id, draft)) throw new Error('此公告已處理或到期，未發布內容。');
    job.status = 'done';
  }).catch(error => { if (jobs.get(id) === job) { job.status = 'failed'; job.error = error.message; } });
  // This status cache contains no content and is not needed once the draft is stored.
  const timer = setTimeout(() => { if (jobs.get(id) === job) jobs.delete(id); }, 60 * 60 * 1000);
  timer.unref();
  return reviewAiStatus(id);
}

// Drafts for the notes editor. The text is only kept here until the page reads it
// (or an hour passes); nothing is saved as a note until the person presses save.
const drafts = new Map();
export function draftAiStatus(id) {
  const job = drafts.get(String(id));
  if (!job) return { status: 'missing' };
  return { status: job.status, error: job.error, model: job.model, stage: job.stage, draft: job.draft };
}
export function startDraftAi(note, categories, organize = organizeNoteDraft, { model = 'qwen3.6', prepare = prepareReviewModel } = {}) {
  if (!Object.hasOwn(REVIEW_MODELS, model)) throw new Error('不支援的模型');
  if ([...jobs.values(), ...drafts.values()].some(job => job.status === 'running')) throw new Error('另一則公告正在整理，請待完成後再試。');
  const id = randomUUID();
  const controller = new AbortController();
  const job = { status: 'running', error: null, model, stage: 'preparing', draft: null };
  drafts.set(id, job);
  job.work = Promise.resolve().then(async () => {
    await prepare(model, { signal: controller.signal });
    job.stage = 'organizing';
    job.draft = await organize(note, categories, { model, signal: controller.signal });
    job.status = 'done';
  }).catch(error => { job.status = 'failed'; job.error = error.message; });
  const timer = setTimeout(() => { controller.abort(); drafts.delete(id); }, 60 * 60 * 1000);
  timer.unref();
  return { id, ...draftAiStatus(id) };
}
