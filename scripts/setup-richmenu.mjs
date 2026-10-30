// Creates the bot's LINE rich menu (the bar under the chat) and makes it the
// default for every user.
//
//   node scripts/setup-richmenu.mjs           print the menu definition only
//   node scripts/setup-richmenu.mjs --apply   create it, upload the image, set as default,
//                                             and delete older menus with the same name
//
// The image is scripts/richmenu/richmenu.png (2500×843), rendered from
// richmenu.html with headless Edge:
//   msedge --headless=new --window-size=2500,843 --user-data-dir=<tmp> --screenshot=richmenu.png richmenu.html
// Taps on 我的班 / 近期值班 / 功能選單 send plain text, so the bot answers with
// free replies (我的班 in a group goes to the 1:1 chat); 行事曆, MedBase and
// 注意事項 open URLs.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MEDBASE_URL = (process.env.MEDBASE_API_URL || 'https://medbase-mobile.vercel.app').replace(/\/+$/, '');
const NOTES_URL = `https://liff.line.me/${process.env.LIFF_NOTES_ID}`;
const CALENDAR_URL = `https://liff.line.me/${process.env.LIFF_CALENDAR_ID}`;
const IMAGE = path.resolve('scripts/richmenu/richmenu.png');
const MENU_NAME = 'hospital-bot-main';

const W = 2500, H = 843;
const cols = [0, 833, 1666, W];
const rows = [0, 421, H];
const cell = (c, r) => ({ x: cols[c], y: rows[r], width: cols[c + 1] - cols[c], height: rows[r + 1] - rows[r] });

const menu = {
  size: { width: W, height: H },
  selected: true,
  name: MENU_NAME,
  chatBarText: '班表與功能',
  areas: [
    { bounds: cell(0, 0), action: { type: 'message', label: '我的班', text: '我的班' } },
    { bounds: cell(1, 0), action: { type: 'message', label: '近期值班', text: '近期值班' } },
    { bounds: cell(2, 0), action: { type: 'uri', label: '行事曆', uri: CALENDAR_URL } },
    { bounds: cell(0, 1), action: { type: 'uri', label: 'MedBase', uri: `${MEDBASE_URL}/schedule` } },
    { bounds: cell(1, 1), action: { type: 'uri', label: '注意事項', uri: NOTES_URL } },
    { bounds: cell(2, 1), action: { type: 'message', label: '功能選單', text: '主選單' } }
  ]
};

async function line(method, url, body, contentType = 'application/json') {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': contentType } : {}) },
    body: body && contentType === 'application/json' ? JSON.stringify(body) : body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify(menu, null, 2));
  console.log(`\nImage: ${IMAGE} (${fs.statSync(IMAGE).size} bytes). Run with --apply to create it and make it the default.`);
  process.exit(0);
}

if (!TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
if (!process.env.LIFF_NOTES_ID || !process.env.LIFF_CALENDAR_ID) throw new Error('LIFF_NOTES_ID / LIFF_CALENDAR_ID is not set');

const { richMenuId } = await line('POST', 'https://api.line.me/v2/bot/richmenu', menu);
console.log('Created', richMenuId);
await line('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, fs.readFileSync(IMAGE), 'image/png');
console.log('Uploaded image');
await line('POST', `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`);
console.log('Set as default for all users');

const { richmenus = [] } = await line('GET', 'https://api.line.me/v2/bot/richmenu/list');
for (const old of richmenus.filter(m => m.name === MENU_NAME && m.richMenuId !== richMenuId)) {
  await line('DELETE', `https://api.line.me/v2/bot/richmenu/${old.richMenuId}`);
  console.log('Deleted older menu', old.richMenuId);
}
