import test from 'node:test';
import assert from 'node:assert/strict';
const { normalizeTableDate, resolveTableDate, pushSlotPassed, caseWindowDate, normalizeAssignments } = await import('../src/case-table.js');

const at = (date, time) => new Date(`${date}T${time}:00+08:00`);

test('the date printed on the table wins over the upload time', () => {
  // Uploaded at 09:10, after the 07:30 cut-off that used to file it under tomorrow.
  assert.deepEqual(resolveTableDate('2026/11/16', at('2026-11-16', '09:10')), { date: '2026-11-16', warning: null });
  assert.deepEqual(resolveTableDate('2026-11-17', at('2026-11-16', '21:00')), { date: '2026-11-17', warning: null });
});

test('an unreadable or far-off date falls back to the next morning with a warning', () => {
  const far = resolveTableDate('2026/10/01', at('2026-11-16', '09:10'));
  assert.equal(far.date, '2026-11-17');
  assert.match(far.warning, /2026\/10\/01/);
  const none = resolveTableDate(null, at('2026-11-16', '06:00'));
  assert.equal(none.date, '2026-11-16');
  assert.match(none.warning, /看不出/);
});

test('table dates in the formats the AI returns', () => {
  assert.equal(normalizeTableDate('115/11/16', '2026-11-16'), '2026-11-16');
  assert.equal(normalizeTableDate('2026年11月16日', '2026-11-16'), '2026-11-16');
  assert.equal(normalizeTableDate('11/17', '2026-11-16'), '2026-11-17');
  assert.equal(normalizeTableDate('1/1', '2026-12-31'), '2027-01-01');
  assert.equal(normalizeTableDate('2026/02/30', '2026-02-01'), null);
});

test('the case window turns over at 20:00 and the push slot at 07:30', () => {
  assert.equal(caseWindowDate(at('2026-11-16', '00:00')), '2026-11-16');
  assert.equal(caseWindowDate(at('2026-11-16', '20:00')), '2026-11-16');
  assert.equal(caseWindowDate(at('2026-11-16', '20:01')), '2026-11-17');
  assert.equal(pushSlotPassed('2026-11-16', at('2026-11-16', '07:29')), false);
  assert.equal(pushSlotPassed('2026-11-16', at('2026-11-16', '07:30')), true);
  assert.equal(pushSlotPassed('2026-11-17', at('2026-11-16', '23:00')), false);
});

test('NP rows from the AI are cleaned', () => {
  assert.deepEqual(normalizeAssignments([
    { ward: '9B', np: '林小美', tel: 60001, shift: null, doctors: [{ name: '王小明', cases: '5' }, '張阿德', { name: '' }] },
    { np: '', doctors: [] },
    'junk'
  ]), [{ ward: '9B', np: '林小美', tel: '60001', shift: '', doctors: [{ name: '王小明', cases: 5 }, { name: '張阿德', cases: null }] }]);
});
