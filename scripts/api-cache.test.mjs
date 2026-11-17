import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/api.js', import.meta.url), 'utf8');

/** Loads public/js/api.js into a fake page whose server answers from `answers`. */
function page(storage = new Map(), answers = {}) {
  const calls = [];
  const events = [];
  const localStorage = {
    get length() { return storage.size; },
    key: i => [...storage.keys()][i] ?? null,
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  const window = {
    location: { origin: 'https://bot.test' },
    fetch: async (input, init = {}) => {
      calls.push({ url: input, method: init.method || 'GET', auth: init.headers?.Authorization });
      const body = answers[input] ?? '{}';
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    dispatchEvent: e => events.push(e.detail),
  };
  const document = { activeElement: null, addEventListener() {} };
  const context = { window, document, localStorage, URL, URLSearchParams, Response, CustomEvent: class { constructor(type, o) { this.detail = o.detail; } }, setTimeout: () => 0, clearTimeout: () => {}, console };
  vm.runInNewContext(source, context);
  return { fetch: window.fetch, setToken: window.__setIdToken, calls, events, storage, document, window };
}

const entry = (body, t = Date.now()) => JSON.stringify({ t, b: body });
const bodyOf = v => JSON.parse(v).b;
const tick = () => new Promise(r => setTimeout(r, 10));

test('a listed GET is drawn from the phone copy and checked with the server once', async () => {
  const storage = new Map([['apicache:v2:/api/line-groups', entry('[1]')]]);
  const p = page(storage, { '/api/line-groups': '[1,2]' });
  p.setToken('tok');
  assert.equal(await (await p.fetch('/api/line-groups')).text(), '[1]');
  await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].auth, 'Bearer tok');
  assert.equal(bodyOf(storage.get('apicache:v2:/api/line-groups')), '[1,2]');
  assert.deepEqual(p.events.map(e => e.path), ['/api/line-groups']);
  // Redrawing after the event uses the fresh copy without asking again.
  assert.equal(await (await p.fetch('/api/line-groups')).text(), '[1,2]');
  assert.equal(p.calls.length, 1);
});

test('case tables are kept for one day only', async () => {
  const old = Date.now() - 25 * 60 * 60 * 1000;
  const storage = new Map([['apicache:v2:/api/dispatch-cache?msgId=1', entry('[1]', old)], ['apicache:v2:/api/notes', entry('[1]', old)]]);
  const p = page(storage, { '/api/dispatch-cache?msgId=1': '[2]' });
  p.setToken('tok');
  assert.equal(await (await p.fetch('/api/dispatch-cache?msgId=1')).text(), '[2]');   // expired: asked live
  assert.equal(await (await p.fetch('/api/notes')).text(), '[1]');                    // notes do not expire
});

test('job progress and share links are always asked live', async () => {
  const p = page();
  p.setToken('tok');
  await p.fetch('/api/notes/organize/abc');
  await p.fetch('/api/images/1/share-link');
  assert.equal(p.storage.size, 0);
});

test('a redraw waits while someone is typing', async () => {
  const storage = new Map([['apicache:v2:/api/notes', entry('[1]')]]);
  const p = page(storage, { '/api/notes': '[2]' });
  p.document.activeElement = { tagName: 'TEXTAREA' };
  p.setToken('tok');
  await p.fetch('/api/notes');
  await tick();
  assert.equal(p.events.length, 0);
});

test('a change drops the copies of that area only', async () => {
  const storage = new Map([['apicache:v2:/api/doctor-mappings', entry('[]')], ['apicache:v2:/api/events?groupId=C1', entry('[]')]]);
  const p = page(storage);
  p.setToken('tok');
  await p.fetch('/api/doctor-mappings/5', { method: 'DELETE' });
  assert.deepEqual([...storage.keys()], ['apicache:v2:/api/events?groupId=C1']);
});

test('the server check waits for the sign-in token', async () => {
  const storage = new Map([['apicache:v2:/api/events', entry('[]')]]);
  const p = page(storage);
  await p.fetch('/api/events');
  await tick();
  assert.equal(p.calls.length, 0);
  p.setToken('tok');
  await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].auth, 'Bearer tok');
});

test('a note says when the copy on screen was saved, then that it is up to date', async () => {
  const saved = new Date(2026, 10, 16, 9, 5).getTime();
  const storage = new Map([['apicache:v2:/api/travels', entry('[1]', saved)]]);
  const p = page(storage, { '/api/travels': '[1]' });
  const note = { style: {}, setAttribute() {}, textContent: '' };
  p.document.body = { appendChild() {} };
  p.document.createElement = () => note;
  p.setToken('tok');
  await p.fetch('/api/travels');
  assert.match(note.textContent, /^顯示 11\/16 09:05 的資料/);
  await tick();
  assert.equal(note.textContent, '已更新為最新資料');
});

test('link parameters are read before LINE unwraps liff.state', () => {
  const p = page();
  p.window.location.search = '?liff.state=' + encodeURIComponent('?groupId=C123&absences=1');
  assert.equal(p.window.__linkParam('groupId'), 'C123');
  p.window.location.search = '?groupId=C456';
  assert.equal(p.window.__linkParam('groupId'), 'C456');
  p.window.location.search = '';
  assert.equal(p.window.__linkParam('groupId'), '');
});
