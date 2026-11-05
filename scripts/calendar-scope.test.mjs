import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/calendar.html', import.meta.url), 'utf8');
function calendar(search, context = {}) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const sandbox = { URLSearchParams, console, window: { location: { search } }, liff: { getContext: () => context }, document: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext('parseGroupId()', sandbox);
  return sandbox;
}
const scope = (search, context) => vm.runInContext('groupId', calendar(search, context));
test('calendar without group context never silently reads an unrelated ward', () => {
  assert.equal(scope(''), '');
});
test('explicit announcement group takes precedence over LIFF context', () => {
  assert.equal(scope('?groupId=Cnotice', { groupId: 'Cother' }), 'Cnotice');
  assert.equal(scope('', { groupId: 'Ccontext' }), 'Ccontext');
});
test('contextless entry prompts for a group and selecting it fetches that calendar', async () => {
  const sandbox = calendar('');
  const elements = new Map();
  sandbox.document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, { options: [{}], appendChild(option) { this.options.push(option); } });
    return elements.get(id);
  };
  sandbox.document.createElement = () => ({});
  const calls = [];
  sandbox.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => url === '/api/line-groups'
      ? [{ line_group_id: 'Cnotice', group_name: '測試群組' }, { line_group_id: 'Cold', left_at: '2026-01-01' }]
      : [{ title: '課程', date: '2026-11-29' }] };
  };
  await vm.runInContext('fetchEventsList()', sandbox);
  assert.deepEqual(calls, ['/api/line-groups']);
  assert.equal(elements.get('calendar-group-picker').hidden, false);
  assert.equal(elements.get('calendar-group').options.length, 2);
  sandbox.URL = URL;
  sandbox.window.location.href = 'https://example.com/calendar.html';
  sandbox.window.history = { replaceState() {} };
  let rendered;
  sandbox.renderEventsList = events => { rendered = events; };
  await vm.runInContext("selectCalendarGroup('Cnotice')", sandbox);
  assert.equal(calls.at(-1), '/api/events?groupId=Cnotice&absences=1');
  assert.equal(rendered[0].title, '課程');
});
