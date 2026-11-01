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

  CREATE TABLE IF NOT EXISTS note_image_imports (
    image_key TEXT NOT NULL,
    note_id INTEGER NOT NULL REFERENCES general_notes(id) ON DELETE CASCADE,
    PRIMARY KEY (image_key, note_id)
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

  /* MedBase 排班系統串接：LINE 帳號 ↔ HIS 帳號（綁定碼兌換而來） */
  CREATE TABLE IF NOT EXISTS medbase_links (
    line_user_id   TEXT PRIMARY KEY,
    his            TEXT NOT NULL,
    name           TEXT NOT NULL,
    medbase_group  TEXT NOT NULL,
    linked_at      TEXT NOT NULL
  );

  /* 每個 LINE 群組對應的 MedBase 排班群組與通知設定 */
  CREATE TABLE IF NOT EXISTS medbase_groups (
    line_group_id    TEXT PRIMARY KEY,
    group_name       TEXT NOT NULL DEFAULT '',
    medbase_group    TEXT NOT NULL,
    remind_enabled   INTEGER NOT NULL DEFAULT 0,
    remind_time      TEXT NOT NULL DEFAULT '20:00',
    notify_publish   INTEGER NOT NULL DEFAULT 0,
    last_reminded    TEXT,
    last_versions    TEXT NOT NULL DEFAULT '{}'
  );

  /* Bot 被邀入過的 LINE 群組；退出時保留紀錄、標記 left_at */
  CREATE TABLE IF NOT EXISTS line_groups (
    line_group_id  TEXT PRIMARY KEY,
    group_name     TEXT NOT NULL DEFAULT '',
    joined_at      TEXT NOT NULL,
    left_at        TEXT
  );

  /* 各 LINE 群組的功能開關；line_group_id = '*' 是尚未個別設定之群組的預設值 */
  CREATE TABLE IF NOT EXISTS group_features (
    line_group_id  TEXT NOT NULL,
    feature        TEXT NOT NULL,
    enabled        INTEGER NOT NULL,
    updated_by     TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (line_group_id, feature)
  );

  /* 出國登記：全科共用一份，不分 LINE 群組 */
  CREATE TABLE IF NOT EXISTS travel_registrations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    traveler       TEXT NOT NULL,
    destination    TEXT NOT NULL,
    purpose        TEXT,
    depart_date    TEXT NOT NULL,
    depart_time    TEXT,
    depart_flight  TEXT,
    return_date    TEXT NOT NULL,
    return_time    TEXT,
    return_flight  TEXT,
    deputy         TEXT,
    note           TEXT,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_by     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dispatch_date ON daily_dispatch_cache (dispatch_date);
  CREATE INDEX IF NOT EXISTS idx_medbase_links_his ON medbase_links (his);
  CREATE INDEX IF NOT EXISTS idx_events_group  ON group_events (source_group_id, date);
  CREATE INDEX IF NOT EXISTS idx_travel_return ON travel_registrations (return_date);

  /* Persistent deduplication for group leave announcements, including deleted registrations. */
  CREATE TABLE IF NOT EXISTS leave_message_imports (
    line_message_id TEXT PRIMARY KEY,
    source_group_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    registration_id INTEGER REFERENCES travel_registrations(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS person_aliases (
    alias TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_person_aliases (
    source_group_id TEXT NOT NULL, alias TEXT NOT NULL, canonical_name TEXT NOT NULL,
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (source_group_id, alias)
  );
  CREATE TABLE IF NOT EXISTS pending_leave_aliases (
    token TEXT PRIMARY KEY, line_message_id TEXT UNIQUE NOT NULL,
    source_group_id TEXT NOT NULL, source_user_id TEXT NOT NULL,
    trip_json TEXT NOT NULL, choices_json TEXT NOT NULL, created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
  );
`);

// travel_registrations.kind: 出國 (abroad) or 長假 (long leave). Rows from
// before the column existed were all trips abroad.
if (!sqlite.prepare('PRAGMA table_info(travel_registrations)').all().some(c => c.name === 'kind')) {
  sqlite.exec(`ALTER TABLE travel_registrations ADD COLUMN kind TEXT NOT NULL DEFAULT '出國'`);
}

// Existing long-leave registrations are full-day leave; keep their dates and audit history.
if (!sqlite.prepare('PRAGMA table_info(travel_registrations)').all().some(c => c.name === 'leave_period')) {
  sqlite.exec("ALTER TABLE travel_registrations ADD COLUMN leave_period TEXT NOT NULL DEFAULT '全天'");
}
sqlite.prepare("UPDATE travel_registrations SET kind = '休假' WHERE kind = '長假'").run();

// Old rows have no operational value and only make the confirmation UI noisy.
sqlite
  .prepare('DELETE FROM daily_dispatch_cache WHERE dispatch_date < date(?, ?)')
  .run(todayInTaipei(), `-${DISPATCH_RETENTION_DAYS} days`);

console.log(`Database: SQLite ready at ${DB_PATH}`);

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
const parseJsonObject = (row, column) => {
  try {
    return { ...row, [column]: JSON.parse(row[column] || '{}') };
  } catch {
    return { ...row, [column]: {} };
  }
};

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
  // Explicitly maintained name aliases; never inferred from conversation.
  person_aliases: {
    set(alias, canonicalName, by, sourceId = null) {
      alias = String(alias || '').trim();
      canonicalName = String(canonicalName || '').trim();
      if (!alias || !canonicalName || alias === canonicalName || alias.length > 30 || canonicalName.length > 30) throw new Error('請提供不同的別名與正式姓名（各 1～30 字）');
      if (sourceId) {
        if (this.resolve(canonicalName, sourceId) !== canonicalName || sqlite.prepare('SELECT 1 FROM group_person_aliases WHERE source_group_id = ? AND canonical_name = ?').get(sourceId, alias)) throw new Error('別名需直接對應正式姓名，不可串接其他別名');
        sqlite.prepare(`INSERT INTO group_person_aliases VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_group_id, alias) DO UPDATE SET canonical_name=excluded.canonical_name, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
          .run(sourceId, alias, canonicalName, by, nowIso());
        return;
      }
      if (sqlite.prepare('SELECT 1 FROM person_aliases WHERE alias = ? OR canonical_name = ?').get(canonicalName, alias)) throw new Error('別名需直接對應正式姓名，不可串接其他別名');
      sqlite.prepare(`INSERT INTO person_aliases (alias, canonical_name, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET canonical_name=excluded.canonical_name, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .run(alias, canonicalName, by, nowIso());
    },
    resolve(name, sourceId = null) {
      if (!name) return name;
      if (sourceId) {
        const scoped = sqlite.prepare('SELECT canonical_name FROM group_person_aliases WHERE source_group_id = ? AND alias = ?').get(sourceId, name.trim());
        if (scoped) return scoped.canonical_name;
      }
      return sqlite.prepare('SELECT canonical_name FROM person_aliases WHERE alias = ?').get(name.trim())?.canonical_name || name;
    }
  },
  pending_leave_aliases: {
    forMessage(id) { return sqlite.prepare('SELECT token FROM pending_leave_aliases WHERE line_message_id = ?').get(id); },
    get(token) {
      const row = sqlite.prepare('SELECT * FROM pending_leave_aliases WHERE token = ?').get(token);
      return row ? { ...row, trip: JSON.parse(row.trip_json), choices: JSON.parse(row.choices_json) } : null;
    },
    create(token, trip, choices, meta) {
      const inserted = sqlite.prepare(`INSERT OR IGNORE INTO pending_leave_aliases
        (token, line_message_id, source_group_id, source_user_id, trip_json, choices_json, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(token, meta.messageId, meta.sourceId, meta.userId, JSON.stringify(trip), JSON.stringify(choices), meta.by, Date.now() + 86400000);
      return inserted.changes ? this.get(token) : null;
    },
    confirm(token, sourceId, userId, selection) {
      return sqlite.transaction(() => {
        const pending = this.get(token);
        if (!pending || pending.expires_at < Date.now()) return { error: '選單已過期，請重新傳送休假公告。' };
        if (pending.source_group_id !== sourceId || pending.source_user_id !== userId) return { error: '僅原公告發送者可在原群組確認這個代稱。' };
        if (pending.status !== 'pending') return { error: '這份選單已處理，請查看原登記或重新傳送公告。' };
        if (selection === 'cancel') {
          sqlite.prepare("UPDATE pending_leave_aliases SET status='cancelled' WHERE token = ?").run(token);
          return { cancelled: true };
        }
        if (!Number.isInteger(selection) || !pending.choices[selection]) return { error: '人選無效，請重新選擇。' };
        const name = pending.choices[selection].name;
        const alias = pending.trip.deputy;
        const existing = db.person_aliases.resolve(alias, sourceId);
        if (existing !== alias && existing !== name) return { error: '這個代稱已有其他對應，未覆寫；請先確認正式姓名。' };
        db.person_aliases.set(alias, name, pending.created_by, sourceId);
        const result = db.travels.importFromLine(pending.trip, { messageId: pending.line_message_id, sourceId, userId, by: pending.created_by });
        sqlite.prepare("UPDATE pending_leave_aliases SET status='confirmed' WHERE token = ?").run(token);
        return { result, trip: pending.trip };
      })();
    }
  },
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
    /** Persist image identity and compare existing notices atomically, including legacy rows. */
    importFromImages(notes, imageHashes) {
      const imageKey = JSON.stringify([...new Set(imageHashes)].sort());
      const normalize = value => value.normalize('NFKC').replace(/\s+/gu, '').trim();
      return sqlite.transaction(() => {
        if (sqlite.prepare('SELECT 1 FROM note_image_imports WHERE image_key = ?').get(imageKey)) {
          return { created: [], skipped: notes.length };
        }
        const existing = sqlite.prepare('SELECT * FROM general_notes').all();
        const created = [];
        let skipped = 0;
        for (const note of notes) {
          let row = existing.find(row => normalize(row.title) === normalize(note.title) && normalize(row.content) === normalize(note.content));
          if (row) {
            skipped++;
          } else {
            const info = sqlite.prepare('INSERT INTO general_notes (title, content, updated_at, updated_by) VALUES (?, ?, ?, ?)')
              .run(note.title, note.content, nowIso(), 'AI 晨會多圖整併');
            row = sqlite.prepare('SELECT * FROM general_notes WHERE id = ?').get(info.lastInsertRowid);
            existing.push(row);
            created.push(row);
          }
          sqlite.prepare('INSERT OR IGNORE INTO note_image_imports (image_key, note_id) VALUES (?, ?)').run(imageKey, row.id);
        }
        return { created, skipped };
      })();
    },

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

    /**
     * Inserts many mappings in one transaction (roster import), skipping any
     * that already map the same key to the same group.
     * @param {Array<{matchKey: string, groupName: string, lineGroupId: string, type: string}>} rows
     */
    async createMany(rows) {
      const exists = sqlite.prepare(
        'SELECT 1 FROM doctor_group_mapping WHERE UPPER(match_key) = UPPER(?) AND line_group_id = ?'
      );
      const insert = sqlite.prepare(
        'INSERT INTO doctor_group_mapping (match_key, group_name, line_group_id, type) VALUES (?, ?, ?, ?)'
      );
      return sqlite.transaction(() => {
        let created = 0;
        let skipped = 0;
        for (const r of rows) {
          if (exists.get(r.matchKey, r.lineGroupId)) {
            skipped++;
          } else {
            insert.run(r.matchKey, r.groupName, r.lineGroupId, r.type);
            created++;
          }
        }
        return { created, skipped };
      })();
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

  // --- Overseas travel registrations ---
  travels: {
    importedMessage(id) { return !!sqlite.prepare('SELECT 1 FROM leave_message_imports WHERE line_message_id = ?').get(id); },
    /** Atomic message deduplication + overlap check + registration. */
    importFromLine(trip, { messageId, sourceId, userId, by }) {
      const normalizeName = name => name.replace(/^NP\s*|醫師$|\s*NP$/giu, '').replace(/\s+/g, '');
      return sqlite.transaction(() => {
        if (sqlite.prepare('SELECT 1 FROM leave_message_imports WHERE line_message_id = ?').get(messageId)) return { status: 'duplicate' };
        const traveler = db.person_aliases.resolve(trip.traveler, sourceId);
        const deputy = db.person_aliases.resolve(trip.deputy, sourceId);
        const aliases = [[trip.traveler, traveler], [trip.deputy, deputy]].filter(([original, resolved]) => original && original !== resolved);
        trip = { ...trip, traveler, deputy,
          note: aliases.length ? `${trip.note || ''}；姓名別名：${aliases.map(([original, resolved]) => `${original}＝${resolved}`).join('、')}`.slice(0, 300) : trip.note };
        const overlaps = sqlite.prepare("SELECT * FROM travel_registrations WHERE kind IN ('休假', '長假') AND depart_date <= ? AND return_date >= ?")
          .all(trip.return_date, trip.depart_date).filter(t => normalizeName(db.person_aliases.resolve(t.traveler, sourceId)) === normalizeName(trip.traveler) &&
            (t.leave_period === '全天' || trip.leave_period === '全天' || t.leave_period === trip.leave_period));
        const same = overlaps.find(t => t.depart_date === trip.depart_date && t.return_date === trip.return_date &&
          t.leave_period === trip.leave_period && (db.person_aliases.resolve(t.deputy, sourceId) || '') === (trip.deputy || ''));
        const status = same ? 'exists' : overlaps.length ? 'overlap' : 'created';
        let registration = same || overlaps[0] || null;
        if (status === 'created') {
          registration = this.create(trip, by);
        }
        sqlite.prepare(`INSERT INTO leave_message_imports (line_message_id, source_group_id, source_user_id, registration_id, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(messageId, sourceId, userId, registration?.id ?? null, nowIso());
        return { status, registration };
      })();
    },
    /** Trips not yet over (return_date >= today); `includePast` returns everything. */
    list({ includePast = false } = {}) {
      return includePast
        ? sqlite.prepare('SELECT * FROM travel_registrations ORDER BY depart_date DESC, id DESC').all()
        : sqlite
            .prepare('SELECT * FROM travel_registrations WHERE return_date >= ? ORDER BY depart_date ASC, id ASC')
            .all(todayInTaipei());
    },

    get(id) {
      return sqlite.prepare('SELECT * FROM travel_registrations WHERE id = ?').get(id) || null;
    },

    create(trip, by) {
      const now = nowIso();
      const info = sqlite
        .prepare(
          `INSERT INTO travel_registrations
             (kind, leave_period, traveler, destination, purpose, depart_date, depart_time, depart_flight,
              return_date, return_time, return_flight, deputy, note,
              created_by, created_at, updated_by, updated_at)
           VALUES (@kind, @leave_period, @traveler, @destination, @purpose, @depart_date, @depart_time, @depart_flight,
                   @return_date, @return_time, @return_flight, @deputy, @note,
                   @by, @now, @by, @now)`
        )
        .run({ ...trip, by, now });
      return this.get(info.lastInsertRowid);
    },

    update(id, trip, by) {
      const changes = sqlite
        .prepare(
          `UPDATE travel_registrations SET
             kind = @kind, leave_period = @leave_period, traveler = @traveler, destination = @destination, purpose = @purpose,
             depart_date = @depart_date, depart_time = @depart_time, depart_flight = @depart_flight,
             return_date = @return_date, return_time = @return_time, return_flight = @return_flight,
             deputy = @deputy, note = @note, updated_by = @by, updated_at = @now
           WHERE id = @id`
        )
        .run({ ...trip, id, by, now: nowIso() }).changes;
      return changes > 0 ? this.get(id) : null;
    },

    remove(id) {
      return sqlite.prepare('DELETE FROM travel_registrations WHERE id = ?').run(id).changes > 0;
    }
  },

  // --- Rotations API ---
  // --- MedBase integration ---
  line_groups: {
    getAll() {
      return sqlite.prepare('SELECT * FROM line_groups ORDER BY left_at IS NOT NULL, joined_at DESC').all();
    },

    recordJoin(lineGroupId, groupName) {
      sqlite
        .prepare(`INSERT INTO line_groups (line_group_id, group_name, joined_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(line_group_id) DO UPDATE SET
                    group_name = CASE WHEN excluded.group_name != '' THEN excluded.group_name ELSE line_groups.group_name END,
                    joined_at = excluded.joined_at, left_at = NULL`)
        .run(lineGroupId, groupName, new Date().toISOString());
    },

    recordLeave(lineGroupId) {
      sqlite.prepare('UPDATE line_groups SET left_at = ? WHERE line_group_id = ?').run(new Date().toISOString(), lineGroupId);
    },

    remove(lineGroupId) {
      sqlite.prepare('DELETE FROM group_features WHERE line_group_id = ?').run(lineGroupId);
      return sqlite.prepare('DELETE FROM line_groups WHERE line_group_id = ?').run(lineGroupId).changes > 0;
    }
  },

  // Per-group feature switches. A feature with no row for the group falls back
  // to the '*' row; with neither, features.js applies the feature's own default.
  group_features: {
    getAll() {
      return sqlite.prepare('SELECT * FROM group_features').all();
    },

    /** { feature: boolean } saved for one group (or '*'); unsaved features are absent. */
    get(lineGroupId) {
      const rows = sqlite.prepare('SELECT feature, enabled FROM group_features WHERE line_group_id = ?').all(lineGroupId);
      return Object.fromEntries(rows.map(r => [r.feature, r.enabled === 1]));
    },

    /** The saved switch for a group, else the '*' one; null when neither is saved. */
    lookup(lineGroupId, feature) {
      const row = sqlite
        .prepare(`SELECT enabled FROM group_features WHERE feature = ? AND line_group_id IN (?, '*')
                  ORDER BY line_group_id = '*' LIMIT 1`)
        .get(feature, lineGroupId);
      return row ? row.enabled === 1 : null;
    },

    /** Saves every given switch for a group in one transaction. */
    save(lineGroupId, features, updatedBy) {
      const upsert = sqlite.prepare(
        `INSERT INTO group_features (line_group_id, feature, enabled, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (line_group_id, feature) DO UPDATE SET
           enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      );
      const now = nowIso();
      sqlite.transaction(() => {
        for (const [feature, enabled] of Object.entries(features)) {
          upsert.run(lineGroupId, feature, enabled ? 1 : 0, updatedBy, now);
        }
      })();
      return this.get(lineGroupId);
    },

    /** Drops a group's own switches so it follows the '*' defaults again. */
    reset(lineGroupId) {
      return sqlite.prepare('DELETE FROM group_features WHERE line_group_id = ?').run(lineGroupId).changes;
    }
  },

  medbase_links: {
    get(lineUserId) {
      return sqlite.prepare('SELECT * FROM medbase_links WHERE line_user_id = ?').get(lineUserId) || null;
    },

    /** One HIS account may be linked from several LINE accounts (e.g. a new phone). */
    getByHis(his) {
      return sqlite.prepare('SELECT * FROM medbase_links WHERE his = ?').all(his);
    },

    upsert(lineUserId, { his, name, group }) {
      sqlite
        .prepare(`INSERT INTO medbase_links (line_user_id, his, name, medbase_group, linked_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(line_user_id) DO UPDATE SET
                    his = excluded.his, name = excluded.name,
                    medbase_group = excluded.medbase_group, linked_at = excluded.linked_at`)
        .run(lineUserId, his, name, group, new Date().toISOString());
      return this.get(lineUserId);
    },

    remove(lineUserId) {
      return sqlite.prepare('DELETE FROM medbase_links WHERE line_user_id = ?').run(lineUserId).changes > 0;
    }
  },

  medbase_groups: {
    getAll() {
      return sqlite.prepare('SELECT * FROM medbase_groups ORDER BY group_name').all()
        .map(row => parseJsonObject(row, 'last_versions'));
    },

    get(lineGroupId) {
      const row = sqlite.prepare('SELECT * FROM medbase_groups WHERE line_group_id = ?').get(lineGroupId);
      return row ? parseJsonObject(row, 'last_versions') : null;
    },

    upsert(lineGroupId, { groupName, medbaseGroup, remindEnabled, remindTime, notifyPublish }) {
      sqlite
        .prepare(`INSERT INTO medbase_groups (line_group_id, group_name, medbase_group, remind_enabled, remind_time, notify_publish)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(line_group_id) DO UPDATE SET
                    group_name = excluded.group_name, medbase_group = excluded.medbase_group,
                    remind_enabled = excluded.remind_enabled, remind_time = excluded.remind_time,
                    notify_publish = excluded.notify_publish`)
        .run(lineGroupId, groupName, medbaseGroup, remindEnabled ? 1 : 0, remindTime, notifyPublish ? 1 : 0);
      return this.get(lineGroupId);
    },

    remove(lineGroupId) {
      return sqlite.prepare('DELETE FROM medbase_groups WHERE line_group_id = ?').run(lineGroupId).changes > 0;
    },

    markReminded(lineGroupId, date) {
      sqlite.prepare('UPDATE medbase_groups SET last_reminded = ? WHERE line_group_id = ?').run(date, lineGroupId);
    },

    setVersions(lineGroupId, versions) {
      sqlite.prepare('UPDATE medbase_groups SET last_versions = ? WHERE line_group_id = ?').run(JSON.stringify(versions), lineGroupId);
    }
  },

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
