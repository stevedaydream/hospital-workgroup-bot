import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorRoster, mappingDepartment } from '../src/doctor-roster.js';

test('roster keeps only attending names, departments and titles', () => {
  const rows = doctorRoster([
    { name: '王 甲', department: ' 骨科 ', title: '主治醫師', his_account: 'private', his_password: 'secret', ext: '123', notes: 'private' },
    { name: '王甲', department: '骨科', title: '主治醫師' },
    { name: '王甲', department: '泌尿科', title: 'VS' },
    { name: '乙', department: '骨科', title: '住院醫師' },
    { name: '丙', department: '骨科', title: '專科護理師' },
    { name: '', title: '主治醫師' }, null
  ]);
  assert.deepEqual(rows, [
    { name: '王甲', department: '骨科', title: '主治醫師' },
    { name: '王甲', department: '泌尿科', title: 'VS' }
  ]);
  assert.throws(() => doctorRoster(null), /格式錯誤/);
  assert.deepEqual(doctorRoster([]), []);
});

test('a mapping is labelled with the department MedBase lists for it', () => {
  const roster = [
    { name: '王甲', department: '一般外科GS' },
    { name: '李乙', department: '泌尿科URO' },
    { name: '張丙', department: '眼科' },
    { name: '張丙', department: '眼科OPH' }
  ];
  assert.equal(mappingDepartment({ type: 'DIRECT', match_key: '王甲' }, roster), '一般外科');
  assert.equal(mappingDepartment({ type: 'DIRECT', match_key: '張丙' }, roster), '眼科', 'same department spelt two ways');
  assert.equal(mappingDepartment({ type: 'FLEXIBLE', match_key: 'uro' }, roster), '泌尿科');
  assert.equal(mappingDepartment({ type: 'DIRECT', match_key: '不在名單' }, roster), null);
  assert.equal(mappingDepartment({ type: 'DIRECT', match_key: '王甲' }, null), null, 'MedBase unreachable');
});