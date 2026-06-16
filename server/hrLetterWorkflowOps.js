/**
 * Phase 8 — letter approval workflow, reference numbers, official export lock.
 * @module server/hrLetterWorkflowOps
 */

import crypto from 'node:crypto';
import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { buildHrLetterContent } from './hrLetterTemplates.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { hrUserHas } from './hrPermissions.js';
import { createHrNotification } from './hrNotifications.js';

const COMPANY = 'Zarewa Aluminium and Plastics Ltd';
const DRAFT_WATERMARK = 'DRAFT — NOT VALID FOR OFFICIAL USE';
const OFFICIAL_STATUSES = new Set(['approved', 'issued']);

export const LETTER_STATUSES = [
  'draft',
  'submitted',
  'hr_review',
  'gm_review',
  'md_review',
  'approved',
  'issued',
  'rejected',
  'cancelled',
  'test',
  'archived',
];

export const SENSITIVE_LETTER_KINDS = new Set([
  'termination',
  'dismissal',
  'suspension',
  'final_warning',
  'warning',
  'layoff',
  'salary_increment',
  'salary',
  'bonus_approval',
  'loan_agreement',
  'staff_loan_agreement',
  'promotion',
  'query',
  'investigation_notice',
  'salary_recovery',
]);

const LETTER_TYPE_CODES = {
  appointment: 'APP',
  confirmation: 'CNF',
  probation_extension: 'PRB',
  promotion: 'PRM',
  salary: 'PAY',
  salary_increment: 'PAY',
  bonus_approval: 'PAY',
  transfer: 'TRF',
  transfer_inter_branch: 'TRF',
  transfer_in_branch: 'TRF',
  transfer_hq_to_branch: 'TRF',
  transfer_branch_to_hq: 'TRF',
  transfer_temporary: 'TRF',
  query: 'DIS',
  warning: 'DIS',
  final_warning: 'DIS',
  suspension: 'DIS',
  dismissal: 'DIS',
  termination: 'DIS',
  investigation_notice: 'DIS',
  hearing_invitation: 'DIS',
  salary_recovery: 'DIS',
  leave_approval: 'LVE',
  leave_rejection: 'LVE',
  resignation_acceptance: 'EXT',
  exit_clearance: 'EXT',
  layoff: 'EXT',
  employment: 'EMP',
  introduction: 'EMP',
  experience: 'EMP',
  certificate_of_service: 'EMP',
  training_approval: 'DEV',
  handbook_receipt: 'POL',
  confidentiality_pledge: 'POL',
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function loadStaffBrief(db, userId) {
  const u = db.prepare(`SELECT display_name, username FROM app_users WHERE id = ?`).get(userId);
  const p = db.prepare(
    `SELECT employee_no, job_title, department, branch_id, date_joined_iso, base_salary_ngn FROM hr_staff_profiles WHERE user_id = ?`
  ).get(userId);
  if (!u) return null;
  return {
    displayName: u.display_name || u.username,
    username: u.username,
    employeeNo: p?.employee_no,
    jobTitle: p?.job_title,
    department: p?.department,
    branchId: p?.branch_id,
    dateJoinedIso: p?.date_joined_iso,
    baseSalaryNgn: p?.base_salary_ngn,
  };
}

export function letterRequiresMdApproval(letterKind) {
  return SENSITIVE_LETTER_KINDS.has(String(letterKind || '').trim().toLowerCase());
}

export function getDefaultLetterRefConfig() {
  const year = new Date().getFullYear();
  return {
    prefix: 'ZAR/HR',
    year,
    resetMode: 'yearly',
    startingSequence: 1,
    sequences: {},
    lastIssuedReference: null,
  };
}

export function getLetterReferenceConfig(db) {
  if (!hrTableExists(db, 'hr_settings')) return getDefaultLetterRefConfig();
  const row = db.prepare(`SELECT value_json FROM hr_settings WHERE key = 'letter_reference_config'`).get();
  if (!row?.value_json) return getDefaultLetterRefConfig();
  return { ...getDefaultLetterRefConfig(), ...safeJsonParse(row.value_json, {}) };
}

export function saveLetterReferenceConfig(db, config, actor) {
  if (!hrTableExists(db, 'hr_settings')) return { ok: false, error: 'HR settings not initialised.' };
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_settings (key, value_json, updated_at_iso, updated_by_user_id)
     VALUES ('letter_reference_config', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso, updated_by_user_id=excluded.updated_by_user_id`
  ).run(JSON.stringify(config), now, actor?.id || null);
  return { ok: true };
}

function typeCodeForKind(letterKind) {
  return LETTER_TYPE_CODES[String(letterKind || '').trim().toLowerCase()] || 'GEN';
}

export function previewNextLetterReferences(db, letterKind, count = 3) {
  const cfg = getLetterReferenceConfig(db);
  const year = cfg.year || new Date().getFullYear();
  const code = typeCodeForKind(letterKind);
  const key = `${year}:${code}`;
  let seq = Number(cfg.sequences?.[key] || cfg.startingSequence || 1);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${cfg.prefix}/${code}/${year}/${String(seq + i).padStart(4, '0')}`);
  }
  return out;
}

function assignReferenceNumber(db, letterKind) {
  const cfg = getLetterReferenceConfig(db);
  const year = new Date().getFullYear();
  if (cfg.year !== year && cfg.resetMode === 'yearly') {
    cfg.year = year;
    cfg.sequences = {};
  }
  const code = typeCodeForKind(letterKind);
  const key = `${year}:${code}`;
  const next = Number(cfg.sequences?.[key] || cfg.startingSequence || 1);
  const ref = `${cfg.prefix}/${code}/${year}/${String(next).padStart(4, '0')}`;
  cfg.sequences = { ...(cfg.sequences || {}), [key]: next + 1 };
  cfg.lastIssuedReference = ref;
  cfg.year = year;
  saveLetterReferenceConfig(db, cfg, null);
  return ref;
}

export function resetLetterReferencesForLiveUse(db, actor, body = {}) {
  if (!hrTableExists(db, 'hr_settings')) return { ok: false, error: 'HR settings not initialised.' };
  const startingSequence = Math.max(1, Math.round(Number(body.startingSequence) || 1));
  const archiveTest = body.archiveTestLetters !== false;
  const cfg = {
    ...getDefaultLetterRefConfig(),
    startingSequence,
    sequences: {},
    lastIssuedReference: null,
  };
  saveLetterReferenceConfig(db, cfg, actor);
  if (archiveTest && hrTablesReady(db)) {
    try {
      db.prepare(
        `UPDATE hr_employment_letters SET status = 'archived' WHERE status IN ('draft','issued','test') AND (reference_number IS NULL OR reference_number LIKE 'TEST%')`
      ).run();
    } catch {
      /* optional columns */
    }
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.reference_reset',
    entityKind: 'hr_settings',
    entityId: 'letter_reference_config',
    details: { startingSequence, archiveTest },
  });
  return { ok: true, config: cfg, preview: previewNextLetterReferences(db, 'appointment', 5) };
}

function mapLetterRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    letterKind: row.letter_kind,
    contentText: row.content_text,
    status: row.status || 'issued',
    referenceNumber: row.reference_number || null,
    draftId: row.draft_id || null,
    issuedAtIso: row.issued_at_iso,
    issuedByUserId: row.issued_by_user_id,
    sourceRecordKind: row.source_record_kind,
    sourceRecordId: row.source_record_id,
    preparedByUserId: row.prepared_by_user_id || row.issued_by_user_id,
    rejectionReason: row.rejection_reason || null,
    submittedAtIso: row.submitted_at_iso,
    hrReviewedAtIso: row.hr_reviewed_at_iso,
    gmReviewedAtIso: row.gm_reviewed_at_iso,
    mdApprovedAtIso: row.md_approved_at_iso,
    downloadCount: row.download_count || 0,
    printCount: row.print_count || 0,
  };
}

export function getEmploymentLetter(db, letterId) {
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(String(letterId || '').trim());
  return mapLetterRow(row);
}

export function listEmploymentLettersDetailed(db, userId) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_employment_letters WHERE 1=1`;
  const args = [];
  if (userId) {
    sql += ` AND user_id = ?`;
    args.push(userId);
  }
  sql += ` ORDER BY COALESCE(issued_at_iso, submitted_at_iso, id) DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map(mapLetterRow);
}

export function listEmploymentLettersByIds(db, letterIds) {
  if (!hrTablesReady(db)) return [];
  const ids = [...new Set((letterIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT l.*, u.display_name AS staffDisplayName
       FROM hr_employment_letters l
       LEFT JOIN app_users u ON u.id = l.user_id
       WHERE l.id IN (${placeholders})`
    )
    .all(...ids);
  return rows.map((row) => ({
    ...mapLetterRow(row),
    staffDisplayName: row.staffDisplayName || row.user_id,
  }));
}

export function createDraftLetter(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || '').trim();
  const letterKind = String(body?.letterKind || 'employment').trim().toLowerCase();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const staff = loadStaffBrief(db, userId);
  if (!staff) return { ok: false, error: 'Staff not found.' };
  const extra = body?.extraData || body?.extra || body;
  const content = buildHrLetterContent(letterKind, staff, extra);
  const id = newId('HRL');
  const draftId = newId('DRF');
  const sourceRecordKind = String(body?.sourceRecordKind || extra?.sourceRecordKind || '').trim() || null;
  const sourceRecordId = String(body?.sourceRecordId || extra?.sourceRecordId || '').trim() || null;
  try {
    db.prepare(
      `INSERT INTO hr_employment_letters (
        id, user_id, letter_kind, content_text, status, draft_id, prepared_by_user_id,
        source_record_kind, source_record_id, download_count, print_count
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      userId,
      letterKind,
      content,
      'draft',
      draftId,
      actor?.id || null,
      sourceRecordKind,
      sourceRecordId,
      0,
      0,
    );
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.draft_created',
    entityKind: 'hr_employment_letter',
    entityId: id,
    details: { letterKind, userId },
  });
  return { ok: true, id, draftId, status: 'draft', contentText: content, letterKind };
}

function patchLetterStatus(db, letterId, patch, actor, auditAction) {
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return { ok: false, error: 'No updates.' };
  args.push(letterId);
  db.prepare(`UPDATE hr_employment_letters SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: auditAction,
    entityKind: 'hr_employment_letter',
    entityId: letterId,
    details: patch,
  });
  return { ok: true, letter: getEmploymentLetter(db, letterId) };
}

export function submitLetter(db, actor, letterId) {
  const row = db.prepare(`SELECT status FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  if (!['draft', 'rejected'].includes(String(row.status))) {
    return { ok: false, error: 'Only draft or rejected letters can be submitted.' };
  }
  const now = nowIso();
  const r = patchLetterStatus(
    db,
    letterId,
    { status: 'submitted', submitted_at_iso: now, submitted_by_user_id: actor?.id, rejection_reason: null },
    actor,
    'hr.letter.submitted',
  );
  notifyLetterPending(db, letterId, 'Letter submitted for review');
  return r;
}

export function hrReviewLetter(db, actor, letterId, { approve, note } = {}) {
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  if (!['submitted', 'hr_review'].includes(String(row.status))) {
    return { ok: false, error: 'Letter is not awaiting HR review.' };
  }
  const now = nowIso();
  if (!approve) {
    return patchLetterStatus(
      db,
      letterId,
      { status: 'rejected', rejection_reason: String(note || 'Rejected at HR review').trim(), hr_reviewed_at_iso: now, hr_reviewed_by_user_id: actor?.id },
      actor,
      'hr.letter.rejected',
    );
  }
  const next = letterRequiresMdApproval(row.letter_kind) ? 'gm_review' : 'approved';
  return patchLetterStatus(
    db,
    letterId,
    { status: next, hr_reviewed_at_iso: now, hr_reviewed_by_user_id: actor?.id },
    actor,
    'hr.letter.hr_reviewed',
  );
}

export function gmReviewLetter(db, actor, letterId, { approve, note } = {}) {
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  if (!['gm_review', 'approved'].includes(String(row.status)) && row.status !== 'hr_review') {
    /* allow gm from gm_review */
  }
  if (String(row.status) !== 'gm_review') {
    return { ok: false, error: 'Letter is not awaiting GM review.' };
  }
  const now = nowIso();
  if (!approve) {
    return patchLetterStatus(
      db,
      letterId,
      { status: 'rejected', rejection_reason: String(note || 'Rejected at GM review').trim(), gm_reviewed_at_iso: now, gm_reviewed_by_user_id: actor?.id },
      actor,
      'hr.letter.rejected',
    );
  }
  const next = letterRequiresMdApproval(row.letter_kind) ? 'md_review' : 'approved';
  return patchLetterStatus(
    db,
    letterId,
    { status: next, gm_reviewed_at_iso: now, gm_reviewed_by_user_id: actor?.id },
    actor,
    'hr.letter.gm_reviewed',
  );
}

export function mdApproveLetter(db, actor, letterId, { approve, note } = {}) {
  const row = db.prepare(`SELECT status FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  if (String(row.status) !== 'md_review') {
    return { ok: false, error: 'Letter is not awaiting MD approval.' };
  }
  const now = nowIso();
  if (!approve) {
    return patchLetterStatus(
      db,
      letterId,
      { status: 'rejected', rejection_reason: String(note || 'Rejected at MD approval').trim(), md_approved_at_iso: now, md_approved_by_user_id: actor?.id },
      actor,
      'hr.letter.rejected',
    );
  }
  return patchLetterStatus(
    db,
    letterId,
    { status: 'approved', md_approved_at_iso: now, md_approved_by_user_id: actor?.id },
    actor,
    'hr.letter.md_approved',
  );
}

export function issueLetter(db, actor, letterId) {
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  if (!['approved', 'draft'].includes(String(row.status)) && String(row.status) !== 'submitted') {
    /* strict: only approved */
  }
  if (String(row.status) !== 'approved' && !hrUserHas(actor, '*')) {
    if (String(row.status) !== 'approved') {
      return { ok: false, error: 'Letter must be approved before issue.' };
    }
  }
  const ref = row.reference_number || assignReferenceNumber(db, row.letter_kind);
  const now = nowIso();
  const r = patchLetterStatus(
    db,
    letterId,
    {
      status: 'issued',
      reference_number: ref,
      issued_at_iso: now,
      issued_by_user_id: actor?.id,
    },
    actor,
    'hr.letter.issued',
  );
  createHrNotification(db, {
    userId: row.user_id,
    kind: 'letter_issued',
    title: 'Official letter issued',
    body: `Your ${row.letter_kind} letter (${ref}) has been issued.`,
    routePath: '/my-profile/documents',
    entityKind: 'hr_employment_letter',
    entityId: letterId,
  });
  return r;
}

export function rejectLetter(db, actor, letterId, reason) {
  return patchLetterStatus(
    db,
    letterId,
    { status: 'rejected', rejection_reason: String(reason || 'Rejected').trim() },
    actor,
    'hr.letter.rejected',
  );
}

function notifyLetterPending(db, letterId, title) {
  try {
    const hrUsers = db.prepare(`SELECT id FROM app_users WHERE role_key IN ('hr_admin','gmhr','admin','md') LIMIT 20`).all();
    for (const u of hrUsers) {
      createHrNotification(db, {
        userId: u.id,
        kind: 'letter_pending',
        title,
        body: `Letter ${letterId} requires review.`,
        routePath: `/hr/documents?tab=letters&letterId=${encodeURIComponent(letterId)}`,
        entityKind: 'hr_employment_letter',
        entityId: letterId,
      });
    }
  } catch {
    /* optional */
  }
}

function watermarkLines(content) {
  return [DRAFT_WATERMARK, '—'.repeat(40), ...String(content || '').split(/\r?\n/)];
}

export function exportLetterPreviewPdf(db, letterId) {
  const letter = getEmploymentLetter(db, letterId);
  if (!letter) return { ok: false, error: 'Letter not found.' };
  const lines = watermarkLines(letter.contentText);
  const pdf = buildSimpleTextPdf([{ lines }]);
  return {
    ok: true,
    pdf,
    filename: `draft-${letter.letterKind}-${letter.id}.pdf`,
    contentType: 'application/pdf',
    watermarked: true,
  };
}

export function assertOfficialLetterExport(db, letterId, actor, actionKind) {
  const letter = getEmploymentLetter(db, letterId);
  if (!letter) return { ok: false, error: 'Letter not found.', code: 'NOT_FOUND' };
  const status = String(letter.status || 'issued');
  if (!OFFICIAL_STATUSES.has(status)) {
    appendHrAuditEvent(db, {
      actorUserId: actor?.id,
      action: `hr.letter.${actionKind}_blocked`,
      entityKind: 'hr_employment_letter',
      entityId: letterId,
      details: { status },
    });
    return {
      ok: false,
      error: 'This letter must be approved before it can be printed or downloaded.',
      code: 'LETTER_NOT_APPROVED',
      status,
    };
  }
  return { ok: true, letter };
}

export function exportOfficialLetterPdf(db, letterId, actor) {
  const gate = assertOfficialLetterExport(db, letterId, actor, 'pdf_download');
  if (!gate.ok) return gate;
  const letter = gate.letter;
  const header = letter.referenceNumber ? [`Reference: ${letter.referenceNumber}`, ''] : [];
  const lines = [...header, ...String(letter.contentText || '').split(/\r?\n/)];
  const pdf = buildSimpleTextPdf([{ lines }]);
  try {
    db.prepare(`UPDATE hr_employment_letters SET download_count = COALESCE(download_count,0) + 1 WHERE id = ?`).run(letterId);
  } catch {
    /* column optional */
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.pdf_download',
    entityKind: 'hr_employment_letter',
    entityId: letterId,
    details: { referenceNumber: letter.referenceNumber },
  });
  const kind = String(letter.letterKind || 'letter').replace(/[^\w-]+/g, '-');
  return {
    ok: true,
    pdf,
    filename: `${kind}-${letter.referenceNumber || letter.id}.pdf`,
    contentType: 'application/pdf',
  };
}

export function exportOfficialLetterDocx(db, letterId, actor) {
  const gate = assertOfficialLetterExport(db, letterId, actor, 'docx_download');
  if (!gate.ok) return gate;
  const letter = gate.letter;
  const refLine = letter.referenceNumber ? `<p><strong>Reference:</strong> ${letter.referenceNumber}</p>` : '';
  const bodyHtml = String(letter.contentText || '')
    .split(/\r?\n/)
    .map((line) => `<p style="margin:0 0 6pt 0;font-family:Calibri,Arial,sans-serif;font-size:11pt;">${line.replace(/</g, '&lt;') || '&nbsp;'}</p>`)
    .join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${letter.letterKind}</title></head>
<body>${refLine}${bodyHtml}</body></html>`;
  try {
    db.prepare(`UPDATE hr_employment_letters SET download_count = COALESCE(download_count,0) + 1 WHERE id = ?`).run(letterId);
  } catch {
    /* */
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.docx_download',
    entityKind: 'hr_employment_letter',
    entityId: letterId,
    details: { referenceNumber: letter.referenceNumber },
  });
  return {
    ok: true,
    body: Buffer.from(html, 'utf8'),
    filename: `${letter.letterKind}-${letter.referenceNumber || letter.id}.doc`,
    contentType: 'application/msword',
  };
}

export function recordLetterPrint(db, letterId, actor) {
  const gate = assertOfficialLetterExport(db, letterId, actor, 'print');
  if (!gate.ok) return gate;
  try {
    db.prepare(`UPDATE hr_employment_letters SET print_count = COALESCE(print_count,0) + 1 WHERE id = ?`).run(letterId);
  } catch {
    /* */
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.print',
    entityKind: 'hr_employment_letter',
    entityId: letterId,
  });
  return { ok: true };
}
