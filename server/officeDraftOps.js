/**
 * Server-side Compose Memo drafts — cross-device autosave.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';

function nowIso() {
  return new Date().toISOString();
}

function newDraftId() {
  return `MDR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function officeDraftTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_memo_drafts'`).get()
    );
  } catch {
    return false;
  }
}

function mapDraftRow(row) {
  const payload = safeJsonParse(row.payload_json, {});
  return {
    id: row.id,
    branchId: row.branch_id,
    userId: row.user_id,
    subject: row.subject || '',
    body: row.body || '',
    confidentiality: row.confidentiality || 'internal',
    smartMemoType: row.smart_memo_type || '',
    updatedAtIso: row.updated_at_iso,
    payload,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} branchId
 */
export function listOfficeMemoDrafts(db, userId, branchId) {
  if (!officeDraftTablesReady(db)) return [];
  const uid = String(userId || '').trim();
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  if (!uid) return [];
  return db
    .prepare(
      `SELECT * FROM office_memo_drafts WHERE user_id = ? AND branch_id = ? ORDER BY updated_at_iso DESC LIMIT 20`
    )
    .all(uid, bid)
    .map(mapDraftRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {object} body
 */
export function upsertOfficeMemoDraft(db, userId, body) {
  if (!officeDraftTablesReady(db)) return { ok: false, error: 'Memo drafts are not available.' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  const branchId = String(body?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const id = String(body?.id || '').trim() || newDraftId();
  const now = nowIso();
  const payload = body?.payload != null && typeof body.payload === 'object' ? body.payload : {};
  db.prepare(
    `INSERT INTO office_memo_drafts (
      id, user_id, branch_id, subject, body, confidentiality, smart_memo_type, payload_json, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      subject = excluded.subject,
      body = excluded.body,
      confidentiality = excluded.confidentiality,
      smart_memo_type = excluded.smart_memo_type,
      payload_json = excluded.payload_json,
      updated_at_iso = excluded.updated_at_iso`
  ).run(
    id,
    uid,
    branchId,
    String(body?.subject ?? '').slice(0, 500),
    String(body?.body ?? '').slice(0, 50000),
    String(body?.confidentiality || 'internal').trim() || 'internal',
    String(body?.smartMemoType || '').trim() || null,
    JSON.stringify({
      ...payload,
      toIds: Array.isArray(body?.toIds) ? body.toIds : payload.toIds || [],
      ccIds: Array.isArray(body?.ccIds) ? body.ccIds : payload.ccIds || [],
      officeKey: body?.officeKey || payload.officeKey || 'office_admin',
      documentClass: body?.documentClass || payload.documentClass || 'correspondence',
      smartGuidedFields: body?.smartGuidedFields || payload.smartGuidedFields || {},
    }),
    now
  );
  const row = db.prepare(`SELECT * FROM office_memo_drafts WHERE id = ? AND user_id = ?`).get(id, uid);
  return { ok: true, draft: row ? mapDraftRow(row) : { id } };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} draftId
 */
export function deleteOfficeMemoDraft(db, userId, draftId) {
  if (!officeDraftTablesReady(db)) return { ok: false, error: 'Memo drafts are not available.' };
  const uid = String(userId || '').trim();
  const id = String(draftId || '').trim();
  if (!uid || !id) return { ok: false, error: 'Invalid.' };
  db.prepare(`DELETE FROM office_memo_drafts WHERE id = ? AND user_id = ?`).run(id, uid);
  return { ok: true };
}
