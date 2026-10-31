import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorRoster } from '../src/doctor-roster.js';

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
