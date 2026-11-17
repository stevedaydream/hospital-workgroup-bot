/**
 * Shared fetch patch for the LIFF pages.
 *
 * 1. Attaches the LINE ID token to every same-origin /api/ request.
 *    The server verifies that token against LINE and refuses unknown callers, so
 *    a LIFF page that forgets the header simply stops working. Patching fetch
 *    once here keeps that guarantee without touching every call site.
 *
 * 2. Keeps a copy of a few non-sensitive GET responses on the phone
 *    (localStorage), so a page draws at once from the last copy while the
 *    server is asked again in the background. When the fresh answer differs,
 *    it is stored and an `api:updated` event ({ detail: { path } }) tells the
 *    page to draw again. Patient data (case tables, photos, notes) is never kept.
 *    Any POST/PUT/DELETE drops the copies under the same /api/<first part>.
 *
 * Usage: include before the page script, then call
 *   window.__setIdToken(liff.getIDToken())
 * immediately after liff.init() resolves.
 */
(function () {
  let idToken = null;
  const originalFetch = window.fetch.bind(window);

  const CACHE_PREFIX = 'apicache:v1:';
  const CACHEABLE = /^\/api\/(config|line-groups|doctor-mappings|doctor-mappings\/medbase-roster|group-features|medbase\/groups|events|travels)$/;
  const MAX_ENTRY = 500 * 1024;
  const fresh = new Set();      // keys already checked with the server on this page load
  const waiting = [];           // checks held until the ID token is known

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { if (value.length <= MAX_ENTRY) localStorage.setItem(key, value); } catch { /* full or blocked */ } },
    dropWhere(test) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith(CACHE_PREFIX) && test(k.slice(CACHE_PREFIX.length))) localStorage.removeItem(k);
        }
      } catch { /* blocked */ }
    }
  };

  function withToken(init) {
    if (!idToken) return init;
    const options = init ? Object.assign({}, init) : {};
    options.headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + idToken });
    return options;
  }

  const jsonResponse = body => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-From-Cache': '1' } });

  async function fetchAndStore(key, input, init) {
    const res = await originalFetch(input, withToken(init));
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const body = await res.clone().text();
      const before = store.get(CACHE_PREFIX + key);
      store.set(CACHE_PREFIX + key, body);
      fresh.add(key);
      return { res, changed: before !== null && before !== body };
    }
    return { res, changed: false };
  }

  function revalidate(key, input, init) {
    const run = () => fetchAndStore(key, input, init)
      .then(({ changed }) => { if (changed) window.dispatchEvent(new CustomEvent('api:updated', { detail: { path: key.split('?')[0], key } })); })
      .catch(() => { /* offline: keep the copy */ });
    // /api/config needs no token; everything else waits for it (or 5 s, for pages that never sign in).
    if (idToken || key === '/api/config') run();
    else waiting.push(run);
  }

  window.__setIdToken = function (token) {
    idToken = token || null;
    if (idToken) waiting.splice(0).forEach(run => run());
  };
  setTimeout(() => waiting.splice(0).forEach(run => run()), 5000);

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isInternalApi = url.startsWith('/api/') || url.startsWith(window.location.origin + '/api/');
    if (!isInternalApi) return originalFetch(input, init);

    const parsed = new URL(url, window.location.origin);
    const key = parsed.pathname + parsed.search;
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    if (method !== 'GET') {
      const area = parsed.pathname.split('/')[2];
      if (area !== 'users') store.dropWhere(k => k.split('/')[2] === area);
      fresh.clear();
      return originalFetch(input, withToken(init));
    }

    if (!CACHEABLE.test(parsed.pathname)) return originalFetch(input, withToken(init));

    const cached = store.get(CACHE_PREFIX + key);
    if (cached === null) return fetchAndStore(key, input, init).then(r => r.res);
    if (!fresh.has(key)) { fresh.add(key); revalidate(key, input, init); }
    return Promise.resolve(jsonResponse(cached));
  };
})();
