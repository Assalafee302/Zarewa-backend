/**
 * Staff onboarding documents (file store) and checklist helpers.
 * @module server/hrStaffDocuments
 */
import crypto from 'node:crypto';
import {
  HR_REQUIRED_DOC_KINDS,
  buildHrStaffOnboardingChecklist,
  hrStaffDocKindLabel,
} from '../shared/lib/hrStaffDocuments.js';
import { updateUserProfile } from './auth.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(10).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

const MAX_DOC_B64 = 4_500_000;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export function hrStaffDocumentsTableReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_documents'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listHrStaffDocumentMeta(db, userId) {
  if (!hrStaffDocumentsTableReady(db)) return [];
  const uid = String(userId || '').trim();
  if (!uid) return [];
  return db
    .prepare(
      `SELECT id, user_id AS userId, doc_kind AS docKind, file_name AS fileName, mime_type AS mimeType,
              uploaded_at_iso AS uploadedAtIso, uploaded_by_user_id AS uploadedByUserId
       FROM hr_staff_documents
       WHERE user_id = ?
       ORDER BY doc_kind ASC, uploaded_at_iso DESC`
    )
    .all(uid)
    .map((r) => ({
      ...r,
      label: hrStaffDocKindLabel(r.docKind),
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getHrStaffDocumentRow(db, userId, docId) {
  if (!hrStaffDocumentsTableReady(db)) return null;
  return db
    .prepare(`SELECT * FROM hr_staff_documents WHERE user_id = ? AND id = ?`)
    .get(String(userId || '').trim(), String(docId || '').trim());
}

function normalizeUploadBody(body) {
  const docKind = String(body?.docKind || body?.kind || '').trim();
  if (!HR_REQUIRED_DOC_KINDS.includes(docKind)) {
    return { ok: false, error: `Invalid document type. Use one of: ${HR_REQUIRED_DOC_KINDS.join(', ')}` };
  }
  const fileName = String(body?.fileName || body?.file_name || 'document').trim().slice(0, 200) || 'document';
  const mimeType = String(body?.mimeType || body?.mime_type || 'application/octet-stream').trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    return { ok: false, error: 'File must be PDF, PNG, JPEG, or WebP.' };
  }
  let dataB64 = String(body?.dataBase64 || body?.data_b64 || '').trim();
  if (dataB64.includes(',')) dataB64 = dataB64.split(',')[1] || '';
  if (!dataB64 || dataB64.length > MAX_DOC_B64) {
    return { ok: false, error: 'File is missing or too large (max ~3 MB).' };
  }
  return { ok: true, docKind, fileName, mimeType, dataB64 };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {string} userId
 * @param {object} body
 */
export function uploadHrStaffDocument(db, actorUserId, userId, body) {
  if (!hrStaffDocumentsTableReady(db)) return { ok: false, error: 'HR documents not initialised.' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId is required.' };
  const profile = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(uid);
  if (!profile) return { ok: false, error: 'No HR employee file for this user.' };

  const norm = normalizeUploadBody(body);
  if (!norm.ok) return norm;

  db.prepare(`DELETE FROM hr_staff_documents WHERE user_id = ? AND doc_kind = ?`).run(uid, norm.docKind);

  const now = nowIso();
  const id = newId('HRDOC');
  db.prepare(
    `INSERT INTO hr_staff_documents (
      id, user_id, doc_kind, file_name, mime_type, data_b64, uploaded_at_iso, uploaded_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, uid, norm.docKind, norm.fileName, norm.mimeType, norm.dataB64, now, actorUserId || null);

  syncProfileDocumentsIndex(db, uid);
  const meta = listHrStaffDocumentMeta(db, uid).find((d) => d.id === id);
  return { ok: true, document: meta };
}

/**
 * Replace prior upload for same doc kind (keep latest only).
 */
function syncProfileDocumentsIndex(db, userId) {
  const metas = listHrStaffDocumentMeta(db, userId);
  const byKind = new Map();
  for (const m of metas) {
    if (!byKind.has(m.docKind)) byKind.set(m.docKind, m);
  }
  const documents = Array.from(byKind.values()).map((m) => ({
    id: m.id,
    kind: m.docKind,
    label: m.label,
    fileName: m.fileName,
    uploadedAtIso: m.uploadedAtIso,
  }));
  const row = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!row) return;
  const extra = safeJsonParse(row.profile_extra_json, {});
  extra.documents = documents;
  db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ? WHERE user_id = ?`).run(
    JSON.stringify(extra),
    userId
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} docId
 */
export function deleteHrStaffDocument(db, userId, docId) {
  if (!hrStaffDocumentsTableReady(db)) return { ok: false, error: 'HR documents not initialised.' };
  const row = getHrStaffDocumentRow(db, userId, docId);
  if (!row) return { ok: false, error: 'Document not found.' };
  db.prepare(`DELETE FROM hr_staff_documents WHERE id = ?`).run(docId);
  syncProfileDocumentsIndex(db, userId);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} staffRow from listHrStaff / getHrStaffOne
 * @param {string | null} avatarUrl
 */
export function enrichStaffWithOnboarding(db, staff, avatarUrl = null) {
  if (!staff) return staff;
  const metas = listHrStaffDocumentMeta(db, staff.userId);
  const uploadedDocKinds = [...new Set(metas.map((m) => m.docKind))];
  const checklist = buildHrStaffOnboardingChecklist({
    ninNumber: staff.ninNumber,
    nextOfKin: staff.nextOfKin,
    avatarUrl: avatarUrl ?? staff.avatarUrl,
    uploadedDocKinds,
  });
  const extraMissing = checklist.missing.filter((m) => !staff.criticalMissing?.includes(m));
  return {
    ...staff,
    avatarUrl: avatarUrl ?? staff.avatarUrl ?? null,
    documents: metas,
    onboardingChecklist: checklist,
    criticalMissing: [...(staff.criticalMissing || []), ...extraMissing],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {string} userId
 * @param {string | null} avatarUrl
 */
export function setHrStaffPassportPhoto(db, _actorUserId, userId, avatarUrl) {
  const uid = String(userId || '').trim();
  const u = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
  if (!u) return { ok: false, error: 'User not found.' };
  return updateUserProfile(db, uid, { avatarUrl: avatarUrl ?? null });
}
