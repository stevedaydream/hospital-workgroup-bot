/**
 * Single-file SQLite data layer.
 *
 * Replaces the previous triple implementation (local JSON / Firestore /
 * Supabase). The dataset is a few hundred rows; a single file next to the
 * process is faster, cheaper and has no "project paused" failure mode.
 *
 * All methods stay `async` so existing call sites keep working unchanged,
 * even though better-sqlite3 is synchronous.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { todayInTaipei, tomorrowInTaipei, nowIso } from './util/date.js';

dotenv.config();

const DB_PATH = process.env.SQLITE_PATH || path.resolve('data/hospital.db');
const DISPATCH_RETENTION_DAYS = 60;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id  TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS general_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doctor_group_mapping (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    match_key      TEXT NOT NULL,
    group_name     TEXT NOT NULL,
    line_group_id  TEXT NOT NULL,
    type           TEXT NOT NULL CHECK (type IN ('DIRECT', 'FLEXIBLE'))
  );

  /*
   * dispatch_date is the morning the image is meant to go out (Taiwan date),
   * decided when the image is uploaded. The old created_at + UTC arithmetic
   * only worked by accident; see src/util/date.js.
   */
  CREATE TABLE IF NOT EXISTS daily_dispatch_cache (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    target_line_group_id     TEXT NOT NULL,
    source_image_message_id  TEXT NOT NULL,
    is_confirmed             INTEGER NOT NULL DEFAULT 0,
    dispatch_date            TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    UNIQUE (dispatch_date, target_line_group_id)
  );

  CREATE TABLE IF NOT EXISTS group_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    date             TEXT NOT NULL,
    time             TEXT,
    location         TEXT,
    description      TEXT,
    source_group_id  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    created_by       TEXT NOT NULL DEFAULT '未知人員'
  );

  CREATE TABLE IF NOT EXISTS presentation_rotations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    doctors          TEXT NOT NULL DEFAULT '[]',
    nps              TEXT NOT NULL DEFAULT '[]',
    exclusions       TEXT NOT NULL DEFAULT '[]',
    dept_sequence    TEXT NOT NULL DEFAULT '[]',
    ward_sequence    TEXT NOT NULL DEFAULT '[]',
    source_group_id  TEXT UNIQUE NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dispatch_date ON daily_dispatch_cache (dispatch_date);
  CREATE INDEX IF NOT EXISTS idx_events_group  ON group_events (source_group_id, date);
`);

// Old rows have no operational value and only make the confirmation UI noisy.
sqlite
  .prepare('DELETE FROM daily_dispatch_cache WHERE dispatch_date < date(?, ?)')
  .run(todayInTaipei(), `-${DISPATCH_RETENTION_DAYS} days`);

console.log(`Database: SQLite ready at ${DB_PATH}`);

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
const parseJsonColumns = (row, columns) => {
  if (!row) return row;
  const out = { ...row };
  for (const col of columns) {
    try {
      out[col] = JSON.parse(row[col] ?? '[]');
    } catch {
      out[col] = [];
    }
  }
  return out;
};

const ROTATION_JSON_COLUMNS = ['doctors', 'nps', 'exclusions', 'dept_sequence', 'ward_sequence'];

const toDispatchRow = (row) => (row ? { ...row, is_confirmed: row.is_confirmed === 1 } : row);

// ----------------------------------------------------
// Database Interface Methods
// ----------------------------------------------------
export const db = {
  // --- Users API ---
  users: {
    async getAll() {
      return sqlite.prepare('SELECT * FROM users ORDER BY id').all();
    },

    async getByLineUserId(lineUserId) {
      return sqlite.prepare('SELECT * FROM users WHERE line_user_id = ?').get(lineUserId) || null;
    },

    async createOrUpdate(lineUserId, displayName) {
      sqlite
        .prepare(
          `INSERT INTO users (line_user_id, display_name) VALUES (?, ?)
           ON CONFLICT (line_user_id) DO UPDATE SET display_name = excluded.display_name`
        )
        .run(lineUserId, displayName);
      return this.getByLineUserId(lineUserId);
    }
  },

  // --- General Notes API ---
  general_notes: {
    async getAll() {
      return sqlite.prepare('SELECT * FROM general_notes ORDER BY updated_at DESC').all();
    },

    async getById(id) {
      return sqlite.prepare('SELECT * FROM general_notes WHERE id = ?').get(id) || null;
    },

    async create(title, content, updatedBy) {
      const info = sqlite
        .prepare('INSERT INTO general_notes (title, content, updated_at, updated_by) VALUES (?, ?, ?, ?)')
        .run(title, content, nowIso(), updatedBy);
      return this.getById(info.lastInsertRowid);
    },

    async update(id, title, content, updatedBy) {
      const info = sqlite
        .prepare('UPDATE general_notes SET title = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(title, content, nowIso(), updatedBy, id);
      if (info.changes === 0) throw new Error('Note not found');
      return this.getById(id);
    },

    async delete(id) {
      sqlite.prepare('DELETE FROM general_notes WHERE id = ?').run(id);
      return { success: true };
    }
  },

  // --- Doctor Group Mapping API ---
  doctor_group_mapping: {
    async getAll() {
      return sqlite.prepare('SELECT * FROM doctor_group_mapping ORDER BY id').all();
    },

    async getByMatchKey(matchKey) {
      // Department codes are compared case-insensitively (URO / uro / Uro).
      return sqlite
        .prepare('SELECT * FROM doctor_group_mapping WHERE UPPER(match_key) = UPPER(?)')
        .all(matchKey);
    },

    async create(matchKey, groupName, lineGroupId, type) {
      const info = sqlite
        .prepare('INSERT INTO doctor_group_mapping (match_key, group_name, line_group_id, type) VALUES (?, ?, ?, ?)')
        .run(matchKey, groupName, lineGroupId, type);
      return sqlite.prepare('SELECT * FROM doctor_group_mapping WHERE id = ?').get(info.lastInsertRowid);
    },

    async delete(id) {
      sqlite.prepare('DELETE FROM doctor_group_mapping WHERE id = ?').run(id);
      return { success: true };
    }
  },

  // --- Daily Dispatch Cache API ---
  daily_dispatch_cache: {
    /** Rows scheduled for an explicit Taiwan date. */
    async getForDate(dispatchDate) {
      return sqlite
        .prepare('SELECT * FROM daily_dispatch_cache WHERE dispatch_date = ? ORDER BY id')
        .all(dispatchDate)
        .map(toDispatchRow);
    },

    /** What the 07:30 job must send this morning. */
    async getDue() {
      return this.getForDate(todayInTaipei());
    },

    /** What is queued for tomorrow morning -- i.e. awaiting confirmation today. */
    async getPending() {
      return this.getForDate(tomorrowInTaipei());
    },

    async add(targetLineGroupId, sourceImageMessageId, isConfirmed, dispatchDate = tomorrowInTaipei()) {
      sqlite
        .prepare(
          `INSERT INTO daily_dispatch_cache
             (target_line_group_id, source_image_message_id, is_confirmed, dispatch_date, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (dispatch_date, target_line_group_id) DO UPDATE SET
             source_image_message_id = excluded.source_image_message_id,
             is_confirmed            = excluded.is_confirmed`
        )
        .run(targetLineGroupId, sourceImageMessageId, isConfirmed ? 1 : 0, dispatchDate, nowIso());

      return toDispatchRow(
        sqlite
          .prepare('SELECT * FROM daily_dispatch_cache WHERE dispatch_date = ? AND target_line_group_id = ?')
          .get(dispatchDate, targetLineGroupId)
      );
    },

    async remove(targetLineGroupId, dispatchDate = tomorrowInTaipei()) {
      sqlite
        .prepare('DELETE FROM daily_dispatch_cache WHERE dispatch_date = ? AND target_line_group_id = ?')
        .run(dispatchDate, targetLineGroupId);
    },

    /** "清空轉發" -- drop everything not yet delivered (today's leftovers included). */
    async clearAll() {
      sqlite.prepare('DELETE FROM daily_dispatch_cache WHERE dispatch_date >= ?').run(todayInTaipei());
    }
  },

  // --- Group Events API ---
  group_events: {
    async getAll(groupId) {
      return sqlite
        .prepare('SELECT * FROM group_events WHERE source_group_id = ? ORDER BY date ASC, time ASC')
        .all(groupId);
    },

    async getAllGlobal() {
      return sqlite.prepare('SELECT * FROM group_events').all();
    },

    async create(groupId, event) {
      const info = sqlite
        .prepare(
          `INSERT INTO group_events (title, date, time, location, description, source_group_id, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.title,
          event.date,
          event.time || null,
          event.location || null,
          event.description || null,
          groupId,
          nowIso(),
          event.created_by || '未知人員'
        );
      return sqlite.prepare('SELECT * FROM group_events WHERE id = ?').get(info.lastInsertRowid);
    },

    async delete(id) {
      sqlite.prepare('DELETE FROM group_events WHERE id = ?').run(id);
      return { success: true };
    },

    async clearGeneratedPresentations(groupId) {
      sqlite
        .prepare(
          `DELETE FROM group_events
           WHERE source_group_id = ?
             AND (description = '周四晨會報告輪序' OR description = 'AI 晨會多圖整併')`
        )
        .run(groupId);
      return { success: true };
    }
  },

  // --- Rotations API ---
  rotations: {
    async get(groupId) {
      const row = sqlite
        .prepare('SELECT * FROM presentation_rotations WHERE source_group_id = ?')
        .get(groupId);
      if (!row) {
        return {
          doctors: [],
          nps: [],
          exclusions: [],
          dept_sequence: [],
          ward_sequence: [],
          source_group_id: groupId
        };
      }
      return parseJsonColumns(row, ROTATION_JSON_COLUMNS);
    },

    async save(groupId, rotationData) {
      const { doctors, nps, exclusions, dept_sequence, ward_sequence } = rotationData;
      sqlite
        .prepare(
          `INSERT INTO presentation_rotations
             (source_group_id, doctors, nps, exclusions, dept_sequence, ward_sequence)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_group_id) DO UPDATE SET
             doctors       = excluded.doctors,
             nps           = excluded.nps,
             exclusions    = excluded.exclusions,
             dept_sequence = excluded.dept_sequence,
             ward_sequence = excluded.ward_sequence`
        )
        .run(
          groupId,
          JSON.stringify(doctors || []),
          JSON.stringify(nps || []),
          JSON.stringify(exclusions || []),
          JSON.stringify(dept_sequence || []),
          JSON.stringify(ward_sequence || [])
        );
      return this.get(groupId);
    }
  }
};

export { sqlite };
