import fs from 'fs/promises';
import path from 'path';
import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const DB_TYPE = process.env.DB_TYPE || 'local';
const JSON_DB_PATH = path.resolve('db.json');

// Initialize Firebase if configured
let firestoreDb = null;
if (DB_TYPE === 'firestore') {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : null;

    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      firestoreDb = admin.firestore();
      console.log('Database: Connected to Firebase Firestore.');
    } else {
      console.warn('Database: Firestore config missing. Falling back to local JSON DB.');
    }
  } catch (error) {
    console.error('Database: Failed to initialize Firebase Firestore:', error.message);
  }
}

// Initialize Supabase if configured
let supabaseDb = null;
if (DB_TYPE === 'supabase') {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      supabaseDb = createClient(supabaseUrl, supabaseKey);
      console.log('Database: Connected to Supabase PostgreSQL.');
    } else {
      console.warn('Database: Supabase config missing. Falling back to local JSON DB.');
    }
  } catch (error) {
    console.error('Database: Failed to initialize Supabase client:', error.message);
  }
}

// ----------------------------------------------------
// Local JSON Database Implementation
// ----------------------------------------------------
const defaultSchema = {
  users: [
    { id: 1, line_user_id: 'U_demo_user_1', display_name: '陳鍾沛醫生' },
    { id: 2, line_user_id: 'U_demo_user_2', display_name: '林小嫻護理師' }
  ],
  general_notes: [
    {
      id: 1,
      title: "今日交班公告",
      content: "9B-12床王大同準備下午出院，請協助辦理出院手續與衛教。",
      updated_at: new Date().toISOString(),
      updated_by: "系統管理員"
    },
    {
      id: 2,
      title: "課程與會議提醒",
      content: "明日 08:00 有全科晨會與個案報告，請陳鍾沛醫師準時出席。",
      updated_at: new Date().toISOString(),
      updated_by: "系統管理員"
    },
    {
      id: 3,
      title: "醫療儀器保養",
      content: "超音波儀器今日定期保養，預計下午3點歸還至護理站。",
      updated_at: new Date().toISOString(),
      updated_by: "系統管理員"
    }
  ],
  doctor_group_mapping: [
    { id: 1, match_key: "陳鍾沛", group_name: "大樹骨群", line_group_id: "G_ortho_group", type: "DIRECT" },
    { id: 2, match_key: "URO", group_name: "王彥傑醫師群", line_group_id: "G_uro_wang_yj", type: "FLEXIBLE" },
    { id: 3, match_key: "URO", group_name: "王世峰醫師群", line_group_id: "G_uro_wang_sf", type: "FLEXIBLE" }
  ],
  daily_dispatch_cache: [],
  group_events: [],
  presentation_rotations: []
};

async function readLocalDb() {
  try {
    const data = await fs.readFile(JSON_DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    await fs.writeFile(JSON_DB_PATH, JSON.stringify(defaultSchema, null, 2), 'utf-8');
    return defaultSchema;
  }
}

async function writeLocalDb(data) {
  await fs.writeFile(JSON_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ----------------------------------------------------
// Database Interface Methods
// ----------------------------------------------------
export const db = {
  // --- Users API ---
  users: {
    async getAll() {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('users').select('*');
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('users').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return data.users;
      }
    },

    async getByLineUserId(lineUserId) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('users').select('*').eq('line_user_id', lineUserId).maybeSingle();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('users').where('line_user_id', '==', lineUserId).get();
        if (snapshot.empty) return null;
        return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
      } else {
        const data = await readLocalDb();
        return data.users.find(u => u.line_user_id === lineUserId) || null;
      }
    },

    async createOrUpdate(lineUserId, displayName) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('users').upsert(
          { line_user_id: lineUserId, display_name: displayName },
          { onConflict: 'line_user_id' }
        ).select().single();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('users').where('line_user_id', '==', lineUserId).get();
        if (snapshot.empty) {
          const docRef = await firestoreDb.collection('users').add({
            line_user_id: lineUserId,
            display_name: displayName,
          });
          return { id: docRef.id, line_user_id: lineUserId, display_name: displayName };
        } else {
          const doc = snapshot.docs[0];
          await doc.ref.update({ display_name: displayName });
          return { id: doc.id, line_user_id: lineUserId, display_name: displayName };
        }
      } else {
        const dbData = await readLocalDb();
        let user = dbData.users.find(u => u.line_user_id === lineUserId);
        if (user) {
          user.display_name = displayName;
        } else {
          user = {
            id: dbData.users.length > 0 ? Math.max(...dbData.users.map(u => u.id)) + 1 : 1,
            line_user_id: lineUserId,
            display_name: displayName
          };
          dbData.users.push(user);
        }
        await writeLocalDb(dbData);
        return user;
      }
    }
  },

  // --- General Notes API ---
  general_notes: {
    async getAll() {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('general_notes').select('*').order('updated_at', { ascending: false });
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('general_notes').orderBy('updated_at', 'desc').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return [...data.general_notes].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      }
    },

    async getById(id) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('general_notes').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const doc = await firestoreDb.collection('general_notes').doc(id).get();
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() };
      } else {
        const data = await readLocalDb();
        return data.general_notes.find(n => n.id === parseInt(id) || n.id === id) || null;
      }
    },

    async create(title, content, updatedBy) {
      const now = new Date().toISOString();
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('general_notes').insert({
          title,
          content,
          updated_by: updatedBy,
          updated_at: now
        }).select().single();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const docRef = await firestoreDb.collection('general_notes').add({
          title,
          content,
          updated_at: now,
          updated_by: updatedBy
        });
        return { id: docRef.id, title, content, updated_at: now, updated_by: updatedBy };
      } else {
        const dbData = await readLocalDb();
        const newNote = {
          id: dbData.general_notes.length > 0 ? Math.max(...dbData.general_notes.map(n => n.id)) + 1 : 1,
          title,
          content,
          updated_at: now,
          updated_by: updatedBy
        };
        dbData.general_notes.push(newNote);
        await writeLocalDb(dbData);
        return newNote;
      }
    },

    async update(id, title, content, updatedBy) {
      const now = new Date().toISOString();
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('general_notes').update({
          title,
          content,
          updated_by: updatedBy,
          updated_at: now
        }).eq('id', id).select().single();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        await firestoreDb.collection('general_notes').doc(id).update({
          title,
          content,
          updated_at: now,
          updated_by: updatedBy
        });
        return { id, title, content, updated_at: now, updated_by: updatedBy };
      } else {
        const dbData = await readLocalDb();
        const targetId = parseInt(id) || id;
        const note = dbData.general_notes.find(n => n.id === targetId);
        if (note) {
          note.title = title;
          note.content = content;
          note.updated_at = now;
          note.updated_by = updatedBy;
          await writeLocalDb(dbData);
          return note;
        }
        throw new Error('Note not found');
      }
    },

    async delete(id) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('general_notes').delete().eq('id', id);
        if (error) throw error;
        return { success: true };
      } else if (firestoreDb) {
        await firestoreDb.collection('general_notes').doc(id).delete();
        return { success: true };
      } else {
        const dbData = await readLocalDb();
        const targetId = parseInt(id) || id;
        dbData.general_notes = dbData.general_notes.filter(n => n.id !== targetId);
        await writeLocalDb(dbData);
        return { success: true };
      }
    }
  },

  // --- Doctor Group Mapping API ---
  doctor_group_mapping: {
    async getAll() {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('doctor_group_mapping').select('*');
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('doctor_group_mapping').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return data.doctor_group_mapping;
      }
    },

    async getByMatchKey(matchKey) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('doctor_group_mapping')
          .select('*')
          .ilike('match_key', matchKey);
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('doctor_group_mapping').where('match_key', '==', matchKey).get();
        if (!snapshot.empty) {
          return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        }
        const snapshotUpper = await firestoreDb.collection('doctor_group_mapping').where('match_key', '==', matchKey.toUpperCase()).get();
        return snapshotUpper.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return data.doctor_group_mapping.filter(m => m.match_key.toUpperCase() === matchKey.toUpperCase());
      }
    },

    async create(matchKey, groupName, lineGroupId, type) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('doctor_group_mapping').insert({
          match_key: matchKey,
          group_name: groupName,
          line_group_id: lineGroupId,
          type
        }).select().single();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const docRef = await firestoreDb.collection('doctor_group_mapping').add({
          match_key: matchKey,
          group_name: groupName,
          line_group_id: lineGroupId,
          type
        });
        return { id: docRef.id, match_key: matchKey, group_name: groupName, line_group_id: lineGroupId, type };
      } else {
        const dbData = await readLocalDb();
        const newMapping = {
          id: dbData.doctor_group_mapping.length > 0 ? Math.max(...dbData.doctor_group_mapping.map(m => m.id)) + 1 : 1,
          match_key: matchKey,
          group_name: groupName,
          line_group_id: lineGroupId,
          type
        };
        dbData.doctor_group_mapping.push(newMapping);
        await writeLocalDb(dbData);
        return newMapping;
      }
    },

    async delete(id) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('doctor_group_mapping').delete().eq('id', id);
        if (error) throw error;
        return { success: true };
      } else if (firestoreDb) {
        await firestoreDb.collection('doctor_group_mapping').doc(id).delete();
        return { success: true };
      } else {
        const dbData = await readLocalDb();
        const targetId = parseInt(id) || id;
        dbData.doctor_group_mapping = dbData.doctor_group_mapping.filter(m => m.id !== targetId);
        await writeLocalDb(dbData);
        return { success: true };
      }
    }
  },

  // --- Daily Dispatch Cache API ---
  daily_dispatch_cache: {
    async getPending() {
      const today = new Date().toISOString().split('T')[0];
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('daily_dispatch_cache')
          .select('*')
          .eq('created_at', today);
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('daily_dispatch_cache')
          .where('created_at', '==', today)
          .get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return data.daily_dispatch_cache.filter(c => c.created_at === today);
      }
    },

    async add(targetLineGroupId, sourceImageMessageId, isConfirmed) {
      const today = new Date().toISOString().split('T')[0];
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data: existing, error: checkError } = await supabaseDb.from('daily_dispatch_cache')
          .select('*')
          .eq('created_at', today)
          .eq('target_line_group_id', targetLineGroupId)
          .maybeSingle();
        if (checkError) throw checkError;

        if (existing) {
          const { data, error } = await supabaseDb.from('daily_dispatch_cache')
            .update({
              source_image_message_id: sourceImageMessageId,
              is_confirmed: isConfirmed
            })
            .eq('id', existing.id)
            .select().single();
          if (error) throw error;
          return data;
        } else {
          const { data, error } = await supabaseDb.from('daily_dispatch_cache')
            .insert({
              target_line_group_id: targetLineGroupId,
              source_image_message_id: sourceImageMessageId,
              is_confirmed: isConfirmed,
              created_at: today
            })
            .select().single();
          if (error) throw error;
          return data;
        }
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('daily_dispatch_cache')
          .where('created_at', '==', today)
          .where('target_line_group_id', '==', targetLineGroupId)
          .get();
        
        if (snapshot.empty) {
          const docRef = await firestoreDb.collection('daily_dispatch_cache').add({
            target_line_group_id: targetLineGroupId,
            source_image_message_id: sourceImageMessageId,
            is_confirmed: isConfirmed,
            created_at: today
          });
          return { id: docRef.id, target_line_group_id: targetLineGroupId, source_image_message_id: sourceImageMessageId, is_confirmed: isConfirmed, created_at: today };
        } else {
          const doc = snapshot.docs[0];
          await doc.ref.update({
            source_image_message_id: sourceImageMessageId,
            is_confirmed: isConfirmed
          });
          return { id: doc.id, target_line_group_id: targetLineGroupId, source_image_message_id: sourceImageMessageId, is_confirmed: isConfirmed, created_at: today };
        }
      } else {
        const dbData = await readLocalDb();
        let cacheItem = dbData.daily_dispatch_cache.find(c => c.created_at === today && c.target_line_group_id === targetLineGroupId);
        if (cacheItem) {
          cacheItem.source_image_message_id = sourceImageMessageId;
          cacheItem.is_confirmed = isConfirmed;
        } else {
          cacheItem = {
            id: dbData.daily_dispatch_cache.length > 0 ? Math.max(...dbData.daily_dispatch_cache.map(c => c.id)) + 1 : 1,
            target_line_group_id: targetLineGroupId,
            source_image_message_id: sourceImageMessageId,
            is_confirmed: isConfirmed,
            created_at: today
          };
          dbData.daily_dispatch_cache.push(cacheItem);
        }
        await writeLocalDb(dbData);
        return cacheItem;
      }
    },

    async confirm(targetLineGroupId, sourceImageMessageId) {
      const today = new Date().toISOString().split('T')[0];
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('daily_dispatch_cache')
          .update({ is_confirmed: true })
          .eq('created_at', today)
          .eq('target_line_group_id', targetLineGroupId);
        if (error) throw error;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('daily_dispatch_cache')
          .where('created_at', '==', today)
          .where('target_line_group_id', '==', targetLineGroupId)
          .get();
        if (!snapshot.empty) {
          const doc = snapshot.docs[0];
          await doc.ref.update({ is_confirmed: true });
        }
      } else {
        const dbData = await readLocalDb();
        const cacheItem = dbData.daily_dispatch_cache.find(c => c.created_at === today && c.target_line_group_id === targetLineGroupId);
        if (cacheItem) {
          cacheItem.is_confirmed = true;
          await writeLocalDb(dbData);
        }
      }
    },

    async remove(targetLineGroupId) {
      const today = new Date().toISOString().split('T')[0];
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('daily_dispatch_cache')
          .delete()
          .eq('created_at', today)
          .eq('target_line_group_id', targetLineGroupId);
        if (error) throw error;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('daily_dispatch_cache')
          .where('created_at', '==', today)
          .where('target_line_group_id', '==', targetLineGroupId)
          .get();
        for (const doc of snapshot.docs) {
          await doc.ref.delete();
        }
      } else {
        const dbData = await readLocalDb();
        dbData.daily_dispatch_cache = dbData.daily_dispatch_cache.filter(
          c => !(c.created_at === today && c.target_line_group_id === targetLineGroupId)
        );
        await writeLocalDb(dbData);
      }
    },

    async clearAll() {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('daily_dispatch_cache').delete().neq('id', 0);
        if (error) throw error;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('daily_dispatch_cache').get();
        const batch = firestoreDb.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      } else {
        const dbData = await readLocalDb();
        dbData.daily_dispatch_cache = [];
        await writeLocalDb(dbData);
      }
    }
  },

  // --- Group Events API ---
  group_events: {
    async getAll(groupId) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('group_events')
          .select('*')
          .eq('source_group_id', groupId)
          .order('date', { ascending: true })
          .order('time', { ascending: true, nullsFirst: true });
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('group_events')
          .where('source_group_id', '==', groupId)
          .get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
          .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
      } else {
        const data = await readLocalDb();
        return data.group_events
          .filter(e => e.source_group_id === groupId)
          .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
      }
    },

    async getAllGlobal() {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('group_events').select('*');
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('group_events').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        const data = await readLocalDb();
        return data.group_events;
      }
    },

    async create(groupId, event) {
      const now = new Date().toISOString();
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('group_events').insert({
          title: event.title,
          date: event.date,
          time: event.time || null,
          location: event.location || null,
          description: event.description || null,
          source_group_id: groupId,
          created_by: event.created_by || '未知人員'
        }).select().single();
        if (error) throw error;
        return data;
      } else if (firestoreDb) {
        const docRef = await firestoreDb.collection('group_events').add({
          ...event,
          source_group_id: groupId,
          created_at: now
        });
        return { id: docRef.id, ...event, source_group_id: groupId, created_at: now };
      } else {
        const dbData = await readLocalDb();
        const newEvent = {
          id: dbData.group_events.length > 0 ? Math.max(...dbData.group_events.map(e => e.id)) + 1 : 1,
          ...event,
          source_group_id: groupId,
          created_at: now
        };
        dbData.group_events.push(newEvent);
        await writeLocalDb(dbData);
        return newEvent;
      }
    },

    async delete(id) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('group_events').delete().eq('id', id);
        if (error) throw error;
        return { success: true };
      } else if (firestoreDb) {
        await firestoreDb.collection('group_events').doc(id).delete();
        return { success: true };
      } else {
        const dbData = await readLocalDb();
        const targetId = parseInt(id) || id;
        dbData.group_events = dbData.group_events.filter(e => e.id !== targetId);
        await writeLocalDb(dbData);
        return { success: true };
      }
    },

    async clearGeneratedPresentations(groupId) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { error } = await supabaseDb.from('group_events')
          .delete()
          .eq('source_group_id', groupId)
          .in('description', ['周四晨會報告輪序', 'AI 晨會多圖整併']);
        if (error) throw error;
        return { success: true };
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('group_events')
          .where('source_group_id', '==', groupId)
          .get();
        const batch = firestoreDb.batch();
        let count = 0;
        snapshot.docs.forEach(doc => {
          const desc = doc.data().description;
          if (desc === "周四晨會報告輪序" || desc === "AI 晨會多圖整併") {
            batch.delete(doc.ref);
            count++;
          }
        });
        if (count > 0) await batch.commit();
        return { success: true };
      } else {
        const dbData = await readLocalDb();
        dbData.group_events = dbData.group_events.filter(
          e => !(e.source_group_id === groupId && (e.description === "周四晨會報告輪序" || e.description === "AI 晨會多圖整併"))
        );
        await writeLocalDb(dbData);
        return { success: true };
      }
    }
  },

  // --- Rotations API ---
  rotations: {
    async get(groupId) {
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data, error } = await supabaseDb.from('presentation_rotations')
          .select('*')
          .eq('source_group_id', groupId)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          return { doctors: [], nps: [], exclusions: [], source_group_id: groupId };
        }
        return data;
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('presentation_rotations')
          .where('source_group_id', '==', groupId)
          .get();
        if (snapshot.empty) {
          return { doctors: [], nps: [], exclusions: [], source_group_id: groupId };
        }
        return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
      } else {
        const data = await readLocalDb();
        let r = data.presentation_rotations.find(x => x.source_group_id === groupId);
        if (!r) {
          r = { doctors: [], nps: [], exclusions: [], source_group_id: groupId };
        }
        return r;
      }
    },

    async save(groupId, rotationData) {
      const { doctors, nps, exclusions, dept_sequence, ward_sequence } = rotationData;
      if (DB_TYPE === 'supabase' && supabaseDb) {
        const { data: existing, error: checkError } = await supabaseDb.from('presentation_rotations')
          .select('*')
          .eq('source_group_id', groupId)
          .maybeSingle();
        if (checkError) throw checkError;

        if (existing) {
          const { data, error } = await supabaseDb.from('presentation_rotations')
            .update({
              doctors: doctors || [],
              nps: nps || [],
              exclusions: exclusions || [],
              dept_sequence: dept_sequence || [],
              ward_sequence: ward_sequence || []
            })
            .eq('id', existing.id)
            .select().single();
          if (error) throw error;
          return data;
        } else {
          const { data, error } = await supabaseDb.from('presentation_rotations')
            .insert({
              source_group_id: groupId,
              doctors: doctors || [],
              nps: nps || [],
              exclusions: exclusions || [],
              dept_sequence: dept_sequence || [],
              ward_sequence: ward_sequence || []
            })
            .select().single();
          if (error) throw error;
          return data;
        }
      } else if (firestoreDb) {
        const snapshot = await firestoreDb.collection('presentation_rotations')
          .where('source_group_id', '==', groupId)
          .get();
        if (snapshot.empty) {
          const docRef = await firestoreDb.collection('presentation_rotations').add({
            doctors: doctors || [],
            nps: nps || [],
            exclusions: exclusions || [],
            dept_sequence: dept_sequence || [],
            ward_sequence: ward_sequence || [],
            source_group_id: groupId
          });
          return { id: docRef.id, doctors, nps, exclusions, dept_sequence, ward_sequence, source_group_id: groupId };
        } else {
          const doc = snapshot.docs[0];
          await doc.ref.update({
            doctors: doctors || [],
            nps: nps || [],
            exclusions: exclusions || [],
            dept_sequence: dept_sequence || [],
            ward_sequence: ward_sequence || []
          });
          return { id: doc.id, doctors, nps, exclusions, dept_sequence, ward_sequence, source_group_id: groupId };
        }
      } else {
        const dbData = await readLocalDb();
        let r = dbData.presentation_rotations.find(x => x.source_group_id === groupId);
        if (r) {
          r.doctors = doctors || [];
          r.nps = nps || [];
          r.exclusions = exclusions || [];
          r.dept_sequence = dept_sequence || [];
          r.ward_sequence = ward_sequence || [];
        } else {
          r = {
            id: dbData.presentation_rotations.length > 0 ? Math.max(...dbData.presentation_rotations.map(x => x.id || 0)) + 1 : 1,
            doctors: doctors || [],
            nps: nps || [],
            exclusions: exclusions || [],
            dept_sequence: dept_sequence || [],
            ward_sequence: ward_sequence || [],
            source_group_id: groupId
          };
          dbData.presentation_rotations.push(r);
        }
        await writeLocalDb(dbData);
        return r;
      }
    }
  }
};
