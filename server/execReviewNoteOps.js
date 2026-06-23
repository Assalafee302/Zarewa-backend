/**
 * MD chairman / monthly review narrative stored in org_policy_kv (one note per month).
 */
import { orgPolicyTablesReady } from './orgPolicy.js';

const NOTE_PREFIX = 'md.chairman_review.';
export const MD_REVIEW_NOTE_MAX_LEN = 8000;

export function mdReviewNotePolicyKey(monthKey) {
  const mk = String(monthKey || '').trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(mk)) return null;
  return `${NOTE_PREFIX}${mk}`;
}

function parseNotePayload(valueJson) {
  if (valueJson == null || valueJson === '') return { narrative: '' };
  try {
    const parsed = JSON.parse(String(valueJson));
    if (typeof parsed === 'string') return { narrative: parsed.slice(0, MD_REVIEW_NOTE_MAX_LEN) };
    return {
      narrative: String(parsed?.narrative || '').slice(0, MD_REVIEW_NOTE_MAX_LEN),
      updatedByDisplay: parsed?.updatedByDisplay || '',
    };
  } catch {
    return { narrative: String(valueJson).slice(0, MD_REVIEW_NOTE_MAX_LEN) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} monthKey YYYY-MM
 */
export function getMdReviewNote(db, monthKey) {
  const mk = String(monthKey || '').trim().slice(0, 7);
  const policyKey = mdReviewNotePolicyKey(mk);
  if (!policyKey) return { ok: false, error: 'monthKey must be YYYY-MM.' };

  if (!orgPolicyTablesReady(db)) {
    return { ok: true, monthKey: mk, narrative: '', updatedAtIso: null, updatedByDisplay: '' };
  }

  const row = db.prepare(`SELECT value_json, updated_at_iso FROM org_policy_kv WHERE policy_key = ?`).get(policyKey);
  const parsed = parseNotePayload(row?.value_json);
  return {
    ok: true,
    monthKey: mk,
    narrative: parsed.narrative || '',
    updatedAtIso: row?.updated_at_iso || null,
    updatedByDisplay: parsed.updatedByDisplay || '',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} monthKey
 * @param {string} narrative
 */
export function saveMdReviewNote(db, user, monthKey, narrative) {
  const mk = String(monthKey || '').trim().slice(0, 7);
  const policyKey = mdReviewNotePolicyKey(mk);
  if (!policyKey) return { ok: false, error: 'monthKey must be YYYY-MM.' };
  if (!orgPolicyTablesReady(db)) return { ok: false, error: 'Policy storage is not available.' };

  const text = String(narrative || '').trim().slice(0, MD_REVIEW_NOTE_MAX_LEN);
  const now = new Date().toISOString();
  const display =
    String(user?.displayName || user?.name || user?.username || user?.id || 'MD').trim() || 'MD';
  const payload = JSON.stringify({ narrative: text, updatedByDisplay: display });

  db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(policy_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_display = excluded.updated_by_display`
  ).run(policyKey, payload, now, String(user?.id || ''), display);

  return getMdReviewNote(db, mk);
}
