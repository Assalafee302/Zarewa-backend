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

const DOC_CATEGORY_BY_KIND = {
  nin_slip: 'identity',
  passport_photo: 'identity',
  appointment_letter: 'employment',
  cv: 'qualification',
  academic_credentials: 'qualification',
  confidentiality_pledge: 'policy',
  employee_handbook_receipt: 'policy',
};

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

function mapDocRow(r) {
  return {
    id: r.id,
    userId: r.user_id ?? r.userId,
    docKind: r.doc_kind ?? r.docKind,
    fileName: r.file_name ?? r.fileName,
    mimeType: r.mime_type ?? r.mimeType,
    uploadedAtIso: r.uploaded_at_iso ?? r.uploadedAtIso,
    uploadedByUserId: r.uploaded_by_user_id ?? r.uploadedByUserId,
    expiryDateIso: r.expiry_date_iso ?? r.expiryDateIso ?? null,
    issueDateIso: r.issue_date_iso ?? r.issueDateIso ?? null,
    verificationStatus: r.verification_status ?? r.verificationStatus ?? 'pending',
    verifiedByUserId: r.verified_by_user_id ?? r.verifiedByUserId ?? null,
    verifiedAtIso: r.verified_at_iso ?? r.verifiedAtIso ?? null,
    rejectionReason: r.rejection_reason ?? r.rejectionReason ?? null,
    notes: r.notes ?? null,
    docCategory: r.doc_category ?? r.docCategory ?? DOC_CATEGORY_BY_KIND[r.doc_kind ?? r.docKind] ?? 'other',
    label: hrStaffDocKindLabel(r.doc_kind ?? r.docKind),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listHrStaffDocumentMeta(db, userId) {
  if (!hrStaffDocumentsTableReady(db)) return [];
  const uid = String(userId || '').trim();
  if (!uid) return [];
  try {
    return db
      .prepare(
        `SELECT id, user_id, doc_kind, file_name, mime_type, uploaded_at_iso, uploaded_by_user_id,
                expiry_date_iso, issue_date_iso, verification_status, verified_by_user_id,
                verified_at_iso, rejection_reason, notes, doc_category
         FROM hr_staff_documents
         WHERE user_id = ?
         ORDER BY doc_kind ASC, uploaded_at_iso DESC`
      )
      .all(uid)
      .map(mapDocRow);
  } catch {
    return db
      .prepare(
        `SELECT id, user_id AS userId, doc_kind AS docKind, file_name AS fileName, mime_type AS mimeType,
                uploaded_at_iso AS uploadedAtIso, uploaded_by_user_id AS uploadedByUserId
         FROM hr_staff_documents WHERE user_id = ? ORDER BY doc_kind ASC, uploaded_at_iso DESC`
      )
      .all(uid)
      .map(mapDocRow);
  }
}

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
  const expiryDateIso = String(body?.expiryDateIso || body?.expiry_date_iso || '').trim().slice(0, 10) || null;
  const issueDateIso = String(body?.issueDateIso || body?.issue_date_iso || '').trim().slice(0, 10) || null;
  const notes = String(body?.notes || '').trim() || null;
  const docCategory = String(body?.docCategory || DOC_CATEGORY_BY_KIND[docKind] || 'other').trim();
  return { ok: true, docKind, fileName, mimeType, dataB64, expiryDateIso, issueDateIso, notes, docCategory };
}

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
  try {
    db.prepare(
      `INSERT INTO hr_staff_documents (
        id, user_id, doc_kind, file_name, mime_type, data_b64, uploaded_at_iso, uploaded_by_user_id,
        expiry_date_iso, issue_date_iso, verification_status, notes, doc_category
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      uid,
      norm.docKind,
      norm.fileName,
      norm.mimeType,
      norm.dataB64,
      now,
      actorUserId || null,
      norm.expiryDateIso,
      norm.issueDateIso,
      'pending',
      norm.notes,
      norm.docCategory
    );
  } catch {
    db.prepare(
      `INSERT INTO hr_staff_documents (
        id, user_id, doc_kind, file_name, mime_type, data_b64, uploaded_at_iso, uploaded_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, uid, norm.docKind, norm.fileName, norm.mimeType, norm.dataB64, now, actorUserId || null);
  }

  syncProfileDocumentsIndex(db, uid);
  const meta = listHrStaffDocumentMeta(db, uid).find((d) => d.id === id);
  return { ok: true, document: meta };
}

export function verifyHrStaffDocument(db, actorUserId, userId, docId, body) {
  if (!hrStaffDocumentsTableReady(db)) return { ok: false, error: 'HR documents not initialised.' };
  const row = getHrStaffDocumentRow(db, userId, docId);
  if (!row) return { ok: false, error: 'Document not found.' };
  const action = String(body?.action || body?.status || 'verify').trim().toLowerCase();
  const now = nowIso();
  if (action === 'reject') {
    const reason = String(body?.rejectionReason || body?.reason || '').trim();
    if (!reason) return { ok: false, error: 'Rejection reason is required.' };
    try {
      db.prepare(
        `UPDATE hr_staff_documents SET verification_status = 'rejected', rejection_reason = ?, verified_by_user_id = ?, verified_at_iso = ? WHERE id = ?`
      ).run(reason, actorUserId, now, docId);
    } catch {
      return { ok: false, error: 'Verification columns not available.' };
    }
  } else {
    try {
      db.prepare(
        `UPDATE hr_staff_documents SET verification_status = 'verified', rejection_reason = NULL, verified_by_user_id = ?, verified_at_iso = ? WHERE id = ?`
      ).run(actorUserId, now, docId);
    } catch {
      return { ok: false, error: 'Verification columns not available.' };
    }
  }
  return { ok: true, document: listHrStaffDocumentMeta(db, userId).find((d) => d.id === docId) };
}

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
    expiryDateIso: m.expiryDateIso,
    verificationStatus: m.verificationStatus,
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

export function deleteHrStaffDocument(db, userId, docId) {
  if (!hrStaffDocumentsTableReady(db)) return { ok: false, error: 'HR documents not initialised.' };
  const row = getHrStaffDocumentRow(db, userId, docId);
  if (!row) return { ok: false, error: 'Document not found.' };
  db.prepare(`DELETE FROM hr_staff_documents WHERE id = ?`).run(docId);
  syncProfileDocumentsIndex(db, userId);
  return { ok: true };
}

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

export function setHrStaffPassportPhoto(db, _actorUserId, userId, avatarUrl) {
  const uid = String(userId || '').trim();
  const u = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
  if (!u) return { ok: false, error: 'User not found.' };
  return updateUserProfile(db, uid, { avatarUrl: avatarUrl ?? null });
}

export { DOC_CATEGORY_BY_KIND };
