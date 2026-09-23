/**
 * Offline stand-in used when neither a local model nor an API key is present.
 * Keeps the whole LINE flow testable without any inference at all.
 *
 * The shape of the reply is driven by which schema was requested, so it stays
 * correct no matter how the orchestrator sequences its stages.
 */

import {
  CLASSIFY_SCHEMA,
  CASE_TABLE_SCHEMA,
  WARD_NOTE_SCHEMA,
  CALENDAR_SCHEMA,
  IMAGE_DIGEST_SCHEMA
} from './schemas.js';
import { todayInTaipei } from '../util/date.js';

export const name = 'mock';

export async function isAvailable() {
  return true;
}

export async function complete({ images = [], schema }) {
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Vary the simulated document type by payload size so repeated local runs
  // exercise all three pipelines.
  const variant = (images[0]?.length || 0) % 3;

  if (schema === CLASSIFY_SCHEMA) {
    const type = ['CASE_TABLE', 'WARD_NOTE', 'CALENDAR'][variant];
    return { data: { type }, elapsedMs: 300 };
  }

  if (schema === CASE_TABLE_SCHEMA) {
    return {
      data: {
        date: todayInTaipei().replace(/-/g, '/'),
        assignments: [
          { doctor: '鄧明紘', department: 'URO' },
          { doctor: '陳鍾沛', department: 'ORTHO' }
        ]
      },
      elapsedMs: 300
    };
  }

  if (schema === WARD_NOTE_SCHEMA) {
    return {
      data: {
        notes: [
          { title: '會診', content: '泌尿科 URO 今日下午 14:00 有緊急會診，請值班護理師協助備妥病歷。' }
        ]
      },
      elapsedMs: 300
    };
  }

  if (schema === CALENDAR_SCHEMA) {
    return {
      data: {
        events: [
          {
            title: '週四晨會報告',
            date: todayInTaipei(),
            time: '08:00',
            location: '第二會議室',
            description: '陳鍾沛醫師及黃郁芳專科護理師報告'
          }
        ]
      },
      elapsedMs: 300
    };
  }

  if (schema === IMAGE_DIGEST_SCHEMA) {
    return { data: { summary: '・病房清消：明日 09:00 起全區大掃除。\n・會診規範：非緊急會診請於 17:00 前送出。' }, elapsedMs: 300 };
  }

  return { data: { notes: [{ title: '晨會公告', content: '（MOCK）多張簡報整併結果。' }] }, elapsedMs: 300 };
}
