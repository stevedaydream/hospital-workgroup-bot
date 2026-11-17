import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('schedule and duty answers are reused until a swap or publish clears them', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { getNpNames, clearMedbaseCache, deliverNotice } = await import('./src/medbase.js');
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ok: true, items: [{ name: '王小明' }] }), { status: 200 }); };
    await Promise.all([getNpNames('2026-01-02'), getNpNames('2026-01-02')]);
    assert.equal(calls, 2);                       // day + duty, shared by both questions
    await getNpNames('2026-01-02');
    assert.equal(calls, 2);                       // answered from the cache
    await deliverNotice({ toHis: 'nobody', text: 'x' }, async () => {});
    await getNpNames('2026-01-02');
    assert.equal(calls, 4);                       // a swap notice cleared it
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ok: false, error: 'down' }), { status: 502 }); };
    clearMedbaseCache();
    await getNpNames('2026-01-03');
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ok: true, items: [] }), { status: 200 }); };
    const before = calls;
    await getNpNames('2026-01-03');
    assert.equal(calls, before + 2);              // failures are not kept
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, SQLITE_PATH: ':memory:', MEDBASE_API_KEY: 'test-only', MEDBASE_API_URL: 'https://medbase.example' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
