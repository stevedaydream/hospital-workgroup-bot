// Public entry point on Vercel that forwards every request to the bot behind
// Tailscale Funnel. LINE's webhook client fails the TLS handshake with Funnel
// on roughly one request in six and then waits minutes before redelivering;
// LINE talks to Vercel instead, and a failed hop to Funnel is retried here
// within seconds. Requests and responses pass through byte-for-byte, so the
// bot still verifies LINE's signature itself.

const ORIGIN = (process.env.ORIGIN_URL || 'https://steve.tailb73635.ts.net:10000').replace(/\/+$/, '');
const RETRY_DELAYS_MS = [300, 800, 1500];
const ATTEMPT_TIMEOUT_MS = 20000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'forwarded', 'x-real-ip']);
// fetch() has already decoded the body, so the original framing headers are wrong.
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function handler(request) {
  const incoming = new URL(request.url);
  // vercel.json rewrites every path to /api/proxy?__path=<original path>.
  const path = incoming.searchParams.get('__path') || '/';
  incoming.searchParams.delete('__path');
  const query = incoming.searchParams.toString();
  const target = `${ORIGIN}${path.startsWith('/') ? path : `/${path}`}${query ? `?${query}` : ''}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(name) || name.startsWith('x-vercel-') || name.startsWith('x-forwarded-')) continue;
    headers.set(key, value);
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const res = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      });
      if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
        console.warn(`[relay] ${request.method} ${path} -> ${res.status}, retrying (attempt ${attempt + 1})`);
        continue;
      }
      if (attempt > 0) console.log(`[relay] ${request.method} ${path} succeeded on attempt ${attempt + 1}`);

      const outHeaders = new Headers();
      for (const [key, value] of res.headers) {
        if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.append(key, value);
      }
      return new Response(request.method === 'HEAD' ? null : await res.arrayBuffer(), {
        status: res.status,
        headers: outHeaders
      });
    } catch (error) {
      lastError = error;
      // A timeout may mean the bot already received a non-idempotent request
      // (e.g. saving a note); only connection/TLS failures are safe to retry.
      if (error.name === 'TimeoutError') break;
      console.warn(`[relay] ${request.method} ${path} failed: ${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ''} (attempt ${attempt + 1})`);
    }
  }

  console.error(`[relay] ${request.method} ${path} gave up: ${lastError?.message}`);
  return new Response('Bot unreachable', { status: 502 });
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
