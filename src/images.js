import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { todayInTaipei } from './util/date.js';

dotenv.config();

/**
 * Uploaded case-table photos. They hold patient data, so they live under
 * data/ (never served as static files, never in git) and leave the bot only
 * through a signed, expiring /images URL (for LINE to fetch when an image is
 * pushed) or the logged-in /api/images endpoint (the review page).
 */
export const IMAGES_DIR = path.resolve('data/images');
const LEGACY_DIR = path.resolve('public/images');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.IMAGE_URL_SECRET || process.env.LINE_CHANNEL_SECRET || '';
const ID = /^\d{1,32}$/;
const LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const IMAGE_RETENTION_DAYS = 30;

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Photos saved before this module existed sat in public/, open to anyone with the URL.
if (fs.existsSync(LEGACY_DIR)) {
  for (const name of fs.readdirSync(LEGACY_DIR)) {
    const from = path.join(LEGACY_DIR, name);
    const to = path.join(IMAGES_DIR, name);
    if (fs.existsSync(to)) fs.rmSync(from);
    else fs.renameSync(from, to);
  }
  fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
}

export const imagePath = id => (ID.test(String(id)) ? path.join(IMAGES_DIR, `${id}.jpg`) : null);

const sign = (id, exp) => crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');

/** A link LINE can fetch for a push or share; by default it stops working after two weeks. */
export function signedImageUrl(id, now = Date.now(), ttlMs = LINK_TTL_MS) {
  const exp = now + ttlMs;
  return `${BASE_URL}/images/${id}.jpg?exp=${exp}&sig=${sign(id, exp)}`;
}

export function verifyImageLink(id, exp, sig, now = Date.now()) {
  if (!SECRET || !ID.test(String(id)) || !/^\d+$/.test(String(exp)) || Number(exp) < now || typeof sig !== 'string') return false;
  const expected = Buffer.from(sign(id, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Deletes photos older than the retention period, keeping any still queued for dispatch. */
export function pruneImages(keepIds, now = Date.now()) {
  const keep = new Set(keepIds.map(String));
  const cutoff = now - IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(IMAGES_DIR)) {
    const file = path.join(IMAGES_DIR, name);
    if (keep.has(path.parse(name).name) || fs.statSync(file).mtimeMs >= cutoff) continue;
    fs.rmSync(file);
    removed++;
  }
  if (removed) console.log(`[Images] Removed ${removed} photos older than ${IMAGE_RETENTION_DAYS} days (${todayInTaipei()}).`);
  return removed;
}
