/**
 * Deterministic parsing of spreadsheet uploads.
 *
 * The daily case table originates as an Excel file; the photographs in the
 * group are pictures of that file on someone's screen. Asking a 4B vision
 * model to recover structure from those pixels is solving a problem that only
 * exists because the structured original was thrown away. When the file itself
 * is sent, accuracy is exact and inference cost is zero.
 *
 * Supported: .xlsx, .csv. Not supported: the legacy binary .xls, and .xlsm
 * (LINE often blocks macro-enabled files anyway) -- both should be re-saved as
 * .xlsx or .csv.
 */

import ExcelJS from 'exceljs';

const DEPARTMENT_CODES = new Set([
  'PS', 'ORTHO', 'URO', 'CVS', 'CS', 'ENT', 'OPH', 'NS', 'GS', 'CRS', 'PLASTY', 'NEURO', 'OBS', 'GYN'
]);

const NAME_HEADERS = ['姓名', '醫師', '醫生', '名字', 'name', 'doctor'];
const DEPARTMENT_HEADERS = ['科別', '科', '部門', 'department', 'dept'];

const cellToString = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
    return '';
  }
  return String(value).trim();
};

/** Reads any supported upload into a plain grid of strings. */
export async function readGrid(buffer, filename = '') {
  const extension = filename.toLowerCase().split('.').pop();

  if (extension === 'csv') {
    return buffer
      .toString('utf-8')
      .replace(/^﻿/, '') // Excel writes a BOM
      .split(/\r?\n/)
      .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')));
  }

  if (extension === 'xls' || extension === 'xlsm') {
    throw new Error(`不支援 .${extension} 格式，請在 Excel 中「另存新檔」為 .xlsx 或 .csv 後再上傳。`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('這個檔案裡沒有任何工作表。');

  const grid = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellToString(cell.value)));
    grid.push(cells);
  });
  return grid;
}

const normaliseHeader = (value) => value.toLowerCase().replace(/\s/g, '');

/**
 * Roster import. Two layouts are accepted:
 *
 *   A. one row per doctor, with 姓名 / 科別 header columns
 *   B. one column per department, the code as the header and names below --
 *      the shape of the reference block printed at the bottom of the real
 *      case table
 *
 * @returns {Array<{name: string, department: string}>}
 */
export function parseRoster(grid) {
  const headerRowIndex = grid.findIndex((row) =>
    row.some((cell) => NAME_HEADERS.includes(normaliseHeader(cell)))
  );

  if (headerRowIndex >= 0) {
    const header = grid[headerRowIndex].map(normaliseHeader);
    const nameColumn = header.findIndex((cell) => NAME_HEADERS.includes(cell));
    const deptColumn = header.findIndex((cell) => DEPARTMENT_HEADERS.includes(cell));

    if (deptColumn === -1) {
      throw new Error('找到了姓名欄，但缺少「科別」欄位，請確認表頭。');
    }

    const entries = [];
    for (const row of grid.slice(headerRowIndex + 1)) {
      const name = (row[nameColumn] || '').trim();
      const department = (row[deptColumn] || '').trim().toUpperCase();
      if (name && department) entries.push({ name, department });
    }
    return dedupeByName(entries);
  }

  // Layout B: find the row that looks like a header of department codes.
  const codeRowIndex = grid.findIndex(
    (row) => row.filter((cell) => DEPARTMENT_CODES.has(cell.toUpperCase())).length >= 2
  );
  if (codeRowIndex === -1) {
    throw new Error('看不出名冊格式：請提供「姓名／科別」兩欄，或以科別代號作為欄標題。');
  }

  const columnDepartments = grid[codeRowIndex].map((cell) =>
    DEPARTMENT_CODES.has(cell.toUpperCase()) ? cell.toUpperCase() : null
  );

  const entries = [];
  for (const row of grid.slice(codeRowIndex + 1)) {
    row.forEach((cell, column) => {
      const department = columnDepartments[column];
      const name = (cell || '').trim();
      // A department code appearing again marks the start of a new block.
      if (department && name && !DEPARTMENT_CODES.has(name.toUpperCase())) {
        entries.push({ name, department });
      }
    });
  }

  if (entries.length === 0) {
    throw new Error('找到了科別欄標題，但底下沒有任何人名。');
  }
  return dedupeByName(entries);
}

function dedupeByName(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.name)) seen.set(entry.name, entry);
  }
  return [...seen.values()];
}

const DATE_PATTERNS = [
  /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/, // 2026年5月28日 / 2026/5/28
  /(\d{3})[年/-](\d{1,2})[月/-](\d{1,2})/ // 民國 115/05/28
];

function findDate(grid) {
  for (const row of grid.slice(0, 8)) {
    for (const cell of row) {
      for (const pattern of DATE_PATTERNS) {
        const match = cell.match(pattern);
        if (!match) continue;
        let year = parseInt(match[1], 10);
        if (year < 1000) year += 1911; // ROC -> AD
        const month = String(parseInt(match[2], 10)).padStart(2, '0');
        const day = String(parseInt(match[3], 10)).padStart(2, '0');
        return `${year}/${month}/${day}`;
      }
    }
  }
  return null;
}

/**
 * Case table import.
 *
 * The sheet has two distinct regions: today's assignment rows at the top, and
 * a departmental roster at the bottom. Only the top matters -- treating the
 * bottom block as "on duty today" is what would forward the table to every
 * group. The boundary is detected as the first row that carries several
 * department codes at once, which is how that reference block is headed.
 *
 * @param {string[][]} grid
 * @param {Array<{name: string, department: string, aliases: string[]}>} roster
 */
export function parseCaseTable(grid, roster) {
  const rosterNames = new Map();
  for (const doctor of roster) {
    rosterNames.set(doctor.name, doctor);
    for (const alias of doctor.aliases || []) rosterNames.set(alias, doctor);
  }

  let boundary = grid.findIndex(
    (row) => row.filter((cell) => DEPARTMENT_CODES.has(cell.toUpperCase())).length >= 3
  );
  if (boundary === -1) boundary = grid.length;

  const assignments = [];
  const seen = new Set();

  grid.slice(0, boundary).forEach((row) => {
    // A department code on the same row applies to the names on that row.
    const rowDepartment =
      row.map((cell) => cell.toUpperCase()).find((cell) => DEPARTMENT_CODES.has(cell)) || '';

    for (const cell of row) {
      const name = (cell || '').trim();
      if (!name || !rosterNames.has(name)) continue;

      const doctor = rosterNames.get(name);
      const key = doctor.name;
      if (seen.has(key)) continue;
      seen.add(key);

      assignments.push({
        doctor: doctor.name,
        department: (doctor.department || rowDepartment).toUpperCase()
      });
    }
  });

  return { date: findDate(grid), assignments, boundaryRow: boundary };
}
