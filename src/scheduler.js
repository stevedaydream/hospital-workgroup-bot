import dotenv from 'dotenv';
import { db } from './db.js';
import { pushMessage } from './line.js';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Runs the daily case distribution image dispatch.
 * Fetches all confirmed dispatches for today and sends the cached images to respective groups.
 */
export async function runDailyDispatch() {
  console.log('[Scheduler] Starting daily dispatch job...');
  try {
    const pendingDispatches = await db.daily_dispatch_cache.getPending();
    const confirmedDispatches = pendingDispatches.filter(d => d.is_confirmed);
    
    if (confirmedDispatches.length === 0) {
      console.log('[Scheduler] No confirmed dispatches for today.');
      return { success: true, count: 0 };
    }

    // Deduplicate by target group ID to avoid double-posting
    const uniqueDispatches = {};
    for (const d of confirmedDispatches) {
      uniqueDispatches[d.target_line_group_id] = d;
    }

    let sendCount = 0;
    for (const groupId of Object.keys(uniqueDispatches)) {
      const dispatch = uniqueDispatches[groupId];
      const imageUrl = `${BASE_URL}/images/${dispatch.source_image_message_id}.jpg`;
      
      console.log(`[Scheduler] Dispatching image to group ${groupId}. URL: ${imageUrl}`);
      
      await pushMessage(groupId, {
        type: 'image',
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl
      });
      
      sendCount++;
    }

    console.log(`[Scheduler] Daily dispatch completed. Sent to ${sendCount} groups.`);
    return { success: true, count: sendCount };
  } catch (error) {
    console.error('[Scheduler] Error running daily dispatch:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Runs daily reminders for presentations and administrative courses.
 * Looks up scheduled users and sends them highlighted @mentions.
 */
export async function runDailyReminders() {
  console.log('[Scheduler] Starting daily reminders job...');
  try {
    const allEvents = await db.group_events.getAllGlobal();
    const allMappings = await db.doctor_group_mapping.getAll();
    const allUsers = await db.users.getAll();

    const now = new Date();
    // Get current date string in Taiwan Time (YYYY-MM-DD)
    const tzOffset = 8 * 60 * 60 * 1000;
    const todayStr = new Date(now.getTime() + tzOffset).toISOString().split('T')[0];
    const today = new Date(todayStr);

    for (const evt of allEvents) {
      // Parse event date
      const eventDate = new Date(evt.date);
      const diffTime = eventDate - today;
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

      // Remind at 28 days (under 1 month warning), 7 days (1 week warning) and 1 day (final warning)
      if (diffDays === 28 || diffDays === 7 || diffDays === 1) {
        // Find if this event mentions any doctor in mappings
        for (const map of allMappings) {
          if (map.type === 'DIRECT' && evt.title.includes(map.match_key)) {
            const docName = map.match_key;
            const targetGroupId = map.line_group_id; // Send directly to their group (Group B)
            
            // Find user profile for mention
            const targetUser = allUsers.find(u => u.display_name.includes(docName));
            
            let messageObj;
            if (diffDays === 28) {
              // 4 weeks reminder (next month preview)
              const prefix = "📢 報告提醒（下月預告）：";
              const timeStr = evt.time ? ` ${evt.time}` : '';
              
              if (targetUser) {
                const mentionText = `@${targetUser.display_name}`;
                const suffix = ` 於 ${evt.date} (${getDayOfWeek(evt.date)})${timeStr} 有排定晨會個案報告，特此預告提醒。`;
                const fullText = prefix + mentionText + suffix;
                messageObj = {
                  type: "text",
                  text: fullText,
                  mention: {
                    mentions: [{
                      index: prefix.length,
                      length: mentionText.length,
                      userId: targetUser.line_user_id
                    }]
                  }
                };
              } else {
                messageObj = {
                  type: "text",
                  text: `📢 報告提醒（下月預告）：${docName}醫師 於 ${evt.date} (${getDayOfWeek(evt.date)})${timeStr} 有排定晨會個案報告，特此預告提醒。`
                };
              }
            } else if (diffDays === 7) {
              // 7 days reminder
              const prefix = "📢 報告提醒：下週 ";
              const timeStr = evt.time ? ` ${evt.time}` : '';
              
              if (targetUser) {
                const mentionText = `@${targetUser.display_name}`;
                const suffix = ` (${getDayOfWeek(evt.date)}) 有晨會個案報告，請提前準備報告內容。`;
                const fullText = prefix + mentionText + suffix;
                messageObj = {
                  type: "text",
                  text: fullText,
                  mention: {
                    mentions: [{
                      index: prefix.length,
                      length: mentionText.length,
                      userId: targetUser.line_user_id
                    }]
                  }
                };
              } else {
                messageObj = {
                  type: "text",
                  text: `📢 報告提醒：下週 ${evt.date} (${getDayOfWeek(evt.date)})${timeStr} 由 ${docName}醫師 進行晨會報告，請提前準備。`
                };
              }
            } else {
              // 1 day reminder (tomorrow)
              const prefix = "📢 明日報告提醒：";
              const timeStr = evt.time ? ` 於明日 ${evt.time}` : ' 於明日';
              const locStr = evt.location ? ` 在 ${evt.location}` : '';
              
              if (targetUser) {
                const mentionText = `@${targetUser.display_name}`;
                const suffix = `${timeStr}${locStr}進行晨會個案報告，請準時出席。`;
                const fullText = prefix + mentionText + suffix;
                messageObj = {
                  type: "text",
                  text: fullText,
                  mention: {
                    mentions: [{
                      index: prefix.length,
                      length: mentionText.length,
                      userId: targetUser.line_user_id
                    }]
                  }
                };
              } else {
                messageObj = {
                  type: "text",
                  text: `📢 明日報告提醒：${docName}醫師${timeStr}${locStr}進行晨會個案報告，請準時出席。`
                };
              }
            }

            console.log(`[Scheduler] Pushing cross-group reminder to group ${targetGroupId} for ${docName}`);
            await pushMessage(targetGroupId, messageObj);
          }
        }
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error running daily reminders:', error);
  }
}

function getDayOfWeek(dateStr) {
  const date = new Date(dateStr);
  return '週' + ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
}

// ----------------------------------------------------
// Setup Cron Job Schedule locally
// ----------------------------------------------------
export async function initializeScheduler() {
  if (process.env.NODE_ENV !== 'production') {
    try {
      const cron = (await import('node-cron')).default;
      cron.schedule('30 7 * * *', async () => {
        console.log('[Cron] 07:30 Daily Cron Triggered.');
        await runDailyDispatch();
        await runDailyReminders();
      });
      console.log('[Cron] Local scheduler initialized to run everyday at 07:30.');
    } catch (e) {
      console.warn('[Cron] Local scheduler failed to initialize:', e.message);
    }
  }
}
