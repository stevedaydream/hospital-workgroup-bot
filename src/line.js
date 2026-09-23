import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { db } from './db.js';
import { analyzeImages } from './ai/index.js';
import { buildDispatchProposal } from './roster.js';
import { readGrid, parseCaseTable } from './parsers/workbook.js';
import { todayInTaipei, tomorrowInTaipei } from './util/date.js';

dotenv.config();

// In-memory sessions to debounce and group consecutive image uploads
const imageGroupSessions = new Map();
const GROUP_WINDOW_MS = 10000; // 10-second wait window for consecutive uploads

// How long a proposed dispatch waits for a human before adopting itself. A
// confirmation step that can silently expire is worse than no confirmation
// step: "nobody tapped" must not mean "nothing was sent".
const CONFIRM_GRACE_HOURS = parseFloat(process.env.CONFIRM_GRACE_HOURS || '2');

// Spreadsheets carry the case table exactly; photographs only approximate it.
const SPREADSHEET_EXTENSIONS = ['xlsx', 'csv', 'xls', 'xlsm'];

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LIFF_NOTES_ID = process.env.LIFF_NOTES_ID;
const LIFF_DISPATCH_ID = process.env.LIFF_DISPATCH_ID;

// Ensure directories exist
const IMAGES_DIR = path.resolve('public/images');
fs.mkdir(IMAGES_DIR, { recursive: true }).catch(console.error);

// ----------------------------------------------------
// Signature Verification
// ----------------------------------------------------
export function verifySignature(rawBody, signature) {
  if (!signature || !LINE_CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

// ----------------------------------------------------
// LINE API Helpers
// ----------------------------------------------------
export async function replyMessage(replyToken, messages) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: Array.isArray(messages) ? messages : [messages]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE reply error:', errorText);
    }
  } catch (error) {
    console.error('Error sending LINE reply:', error);
  }
}

export async function pushMessage(to, messages) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to,
        messages: Array.isArray(messages) ? messages : [messages]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`LINE push error to ${to}:`, errorText);
    }
  } catch (error) {
    console.error(`Error sending LINE push to ${to}:`, error);
  }
}

async function downloadMessageContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download LINE content: ${response.statusText}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

// ----------------------------------------------------
// Rich Flex Messages (JSON)
// ----------------------------------------------------

function getMainMenuFlex(sourceId) {
  const liffUrl = `https://liff.line.me/${LIFF_NOTES_ID}?groupId=${sourceId}`;
  const adminLiffUrl = `https://liff.line.me/${process.env.LIFF_ADMIN_ID || 'placeholder_admin_liff_id'}?groupId=${sourceId}`;
  const calendarLiffUrl = `https://liff.line.me/${process.env.LIFF_CALENDAR_ID || 'placeholder_calendar_liff_id'}?groupId=${sourceId}`;
  const dispatchLiffUrl = `https://liff.line.me/${LIFF_DISPATCH_ID}?groupId=${sourceId}`;
  
  return {
    type: "flex",
    altText: "醫院工作群組優化助手 - 主選單",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f4ef",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手",
            color: "#191b20",
            weight: "bold",
            size: "xl"
          },
          {
            type: "text",
            text: "Hospital Workgroup Assistant",
            color: "#62666f",
            size: "xs",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f4ef",
        paddingAll: "20px",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "💡 便捷功能選單",
            color: "#191b20",
            weight: "bold",
            size: "md"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "📝 共同編輯注意事項",
              uri: liffUrl
            },
            style: "primary",
            color: "#191b20",
            height: "sm"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "📅 病房行事曆與行程",
              uri: calendarLiffUrl
            },
            style: "primary",
            color: "#c9256a",
            height: "sm",
            margin: "md"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "🔍 審查今日 Case 分流",
              uri: dispatchLiffUrl
            },
            style: "primary",
            color: "#c9256a",
            height: "sm",
            margin: "md"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "⚙️ ID 與對照管理後台",
              uri: adminLiffUrl
            },
            style: "primary",
            color: "#b3261e",
            height: "sm",
            margin: "md"
          },
          {
            type: "separator",
            color: "#d8d3c7",
            margin: "md"
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            margin: "md",
            contents: [
              {
                type: "text",
                text: "📋 Case 分配表自動分流指引：",
                color: "#62666f",
                size: "xs",
                weight: "bold"
              },
              {
                type: "text",
                text: "• 直接在此群組上傳今日「分配表照片」",
                color: "#3d4149",
                size: "xs"
              },
              {
                type: "text",
                text: "• 系統將自動辨識醫師人名與科別",
                color: "#3d4149",
                size: "xs"
              },
              {
                type: "text",
                text: "• 於每日早上 07:30 自動分流發送至各科室群組",
                color: "#3d4149",
                size: "xs"
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#efece4",
        contents: [
          {
            type: "text",
            text: "設計給臨床同仁的行政貼心工具",
            color: "#8d9199",
            size: "xxs",
            align: "center",
            margin: "xs"
          }
        ]
      }
    }
  };
}

function getAutoNotesAddedFlex(addedNotes, sourceId) {
  const liffUrl = `https://liff.line.me/${LIFF_NOTES_ID}?groupId=${sourceId}`;
  const contents = [
    {
      type: "text",
      text: "✨ AI 已自動新增病房公告",
      weight: "bold",
      size: "md",
      color: "#191b20"
    },
    {
      type: "text",
      text: "偵測到公告內容，已自動儲存至病房注意事項管理目錄：",
      color: "#62666f",
      size: "xs",
      margin: "sm",
      wrap: true
    },
    {
      type: "separator",
      color: "#d8d3c7",
      margin: "md"
    }
  ];

  addedNotes.forEach((note, idx) => {
    contents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        {
          type: "text",
          text: `📌 類別/標題：${note.title}`,
          color: "#1d6b53",
          weight: "bold",
          size: "sm"
        },
        {
          type: "text",
          text: note.content,
          color: "#62666f",
          size: "xs",
          wrap: true
        }
      ]
    });
    if (idx < addedNotes.length - 1) {
      contents.push({
        type: "separator",
        color: "#efece4",
        margin: "md"
      });
    }
  });

  contents.push({
    type: "separator",
    color: "#d8d3c7",
    margin: "md"
  });

  contents.push({
    type: "button",
    action: {
      type: "uri",
      label: "📝 開啟注意事項目錄",
      uri: liffUrl
    },
    style: "primary",
    color: "#1d6b53",
    margin: "md",
    height: "sm"
  });

  return {
    type: "flex",
    altText: "AI 圖片自動新增公告通知",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1d6b53",
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手 - 公告系統",
            color: "#191b20",
            weight: "bold",
            size: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f4ef",
        paddingAll: "20px",
        spacing: "xs",
        contents: contents
      }
    }
  };
}

function getAutoCalendarAddedFlex(addedEvents, sourceId) {
  const liffUrl = `https://liff.line.me/${process.env.LIFF_CALENDAR_ID || 'placeholder_calendar_liff_id'}?groupId=${sourceId}`;
  const contents = [
    {
      type: "text",
      text: "📅 AI 已自動新增行程活動",
      weight: "bold",
      size: "md",
      color: "#191b20"
    },
    {
      type: "text",
      text: "偵測到行事曆排程，已自動儲存至病房行事曆：",
      color: "#62666f",
      size: "xs",
      margin: "sm",
      wrap: true
    },
    {
      type: "separator",
      color: "#d8d3c7",
      margin: "md"
    }
  ];

  addedEvents.forEach((evt, idx) => {
    let timeStr = evt.time ? ` ⏰ ${evt.time}` : '';
    let locStr = evt.location ? ` 📍 ${evt.location}` : '';
    
    contents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        {
          type: "text",
          text: `📌 ${evt.date}${timeStr}${locStr}`,
          color: "#c9256a",
          weight: "bold",
          size: "xs"
        },
        {
          type: "text",
          text: evt.title,
          color: "#62666f",
          weight: "bold",
          size: "sm",
          wrap: true
        },
        evt.description ? {
          type: "text",
          text: evt.description,
          color: "#62666f",
          size: "xs",
          wrap: true
        } : null
      ].filter(Boolean)
    });
    if (idx < addedEvents.length - 1) {
      contents.push({
        type: "separator",
        color: "#efece4",
        margin: "md"
      });
    }
  });

  contents.push({
    type: "separator",
    color: "#d8d3c7",
    margin: "md"
  });

  contents.push({
    type: "button",
    action: {
      type: "uri",
      label: "📅 開啟病房行事曆",
      uri: liffUrl
    },
    style: "primary",
    color: "#c9256a",
    margin: "md",
    height: "sm"
  });

  return {
    type: "flex",
    altText: "AI 圖片自動新增行程通知",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#191b20",
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手 - 行事曆系統",
            color: "#191b20",
            weight: "bold",
            size: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f4ef",
        paddingAll: "20px",
        spacing: "xs",
        contents: contents
      }
    }
  };
}

/**
 * Best-effort display name for whoever tapped a confirmation button.
 * Falls back quietly: knowing *that* it was confirmed matters more than by whom.
 */
async function resolveDisplayName(source) {
  const userId = source?.userId;
  if (!userId) return '同仁';

  const known = await db.users.getByLineUserId(userId);
  if (known) return known.display_name;

  const endpoint = source.groupId
    ? `https://api.line.me/v2/bot/group/${source.groupId}/member/${userId}`
    : `https://api.line.me/v2/bot/profile/${userId}`;

  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    if (!response.ok) return '同仁';
    const profile = await response.json();
    return profile.displayName || '同仁';
  } catch {
    return '同仁';
  }
}

/** The image a spreadsheet upload should be attached to. */
async function findLatestImageMessageId(sourceId) {
  const record = await db.group_last_image.get(sourceId);
  return record?.message_id || null;
}

/**
 * Builds the confirmation card for a proposed dispatch.
 *
 * Every name is shown with the department it will route by, because a bare
 * list of names is not checkable -- the reader cannot tell a missing row from
 * a complete one. Corrected and unmatched names are called out separately:
 * those are precisely where the model is most likely to have gone wrong.
 */
function getDispatchConfirmFlex(confirmation) {
  const { matched, unmatched, targets, dateWarning, origin } = confirmation.payload;
  const contents = [
    {
      type: "text",
      text: "📋 請確認今日 Case 分流",
      weight: "bold",
      size: "md",
      color: "#191b20"
    },
    {
      type: "text",
      text: `來源：${origin}　發送時間：${confirmation.dispatch_date} 07:30`,
      color: "#8d9199",
      size: "xxs",
      margin: "xs"
    }
  ];

  if (dateWarning) {
    contents.push({
      type: "text",
      text: `⚠️ ${dateWarning}`,
      color: "#b3261e",
      weight: "bold",
      size: "xs",
      margin: "md",
      wrap: true
    });
  }

  contents.push({
    type: "text",
    text: "【讀到的今日人員】",
    color: "#62666f",
    size: "xs",
    margin: "md",
    weight: "bold"
  });

  if (matched.length > 0) {
    matched.forEach(entry => {
      contents.push({
        type: "text",
        text: entry.corrected
          ? `• ${entry.name}（${entry.department}）← 原讀作「${entry.ocrName}」`
          : `• ${entry.name}（${entry.department}）`,
        color: entry.corrected ? "#fbbf24" : "#cbd5e1",
        size: "xs",
        margin: "xs",
        wrap: true
      });
    });
  } else {
    contents.push({
      type: "text",
      text: "• （無）",
      color: "#3d4149",
      size: "xs",
      margin: "xs"
    });
  }

  if (unmatched.length > 0) {
    contents.push({
      type: "text",
      text: `⚠️ 有 ${unmatched.length} 個名字無法對應名冊，不會納入轉發：${unmatched.join('、')}`,
      color: "#b3261e",
      size: "xs",
      margin: "md",
      wrap: true
    });
  }

  contents.push({ type: "separator", color: "#d8d3c7", margin: "md" });
  contents.push({
    type: "text",
    text: "【將轉發至】",
    color: "#62666f",
    size: "xs",
    margin: "md",
    weight: "bold"
  });

  targets.forEach(target => {
    contents.push({
      type: "text",
      text: `• ${target.group_name}（${target.reasons.join('、')}）`,
      color: "#3d4149",
      size: "xs",
      margin: "xs",
      wrap: true
    });
  });

  contents.push({
    type: "text",
    text: `⏰ ${CONFIRM_GRACE_HOURS} 小時內無人確認，將自動採用以上結果。`,
    color: "#8d9199",
    size: "xxs",
    margin: "md",
    wrap: true
  });

  contents.push({
    type: "button",
    action: {
      type: "postback",
      label: "✅ 確認排入",
      data: `action=confirm&id=${confirmation.id}`,
      displayText: "確認排入明早轉發"
    },
    style: "primary",
    color: "#1d6b53",
    height: "sm",
    margin: "md"
  });

  contents.push({
    type: "button",
    action: {
      type: "uri",
      label: "✏️ 修改勾選",
      uri: `https://liff.line.me/${LIFF_DISPATCH_ID}?msgId=${confirmation.message_id}&sourceId=${confirmation.source_group_id}`
    },
    style: "secondary",
    height: "sm",
    margin: "sm"
  });

  contents.push({
    type: "button",
    action: {
      type: "postback",
      label: "❌ 全部取消",
      data: `action=cancel&id=${confirmation.id}`,
      displayText: "取消今日轉發"
    },
    style: "link",
    height: "sm"
  });

  return {
    type: "flex",
    altText: `請確認今日 Case 分流（${targets.length} 個群組）`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f4ef",
        paddingAll: "16px",
        contents
      }
    }
  };
}

/**
 * Turns extracted assignments into a proposal awaiting human confirmation.
 * Nothing is marked confirmed here: the rows are queued unconfirmed, and only
 * an explicit tap -- or the grace period elapsing -- promotes them.
 */
async function proposeDispatch({ sourceId, messageId, date, assignments, origin }) {
  const proposal = await buildDispatchProposal(assignments);
  const dateWarning = buildDateWarning(date);

  if (proposal.targets.length === 0) {
    await pushMessage(sourceId, {
      type: "text",
      text:
        `📋 已讀取分配表，但沒有比對到任何需要轉發的群組。\n` +
        (proposal.unmatched.length > 0
          ? `\n無法對應名冊的名字：${proposal.unmatched.join('、')}\n（可能是名冊尚未匯入，或這幾位還沒建檔）`
          : `\n讀到的人員：${proposal.matched.map(m => m.name).join('、') || '（無）'}`)
    });
    return null;
  }

  const dispatchDate = tomorrowInTaipei();
  for (const target of proposal.targets) {
    await db.daily_dispatch_cache.add(target.line_group_id, messageId, false, dispatchDate);
  }

  const confirmation = await db.dispatch_confirmations.create({
    sourceGroupId: sourceId,
    messageId,
    dispatchDate,
    payload: { ...proposal, dateWarning, origin },
    autoAdoptAt: new Date(Date.now() + CONFIRM_GRACE_HOURS * 3600 * 1000).toISOString()
  });

  await pushMessage(sourceId, getDispatchConfirmFlex(confirmation));
  return confirmation;
}

/**
 * Promotes a pending proposal to "will be sent".
 * @param {number} id
 * @param {string} resolvedBy
 * @param {{auto?: boolean}} [options] auto-adoption after the grace period
 */
export async function adoptConfirmation(id, resolvedBy, { auto = false } = {}) {
  const confirmation = await db.dispatch_confirmations.getById(id);
  if (!confirmation || confirmation.status !== 'PENDING') return null;

  for (const target of confirmation.payload.targets) {
    await db.daily_dispatch_cache.add(
      target.line_group_id,
      confirmation.message_id,
      true,
      confirmation.dispatch_date
    );
  }

  await db.dispatch_confirmations.resolve(id, auto ? 'AUTO_ADOPTED' : 'CONFIRMED', resolvedBy);

  const groupList = confirmation.payload.targets.map(t => `• ${t.group_name}`).join('\n');
  await pushMessage(confirmation.source_group_id, {
    type: "text",
    text: auto
      ? `⏰ 逾 ${CONFIRM_GRACE_HOURS} 小時無人確認，已自動採用辨識結果。\n\n${confirmation.dispatch_date} 07:30 將轉發至：\n${groupList}\n\n如需取消，請在群組輸入「取消轉發」。`
      : `✅ 已確認（${resolvedBy}）。\n\n${confirmation.dispatch_date} 07:30 將轉發至：\n${groupList}`
  });

  return confirmation;
}

async function cancelConfirmation(id, resolvedBy) {
  const confirmation = await db.dispatch_confirmations.getById(id);
  if (!confirmation || confirmation.status !== 'PENDING') return null;

  for (const target of confirmation.payload.targets) {
    await db.daily_dispatch_cache.remove(target.line_group_id, confirmation.dispatch_date);
  }
  await db.dispatch_confirmations.resolve(id, 'CANCELLED', resolvedBy);

  await pushMessage(confirmation.source_group_id, {
    type: "text",
    text: `❌ 已取消（${resolvedBy}）。${confirmation.dispatch_date} 早上不會轉發這份分配表。`
  });
  return confirmation;
}

/**
 * A case table dated neither today nor tomorrow is almost always a photo of an
 * old sheet, which would otherwise be forwarded to every group tomorrow.
 * @param {string|null} ocrDate as extracted, YYYY/MM/DD
 * @returns {string|null} warning text, or null when the date looks right
 */
function buildDateWarning(ocrDate) {
  if (!ocrDate) return null;

  const normalised = ocrDate.replace(/-/g, '/');
  const today = todayInTaipei().replace(/-/g, '/');
  const tomorrow = tomorrowInTaipei().replace(/-/g, '/');

  if (normalised === today || normalised === tomorrow) return null;
  return `分配表日期為 ${ocrDate}，與今日(${today})或明日(${tomorrow})不符，請確認是否上傳正確！`;
}

/**
 * Handles batch image analysis after the debounce window expires.
 * @param {string} sourceId - LINE Group/Room/User ID
 */
async function triggerBatchProcess(sourceId) {
  const session = imageGroupSessions.get(sourceId);
  if (!session) return;

  imageGroupSessions.delete(sourceId);
  console.log(`[Batch Process] Starting processing of ${session.buffers.length} images for ${sourceId}`);

  // Use the last uploaded image message ID as the reference
  const messageId = session.messageIds[session.messageIds.length - 1];

  try {
    await pushMessage(sourceId, {
      type: "text",
      text:
        `⚙️ 收集完畢（共 ${session.buffers.length} 張照片），本機 AI 正在辨識中。\n` +
        `單張約需 2～4 分鐘，請稍候，完成後會自動回報。`
    });

    const ocrResult = await analyzeImages(session.buffers, {
      onProgress: (progress) => {
        // Multi-image runs are long enough that silence looks like a crash.
        if (progress.stage === 'digest' && progress.total > 1) {
          pushMessage(sourceId, {
            type: "text",
            text: `🔍 辨識中：第 ${progress.index} / ${progress.total} 張...`
          }).catch(() => {});
        }
      }
    });

    console.log('Batch Analysis Result:', ocrResult);

    // Decided in P2: a silent cloud fallback would mean the hardest photos --
    // exactly the sensitive ones -- leave the hospital without anyone noticing.
    if (ocrResult.fallback?.used) {
      await pushMessage(sourceId, {
        type: "text",
        text:
          `⚠️ 本地辨識未完成（${ocrResult.fallback.reason}），已改用雲端 AI 分析。\n` +
          `請注意：本次照片已上傳至 Google。`
      });
    }

    if (ocrResult.type === 'WARD_NOTE') {
      // --- 🔴 WARD_NOTE Pipeline: Auto-Create Notices ---
      const addedNotes = [];
      if (ocrResult.notes && Array.isArray(ocrResult.notes)) {
        for (const note of ocrResult.notes) {
          const created = await db.general_notes.create(note.title, note.content, 'AI 晨會多圖整併');
          addedNotes.push(created);
        }
      }

      if (addedNotes.length > 0) {
        const flexNotesCard = getAutoNotesAddedFlex(addedNotes, sourceId);
        await pushMessage(sourceId, flexNotesCard);
      } else {
        await pushMessage(sourceId, {
          type: "text",
          text: "⚠️ AI 判斷此圖片為公告，但未能解析出任何具體公告項目。"
        });
      }
    } else if (ocrResult.type === 'CALENDAR') {
      // --- 🔴 CALENDAR Pipeline: Auto-Create Calendar Events ---
      const addedEvents = [];
      if (ocrResult.events && Array.isArray(ocrResult.events)) {
        for (const evt of ocrResult.events) {
          const created = await db.group_events.create(sourceId, {
            title: evt.title,
            date: evt.date,
            time: evt.time || null,
            location: evt.location || null,
            description: evt.description || null,
            created_by: 'AI 自動生成'
          });
          addedEvents.push(created);
        }
      }

      if (addedEvents.length > 0) {
        const flexCalendarCard = getAutoCalendarAddedFlex(addedEvents, sourceId);
        await pushMessage(sourceId, flexCalendarCard);
      } else {
        await pushMessage(sourceId, {
          type: "text",
          text: "⚠️ AI 判斷此圖片為行事曆排程，但未能解析出任何具體活動項目。"
        });
      }
    } else if (ocrResult.type === 'CASE_TABLE') {
      // --- 🔴 CASE_TABLE Pipeline: Schedule case dispatch ---
      await proposeDispatch({
        sourceId,
        messageId,
        date: ocrResult.date,
        assignments: ocrResult.assignments,
        origin: '照片辨識'
      });
    } else {
      // --- 🔴 UNKNOWN/OTHER Pipeline ---
      await pushMessage(sourceId, {
        type: "text",
        text: "⚠️ AI 無法辨識此圖片為『Case分配表』或『病房公告事項』。請確認圖片內容是否清晰，或使用主選單手動編輯公告。"
      });
    }

  } catch (error) {
    console.error('Error processing batch images:', error);
    await pushMessage(sourceId, {
      type: "text",
      text: `❌ 圖片整併分析失敗，錯誤原因：${error.message}`
    });
  }
}

// ----------------------------------------------------
// Webhook Web Entry
// ----------------------------------------------------
export async function handleWebhookEvent(event) {
  console.log(`[Webhook Event] type: ${event.type}, source: ${JSON.stringify(event.source)}`);

  if (event.type === 'join') {
    // Reply with main menu on group join
    const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
    console.log(`[Webhook Join] Joined group/room/user ID: ${sourceId}`);
    
    await replyMessage(event.replyToken, [
      {
        type: "text",
        text: `大家好！我是「醫院工作群組優化助手」🤖。我已經加入此群組，本群組的 LINE ID 為：\n${sourceId}\n\n我將協助各位進行排程提醒、注意事項筆記共同編輯，以及 Case 分配表的每日自動分流轉發！`
      },
      getMainMenuFlex(sourceId)
    ]);
    return;
  }

  // Confirmation cards answer through postbacks -- one tap, no page load.
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data || '');
    const action = params.get('action');

    // The rich menu's UPLOAD cell: how to get a case table into the system.
    if (action === 'help_upload') {
      await replyMessage(event.replyToken, {
        type: "text",
        text:
          "📄 分配表有兩種上傳方式：\n\n" +
          "1️⃣ 傳原始檔（建議）\n" +
          "把 Excel 另存成 .xlsx 或 .csv 直接傳進群組，我會直接讀儲存格，一秒完成，也不會看錯字。\n\n" +
          "2️⃣ 拍照上傳\n" +
          "沒有原始檔時就拍大表照片，本機 AI 辨識約需 2～4 分鐘。連拍多張會自動整併成一則公告。\n\n" +
          "兩種方式都會先跳出確認卡片，請核對人名與群組後再按「確認排入」。"
      });
      return;
    }

    const id = parseInt(params.get('id'), 10);
    if (!action || Number.isNaN(id)) return;

    const actor = await resolveDisplayName(event.source);

    if (action === 'confirm') {
      const result = await adoptConfirmation(id, actor);
      if (!result) {
        await replyMessage(event.replyToken, {
          type: "text",
          text: "這筆分流已經處理過了（可能已被其他同仁確認或取消）。"
        });
      }
      return;
    }

    if (action === 'cancel') {
      const result = await cancelConfirmation(id, actor);
      if (!result) {
        await replyMessage(event.replyToken, {
          type: "text",
          text: "這筆分流已經處理過了。"
        });
      }
      return;
    }
    return;
  }


  if (event.type === 'message') {
    const { message } = event;

    if (message.type === 'text') {
      const text = message.text.trim();
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId;

      if (text === 'menu' || text.endsWith('選單') || text === '選單' || text === '助手' || text === '說明') {
        await replyMessage(event.replyToken, getMainMenuFlex(sourceId));
      } else if (text === '/notes' || text === '編輯筆記') {
        const liffUrl = `https://liff.line.me/${LIFF_NOTES_ID}?groupId=${sourceId}`;
        await replyMessage(event.replyToken, {
          type: "text",
          text: `📝 點選此連結編輯注意事項：\n${liffUrl}`
        });
      } else if (text === '行事曆' || text === '行程' || text === '活動') {
        const liffUrl = `https://liff.line.me/${process.env.LIFF_CALENDAR_ID || 'placeholder_calendar_liff_id'}?groupId=${sourceId}`;
        await replyMessage(event.replyToken, {
          type: "text",
          text: `📅 點選此連結查看病房行事曆與排程：\n${liffUrl}`
        });
      } else if (text === '今日行程' || text === '今天活動' || text === '今日活動' || text === '今天行程') {
        if (sourceId) {
          try {
            const now = new Date();
            const tzOffset = 8 * 60 * 60 * 1000;
            const todayStr = new Date(now.getTime() + tzOffset).toISOString().split('T')[0];
            
            const events = await db.group_events.getAll(sourceId);
            const todayEvents = events.filter(e => e.date === todayStr);
            
            if (todayEvents.length === 0) {
              await replyMessage(event.replyToken, {
                type: "text",
                text: `📅 今日 (${todayStr}) 尚無排定任何活動或報告。`
              });
            } else {
              let resp = `📅 今日 (${todayStr}) 活動排程如下：\n\n`;
              todayEvents.forEach((e, idx) => {
                const timeStr = e.time ? `⏰ ${e.time} ` : '';
                const locStr = e.location ? `📍 ${e.location} ` : '';
                resp += `${idx + 1}. ${timeStr}${locStr}${e.title}\n`;
                if (e.description) resp += `   └ 備註: ${e.description}\n`;
              });
              await replyMessage(event.replyToken, {
                type: "text",
                text: resp.trim()
              });
            }
          } catch (err) {
            console.error('Failed to query today events:', err);
            await replyMessage(event.replyToken, {
              type: "text",
              text: "❌ 查詢今日行程時發生錯誤。"
            });
          }
        }
      } else if (text === '明日行程' || text === '明天活動' || text === '明日活動' || text === '明天行程') {
        if (sourceId) {
          try {
            const now = new Date();
            const tzOffset = 8 * 60 * 60 * 1000;
            const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000 + tzOffset).toISOString().split('T')[0];
            
            const events = await db.group_events.getAll(sourceId);
            const tomorrowEvents = events.filter(e => e.date === tomorrowStr);
            
            if (tomorrowEvents.length === 0) {
              await replyMessage(event.replyToken, {
                type: "text",
                text: `📅 明日 (${tomorrowStr}) 尚無排定任何活動或報告。`
              });
            } else {
              let resp = `📅 明日 (${tomorrowStr}) 活動排程如下：\n\n`;
              tomorrowEvents.forEach((e, idx) => {
                const timeStr = e.time ? `⏰ ${e.time} ` : '';
                const locStr = e.location ? `📍 ${e.location} ` : '';
                resp += `${idx + 1}. ${timeStr}${locStr}${e.title}\n`;
                if (e.description) resp += `   └ 備註: ${e.description}\n`;
              });
              await replyMessage(event.replyToken, {
                type: "text",
                text: resp.trim()
              });
            }
          } catch (err) {
            console.error('Failed to query tomorrow events:', err);
            await replyMessage(event.replyToken, {
              type: "text",
              text: "❌ 查詢明日行程時發生錯誤。"
            });
          }
        }
      } else if (text === '取消轉發' || text === '取消發送') {
        if (sourceId) {
          await db.daily_dispatch_cache.remove(sourceId);
          await replyMessage(event.replyToken, {
            type: "text",
            text: "❌ 已取消此群組明早 07:30 的 Case 分配表自動轉發任務。"
          });
        }
      } else if (text === '清空轉發' || text === '取消今日轉發') {
        await db.daily_dispatch_cache.clearAll();
        await replyMessage(event.replyToken, {
          type: "text",
          text: "🗑️ 已成功清空今日所有科室的分配表自動轉發排程，明早將不會發送任何圖片。"
        });
      } else if (text.toUpperCase() === 'ID' || text === '群組ID' || text === '查詢ID') {
        if (sourceId) {
          await replyMessage(event.replyToken, {
            type: "text",
            text: `ℹ️ 本群組/聊天的 LINE ID 為：\n${sourceId}`
          });
        }
      }
    }

    if (message.type === 'file') {
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
      const fileName = message.fileName || '';
      const extension = fileName.toLowerCase().split('.').pop();

      if (!SPREADSHEET_EXTENSIONS.includes(extension)) {
        return; // Not ours -- staff share all sorts of files in these groups.
      }

      try {
        await replyMessage(event.replyToken, {
          type: "text",
          text: `📄 收到檔案「${fileName}」，正在直接讀取儲存格（不需要 AI 辨識，約 1 秒）...`
        });

        const fileBuffer = await downloadMessageContent(message.id);
        const grid = await readGrid(fileBuffer, fileName);
        const roster = await db.doctors.getAll();

        if (roster.length === 0) {
          await pushMessage(sourceId, {
            type: "text",
            text:
              "⚠️ 尚未匯入醫師名冊，無法從檔案判斷今日人員。\n" +
              "請先從主選單的「管理設定」匯入名冊（姓名 + 科別），之後上傳檔案就能自動分流。"
          });
          return;
        }

        const parsed = parseCaseTable(grid, roster);

        // The image pushed at 07:30 still has to be a picture, so the file
        // route reuses the most recent uploaded image for this group.
        const imageMessageId = await findLatestImageMessageId(sourceId);
        if (!imageMessageId) {
          await pushMessage(sourceId, {
            type: "text",
            text:
              `✅ 檔案讀取成功，今日共 ${parsed.assignments.length} 位人員。\n` +
              "但群組裡還沒有可轉發的分配表照片——請再上傳一張大表照片，我就會用它來發送。"
          });
          return;
        }

        await proposeDispatch({
          sourceId,
          messageId: imageMessageId,
          date: parsed.date,
          assignments: parsed.assignments,
          origin: `檔案 ${fileName}`
        });
      } catch (error) {
        console.error('Error processing uploaded file:', error);
        await pushMessage(sourceId, {
          type: "text",
          text: `❌ 檔案讀取失敗：${error.message}`
        });
      }
    }

    if (message.type === 'image') {
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
      const messageId = message.id;

      try {
        // 1. Download image
        const imageBuffer = await downloadMessageContent(messageId);

        // 2. Cache image locally
        const imageFileName = `${messageId}.jpg`;
        const localImagePath = path.join(IMAGES_DIR, imageFileName);
        await fs.writeFile(localImagePath, imageBuffer);
        console.log(`Image saved to ${localImagePath}`);

        // Remember it so a later spreadsheet upload has something to forward.
        await db.group_last_image.set(sourceId, messageId);

        // 3. Debounce and Group Consecutive Image Uploads
        if (!imageGroupSessions.has(sourceId)) {
          // First image of the batch
          const session = {
            messageIds: [messageId],
            buffers: [imageBuffer],
            timer: null
          };
          imageGroupSessions.set(sourceId, session);

          // Reply indicating we are waiting for more images
          await replyMessage(event.replyToken, {
            type: "text",
            text: "📥 已收到第 1 張照片，正在等待其餘關聯照片...\n（10 秒內上傳新照片將會自動整併為單一晨會公告項目）"
          });

          // Set 10s timer to trigger batch processing
          session.timer = setTimeout(() => {
            triggerBatchProcess(sourceId);
          }, GROUP_WINDOW_MS);

        } else {
          // Subsequent image uploaded within 10s window
          const session = imageGroupSessions.get(sourceId);
          session.messageIds.push(messageId);
          session.buffers.push(imageBuffer);

          // Reset the timer (sliding window debounce)
          clearTimeout(session.timer);

          // Update progress notice back to group chat
          await pushMessage(sourceId, {
            type: "text",
            text: `📥 續傳成功！已收到第 ${session.buffers.length} 張連續照片，請繼續上傳，或等待 10 秒後開始分析...`
          });

          session.timer = setTimeout(() => {
            triggerBatchProcess(sourceId);
          }, GROUP_WINDOW_MS);
        }

      } catch (error) {
        console.error('Error processing uploaded image:', error);
        if (sourceId) {
          await pushMessage(sourceId, {
            type: "text",
            text: `❌ 圖片上傳暫存失敗，錯誤原因：${error.message}`
          });
        }
      }
    }
  }
}
