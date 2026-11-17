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
  const context = { window, localStorage, URL, Response, CustomEvent: class { constructor(type, o) { this.detail = o.detail; } }, setTimeout: () => 0, console };
  vm.runInNewContext(source, context);
  return { fetch: window.fetch, setToken: window.__setIdToken, calls, events, storage };
}

const tick = () => new Promise(r => setTimeout(r, 10));

test('a listed GET is drawn from the phone copy and checked with the server once', async () => {
  const storage = new Map([['apicache:v1:/api/line-groups', '[1]']]);
  const p = page(storage, { '/api/line-groups': '[1,2]' });
  p.setToken('tok');
  assert.equal(await (await p.fetch('/api/line-groups')).text(), '[1]');
  await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].auth, 'Bearer tok');
  assert.equal(storage.get('apicache:v1:/api/line-groups'), '[1,2]');
  assert.deepEqual(p.events.map(e => e.path), ['/api/line-groups']);
  // Redrawing after the event uses the fresh copy without asking again.
  assert.equal(await (await p.fetch('/api/line-groups')).text(), '[1,2]');
  assert.equal(p.calls.length, 1);
});

test('patient data is never kept on the phone', async () => {
  const p = page(new Map(), { '/api/dispatch-cache?msgId=1': '{"x":1}' });
  p.setToken('tok');
  await p.fetch('/api/dispatch-cache?msgId=1');
  await p.fetch('/api/notes');
  assert.equal(p.storage.size, 0);
});

test('a change drops the copies of that area only', async () => {
  const storage = new Map([['apicache:v1:/api/doctor-mappings', '[]'], ['apicache:v1:/api/events?groupId=C1', '[]']]);
  const p = page(storage);
  p.setToken('tok');
  await p.fetch('/api/doctor-mappings/5', { method: 'DELETE' });
  assert.deepEqual([...storage.keys()], ['apicache:v1:/api/events?groupId=C1']);
});

test('the server check waits for the sign-in token', async () => {
  const storage = new Map([['apicache:v1:/api/events', '[]']]);
  const p = page(storage);
  await p.fetch('/api/events');
  await tick();
  assert.equal(p.calls.length, 0);
  p.setToken('tok');
  await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].auth, 'Bearer tok');
});
