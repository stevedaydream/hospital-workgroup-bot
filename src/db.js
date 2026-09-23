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

  /*
   * Doctor roster. Separate from doctor_group_mapping on purpose: this table
   * states a personnel fact (which department someone belongs to), while the
   * mapping table states a routing rule (which LINE group to notify). Most
   * doctors have no group of their own, but their names are still needed --
   * they are the dictionary that turns open-ended OCR into a closed-set match.
   */
  CREATE TABLE IF NOT EXISTS doctors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    department  TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT NOT NULL
  );

  /* Every roster import keeps the previous state so it can be rolled back. */
  CREATE TABLE IF NOT EXISTS roster_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL
  );

  /*
   * A recognised case table waits here for a human to confirm before anything
   * is queued for 07:30. If nobody answers by auto_adopt_at, the matched rows
   * are adopted anyway -- silence must not turn into "nothing was sent".
   */
  CREATE TABLE IF NOT EXISTS dispatch_confirmations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source_group_id  TEXT NOT NULL,
    message_id       TEXT NOT NULL,
    dispatch_date    TEXT NOT NULL,
    payload          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'CONFIRMED', 'AUTO_ADOPTED', 'CANCELLED')),
    created_at       TEXT NOT NULL,
    auto_adopt_at    TEXT NOT NULL,
    resolved_at      TEXT,
    resolved_by      TEXT
  );

  /*
   * The 07:30 push sends an image, so a spreadsheet upload still needs a
   * photograph to forward. Remembering the last image per group survives a
   * restart, which an in-memory map would not.
   */
  CREATE TABLE IF NOT EXISTS group_last_image (
    source_group_id  TEXT PRIMARY KEY,
    message_id       TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dispatch_date ON daily_dispatch_cache (dispatch_date);
  CREATE INDEX IF NOT EXISTS idx_events_group  ON group_events (source_group_id, date);
  CREATE INDEX IF NOT EXISTS idx_confirm_status ON dispatch_confirmations (status, auto_adopt_at);
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

  // --- Last Uploaded Image Per Group ---
  group_last_image: {
    async set(sourceGroupId, messageId) {
      sqlite
        .prepare(
          `INSERT INTO group_last_image (source_group_id, message_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (source_group_id) DO UPDATE SET
             message_id = excluded.message_id,
             created_at = excluded.created_at`
        )
        .run(sourceGroupId, messageId, nowIso());
    },

    async get(sourceGroupId) {
      return sqlite.prepare('SELECT * FROM group_last_image WHERE source_group_id = ?').get(sourceGroupId) || null;
    }
  },

  // --- Doctor Roster API ---
  doctors: {
    async getAll() {
      return sqlite
        .prepare('SELECT * FROM doctors ORDER BY department, name')
        .all()
        .map((row) => parseJsonColumns(row, ['aliases']));
    },

    async getByName(name) {
      const row = sqlite.prepare('SELECT * FROM doctors WHERE name = ?').get(name);
      return row ? parseJsonColumns(row, ['aliases']) : null;
    },

    /**
     * Replaces the whole roster in one transaction, keeping a snapshot of the
     * previous state first. A roster written wrong is as damaging as a wrong
     * dispatch, so it must always be reversible.
     * @param {Array<{name: string, department: string, aliases?: string[]}>} entries
     */
    async replaceAll(entries, updatedBy = '未知人員', note = '') {
      const previous = sqlite.prepare('SELECT name, department, aliases FROM doctors ORDER BY name').all();

      const apply = sqlite.transaction(() => {
        sqlite
          .prepare('INSERT INTO roster_snapshots (created_at, created_by, note, payload) VALUES (?, ?, ?, ?)')
          .run(nowIso(), updatedBy, note, JSON.stringify(previous));

        sqlite.prepare('DELETE FROM doctors').run();
        const insert = sqlite.prepare(
          'INSERT INTO doctors (name, department, aliases, updated_at) VALUES (?, ?, ?, ?)'
        );
        for (const entry of entries) {
          insert.run(
            entry.name,
            (entry.department || '').toUpperCase(),
            JSON.stringify(entry.aliases || []),
            nowIso()
          );
        }

        // Keep the last 10 snapshots; older ones have no practical use.
        sqlite
          .prepare(
            'DELETE FROM roster_snapshots WHERE id NOT IN (SELECT id FROM roster_snapshots ORDER BY id DESC LIMIT 10)'
          )
          .run();
      });

      apply();
      return this.getAll();
    },

    async listSnapshots() {
      return sqlite
        .prepare('SELECT id, created_at, created_by, note FROM roster_snapshots ORDER BY id DESC')
        .all();
    },

    async restoreSnapshot(snapshotId, restoredBy = '未知人員') {
      const snapshot = sqlite.prepare('SELECT * FROM roster_snapshots WHERE id = ?').get(snapshotId);
      if (!snapshot) throw new Error('Snapshot not found');

      const entries = JSON.parse(snapshot.payload).map((row) => ({
        name: row.name,
        department: row.department,
        aliases: JSON.parse(row.aliases || '[]')
      }));

      return this.replaceAll(entries, restoredBy, `還原自快照 #${snapshotId}`);
    }
  },

  // --- Dispatch Confirmation API ---
  dispatch_confirmations: {
    async create({ sourceGroupId, messageId, dispatchDate, payload, autoAdoptAt }) {
      const info = sqlite
        .prepare(
          `INSERT INTO dispatch_confirmations
             (source_group_id, message_id, dispatch_date, payload, status, created_at, auto_adopt_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`
        )
        .run(sourceGroupId, messageId, dispatchDate, JSON.stringify(payload), nowIso(), autoAdoptAt);
      return this.getById(info.lastInsertRowid);
    },

    async getById(id) {
      const row = sqlite.prepare('SELECT * FROM dispatch_confirmations WHERE id = ?').get(id);
      return row ? { ...row, payload: JSON.parse(row.payload) } : null;
    },

    /** Pending rows whose grace period has elapsed. */
    async getDueForAutoAdopt() {
      return sqlite
        .prepare("SELECT * FROM dispatch_confirmations WHERE status = 'PENDING' AND auto_adopt_at <= ?")
        .all(nowIso())
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },

    async resolve(id, status, resolvedBy) {
      sqlite
        .prepare('UPDATE dispatch_confirmations SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(status, nowIso(), resolvedBy, id);
      return this.getById(id);
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
