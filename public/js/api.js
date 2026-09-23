/**
 * Attaches the LINE ID token to every same-origin /api/ request.
 *
 * The server verifies that token against LINE and refuses unknown callers, so
 * a LIFF page that forgets the header simply stops working. Patching fetch
 * once here keeps that guarantee without touching every call site.
 *
 * Usage: include before the page script, then call
 *   window.__setIdToken(liff.getIDToken())
 * immediately after liff.init() resolves.
 */
(function () {
  let idToken = null;

  window.__setIdToken = function (token) {
    idToken = token || null;
  };

  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isInternalApi = url.startsWith('/api/') || url.startsWith(window.location.origin + '/api/');

    if (!idToken || !isInternalApi) {
      return originalFetch(input, init);
    }

    const options = init ? Object.assign({}, init) : {};
    options.headers = Object.assign({}, options.headers || {}, {
      Authorization: 'Bearer ' + idToken
    });

    return originalFetch(input, options);
  };
})();
