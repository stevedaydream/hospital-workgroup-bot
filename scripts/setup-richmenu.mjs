/**
 * Registers the rich menu with LINE and makes it the default for every chat.
 *
 *   node scripts/build-richmenu.mjs      # draw the image first
 *   node scripts/setup-richmenu.mjs      # upload and activate
 *   node scripts/setup-richmenu.mjs --list
 *   node scripts/setup-richmenu.mjs --clean   # delete every rich menu
 *
 * Re-running replaces the previous menu: the new one is uploaded and set as
 * default, then older ones are removed, so a failed upload never leaves the
 * groups without a menu.
 */

import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_NOTES_ID = process.env.LIFF_NOTES_ID;
const LIFF_DISPATCH_ID = process.env.LIFF_DISPATCH_ID;
const LIFF_CALENDAR_ID = process.env.LIFF_CALENDAR_ID;
const LIFF_ADMIN_ID = process.env.LIFF_ADMIN_ID;

if (!TOKEN) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const IMAGE_PATH = 'assets/richmenu/richmenu.png';

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = [0, 833, 1667];
const COL_WIDTHS = [833, 834, 833];
const ROW_HEIGHT = 843;

const bounds = (index) => ({
  x: COLS[index % 3],
  y: Math.floor(index / 3) * ROW_HEIGHT,
  width: COL_WIDTHS[index % 3],
  height: ROW_HEIGHT
});

const liffUri = (id) => `https://liff.line.me/${id}`;

// Order must match CELLS in build-richmenu.mjs.
const actions = [
  { type: 'uri', label: '交班公告', uri: liffUri(LIFF_NOTES_ID) },
  { type: 'uri', label: '今日分流', uri: liffUri(LIFF_DISPATCH_ID) },
  { type: 'uri', label: '晨會行事曆', uri: liffUri(LIFF_CALENDAR_ID) },
  { type: 'postback', label: '怎麼上傳', data: 'action=help_upload', displayText: '怎麼上傳分配表？' },
  // Reuses the text command the bot already understands.
  { type: 'message', label: '取消轉發', text: '取消轉發' },
  { type: 'uri', label: '管理設定', uri: liffUri(LIFF_ADMIN_ID) }
];

const richMenu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: '病房表單主選單',
  chatBarText: '病房工作選單',
  areas: actions.map((action, index) => ({ bounds: bounds(index), action }))
};

async function api(path, options = {}, host = 'https://api.line.me') {
  const response = await fetch(`${host}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return response.status === 200 ? response.json().catch(() => ({})) : {};
}

async function listMenus() {
  const { richmenus = [] } = await api('/v2/bot/richmenu/list');
  return richmenus;
}

if (args.includes('--list')) {
  const menus = await listMenus();
  console.log(menus.length ? menus.map((m) => `${m.richMenuId}  ${m.name}`).join('\n') : '(none)');
  process.exit(0);
}

if (args.includes('--clean')) {
  for (const menu of await listMenus()) {
    await api(`/v2/bot/richmenu/${menu.richMenuId}`, { method: 'DELETE' });
    console.log(`Deleted ${menu.richMenuId} (${menu.name})`);
  }
  process.exit(0);
}

for (const [name, value] of Object.entries({ LIFF_NOTES_ID, LIFF_DISPATCH_ID, LIFF_CALENDAR_ID, LIFF_ADMIN_ID })) {
  if (!value) {
    console.error(`${name} is not set — the menu would link to a broken URL.`);
    process.exit(1);
  }
}

if (!fs.existsSync(IMAGE_PATH)) {
  console.error(`${IMAGE_PATH} is missing. Run: node scripts/build-richmenu.mjs`);
  process.exit(1);
}

const existing = await listMenus();

const { richMenuId } = await api('/v2/bot/richmenu', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(richMenu)
});
console.log(`Created ${richMenuId}`);

// Image upload goes to the data host, not the API host.
await api(
  `/v2/bot/richmenu/${richMenuId}/content`,
  { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: fs.readFileSync(IMAGE_PATH) },
  'https://api-data.line.me'
);
console.log('Image uploaded');

await api(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
console.log('Set as default for all users');

for (const menu of existing) {
  await api(`/v2/bot/richmenu/${menu.richMenuId}`, { method: 'DELETE' });
  console.log(`Removed previous menu ${menu.richMenuId}`);
}

console.log('\nDone. The menu appears in chats within a minute or two.');
