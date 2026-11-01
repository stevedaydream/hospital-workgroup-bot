import { parseTravel, calendarAbsences } from './travel.js';
import { todayInTaipei } from './util/date.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { db } from './db.js';
import { requireLiffAuth, requireAdminKey } from './auth.js';
import { verifySignature, handleWebhookEvent, pushMessage, GROUP_WINDOW_MS } from './line.js';
import { getJobView, getJob, createJob, updateJob, trackModelStage } from './progress.js';
import { analyzeRoster, isModelLoaded, modelLabel } from './ai.js';
import { initializeScheduler, runDailyDispatch, runDailyReminders } from './scheduler.js';
import { medbaseEnabled, verifyNotifySignature, deliverNotice, DEFAULT_MEDBASE_GROUP, getAttendingRoster } from './medbase.js';
import { getGroupMemberCount, getPushQuota } from './line.js';
import { FEATURES, isFeatureKey, effectiveFeatures } from './features.js';

dotenv.config();

// The admin page downsizes photos before upload; this only stops abuse.
const MAX_ROSTER_IMAGE_BYTES = 8 * 1024 * 1024;
const MEDBASE_GROUP_ID = /^[A-Za-z0-9]{1,12}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const app = new Hono();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use('*', cors());

// Health check for Port Monitor. The commit shows whether the running process
// has picked up the latest code (npm start does not reload on change).
const STARTED_AT = new Date().toISOString();
const COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
})();
app.get('/health', (c) => c.json({ status: 'ok', startedAt: STARTED_AT, commit: COMMIT }));

// ----------------------------------------------------
// API Authentication
// ----------------------------------------------------
// /api/config is fetched before liff.init() can possibly run, so it stays open
// -- it only exposes public LIFF IDs. /api/users/sync is the registration door
// and therefore accepts verified-but-unregistered users. Everything else needs
// a verified token belonging to someone already in the roster.
const OPEN_API_PATHS = new Set(['/api/config']);
const liffAuth = requireLiffAuth();
const registrationAuth = requireLiffAuth({ allowUnregistered: true });
const adminAuth = requireAdminKey();

app.use('/api/*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (OPEN_API_PATHS.has(pathname)) return next();
  if (pathname === '/api/test-cron') return adminAuth(c, next);
  if (pathname === '/api/users/sync') return registrationAuth(c, next);
  return liffAuth(c, next);
});

// Event de-duplication set to prevent reprocessing the same retry request
const processedEventKeys = new Set();
const MAX_PROCESSED_KEYS = 500;

// Helper: Calculate Thursdays
function getThursdaysInRange(startDateStr, endDateStr) {
  const thursdays = [];
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  
  let current = new Date(start);
  while (current.getDay() !== 4) { // 4 represents Thursday
    current.setDate(current.getDate() + 1);
  }
  
  while (current <= end) {
    thursdays.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 7);
  }
  
  return thursdays;
}

// ----------------------------------------------------
// MedBase swap notices (medbase-mobile /api/swap → LINE DM)
// ----------------------------------------------------
// Outside /api/*: the caller is MedBase's server, authenticated by an HMAC
// over the raw body with a shared secret and a 5-minute timestamp window.
app.post('/integrations/medbase', async (c) => {
  const rawBody = await c.req.text();
  if (!verifyNotifySignature(rawBody, c.req.header('x-medbase-timestamp'), c.req.header('x-medbase-signature'))) {
    return c.json({ ok: false, error: 'invalid signature' }, 401);
  }
  try {
    const notice = JSON.parse(rawBody);
    const delivered = await deliverNotice(notice, pushMessage);
    console.log(`[MedBase] ${notice.event} delivered to ${delivered} LINE account(s)`);
    return c.json({ ok: true, delivered });
  } catch (error) {
    console.error('[MedBase] notice failed:', error.message);
    return c.json({ ok: false, error: error.message }, 400);
  }
});

// ----------------------------------------------------
// Recognition progress (public/progress.html)
// ----------------------------------------------------
// Opened from a link in the LINE reply, outside LIFF, so it cannot carry an
// ID token. The job id is 96 random bits and the view holds only stage and
// timing -- no image content or recognition results.
app.get('/progress-api/:id', (c) => {
  const view = getJobView(c.req.param('id'), GROUP_WINDOW_MS);
  if (!view) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json(view);
});

// ----------------------------------------------------
// Pretty URL Router Redirects for LIFF Apps
// ----------------------------------------------------
app.get('/liff/notes', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  return c.redirect('/notes.html' + query);
});

app.get('/liff/dispatch', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  return c.redirect('/dispatch.html' + query);
});

app.get('/liff/admin', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  return c.redirect('/admin.html' + query);
});

// Without its own LIFF app, the travel page rides on the calendar one: the menu
// opens it with ?page=travel, which LIFF may first hand over inside liff.state.
app.get('/liff/calendar', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  const wantsTravel = c.req.query('page') === 'travel' || (c.req.query('liff.state') || '').includes('page=travel');
  return c.redirect((wantsTravel ? '/travel.html' : '/calendar.html') + query);
});

app.get('/liff/travel', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  return c.redirect('/travel.html' + query);
});

// ----------------------------------------------------
// LINE Webhook Handler
// ----------------------------------------------------
app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature');
  const rawBody = await c.req.text();

  if (!verifySignature(rawBody, signature)) {
    console.warn('[Webhook] Signature verification failed.');
    return c.text('Invalid signature', 401);
  }

  try {
    const payload = JSON.parse(rawBody);
    for (const event of payload.events || []) {
      const eventKey = event.webhookEventId || (event.message && event.message.id) || `${event.type}-${event.timestamp}`;
      
      // De-duplication check
      if (processedEventKeys.has(eventKey)) {
        console.log(`[Webhook] Duplicate event detected and ignored: ${eventKey}`);
        continue;
      }
      
      processedEventKeys.add(eventKey);
      if (processedEventKeys.size > MAX_PROCESSED_KEYS) {
        const oldestKey = processedEventKeys.values().next().value;
        processedEventKeys.delete(oldestKey);
      }

      // Execute handler in background without blocking the response. LINE
      // expects a reply within seconds; OCR and pushes take much longer.
      handleWebhookEvent(event).catch(error => {
        console.error('[Webhook] Async event execution failed:', error);
      });
    }
  } catch (error) {
    console.error('[Webhook] Error parsing webhook payload:', error);
  }

  return c.text('OK', 200);
});

// ----------------------------------------------------
// LIFF API Endpoints
// ----------------------------------------------------

// Get LIFF configuration IDs
app.get('/api/config', (c) => {
  return c.json({
    LIFF_NOTES_ID: process.env.LIFF_NOTES_ID,
    LIFF_DISPATCH_ID: process.env.LIFF_DISPATCH_ID,
    LIFF_ADMIN_ID: process.env.LIFF_ADMIN_ID,
    LIFF_CALENDAR_ID: process.env.LIFF_CALENDAR_ID,
    LIFF_TRAVEL_ID: process.env.LIFF_TRAVEL_ID || null,
  });
});

// Sync user identity upon LIFF login
app.post('/api/users/sync', async (c) => {
  const { lineUserId, displayName } = await c.req.json();
  if (!lineUserId || !displayName) {
    return c.json({ error: 'Missing parameters' }, 400);
  }
  try {
    const user = await db.users.createOrUpdate(lineUserId, displayName);
    return c.json(user);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/users', async (c) => {
  try {
    const users = await db.users.getAll();
    return c.json(users);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Fetch all ward notes (Directory List)
app.get('/api/note-reviews', c => c.json(db.note_reviews.list()));
app.post('/api/note-reviews/:id/resolve', async c => {
  const { action } = await c.req.json().catch(() => ({}));
  if (!['approve', 'dismiss'].includes(action)) return c.json({ error: '無效操作' }, 400);
  const result = db.note_reviews.resolve(c.req.param('id'), action, c.get('displayName') || '未知人員');
  return result ? c.json(result) : c.json({ error: '找不到待確認公告' }, 404);
});

app.get('/api/notes', async (c) => {
  try {
    const notes = await db.general_notes.getAll();
    return c.json(notes);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Fetch latest ward note (compatibility fallback)
app.get('/api/notes/latest', async (c) => {
  try {
    const notes = await db.general_notes.getAll();
    return c.json(notes.length > 0 ? notes[0] : null);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Fetch specific ward note by ID
app.get('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const note = await db.general_notes.getById(id);
    if (!note) return c.json({ error: 'Note not found' }, 404);
    return c.json(note);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Create a new ward note/notice
app.post('/api/notes', async (c) => {
  const { title, content, updatedBy } = await c.req.json();
  if (!title || !content) {
    return c.json({ error: 'Missing title or content' }, 400);
  }
  try {
    const note = await db.general_notes.create(title, content, updatedBy || '未知人員');
    return c.json(note);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Update an existing ward note/notice
app.put('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const { title, content, updatedBy } = await c.req.json();
  if (!title || !content) {
    return c.json({ error: 'Missing title or content' }, 400);
  }
  try {
    const note = await db.general_notes.update(id, title, content, updatedBy || '未知人員');
    return c.json(note);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Delete a ward note/notice
app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await db.general_notes.delete(id);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Get doctor-group mappings
app.get('/api/doctor-mappings', async (c) => {
  const dept = c.req.query('dept');
  try {
    const allMappings = await db.doctor_group_mapping.getAll();
    if (dept) {
      const filtered = allMappings.filter(m => m.match_key.toUpperCase() === dept.toUpperCase());
      return c.json(filtered);
    } else {
      return c.json(allMappings);
    }
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Read the MedBase directory's attending roster without changing any mappings.
app.get('/api/doctor-mappings/medbase-roster', async (c) => {
  if (!medbaseEnabled) return c.json({ error: '尚未設定 MedBase 串接' }, 503);
  try {
    return c.json({ doctors: await getAttendingRoster(), source: 'MedBase 通訊錄' });
  } catch (error) {
    return c.json({ error: error.message }, 502);
  }
});

// Post a new doctor mapping
app.post('/api/doctor-mappings', async (c) => {
  const { matchKey, groupName, lineGroupId, type } = await c.req.json();
  if (!matchKey || !groupName || !lineGroupId || !type) {
    return c.json({ error: 'Missing parameters' }, 400);
  }
  try {
    const newMap = await db.doctor_group_mapping.create(matchKey, groupName, lineGroupId, type);
    return c.json(newMap);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Roster import, step 1: read doctor names from a photo. Recognition can take
// minutes (cold model load) but the Vercel relay cuts requests at 60s, so this
// starts a job and the admin page polls for the result.
app.post('/api/doctor-mappings/roster-scan', async (c) => {
  const { image } = await c.req.json().catch(() => ({}));
  if (typeof image !== 'string' || !image) {
    return c.json({ error: 'Missing image' }, 400);
  }
  const imageBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (imageBuffer.length === 0 || imageBuffer.length > MAX_ROSTER_IMAGE_BYTES) {
    return c.json({ error: 'Image is empty or too large' }, 413);
  }

  const job = createJob();
  updateJob(job, { stage: 'recognizing' });
  const stage = trackModelStage(job, { isModelLoaded, modelLabel });
  analyzeRoster(imageBuffer, stage.onAttempt)
    .then(result => {
      stage.stop();
      updateJob(job, { stage: 'done', result: { doctors: result.doctors }, resultLabel: `${result.doctors.length} 位醫師` });
    })
    .catch(error => {
      stage.stop();
      console.error('[Roster] recognition failed:', error.message);
      updateJob(job, { stage: 'failed', error: error.message });
    });
  return c.json({ jobId: job.id });
});

app.get('/api/doctor-mappings/roster-scan/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not_found' }, 404);
  return c.json({ ...getJobView(job.id, 0), result: job.result });
});

// Roster import, step 2: write the rows the user reviewed and assigned groups to.
app.post('/api/doctor-mappings/bulk', async (c) => {
  const { mappings } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return c.json({ error: 'Missing mappings' }, 400);
  }
  const rows = mappings.map(m => ({
    matchKey: String(m.matchKey || '').trim(),
    groupName: String(m.groupName || '').trim(),
    lineGroupId: String(m.lineGroupId || '').trim(),
    type: m.type
  }));
  if (rows.some(r => !r.matchKey || !r.groupName || !r.lineGroupId || !['DIRECT', 'FLEXIBLE'].includes(r.type))) {
    return c.json({ error: 'Every row needs matchKey, groupName, lineGroupId and a valid type' }, 400);
  }
  try {
    return c.json(await db.doctor_group_mapping.createMany(rows));
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// LINE groups the bot has been invited into, recorded on join (admin page).
app.get('/api/line-groups', (c) => c.json(db.line_groups.getAll()));

app.delete('/api/line-groups/:lineGroupId', (c) => {
  return c.json({ removed: db.line_groups.remove(c.req.param('lineGroupId')) });
});

// Feature switches per LINE group (admin page). '*' holds the defaults for
// groups that have no settings of their own.
app.get('/api/group-features', (c) => {
  const saved = db.group_features.getAll();
  const lastChange = (id) => saved
    .filter(r => r.line_group_id === id)
    .reduce((latest, r) => (!latest || r.updated_at > latest.updated_at ? r : latest), null);
  const view = (id) => {
    const last = lastChange(id);
    return {
      features: effectiveFeatures(id),
      customized: Boolean(last),
      updated_at: last?.updated_at || null,
      updated_by: last?.updated_by || null
    };
  };
  return c.json({
    features: FEATURES,
    defaults: view('*'),
    groups: db.line_groups.getAll().map(g => ({ ...g, ...view(g.line_group_id) }))
  });
});

app.put('/api/group-features/:lineGroupId', async (c) => {
  const lineGroupId = c.req.param('lineGroupId');
  if (lineGroupId !== '*' && !/^[CR][0-9a-f]{32}$/.test(lineGroupId)) return c.json({ error: 'LINE 群組 ID 格式錯誤' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const features = body.features && typeof body.features === 'object' ? body.features : {};
  const entries = Object.entries(features).filter(([key]) => isFeatureKey(key));
  if (entries.length === 0) return c.json({ error: '沒有可儲存的功能開關' }, 400);
  db.group_features.save(lineGroupId, Object.fromEntries(entries.map(([k, v]) => [k, Boolean(v)])), c.get('displayName') || '未知人員');
  return c.json({ features: effectiveFeatures(lineGroupId) });
});

// Back to following the defaults.
app.delete('/api/group-features/:lineGroupId', (c) => {
  return c.json({ removed: db.group_features.reset(c.req.param('lineGroupId')) });
});

// MedBase settings per LINE group (admin page). Member counts come from LINE
// so the page can show what a daily reminder costs against the push quota.
app.get('/api/medbase/groups', async (c) => {
  const groups = db.medbase_groups.getAll();
  const counts = await Promise.all(groups.map(g => getGroupMemberCount(g.line_group_id)));
  return c.json({
    enabled: medbaseEnabled,
    defaultGroup: DEFAULT_MEDBASE_GROUP,
    quota: await getPushQuota(),
    groups: groups.map((g, i) => ({ ...g, member_count: counts[i] }))
  });
});

app.put('/api/medbase/groups/:lineGroupId', async (c) => {
  const lineGroupId = c.req.param('lineGroupId');
  const body = await c.req.json().catch(() => ({}));
  const medbaseGroup = String(body.medbaseGroup || '').trim();
  const remindTime = String(body.remindTime || '20:00');
  if (!/^[CR][0-9a-f]{32}$/.test(lineGroupId)) return c.json({ error: 'LINE 群組 ID 格式錯誤' }, 400);
  if (!MEDBASE_GROUP_ID.test(medbaseGroup)) return c.json({ error: 'MedBase 群組代碼錯誤' }, 400);
  if (!HHMM.test(remindTime)) return c.json({ error: '提醒時間需為 HH:MM' }, 400);
  return c.json(db.medbase_groups.upsert(lineGroupId, {
    groupName: String(body.groupName || '').trim().slice(0, 50),
    medbaseGroup,
    remindEnabled: Boolean(body.remindEnabled),
    remindTime,
    notifyPublish: Boolean(body.notifyPublish)
  }));
});

app.delete('/api/medbase/groups/:lineGroupId', (c) => {
  return c.json({ removed: db.medbase_groups.remove(c.req.param('lineGroupId')) });
});

// Delete a doctor-group mapping
app.delete('/api/doctor-mappings/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await db.doctor_group_mapping.delete(id);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Fetch dispatch cache details
app.get('/api/dispatch-cache', async (c) => {
  const msgId = c.req.query('msgId');
  try {
    const pending = await db.daily_dispatch_cache.getPending();
    if (msgId) {
      const filtered = pending.filter(p => p.source_image_message_id === msgId);
      return c.json(filtered);
    } else {
      return c.json(pending);
    }
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Confirm/unconfirm selected dispatch groups
app.post('/api/dispatch-cache/confirm', async (c) => {
  const { messageId, selectedGroups, unselectedGroups, sourceId, updatedBy } = await c.req.json();
  if (!messageId) {
    return c.json({ error: 'Missing messageId' }, 400);
  }
  try {
    if (selectedGroups && Array.isArray(selectedGroups)) {
      for (const groupId of selectedGroups) {
        await db.daily_dispatch_cache.add(groupId, messageId, true);
      }
    }
    if (unselectedGroups && Array.isArray(unselectedGroups)) {
      for (const groupId of unselectedGroups) {
        await db.daily_dispatch_cache.remove(groupId);
      }
    }
    
    if (sourceId) {
      const allMappings = await db.doctor_group_mapping.getAll();
      const confirmedGroupNames = [];
      
      if (selectedGroups && Array.isArray(selectedGroups)) {
        for (const groupId of selectedGroups) {
          const mapping = allMappings.find(m => m.line_group_id === groupId);
          if (mapping) {
            confirmedGroupNames.push(mapping.group_name);
          }
        }
      }
      
      const userStr = updatedBy || '同仁';
      let confirmText = `✅ URO (泌尿科) 轉發對象設定成功！\n\n`;
      if (confirmedGroupNames.length > 0) {
        confirmText += `明早 07:30 將自動轉發分配表至：\n` + confirmedGroupNames.map(name => `• ${name}`).join('\n') + `\n\n`;
      } else {
        confirmText += `本日無勾選任何 URO 轉發對象，明早將不會向 URO 群組推送大表。\n\n`;
      }
      confirmText += `（設定同仁：${userStr}）`;
      
      await pushMessage(sourceId, {
        type: 'text',
        text: confirmText
      });
    }
    
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Fetch all events for a group
app.get('/api/events', async (c) => {
  const groupId = c.req.query('groupId');
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400);
  try {
    const events = await db.group_events.getAll(groupId);
    return c.json(c.req.query('absences') === '1'
      ? [...events, ...calendarAbsences(db.travels.list({ includePast: true }), events, todayInTaipei())]
      : events);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Create manual calendar event
app.post('/api/events', async (c) => {
  const { groupId, title, date, time, location, description, createdBy } = await c.req.json();
  if (!groupId || !title || !date) {
    return c.json({ error: 'Missing parameters' }, 400);
  }
  try {
    const event = await db.group_events.create(groupId, {
      title,
      date,
      time: time || null,
      location: location || null,
      description: description || null,
      created_by: createdBy || '未知人員'
    });
    return c.json(event);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Delete calendar event
app.delete('/api/events/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await db.group_events.delete(id);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ----------------------------------------------------
// Overseas travel registrations (public/travel.html)
// ----------------------------------------------------
app.get('/api/travels', (c) => {
  return c.json(db.travels.list({ includePast: c.req.query('past') === '1' }));
});

app.post('/api/travels', async (c) => {
  const { trip, error } = parseTravel(await c.req.json().catch(() => ({})));
  if (error) return c.json({ error }, 400);
  return c.json(db.travels.create(trip, c.get('displayName') || '未知人員'));
});

app.put('/api/travels/:id', async (c) => {
  const { trip, error } = parseTravel(await c.req.json().catch(() => ({})));
  if (error) return c.json({ error }, 400);
  const updated = db.travels.update(Number(c.req.param('id')), trip, c.get('displayName') || '未知人員');
  return updated ? c.json(updated) : c.json({ error: 'not_found' }, 404);
});

app.delete('/api/travels/:id', (c) => {
  return c.json({ removed: db.travels.remove(Number(c.req.param('id'))) });
});

// Fetch rotation settings
app.get('/api/rotations', async (c) => {
  const groupId = c.req.query('groupId');
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400);
  try {
    const rotations = await db.rotations.get(groupId);
    return c.json(rotations);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Save rotation settings
app.post('/api/rotations', async (c) => {
  const { groupId, doctors, nps, exclusions, dept_sequence, ward_sequence } = await c.req.json();
  if (!groupId) return c.json({ error: 'Missing groupId' }, 400);
  try {
    const rotations = await db.rotations.save(groupId, { doctors, nps, exclusions, dept_sequence, ward_sequence });
    return c.json(rotations);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Generate Thursday Morning Presentation Rotations
app.post('/api/rotations/generate', async (c) => {
  const { groupId, startDate, endDate, startDept, startWard } = await c.req.json();
  if (!groupId || !startDate || !endDate) {
    return c.json({ error: 'Missing required parameters' }, 400);
  }
  try {
    const rotation = await db.rotations.get(groupId);
    let { doctors = [], nps = [], exclusions = [], dept_sequence = [], ward_sequence = [] } = rotation;
    
    let doctorsMap = {};
    if (Array.isArray(doctors)) {
      doctorsMap = { 'default': doctors };
    } else {
      doctorsMap = doctors;
    }
    
    let npsMap = {};
    if (Array.isArray(nps)) {
      npsMap = { 'default': nps };
    } else {
      npsMap = nps;
    }
    
    let deptSeq = dept_sequence && dept_sequence.length > 0 ? dept_sequence : Object.keys(doctorsMap);
    if (deptSeq.length === 0) deptSeq = ['default'];
    
    let wardSeq = ward_sequence && ward_sequence.length > 0 ? ward_sequence : Object.keys(npsMap);
    if (wardSeq.length === 0) wardSeq = ['default'];
    
    if (Object.keys(doctorsMap).length === 0 || Object.keys(npsMap).length === 0) {
      return c.json({ error: 'Doctors or NPs rotation list is empty.' }, 400);
    }
    
    await db.group_events.clearGeneratedPresentations(groupId);
    const thursdays = getThursdaysInRange(startDate, endDate);
    
    let deptIdx = startDept ? deptSeq.indexOf(startDept) : 0;
    if (deptIdx === -1) deptIdx = 0;
    
    let wardIdx = startWard ? wardSeq.indexOf(startWard) : 0;
    if (wardIdx === -1) wardIdx = 0;
    
    const docIndices = {};
    const npIndices = {};
    const generated = [];
    
    for (const dateStr of thursdays) {
      const isExcluded = exclusions.includes(dateStr);
      if (isExcluded) {
        const event = await db.group_events.create(groupId, {
          title: "院務會議 (停開晨會報告)",
          date: dateStr,
          time: "08:00",
          location: "第二會議室",
          description: "周四晨會報告輪序"
        });
        generated.push(event);
      } else {
        const dept = deptSeq[deptIdx % deptSeq.length];
        const ward = wardSeq[wardIdx % wardSeq.length];
        
        const docRoster = doctorsMap[dept] || [];
        let doc = "待派醫師";
        if (docRoster.length > 0) {
          if (docIndices[dept] === undefined) docIndices[dept] = 0;
          doc = docRoster[docIndices[dept] % docRoster.length];
          docIndices[dept]++;
        }
        
        const npRoster = npsMap[ward] || [];
        let np = "無專責護理師";
        if (npRoster.length > 0) {
          if (npIndices[ward] === undefined) npIndices[ward] = 0;
          np = npRoster[npIndices[ward] % npRoster.length];
          npIndices[ward]++;
        }
        
        const eventTitle = np === "無專責護理師" ? `${doc}醫師 報告` : `${np} + ${doc}醫師 報告`;
        const event = await db.group_events.create(groupId, {
          title: eventTitle,
          date: dateStr,
          time: "08:00",
          location: "第二會議室",
          description: `周四晨會報告輪序 (負責病房: ${ward}, 負責科別: ${dept})`
        });
        generated.push(event);
        
        deptIdx++;
        wardIdx++;
      }
    }
    
    return c.json({ success: true, count: generated.length, events: generated });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// Trigger the daily cron task manually (requires ADMIN_API_KEY -- this sends
// real images to every confirmed group).
app.get('/api/test-cron', async (c) => {
  console.log('[Manual Trigger] Running daily jobs.');
  const dispatchResult = await runDailyDispatch();
  await runDailyReminders();
  return c.json({
    message: 'Manual jobs triggered.',
    dispatchResult
  });
});

// ----------------------------------------------------
// Static Files (LIFF pages, CSS, dispatched images)
// ----------------------------------------------------
// Served in every environment. On Cloudflare Workers this needed an [assets]
// binding that was never configured, which is why the LIFF pages were
// unreachable in production.
app.use('/*', serveStatic({ root: './public' }));

// ----------------------------------------------------
// Server Startup
// ----------------------------------------------------
serve(
  {
    fetch: app.fetch,
    port: parseInt(PORT),
    // Public traffic arrives through a local reverse proxy (Tailscale Funnel or
    // Caddy), so the app itself never needs to listen beyond loopback.
    hostname: process.env.HOST || '127.0.0.1'
  },
  () => {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    console.log('=================================================');
    console.log(`Hospital Workgroup Bot listening on port ${PORT}`);
    console.log(`Webhook URL : ${baseUrl}/webhook`);
    console.log(`LIFF Notes  : ${baseUrl}/liff/notes`);
    console.log(`LIFF Admin  : ${baseUrl}/liff/admin`);
    console.log('=================================================');

    initializeScheduler();
  }
);
