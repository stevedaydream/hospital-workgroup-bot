/**
 * Draws the rich menu image.
 *
 * Same vocabulary as the LIFF pages: a ruled form rather than a tile grid.
 * Each cell carries the identifier it corresponds to in mono, the action in
 * Ming, and — for the two cells that need a person to decide something today —
 * a ballpoint underline. Ink is what the system does on its own; pen is what
 * still needs someone.
 *
 *   node scripts/build-richmenu.mjs
 *
 * Renders with system CJK fonts, so run it on a machine that has them (any
 * Windows or macOS box) and commit the PNG. The OCI server never needs fonts.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = [0, 833, 1667];
const COL_WIDTHS = [833, 834, 833];
const ROWS = [0, 843];
const ROW_HEIGHT = 843;

const PAPER = '#f6f4ef';
const INK = '#191b20';
const INK_FAINT = '#8d9199';
const RULE = '#d8d3c7';
const PEN = '#c9256a';
const SANS = 'Microsoft JhengHei, PingFang TC, Noto Sans TC, sans-serif';
const SERIF = 'PMingLiU, Songti TC, Noto Serif TC, serif';
const MONO = 'Consolas, Menlo, monospace';

export const CELLS = [
  { code: 'NOTES',    label: '交班公告',   hint: '共同編輯注意事項' },
  { code: 'DISPATCH', label: '今日分流',   hint: '確認明早轉發對象', pen: true },
  { code: 'CALENDAR', label: '晨會行事曆', hint: '報告輪序與活動' },
  { code: 'UPLOAD',   label: '怎麼上傳',   hint: '照片與檔案說明' },
  { code: 'CANCEL',   label: '取消轉發',   hint: '停掉明早的發送',   pen: true },
  { code: 'ADMIN',    label: '管理設定',   hint: '群組對照與名冊' }
];

const escapeXml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cellSvg(cell, index) {
  const column = index % 3;
  const row = Math.floor(index / 3);
  const x = COLS[column];
  const y = ROWS[row];
  const width = COL_WIDTHS[column];
  const padding = 64;

  // A ballpoint stroke: drawn, not ruled, so it reads as added by hand.
  const penStroke = cell.pen
    ? `<path d="M ${x + padding} ${y + 508} C ${x + padding + 90} ${y + 498}, ${x + padding + 180} ${y + 518}, ${x + padding + 268} ${y + 504} S ${x + padding + 360} ${y + 494}, ${x + width - padding - 20} ${y + 508}"
         fill="none" stroke="${PEN}" stroke-width="7" stroke-linecap="round" opacity="0.9"/>`
    : '';

  return `
    <text x="${x + padding}" y="${y + 200}" font-family="${MONO}" font-size="40"
          letter-spacing="7" fill="${INK_FAINT}">${cell.code}</text>
    <text x="${x + padding}" y="${y + 470}" font-family="${SERIF}" font-size="112"
          letter-spacing="10" fill="${cell.pen ? PEN : INK}">${escapeXml(cell.label)}</text>
    ${penStroke}
    <text x="${x + padding}" y="${y + 630}" font-family="${SANS}" font-size="46"
          fill="${INK_FAINT}">${escapeXml(cell.hint)}</text>`;
}

const rules = [
  // Vertical rules between columns
  `<line x1="${COLS[1]}" y1="0" x2="${COLS[1]}" y2="${HEIGHT}" stroke="${RULE}" stroke-width="3"/>`,
  `<line x1="${COLS[2]}" y1="0" x2="${COLS[2]}" y2="${HEIGHT}" stroke="${RULE}" stroke-width="3"/>`,
  // The horizontal rule is heavier: it separates the daily loop (top) from
  // the things you only touch occasionally (bottom).
  `<line x1="0" y1="${ROW_HEIGHT}" x2="${WIDTH}" y2="${ROW_HEIGHT}" stroke="${INK}" stroke-width="5"/>`
].join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  ${rules}
  ${CELLS.map(cellSvg).join('\n')}
  <rect x="2" y="2" width="${WIDTH - 4}" height="${HEIGHT - 4}" fill="none" stroke="${INK}" stroke-width="5"/>
</svg>`;

const outputDir = 'assets/richmenu';
fs.mkdirSync(outputDir, { recursive: true });

const pngPath = path.join(outputDir, 'richmenu.png');
await sharp(Buffer.from(svg)).png({ quality: 90 }).toFile(pngPath);
fs.writeFileSync(path.join(outputDir, 'richmenu.svg'), svg);

const { size } = fs.statSync(pngPath);
console.log(`Wrote ${pngPath} (${(size / 1024).toFixed(0)} KB, ${WIDTH}x${HEIGHT})`);
if (size > 1024 * 1024) {
  console.warn('LINE rejects rich menu images above 1MB — reduce detail or recompress.');
}
