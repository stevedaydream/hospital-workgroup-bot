import crypto from 'crypto';

// In-memory progress of image-recognition jobs, read by public/progress.html.
// LINE messages cannot be edited and push messages are billed per group
// member, so progress lives on a page the user opens from a free reply
// instead of in periodic pushes. Lost on restart, which is fine: a restart
// also kills the job itself.

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

// Rough durations (seconds) used only for the "about N more" estimate.
// Measured 2026-10: Strata ~30s per image, Qwen3.6 ~130s single / ~45s
// consolidating several, a cold model load ~180s.
const LOAD_SECONDS = 180;
const RECOGNIZE_SECONDS = { Strata: 30, 'Qwen3.6': 130, Gemini: 15 };
const RECOGNIZE_MULTI_SECONDS = { Strata: 45, 'Qwen3.6': 50, Gemini: 20 };

export const STAGES = {
  collecting: '等待其他照片',
  loading: '載入 AI 模型',
  recognizing: 'AI 辨識中',
  done: '完成',
  failed: '失敗'
};

function prune() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}

export function createJob() {
  prune();
  const job = {
    id: crypto.randomBytes(12).toString('hex'),
    stage: 'collecting',
    stageSince: Date.now(),
    startedAt: Date.now(),
    imageCount: 1,
    model: null,
    resultLabel: null,
    error: null,
    finishedAt: null
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(job, changes) {
  if (!job || job.finishedAt) return;
  if (changes.stage && changes.stage !== job.stage) job.stageSince = Date.now();
  Object.assign(job, changes);
  if (job.stage === 'done' || job.stage === 'failed') job.finishedAt = Date.now();
}

function remainingSeconds(job, collectWindowMs) {
  const sinceStage = (Date.now() - job.stageSince) / 1000;
  const multi = job.imageCount > 1;
  const recognize = (multi ? RECOGNIZE_MULTI_SECONDS : RECOGNIZE_SECONDS)[job.model] ?? 90;
  switch (job.stage) {
    case 'collecting':
      // The model may still need loading; assume it does so the estimate errs long.
      return Math.max(0, collectWindowMs / 1000 - sinceStage) + LOAD_SECONDS + recognize;
    case 'loading':
      return Math.max(15, LOAD_SECONDS - sinceStage) + recognize;
    case 'recognizing':
      return Math.max(5, recognize - sinceStage);
    default:
      return 0;
  }
}

/** Public view of a job: no image content or recognition results, only state. */
export function getJobView(id, collectWindowMs) {
  const job = jobs.get(id);
  if (!job) return null;
  const now = job.finishedAt || Date.now();
  return {
    stage: job.stage,
    stageLabel: STAGES[job.stage],
    imageCount: job.imageCount,
    model: job.model,
    resultLabel: job.resultLabel,
    error: job.error,
    elapsedSeconds: Math.round((now - job.startedAt) / 1000),
    remainingSeconds: Math.round(remainingSeconds(job, collectWindowMs)),
    finished: Boolean(job.finishedAt)
  };
}
