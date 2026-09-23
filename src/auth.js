/**
 * API authentication.
 *
 * Every /api/* endpoint used to be fully open: anyone who knew the URL could
 * read the staff roster and every LINE group ID, rewrite ward notices, or fire
 * a hospital-wide push via /api/test-cron. On a public VM that is not
 * survivable, so LIFF pages now present their LINE ID token and the server
 * verifies it against LINE before touching the database.
 */

import dotenv from 'dotenv';
import { db } from './db.js';

dotenv.config();

const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';

if (AUTH_DISABLED) {
  console.warn('[Auth] AUTH_DISABLED=true -- every /api/* endpoint is OPEN. Never do this in production.');
} else if (!LINE_LOGIN_CHANNEL_ID) {
  console.error('[Auth] LINE_LOGIN_CHANNEL_ID is not set. All authenticated endpoints will reject requests.');
}

// LINE's verify endpoint is a network hop per call; cache successful results
// until the token itself expires so a page load costs one round trip, not ten.
const verifiedTokens = new Map(); // idToken -> { payload, expiresAtMs }
const MAX_CACHE_ENTRIES = 500;

function cacheVerified(idToken, payload) {
  if (verifiedTokens.size >= MAX_CACHE_ENTRIES) {
    verifiedTokens.delete(verifiedTokens.keys().next().value);
  }
  verifiedTokens.set(idToken, { payload, expiresAtMs: payload.exp * 1000 });
}

/**
 * Verifies a LINE ID token and returns its payload, or null when invalid.
 * @param {string} idToken
 */
export async function verifyIdToken(idToken) {
  if (!idToken || !LINE_LOGIN_CHANNEL_ID) return null;

  const cached = verifiedTokens.get(idToken);
  if (cached) {
    if (cached.expiresAtMs > Date.now()) return cached.payload;
    verifiedTokens.delete(idToken);
  }

  try {
    const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: LINE_LOGIN_CHANNEL_ID })
    });

    if (!response.ok) {
      console.warn(`[Auth] ID token rejected by LINE (${response.status}).`);
      return null;
    }

    const payload = await response.json();

    // LINE already checks aud/exp, but the channel binding is the whole point
    // of this middleware -- verify it locally rather than trusting the call.
    if (payload.aud !== LINE_LOGIN_CHANNEL_ID) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;

    cacheVerified(idToken, payload);
    return payload;
  } catch (error) {
    console.error('[Auth] ID token verification failed:', error.message);
    return null;
  }
}

/**
 * Hono middleware factory.
 * @param {{allowUnregistered?: boolean}} options
 *   allowUnregistered -- let a verified LINE user through even if they are not
 *   in the `users` table yet. Only /api/users/sync needs this, otherwise a new
 *   colleague could never register in the first place.
 */
export function requireLiffAuth({ allowUnregistered = false } = {}) {
  return async (c, next) => {
    if (AUTH_DISABLED) return next();

    const header = c.req.header('authorization') || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    const payload = await verifyIdToken(idToken);
    if (!payload) {
      return c.json({ error: 'Unauthorized: a valid LINE ID token is required.' }, 401);
    }

    const user = await db.users.getByLineUserId(payload.sub);
    if (!user && !allowUnregistered) {
      return c.json({ error: 'Forbidden: this LINE account is not registered.' }, 403);
    }

    c.set('lineUserId', payload.sub);
    c.set('displayName', user?.display_name || payload.name || '未知人員');
    return next();
  };
}

/** Guards operations that trigger real pushes to every group. */
export function requireAdminKey() {
  return async (c, next) => {
    if (AUTH_DISABLED) return next();

    if (!ADMIN_API_KEY) {
      return c.json({ error: 'ADMIN_API_KEY is not configured on the server.' }, 503);
    }

    const provided = c.req.header('x-admin-key') || c.req.query('key');
    if (provided !== ADMIN_API_KEY) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  };
}
