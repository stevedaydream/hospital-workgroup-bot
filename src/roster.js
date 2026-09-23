/**
 * Closed-set name resolution.
 *
 * The dangerous failure of a small vision model is not a crash or an empty
 * result -- those trigger the cloud fallback. It is reading 陳鍾沛 as 陳錘沛
 * with complete confidence: valid JSON, populated fields, no timeout, and
 * tomorrow the table goes to the wrong group.
 *
 * Doctor names are a closed set, so OCR output can be snapped back onto the
 * roster instead of being trusted. Anything that cannot be snapped is reported
 * as unmatched rather than quietly dropped -- a name the system cannot place
 * is exactly the case a human needs to look at.
 */

import { db } from './db.js';

/** Levenshtein distance, capped for early exit. */
function editDistance(a, b, cap = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Resolve one OCR'd name against the roster.
 *
 * Fuzzy matching is only allowed for names of three characters or more: on a
 * two-character name a single-character edit is a different person, not a
 * typo.
 *
 * @param {string} rawName
 * @param {Array<{name: string, department: string, aliases: string[]}>} roster
 * @returns {{doctor: object, confidence: 'exact'|'alias'|'fuzzy'}|null}
 */
export function matchName(rawName, roster) {
  const name = (rawName || '').trim();
  if (!name) return null;

  const exact = roster.find((doctor) => doctor.name === name);
  if (exact) return { doctor: exact, confidence: 'exact' };

  const byAlias = roster.find((doctor) => (doctor.aliases || []).includes(name));
  if (byAlias) return { doctor: byAlias, confidence: 'alias' };

  if (name.length < 3) return null;

  const candidates = roster
    .filter((doctor) => doctor.name.length >= 3)
    .map((doctor) => ({ doctor, distance: editDistance(name, doctor.name, 1) }))
    .filter((candidate) => candidate.distance === 1);

  // Two equally close candidates means the correction is a guess; refuse.
  if (candidates.length !== 1) return null;
  return { doctor: candidates[0].doctor, confidence: 'fuzzy' };
}

/**
 * Turn raw extraction output into a dispatch proposal a human can check.
 *
 * @param {Array<{doctor: string, department: string}>} assignments
 * @returns {Promise<{matched: Array, unmatched: string[], targets: Array}>}
 */
export async function buildDispatchProposal(assignments) {
  const roster = await db.doctors.getAll();
  const mappings = await db.doctor_group_mapping.getAll();

  const matched = [];
  const unmatched = [];
  const targets = new Map(); // line_group_id -> { group_name, reasons: Set }

  const addTarget = (mapping, reason) => {
    const existing = targets.get(mapping.line_group_id);
    if (existing) {
      existing.reasons.add(reason);
    } else {
      targets.set(mapping.line_group_id, {
        line_group_id: mapping.line_group_id,
        group_name: mapping.group_name,
        type: mapping.type,
        reasons: new Set([reason])
      });
    }
  };

  for (const assignment of assignments) {
    const hit = assignment.doctor ? matchName(assignment.doctor, roster) : null;

    if (assignment.doctor && !hit) {
      // Only report a name once, however many rows it appeared on.
      if (!unmatched.includes(assignment.doctor)) unmatched.push(assignment.doctor);
    }

    // The roster is authoritative about which department someone belongs to;
    // the department column on the sheet is a fallback when it is blank.
    const department = (hit?.doctor.department || assignment.department || '').toUpperCase();
    const resolvedName = hit?.doctor.name || null;

    if (resolvedName) {
      matched.push({
        ocrName: assignment.doctor,
        name: resolvedName,
        department,
        confidence: hit.confidence,
        corrected: hit.confidence !== 'exact'
      });
    }

    if (resolvedName) {
      for (const mapping of mappings.filter((m) => m.type === 'DIRECT' && m.match_key === resolvedName)) {
        addTarget(mapping, `${resolvedName}醫師`);
      }
    }

    if (department) {
      for (const mapping of mappings.filter(
        (m) => m.type === 'FLEXIBLE' && m.match_key.toUpperCase() === department
      )) {
        addTarget(mapping, department);
      }
    }
  }

  return {
    matched,
    unmatched,
    targets: [...targets.values()].map((target) => ({ ...target, reasons: [...target.reasons] }))
  };
}
