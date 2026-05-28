import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import dotenv from 'dotenv';
import path from 'path';
import { db } from './db.js';
import { verifySignature, handleWebhookEvent, pushMessage } from './line.js';
import { initializeScheduler, runDailyDispatch, runDailyReminders } from './scheduler.js';

dotenv.config();

const app = new Hono();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use('*', cors());

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

app.get('/liff/calendar', (c) => {
  const query = c.req.url.includes('?') ? c.req.url.substring(c.req.url.indexOf('?')) : '';
  return c.redirect('/calendar.html' + query);
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

      // Execute handler in background without blocking the response
      const promise = handleWebhookEvent(event).catch(error => {
        console.error('[Webhook] Async event execution failed:', error);
      });

      if (c.executionCtx) {
        c.executionCtx.waitUntil(promise);
      }
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
      
      const promise = pushMessage(sourceId, {
        type: 'text',
        text: confirmText
      });
      if (c.executionCtx) {
        c.executionCtx.waitUntil(promise);
      } else {
        await promise;
      }
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
    return c.json(events);
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

// Trigger the daily cron task manually
app.get('/api/test-cron', async (c) => {
  console.log('[Manual Trigger] Running daily jobs.');
  const dispatchResult = await runDailyDispatch();
  const promise = runDailyReminders();
  if (c.executionCtx) {
    c.executionCtx.waitUntil(promise);
  } else {
    await promise;
  }
  return c.json({
    message: 'Manual jobs triggered.',
    dispatchResult
  });
});

// ----------------------------------------------------
// Local Development Server Execution
// ----------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  // Serve static files locally
  try {
    const { serveStatic } = await import('@hono/node-server/serve-static');
    app.use('/*', serveStatic({ root: './public' }));
  } catch (e) {
    console.warn('Local serveStatic middleware not loaded:', e.message);
  }

  serve({
    fetch: app.fetch,
    port: parseInt(PORT)
  }, () => {
    console.log(`=================================================`);
    console.log(`Hospital Workgroup Bot server running locally on port ${PORT}`);
    console.log(`Local LIFF Notes URL: http://localhost:${PORT}/liff/notes`);
    console.log(`Local LIFF Dispatch URL: http://localhost:${PORT}/liff/dispatch`);
    console.log(`=================================================`);
    
    // Initialize Node-cron Scheduler locally
    initializeScheduler();
  });
}

// ----------------------------------------------------
// Cloudflare Workers Entrypoint Exports
// ----------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    console.log('[Cloudflare Cron] Scheduled event triggered.');
    ctx.waitUntil(runDailyDispatch());
    ctx.waitUntil(runDailyReminders());
  }
};
