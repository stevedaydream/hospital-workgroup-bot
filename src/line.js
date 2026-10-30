import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { db } from './db.js';
import { analyzeCaseImage, analyzeMultipleImages, primaryProviderLabel, modelLabel, isModelLoaded } from './ai.js';
import { createJob, updateJob, trackModelStage } from './progress.js';
import { medbaseCommand, medbaseEnabled, MEDBASE_APP_URL } from './medbase.js';
import { todayInTaipei, dayOfWeek } from './util/date.js';

dotenv.config();

// In-memory sessions to debounce and group consecutive image uploads
const imageGroupSessions = new Map();
export const GROUP_WINDOW_MS = 10000; // 10-second wait window for consecutive uploads

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LIFF_NOTES_ID = process.env.LIFF_NOTES_ID;
const LIFF_DISPATCH_ID = process.env.LIFF_DISPATCH_ID;

// 出國登記 has its own LIFF app when LIFF_TRAVEL_ID is set; otherwise it opens
// through the calendar app, whose /liff/calendar route forwards ?page=travel.
function travelLiffUrl() {
  return process.env.LIFF_TRAVEL_ID
    ? `https://liff.line.me/${process.env.LIFF_TRAVEL_ID}`
    : `https://liff.line.me/${process.env.LIFF_CALENDAR_ID || 'placeholder_calendar_liff_id'}?page=travel`;
}

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
  const startedAt = Date.now();
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
    } else {
      console.log(`[Reply] sent in ${Date.now() - startedAt}ms`);
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

async function lineGet(path) {
  try {
    const response = await fetch(`https://api.line.me${path}`, {
      headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Members in a group (a push to a group is billed once per member); null if unknown. */
export async function getGroupMemberCount(groupId) {
  const path = groupId.startsWith('R') ? `/v2/bot/room/${groupId}/members/count` : `/v2/bot/group/${groupId}/members/count`;
  return (await lineGet(path))?.count ?? null;
}

/** This month's push quota: { limit, used } (limit null when unlimited). */
export async function getPushQuota() {
  const [quota, usage] = await Promise.all([lineGet('/v2/bot/message/quota'), lineGet('/v2/bot/message/quota/consumption')]);
  return {
    limit: quota?.type === 'limited' ? quota.value : null,
    used: usage?.totalUsage ?? null
  };
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

/** Reply text for 出國: who is abroad now, who leaves soon, and the form link. */
function travelSummaryText() {
  const today = todayInTaipei();
  const fmt = (date) => `${date.slice(5).replace('-', '/')}(${dayOfWeek(date).slice(1)})`;
  const line = (t) => `• ${t.traveler}｜${t.destination}｜${fmt(t.depart_date)}–${fmt(t.return_date)}` +
    (t.deputy ? `｜代理 ${t.deputy}` : '');
  const trips = db.travels.list();
  const abroad = trips.filter(t => t.depart_date <= today);
  const upcoming = trips.filter(t => t.depart_date > today);

  const parts = ['✈️ 出國登記'];
  parts.push(abroad.length ? '\n目前在國外：\n' + abroad.map(line).join('\n') : '\n目前沒有人在國外。');
  if (upcoming.length) parts.push('\n即將出國：\n' + upcoming.map(line).join('\n'));
  parts.push('\n登記或修改：\n' + travelLiffUrl());
  return parts.join('\n');
}

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
        backgroundColor: "#e6f4f2",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手",
            color: "#0f5f58",
            weight: "bold",
            size: "xl"
          },
          {
            type: "text",
            text: "Hospital Workgroup Assistant",
            color: "#4f5d68",
            size: "xs",
            margin: "xs"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#ffffff",
        paddingAll: "20px",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "💡 便捷功能選單",
            color: "#17212b",
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
            color: "#0369a1",
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
            color: "#6d28d9",
            height: "sm",
            margin: "md"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "✈️ 出國時刻登記",
              uri: travelLiffUrl()
            },
            style: "primary",
            color: "#0f766e",
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
            color: "#047857",
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
            color: "#be123c",
            height: "sm",
            margin: "md"
          },
          // MedBase 排班：查詢用 message action，觸發的是免費的回覆
          ...(medbaseEnabled ? [
            {
              type: "box",
              layout: "horizontal",
              spacing: "sm",
              margin: "md",
              contents: [
                { type: "button", action: { type: "message", label: "🗓 我的班", text: "我的班" }, style: "secondary", height: "sm" },
                { type: "button", action: { type: "message", label: "📋 近期值班", text: "近期值班" }, style: "secondary", height: "sm" }
              ]
            },
            {
              type: "button",
              action: { type: "uri", label: "📱 開啟 MedBase 班表", uri: MEDBASE_APP_URL },
              style: "primary",
              color: "#4338ca",
              height: "sm",
              margin: "sm"
            }
          ] : []),
          {
            type: "separator",
            color: "#e1e6e9",
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
                color: "#4f5d68",
                size: "xs",
                weight: "bold"
              },
              {
                type: "text",
                text: "• 直接在此群組上傳今日「分配表照片」",
                color: "#36434e",
                size: "xs"
              },
              {
                type: "text",
                text: "• 系統將自動辨識醫師人名與科別",
                color: "#36434e",
                size: "xs"
              },
              {
                type: "text",
                text: "• 於每日早上 07:30 自動分流發送至各科室群組",
                color: "#36434e",
                size: "xs"
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f6f8f9",
        contents: [
          {
            type: "text",
            text: "設計給臨床同仁的行政貼心工具",
            color: "#66727c",
            size: "xxs",
            align: "center",
            margin: "xs"
          }
        ]
      }
    }
  };
}

function getOcrSummaryFlex(dispatchedGroups, hasUro, messageId, sourceId, dateWarning = null) {
  const selectUrl = `https://liff.line.me/${LIFF_DISPATCH_ID}?msgId=${messageId}&sourceId=${sourceId}`;
  
  const contents = [
    {
      type: "text",
      text: "📋 Case 分配表自動分流結果",
      weight: "bold",
      size: "md",
      color: "#17212b"
    }
  ];

  if (dateWarning) {
    contents.push({
      type: "text",
      text: `⚠️ ${dateWarning}`,
      color: "#be123c",
      weight: "bold",
      size: "xs",
      margin: "md",
      wrap: true
    });
  }

  if (dispatchedGroups.length > 0) {
    contents.push({
      type: "text",
      text: "【已自動排程明早 07:30 轉發】：",
      color: "#4f5d68",
      size: "xs",
      margin: "md",
      weight: "bold"
    });
    dispatchedGroups.forEach(g => {
      contents.push({
        type: "text",
        text: `• ${g}`,
        color: "#36434e",
        size: "xs",
        margin: "xs"
      });
    });
  } else {
    contents.push({
      type: "text",
      text: "【無直接比對到之骨科醫師】",
      color: "#4f5d68",
      size: "xs",
      margin: "md"
    });
  }

  if (hasUro) {
    contents.push({
      type: "separator",
      color: "#e1e6e9",
      margin: "md"
    });
    contents.push({
      type: "text",
      text: "⚠️ 偵測到今日有 URO (泌尿科) 刀表，請務必點擊下方按鈕審查今日負責人。",
      color: "#be123c",
      size: "xs",
      margin: "md",
      wrap: true
    });
  } else {
    contents.push({
      type: "text",
      text: "所有發送對象已自動比對完成。若發現有錯，可點擊下方按鈕進行手動調整。",
      color: "#047857",
      size: "xs",
      margin: "md",
      wrap: true
    });
  }

  // Always render the Review & Adjust Button
  contents.push({
    type: "button",
    action: {
      type: "uri",
      label: "🔍 審查與修改今日轉發名單",
      uri: selectUrl
    },
    style: "primary",
    color: "#0f766e",
    margin: "md",
    height: "sm"
  });

  // Add the cancel button at the bottom of the card
  contents.push({
    type: "separator",
    color: "#e1e6e9",
    margin: "md"
  });
  contents.push({
    type: "button",
    action: {
      type: "message",
      label: "🗑️ 取消今日所有轉發任務",
      text: "取消今日轉發"
    },
    style: "secondary",
    height: "sm",
    margin: "md"
  });

  return {
    type: "flex",
    altText: "Case 分配表分流排程結果",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#e6f4f2",
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手 - 分流系統",
            color: "#0f5f58",
            weight: "bold",
            size: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#ffffff",
        paddingAll: "20px",
        spacing: "xs",
        contents: contents
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
      color: "#17212b"
    },
    {
      type: "text",
      text: "偵測到公告內容，已自動儲存至病房注意事項管理目錄：",
      color: "#4f5d68",
      size: "xs",
      margin: "sm",
      wrap: true
    },
    {
      type: "separator",
      color: "#e1e6e9",
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
          color: "#0f766e",
          weight: "bold",
          size: "sm"
        },
        {
          type: "text",
          text: note.content,
          color: "#36434e",
          size: "xs",
          wrap: true
        }
      ]
    });
    if (idx < addedNotes.length - 1) {
      contents.push({
        type: "separator",
        color: "#eef1f3",
        margin: "md"
      });
    }
  });

  contents.push({
    type: "separator",
    color: "#e1e6e9",
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
    color: "#047857",
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
        backgroundColor: "#e5f5ee",
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手 - 公告系統",
            color: "#065f46",
            weight: "bold",
            size: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#ffffff",
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
      color: "#17212b"
    },
    {
      type: "text",
      text: "偵測到行事曆排程，已自動儲存至病房行事曆：",
      color: "#4f5d68",
      size: "xs",
      margin: "sm",
      wrap: true
    },
    {
      type: "separator",
      color: "#e1e6e9",
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
          color: "#6d28d9",
          weight: "bold",
          size: "xs"
        },
        {
          type: "text",
          text: evt.title,
          color: "#36434e",
          weight: "bold",
          size: "sm",
          wrap: true
        },
        evt.description ? {
          type: "text",
          text: evt.description,
          color: "#4f5d68",
          size: "xs",
          wrap: true
        } : null
      ].filter(Boolean)
    });
    if (idx < addedEvents.length - 1) {
      contents.push({
        type: "separator",
        color: "#eef1f3",
        margin: "md"
      });
    }
  });

  contents.push({
    type: "separator",
    color: "#e1e6e9",
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
    color: "#6d28d9",
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
        backgroundColor: "#f1ebfd",
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: "醫院工作助手 - 行事曆系統",
            color: "#5b21b6",
            weight: "bold",
            size: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#ffffff",
        paddingAll: "20px",
        spacing: "xs",
        contents: contents
      }
    }
  };
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

  // Progress lives on the page linked from the first reply; the outcome goes
  // out as ONE push, since pushes are billed per group member.
  const { job } = session;
  const resultMessages = [];
  const stage = trackModelStage(job, { isModelLoaded, modelLabel });
  const { onAttempt } = stage;

  try {
    updateJob(job, { stage: 'recognizing', imageCount: session.buffers.length });

    let ocrResult;
    if (session.buffers.length === 1) {
      // Single image: Classify and process
      ocrResult = await analyzeCaseImage(session.buffers[0], onAttempt);
    } else {
      // Multiple images: Consolidate as ward announcements
      ocrResult = await analyzeMultipleImages(session.buffers, onAttempt);
    }
    stage.stop();

    console.log('Batch Analysis Result:', ocrResult);

    // Decision 8·9: the fallback stays automatic, but the group must be told
    // that the photos left the local machine.
    if (ocrResult.fallbackReason) {
      resultMessages.push({
        type: "text",
        text: "☁️ 本機 AI 暫時無法連線，本次照片已改上傳至 Google Gemini 雲端辨識。"
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
        resultMessages.push(flexNotesCard);
      } else {
        resultMessages.push({
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
        resultMessages.push(flexCalendarCard);
      } else {
        resultMessages.push({
          type: "text",
          text: "⚠️ AI 判斷此圖片為行事曆排程，但未能解析出任何具體活動項目。"
        });
      }
    } else if (ocrResult.type === 'CASE_TABLE') {
      // --- 🔴 CASE_TABLE Pipeline: Schedule case dispatch ---
      // Validate date matching today or tomorrow (Taiwan Time UTC+8)
      let dateWarning = null;
      if (ocrResult.date) {
        try {
          const now = new Date();
          const tzOffset = 8 * 60 * 60 * 1000;
          const todayStr = new Date(now.getTime() + tzOffset).toISOString().split('T')[0].replace(/-/g, '/');
          const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000 + tzOffset).toISOString().split('T')[0].replace(/-/g, '/');
          
          const normOcr = ocrResult.date.replace(/-/g, '/');
          if (normOcr !== todayStr && normOcr !== tomorrowStr) {
            dateWarning = `分配表日期為 ${ocrResult.date}，與今日(${todayStr})或明日(${tomorrowStr})不符，請確認是否上傳正確！`;
          }
        } catch (dateErr) {
          console.error('Error during date validation:', dateErr);
        }
      }

      // Resolve mappings
      const dispatchedGroups = [];
      let hasUro = false;

      // Process Direct Doctors
      if (ocrResult.doctors && Array.isArray(ocrResult.doctors)) {
        for (const docName of ocrResult.doctors) {
          const mappings = await db.doctor_group_mapping.getByMatchKey(docName);
          for (const map of mappings) {
            if (map.type === 'DIRECT') {
              await db.daily_dispatch_cache.add(map.line_group_id, messageId, true);
              dispatchedGroups.push(`${map.group_name} (${docName}醫師)`);
            }
          }
        }
      }

      // Process Flexible Departments (e.g. URO)
      if (ocrResult.departments && Array.isArray(ocrResult.departments)) {
        for (const deptCode of ocrResult.departments) {
          const mappings = await db.doctor_group_mapping.getByMatchKey(deptCode);
          const flexibleMaps = mappings.filter(m => m.type === 'FLEXIBLE');
          
          if (flexibleMaps.length > 0) {
            if (deptCode.toUpperCase() === 'URO') {
              hasUro = true;
              // Add all to Cache as unconfirmed by default
              for (const map of flexibleMaps) {
                await db.daily_dispatch_cache.add(map.line_group_id, messageId, false);
              }
            }
          }
        }
      }

      // Send feedback response to group
      const flexSummaryCard = getOcrSummaryFlex(dispatchedGroups, hasUro, messageId, sourceId, dateWarning);
      resultMessages.push(flexSummaryCard);
    } else {
      // --- 🔴 UNKNOWN/OTHER Pipeline ---
      resultMessages.push({
        type: "text",
        text: "⚠️ AI 無法辨識此圖片為『Case分配表』或『病房公告事項』。請確認圖片內容是否清晰，或使用主選單手動編輯公告。"
      });
    }

    const RESULT_LABELS = { WARD_NOTE: '病房公告', CALENDAR: '行事曆', CASE_TABLE: 'Case 分配表' };
    updateJob(job, { stage: 'done', resultLabel: RESULT_LABELS[ocrResult.type] || '無法辨識' });
    await pushMessage(sourceId, resultMessages);
  } catch (error) {
    stage.stop();
    console.error('Error processing batch images:', error);
    updateJob(job, { stage: 'failed', error: error.message });
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
  // Delay from the user sending to us receiving; a redelivery means LINE's
  // first attempt failed, which is where long waits usually come from.
  const delayMs = event.timestamp ? Date.now() - event.timestamp : null;
  const redelivery = event.deliveryContext?.isRedelivery ? ', REDELIVERY' : '';
  console.log(`[Webhook Event] ${new Date().toISOString()} type: ${event.type}, delay: ${delayMs}ms${redelivery}, source: ${JSON.stringify(event.source)}`);

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

  if (event.type === 'message') {
    const { message } = event;

    if (message.type === 'text') {
      const text = message.text.trim();
      const sourceId = event.source.groupId || event.source.roomId || event.source.userId;

      const medbaseReply = await medbaseCommand(text, event.source);
      if (medbaseReply) {
        await replyMessage(event.replyToken, medbaseReply);
        return;
      }

      if (text === 'menu' || text.endsWith('選單') || text === '選單' || text === '助手' || text === '說明') {
        await replyMessage(event.replyToken, getMainMenuFlex(sourceId));
      } else if (text === '/notes' || text === '編輯筆記') {
        const liffUrl = `https://liff.line.me/${LIFF_NOTES_ID}?groupId=${sourceId}`;
        await replyMessage(event.replyToken, {
          type: "text",
          text: `📝 點選此連結編輯注意事項：\n${liffUrl}`
        });
      } else if (text === '出國' || text === '出國登記' || text === '誰出國') {
        await replyMessage(event.replyToken, { type: 'text', text: travelSummaryText() });
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

        // 3. Debounce and Group Consecutive Image Uploads
        if (!imageGroupSessions.has(sourceId)) {
          // First image of the batch
          const session = {
            messageIds: [messageId],
            buffers: [imageBuffer],
            timer: null,
            job: createJob()
          };
          imageGroupSessions.set(sourceId, session);

          // Replies are free; this one carries the progress link so nothing
          // else needs to be pushed until the result is ready.
          await replyMessage(event.replyToken, {
            type: "text",
            text: `📥 已收到第 1 張照片，10 秒內再上傳的照片會一起整併辨識。

⚙️ 接著使用${primaryProviderLabel}辨識，模型需要載入時約 3～4 分鐘。
⏱ 即時進度：${BASE_URL}/progress.html?job=${session.job.id}`
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

          updateJob(session.job, { imageCount: session.buffers.length, stage: 'collecting' });

          // Each upload has its own (free) reply token.
          await replyMessage(event.replyToken, {
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
