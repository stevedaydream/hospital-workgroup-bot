import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { medbaseLinkCommand } from '../src/medbase-links.js';

const base = 'https://medbase.example/';
const uri = message => message.contents.footer.contents[0].action.uri;

test('self-pay commands open the existing items route with an encoded search', () => {
  for (const text of ['自費', '自費項目', '自費品項', '自費查詢', '查自費', 'MedBase 自費']) {
    assert.equal(uri(medbaseLinkCommand(text, base)), base + 'items');
  }
  for (const text of ['自費 人工關節 A&B #1', '自費項目：人工關節 A&B #1', 'MedBase 自費 人工關節 A&B #1']) {
    const url = new URL(uri(medbaseLinkCommand(text, base)));
    assert.equal(url.pathname, '/items');
    assert.equal(url.searchParams.get('q'), '人工關節 A&B #1');
    assert.equal(url.hash, '');
  }
  // Search input never becomes the destination URL.
  assert.equal(new URL(uri(medbaseLinkCommand('自費 https://other.example', base))).origin, 'https://medbase.example');
  assert.equal(medbaseLinkCommand('自費 ' + '關'.repeat(500), base).type, 'text');
});

test('MedBase menu links to verified feature routes and leaves unrelated chat alone', () => {
  for (const text of ['MedBase', 'medbase查詢', 'MedBase 查詢', 'MedBase 選單']) {
    const message = medbaseLinkCommand(text, base);
    assert.equal(message.type, 'flex');
    assert.deepEqual(message.contents.footer.contents.map(b => new URL(b.action.uri).pathname), ['/items','/contacts','/sets','/schedule','/memos']);
  }
  for (const text of ['查詢', '今天值班', '我的班', '請問自費多少錢', 'MedBase 自費用多少']) {
    assert.equal(medbaseLinkCommand(text, base), null);
  }
});

test('command handler respects the group switch and navigation needs no API key or network', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('Navigation must not make a network request'); };
    const { medbaseCommand, medbaseEnabled } = await import('./src/medbase.js');
    assert.equal(medbaseEnabled, false);
    const source = { type: 'group', groupId: 'Ctest', userId: 'Utest' };
    const result = await medbaseCommand('MedBase 查詢', source);
    assert.equal(result.type, 'flex');
    assert.equal(new URL(result.contents.footer.contents[0].action.uri).pathname, '/items');
    assert.equal((await medbaseCommand('自費 人工關節', source)).type, 'text');
    assert.deepEqual(await medbaseCommand('MedBase 查詢', source, () => false), {type: 'text', text: 'MedBase 功能查詢功能目前開發測試中...'});
    assert.equal(await medbaseCommand('今天值班', source), null);
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, SQLITE_PATH: ':memory:', MEDBASE_API_KEY: '', MEDBASE_API_URL: 'https://medbase.example' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
