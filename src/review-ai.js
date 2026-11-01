import { db } from './db.js';
import { organizeNotice } from './local-ai.js';

const jobs = new Map();
export function reviewAiStatus(id) {
  const job = jobs.get(String(id));
  return job ? { status: job.status, error: job.error } : { status: 'idle' };
}
export function startReviewAi(id, organize = organizeNotice) {
  id = String(id);
  const note = db.note_reviews.list().find(row => String(row.id) === id);
  if (!note) return null;
  if (jobs.get(id)?.status === 'running') return reviewAiStatus(id);
  const job = { status: 'running', error: null };
  jobs.set(id, job);
  Promise.resolve().then(() => organize({ title: note.title, content: note.content })).then(draft => {
    if (!db.note_reviews.saveDraft(id, draft)) throw new Error('此公告已處理或到期，未發布內容。');
    job.status = 'done';
  }).catch(error => { job.status = 'failed'; job.error = error.message; });
  // This status cache contains no content and is not needed once the draft is stored.
  const timer = setTimeout(() => { if (jobs.get(id) === job) jobs.delete(id); }, 60 * 60 * 1000);
  timer.unref();
  return reviewAiStatus(id);
}
