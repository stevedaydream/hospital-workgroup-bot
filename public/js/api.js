/**
 * Shared fetch patch for the LIFF pages.
 *
 * 1. Attaches the LINE ID token to every same-origin /api/ request.
 *    The server verifies that token against LINE and refuses unknown callers, so
 *    a LIFF page that forgets the header simply stops working. Patching fetch
 *    once here keeps that guarantee without touching every call site.
 *
 * 2. Keeps a copy of every GET answer on the phone (JSON in localStorage,
 *    photos in Cache Storage), so a page draws at once from the last copy while
 *    the server is asked again in the background. When the fresh answer
 *    differs, it is stored and an `api:updated` event ({ detail: { path, key } })
 *    tells the page to draw again; while someone is typing, the event waits
 *    until they leave the field. Any POST/PUT/DELETE drops the copies under the
 *    same /api/<first part>. Case tables and photos are dropped after a day.
 *
 * Never kept: progress polls for background jobs and signed share links, which
 * only make sense live.
 *
 * Usage: include before the page script, then call
 *   window.__setIdToken(liff.getIDToken())
 * immediately after liff.init() resolves.
 */
(function () {
  let idToken = null;
  const originalFetch = window.fetch.bind(window);

  const PREFIX = 'apicache:v2:';
  const IMAGE_CACHE = 'apicache-images-v1';
  const LIVE_ONLY = /^\/api\/(notes\/organize\/|note-reviews\/[^/]+\/organize$|doctor-mappings\/roster-scan\/|images\/[^/]+\/share-link$|test-cron$|users\/sync$)/;
  const IMAGE = /^\/api\/images\/[^/]+$/;
  const SHORT_LIVED = /^\/api\/(dispatch-cache|images\/)/;   // patient data: one day only
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_ENTRY = 1024 * 1024;
  const fresh = new Set();      // keys already checked with the server on this page load
  const waiting = [];           // checks held until the ID token is known

  const store = {
    /** { t, b }: when the copy was saved and its body, or null. */
    entry(key) {
      try {
        const entry = JSON.parse(localStorage.getItem(PREFIX + key));
        if (!entry || (SHORT_LIVED.test(key) && Date.now() - entry.t > DAY)) return null;
        return entry;
      } catch { return null; }
    },
    get(key) { const e = store.entry(key); return e ? e.b : null; },
    set(key, body) {
      try { if (body.length <= MAX_ENTRY) localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), b: body })); } catch { /* full or blocked */ }
    },
    dropWhere(test) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith('apicache:') && (!k.startsWith(PREFIX) || test(k.slice(PREFIX.length)))) localStorage.removeItem(k);
        }
      } catch { /* blocked */ }
    }
  };

  const images = {
    async open() { try { return window.caches ? await caches.open(IMAGE_CACHE) : null; } catch { return null; } },
    async get(key) {
      const c = await images.open();
      const hit = c && await c.match(key);
      if (!hit) return null;
      if (Date.now() - Number(hit.headers.get('X-Cached-At') || 0) > DAY) { c.delete(key); return null; }
      return hit;
    },
    async put(key, res) {
      const c = await images.open();
      if (!c) return;
      const headers = new Headers(res.headers);
      headers.set('X-Cached-At', String(Date.now()));
      await c.put(key, new Response(await res.blob(), { status: 200, headers }));
    },
    async clearOld() {
      const c = await images.open();
      if (!c) return;
      for (const req of await c.keys()) {
        const hit = await c.match(req);
        if (hit && Date.now() - Number(hit.headers.get('X-Cached-At') || 0) > DAY) c.delete(req);
      }
    }
  };
  images.clearOld().catch(() => {});
  store.dropWhere(() => false);   // only removes copies left by an older version of this file

  function withToken(init) {
    if (!idToken) return init;
    const options = init ? Object.assign({}, init) : {};
    options.headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + idToken });
    return options;
  }

  const jsonResponse = body => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-From-Cache': '1' } });

  /** Asks the server and stores a good answer. `changed` is true when an older copy differed. */
  async function fetchAndStore(key, input, init) {
    const res = await originalFetch(input, withToken(init));
    fresh.add(key);
    if (!res.ok) return { res, changed: false };
    if (IMAGE.test(key)) {
      const had = await images.get(key);
      await images.put(key, res.clone()).catch(() => {});
      return { res, changed: !had };
    }
    if (!(res.headers.get('content-type') || '').includes('application/json')) return { res, changed: false };
    const body = await res.clone().text();
    const before = store.get(key);
    store.set(key, body);
    return { res, changed: before !== null && before !== body };
  }

  // Redraws wait while someone is typing, so a fresh answer never wipes what they entered.
  const typing = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  const pending = new Map();
  function announce(key) {
    pending.set(key, { path: key.split('?')[0], key });
    if (typing()) return;
    const all = [...pending.values()];
    pending.clear();
    all.forEach(detail => window.dispatchEvent(new CustomEvent('api:updated', { detail })));
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (!typing() && pending.size) announce([...pending.keys()][0]); }, 0));

  // A small note at the bottom of the page while something drawn from a phone copy
  // is being checked: "顯示 11/17 09:30 的資料，更新中…", then "已更新" (or offline).
  const badge = {
    el: null, oldest: null, checking: 0, offline: false, hideTimer: null,
    stamp(t) {
      const d = new Date(t);
      const today = new Date().toDateString() === d.toDateString();
      const hm = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
      return today ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    },
    draw(text, done) {
      if (!document.body) return void document.addEventListener('DOMContentLoaded', () => badge.draw(text, done), { once: true });
      if (!badge.el) {
        badge.el = document.createElement('div');
        badge.el.setAttribute('role', 'status');
        badge.el.style.cssText = 'position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9999;'
          + 'padding:6px 12px;border-radius:999px;font-size:12px;line-height:1.4;white-space:nowrap;pointer-events:none;transition:opacity .3s;'
          + 'background:rgba(30,41,59,.88);color:#f8fafc;box-shadow:0 2px 8px rgba(0,0,0,.18);';
        document.body.appendChild(badge.el);
      }
      clearTimeout(badge.hideTimer);
      badge.el.textContent = text;
      badge.el.style.opacity = '1';
      if (done) badge.hideTimer = setTimeout(() => { badge.el.style.opacity = '0'; }, 2500);
    },
    shown(t) {
      badge.oldest = badge.oldest === null ? t : Math.min(badge.oldest, t);
      badge.draw(`顯示 ${badge.stamp(badge.oldest)} 的資料，更新中…`);
    },
    start() { badge.checking++; },
    finish(ok) {
      if (!ok) badge.offline = true;
      if (--badge.checking > 0 || badge.oldest === null) return;
      if (badge.offline) badge.draw(`目前連不上，顯示的是 ${badge.stamp(badge.oldest)} 的資料`);
      else badge.draw('已更新為最新資料', true);
      badge.oldest = null;
      badge.offline = false;
    }
  };

  function revalidate(key, input, init) {
    badge.start();
    const run = () => fetchAndStore(key, input, init)
      .then(({ res, changed }) => { badge.finish(res.ok); if (changed && !IMAGE.test(key)) announce(key); })
      .catch(() => badge.finish(false));
    // /api/config needs no token; everything else waits for it (or 5 s, for pages that never sign in).
    if (idToken || key === '/api/config') run();
    else waiting.push(run);
  }

  /** True when the phone holds a copy of this GET, so a page may draw it before LINE sign-in finishes. */
  window.__hasCopy = function (url) {
    const parsed = new URL(url, window.location.origin);
    return store.get(parsed.pathname + parsed.search) !== null;
  };

  /**
   * A query parameter of the link that opened the page. A liff.line.me link first
   * arrives as ?liff.state=%3FgroupId%3D..., and only after liff.init() as
   * ?groupId=..., so both are read to let a page draw before sign-in finishes.
   */
  window.__linkParam = function (name) {
    const params = new URLSearchParams(window.location.search);
    if (params.get(name)) return params.get(name);
    const state = params.get('liff.state') || '';
    return new URLSearchParams(state.includes('?') ? state.slice(state.indexOf('?') + 1) : '').get(name) || '';
  };

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

    if (LIVE_ONLY.test(parsed.pathname)) return originalFetch(input, withToken(init));

    if (IMAGE.test(parsed.pathname)) {
      // A case photo never changes once uploaded, so a stored copy needs no re-check.
      return images.get(key).then(hit => hit || fetchAndStore(key, input, init).then(r => r.res));
    }

    const copy = store.entry(key);
    if (copy === null) return fetchAndStore(key, input, init).then(r => r.res);
    if (!fresh.has(key)) { fresh.add(key); badge.shown(copy.t); revalidate(key, input, init); }
    return Promise.resolve(jsonResponse(copy.b));
  };
})();
