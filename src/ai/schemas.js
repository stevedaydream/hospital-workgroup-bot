/**
 * JSON schemas shared by every provider.
 *
 * Two llama.cpp behaviours shape these definitions:
 *
 * 1. When a schema is compiled into a GBNF grammar, `required` means "must
 *    emit" and anything else may be silently skipped. Every property is
 *    therefore listed as required -- optional fields would simply vanish.
 * 2. llama-server fails *open* if grammar compilation fails, so a malformed
 *    schema yields unconstrained text rather than an error. Callers must still
 *    validate the parsed object; see `normalise*` below.
 *
 * Absent values are the empty string rather than null: nullable types make the
 * generated grammar considerably more fragile for very little gain.
 */

export const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['CASE_TABLE', 'WARD_NOTE', 'CALENDAR', 'UNKNOWN'] }
  }
};

export const CASE_TABLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'assignments'],
  properties: {
    date: { type: 'string' },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['doctor', 'department'],
        properties: {
          doctor: { type: 'string' },
          department: { type: 'string' }
        }
      }
    }
  }
};

export const WARD_NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'content'],
        properties: {
          title: { type: 'string' },
          content: { type: 'string' }
        }
      }
    }
  }
};

export const CALENDAR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'time', 'location', 'description'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          location: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }
};

/** Per-image description used as the "map" step of multi-image consolidation. */
export const IMAGE_DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string' }
  }
};

const asString = (value) => (typeof value === 'string' ? value.trim() : '');
const emptyToNull = (value) => (value === '' ? null : value);

export function normaliseType(parsed) {
  const type = asString(parsed?.type).toUpperCase();
  return ['CASE_TABLE', 'WARD_NOTE', 'CALENDAR'].includes(type) ? type : 'UNKNOWN';
}

export function normaliseCaseTable(parsed) {
  const rawAssignments = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
  const assignments = rawAssignments
    .map((item) => ({
      doctor: asString(item?.doctor),
      department: asString(item?.department).toUpperCase()
    }))
    .filter((item) => item.doctor || item.department);

  // The same doctor can appear on several rows of one table.
  const seen = new Set();
  const deduped = assignments.filter((item) => {
    const key = `${item.doctor}|${item.department}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { date: emptyToNull(asString(parsed?.date)), assignments: deduped };
}

export function normaliseNotes(parsed) {
  const raw = Array.isArray(parsed?.notes) ? parsed.notes : [];
  return raw
    .map((note) => ({ title: asString(note?.title) || '公告', content: asString(note?.content) }))
    .filter((note) => note.content);
}

export function normaliseEvents(parsed) {
  const raw = Array.isArray(parsed?.events) ? parsed.events : [];
  return raw
    .map((event) => ({
      title: asString(event?.title),
      date: asString(event?.date),
      time: emptyToNull(asString(event?.time)),
      location: emptyToNull(asString(event?.location)),
      description: emptyToNull(asString(event?.description))
    }))
    .filter((event) => event.title && /^\d{4}-\d{2}-\d{2}$/.test(event.date));
}
