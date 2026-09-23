import cron from 'node-cron';
import dotenv from 'dotenv';
import { db } from './db.js';
import { pushMessage, adoptConfirmation } from './line.js';
import { todayInTaipei, daysBetween, dayOfWeek } from './util/date.js';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Runs the daily case distribution image dispatch.
 * Fetches all confirmed dispatches for today and sends the cached images to respective groups.
 */
export async function runDailyDispatch() {
  console.log('[Scheduler] Starting daily dispatch job...');
  try {
    // Rows whose dispatch_date is today, i.e. queued yesterday for this morning.
    const dueDispatches = await db.daily_dispatch_cache.getDue();
    const confirmedDispatches = dueDispatches.filter(d => d.is_confirmed);

    if (confirmedDispatches.length === 0) {
      console.log(`[Scheduler] No confirmed dispatches for ${todayInTaipei()}.`);
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

    const todayStr = todayInTaipei();

    for (const evt of allEvents) {
      const diffDays = daysBetween(todayStr, evt.date);

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
                const suffix = ` 於 ${evt.date} (${dayOfWeek(evt.date)})${timeStr} 有排定晨會個案報告，特此預告提醒。`;
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
                  text: `📢 報告提醒（下月預告）：${docName}醫師 於 ${evt.date} (${dayOfWeek(evt.date)})${timeStr} 有排定晨會個案報告，特此預告提醒。`
                };
              }
            } else if (diffDays === 7) {
              // 7 days reminder
              const prefix = "📢 報告提醒：下週 ";
              const timeStr = evt.time ? ` ${evt.time}` : '';
              
              if (targetUser) {
                const mentionText = `@${targetUser.display_name}`;
                const suffix = ` (${dayOfWeek(evt.date)}) 有晨會個案報告，請提前準備報告內容。`;
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
                  text: `📢 報告提醒：下週 ${evt.date} (${dayOfWeek(evt.date)})${timeStr} 由 ${docName}醫師 進行晨會報告，請提前準備。`
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

/**
 * Adopts dispatch proposals nobody answered within the grace period.
 *
 * The confirmation card exists to catch misreadings, but a ward at 03:00 has
 * nobody to tap it. Expiring silently would turn "we added a safety check"
 * into "the table stopped going out", which is the worse failure -- so the
 * matched result is adopted and the group is told it happened.
 */
export async function runAutoAdoption() {
  try {
    const due = await db.dispatch_confirmations.getDueForAutoAdopt();
    if (due.length === 0) return { adopted: 0 };

    for (const confirmation of due) {
      console.log(`[Scheduler] Auto-adopting unconfirmed dispatch #${confirmation.id}`);
      await adoptConfirmation(confirmation.id, '系統自動採用', { auto: true });
    }
    return { adopted: due.length };
  } catch (error) {
    console.error('[Scheduler] Error during auto-adoption:', error);
    return { adopted: 0, error: error.message };
  }
}

// ----------------------------------------------------
// Cron Job Schedule
// ----------------------------------------------------
/**
 * Starts the 07:30 job. This used to be skipped whenever NODE_ENV was
 * 'production' (the schedule lived in Cloudflare's cron trigger instead), so a
 * production Node process silently never dispatched anything.
 *
 * The timezone is pinned explicitly rather than inherited from the host, so a
 * VM left on UTC still fires at 07:30 Taiwan time.
 */
export function initializeScheduler() {
  cron.schedule(
    '30 7 * * *',
    async () => {
      console.log('[Cron] 07:30 Asia/Taipei daily job triggered.');
      await runDailyDispatch();
      await runDailyReminders();
    },
    { timezone: 'Asia/Taipei' }
  );

  // Checked often enough that the grace period means what the card says.
  cron.schedule('*/10 * * * *', runAutoAdoption, { timezone: 'Asia/Taipei' });

  console.log('[Cron] Scheduler armed: dispatch 07:30 Asia/Taipei, auto-adoption every 10 minutes.');
}
