import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTravel, calendarAbsences } from '../src/travel.js';

const form = { kind: '休假', traveler: '測試醫師', departDate: '2026-10-31', returnDate: '2026-11-02', leavePeriod: '上午' };

test('validates calendar dates, order, type and half-day period', () => {
  for (const patch of [{departDate:'2026-02-30'}, {returnDate:'2026-10-01'}, {leavePeriod:'晚間'}, {kind:'invalid'}]) {
    assert.ok(parseTravel({...form, ...patch}).error);
  }
  assert.ok(parseTravel(null).error);
  const {trip} = parseTravel({...form, departTime:'09:00', departFlight:'BR123'});
  assert.equal(trip.leave_period, '上午');
  assert.equal(trip.depart_time, null);
  assert.equal(trip.depart_flight, null);
  assert.equal(parseTravel({...form,kind:'長假',leavePeriod:undefined}).trip.kind, '休假');
  assert.equal(parseTravel({...form,kind:'長假',leavePeriod:undefined}).trip.leave_period, '全天');
  assert.equal(parseTravel({...form,kind:'出國',departTime:'23:59'}).trip.depart_time, '23:59');
  assert.ok(parseTravel({...form,kind:'出國',departTime:'24:00'}).error);
});

test('daily calendar view flags only matching report periods and never changes events', () => {
  const t = {...parseTravel(form).trip,id:1,updated_by:'測試',deputy:'代理醫師'};
  const events = [
    {id:1,date:'2026-10-31',time:'08:00',title:'測試醫師 報告'},
    {id:2,date:'2026-10-31',time:'14:00',title:'測試醫師 報告'},
    {id:3,date:'2026-10-31',time:'08:00',title:'其他醫師 報告'},
    {id:4,date:'2026-10-31',time:'08:00',title:'院務會議 (停開晨會報告)',description:'測試醫師'},
  ];
  const before = structuredClone(events);
  const rows = calendarAbsences([t],events,'2026-10-31');
  assert.equal(rows.length,3);
  assert.deepEqual(rows[0].conflicts,['測試醫師 報告']);
  assert.match(rows[0].description,/代理：代理醫師/);
  assert.deepEqual(events,before);
  assert.equal(calendarAbsences([{...t,leave_period:'下午'}],events,'2026-10-31')[0].conflicts.length,1);
  assert.equal(calendarAbsences([{...t,leave_period:'全天'}],events,'2026-10-31')[0].conflicts.length,2);
  assert.equal(calendarAbsences([{...t,kind:'出國'}],events,'2026-10-31')[0].conflicts.length,2);
});

test('shows dates outside the 90-day horizon when there are scheduled events', () => {
  const t = {...parseTravel({...form,departDate:'2027-06-01',returnDate:'2027-06-02'}).trip,id:2};
  assert.equal(calendarAbsences([t],[],'2026-10-31').length,0);
  assert.equal(calendarAbsences([t],[{date:'2027-06-02',title:'例會'}],'2026-10-31')[0].date,'2027-06-02');
  assert.deepEqual(calendarAbsences([{...t,depart_date:'2026-02-30'}],[],'2026-10-31'), []);
});

test('migrates legacy long leave without losing dates, deputy or audit history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hospital-leave-migration-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import assert from 'node:assert/strict';
      const sqlite = new Database(process.env.SQLITE_PATH);
      sqlite.exec(\`CREATE TABLE travel_registrations (
        id INTEGER PRIMARY KEY, kind TEXT, traveler TEXT, destination TEXT, purpose TEXT,
        depart_date TEXT, depart_time TEXT, depart_flight TEXT,
        return_date TEXT, return_time TEXT, return_flight TEXT,
        deputy TEXT, note TEXT, created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT
      ); INSERT INTO travel_registrations (id,kind,traveler,depart_date,return_date,deputy,note,created_by,created_at)
        VALUES (1,'長假','測試醫師','2026-10-31','2026-11-02','代理醫師','保留備註','原登記者','2026-10-01');\`);
      sqlite.close();
      const {db} = await import('./src/db.js');
      const old = db.travels.get(1);
      assert.equal(old.kind, '休假');
      assert.equal(old.leave_period, '全天');
      assert.equal(old.depart_date, '2026-10-31');
      assert.equal(old.return_date, '2026-11-02');
      assert.equal(old.deputy, '代理醫師');
      assert.equal(old.note, '保留備註');
      assert.equal(old.created_by, '原登記者');
      assert.equal(old.created_at, '2026-10-01');
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, SQLITE_PATH: join(dir, 'legacy.sqlite') }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
