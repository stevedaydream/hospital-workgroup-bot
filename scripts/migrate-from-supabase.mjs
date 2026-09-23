/**
 * One-off import of the previous Supabase project into the local SQLite file.
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run migrate:supabase
 *
 * Safe to re-run: every table is wiped and re-imported inside a transaction,
 * so a half-finished run cannot leave a partially populated database.
 *
 * Note on dates: the old daily_dispatch_cache.created_at was the (UTC) upload
 * date, and those rows were always meant for the following morning. They are
 * therefore imported as dispatch_date = created_at + 1 day.
 */

import dotenv from 'dotenv';
import { sqlite } from '../src/db.js';
import { addDays, nowIso } from '../src/util/date.js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to run this migration.');
  process.exit(1);
}

async function fetchTable(table) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to read ${table}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const asJsonText = (value) => JSON.stringify(Array.isArray(value) ? value : value ?? []);

const tables = ['users', 'general_notes', 'doctor_group_mapping', 'daily_dispatch_cache', 'group_events', 'presentation_rotations'];

const source = {};
for (const table of tables) {
  source[table] = await fetchTable(table);
  console.log(`Fetched ${source[table].length} rows from ${table}`);
}

const importAll = sqlite.transaction(() => {
  for (const table of tables) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }

  const insertUser = sqlite.prepare('INSERT INTO users (line_user_id, display_name) VALUES (?, ?)');
  for (const row of source.users) {
    insertUser.run(row.line_user_id, row.display_name);
  }

  const insertNote = sqlite.prepare(
    'INSERT INTO general_notes (title, content, updated_at, updated_by) VALUES (?, ?, ?, ?)'
  );
  for (const row of source.general_notes) {
    insertNote.run(row.title, row.content, row.updated_at || nowIso(), row.updated_by || '系統匯入');
  }

  const insertMapping = sqlite.prepare(
    'INSERT INTO doctor_group_mapping (match_key, group_name, line_group_id, type) VALUES (?, ?, ?, ?)'
  );
  for (const row of source.doctor_group_mapping) {
    insertMapping.run(row.match_key, row.group_name, row.line_group_id, row.type);
  }

  const insertDispatch = sqlite.prepare(
    `INSERT OR REPLACE INTO daily_dispatch_cache
       (target_line_group_id, source_image_message_id, is_confirmed, dispatch_date, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of source.daily_dispatch_cache) {
    const createdDate = (row.created_at || '').slice(0, 10);
    if (!createdDate) continue;
    insertDispatch.run(
      row.target_line_group_id,
      row.source_image_message_id,
      row.is_confirmed ? 1 : 0,
      addDays(createdDate, 1),
      nowIso()
    );
  }

  const insertEvent = sqlite.prepare(
    `INSERT INTO group_events (title, date, time, location, description, source_group_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of source.group_events) {
    insertEvent.run(
      row.title,
      row.date,
      row.time || null,
      row.location || null,
      row.description || null,
      row.source_group_id,
      row.created_at || nowIso(),
      row.created_by || '系統匯入'
    );
  }

  const insertRotation = sqlite.prepare(
    `INSERT INTO presentation_rotations
       (source_group_id, doctors, nps, exclusions, dept_sequence, ward_sequence)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const row of source.presentation_rotations) {
    insertRotation.run(
      row.source_group_id,
      asJsonText(row.doctors),
      asJsonText(row.nps),
      asJsonText(row.exclusions),
      asJsonText(row.dept_sequence),
      asJsonText(row.ward_sequence)
    );
  }
});

importAll();

console.log('\nMigration complete:');
for (const table of tables) {
  const { count } = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  console.log(`  ${table}: ${count} rows`);
}
