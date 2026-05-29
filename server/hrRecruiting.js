/**
 * HR recruiting — job postings and applicants.
 * @module server/hrRecruiting
 */

import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function hrRecruitingTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_job_postings'`).get());
  } catch {
    return false;
  }
}

const JOB_STATUSES = new Set(['draft', 'open', 'closed']);
const APPLICANT_STATUSES = new Set(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']);

export function listHrJobPostings(db, opts = {}) {
  if (!hrRecruitingTablesReady(db)) return [];
  const status = String(opts.status || '').trim();
  let sql = `SELECT id, title, branch_id AS branchId, department, description, status,
                    openings, created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso,
                    created_by_user_id AS createdByUserId
             FROM hr_job_postings`;
  const args = [];
  if (status && JOB_STATUSES.has(status)) {
    sql += ` WHERE status = ?`;
    args.push(status);
  }
  sql += ` ORDER BY updated_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args);
}

export function getHrJobPosting(db, jobId) {
  if (!hrRecruitingTablesReady(db)) return null;
  return (
    db
      .prepare(
        `SELECT id, title, branch_id AS branchId, department, description, status,
                openings, created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso
         FROM hr_job_postings WHERE id = ?`
      )
      .get(String(jobId || '').trim()) || null
  );
}

export function createHrJobPosting(db, actor, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const title = String(body.title || '').trim();
  if (title.length < 3) return { ok: false, error: 'title is required (min 3 characters).' };
  const status = JOB_STATUSES.has(String(body.status || '')) ? String(body.status) : 'draft';
  const id = newId('HRJOB');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_job_postings (
      id, title, branch_id, department, description, status, openings,
      created_at_iso, updated_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    title,
    String(body.branchId || '').trim() || null,
    String(body.department || '').trim() || null,
    String(body.description || '').trim() || null,
    status,
    Math.max(1, Math.round(Number(body.openings) || 1)),
    now,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function patchHrJobPosting(db, jobId, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const row = getHrJobPosting(db, jobId);
  if (!row) return { ok: false, error: 'Job not found.' };
  const status = body.status !== undefined ? String(body.status || '').trim() : row.status;
  if (!JOB_STATUSES.has(status)) return { ok: false, error: 'Invalid status.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_job_postings SET
      title = COALESCE(?, title),
      branch_id = COALESCE(?, branch_id),
      department = COALESCE(?, department),
      description = COALESCE(?, description),
      status = ?,
      openings = COALESCE(?, openings),
      updated_at_iso = ?
     WHERE id = ?`
  ).run(
    body.title !== undefined ? String(body.title || '').trim() || row.title : null,
    body.branchId !== undefined ? String(body.branchId || '').trim() || null : null,
    body.department !== undefined ? String(body.department || '').trim() || null : null,
    body.description !== undefined ? String(body.description || '').trim() || null : null,
    status,
    body.openings !== undefined ? Math.max(1, Math.round(Number(body.openings) || 1)) : null,
    now,
    row.id
  );
  return { ok: true, job: getHrJobPosting(db, jobId) };
}

export function listHrApplicants(db, jobId) {
  if (!hrRecruitingTablesReady(db)) return [];
  const jid = String(jobId || '').trim();
  let sql = `SELECT id, job_id AS jobId, full_name AS fullName, email, phone, status, notes,
                    applied_at_iso AS appliedAtIso, updated_at_iso AS updatedAtIso,
                    hired_user_id AS hiredUserId
             FROM hr_job_applicants`;
  const args = [];
  if (jid) {
    sql += ` WHERE job_id = ?`;
    args.push(jid);
  }
  sql += ` ORDER BY applied_at_iso DESC LIMIT 500`;
  return db.prepare(sql).all(...args);
}

export function createHrApplicant(db, actor, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const jobId = String(body.jobId || '').trim();
  if (!getHrJobPosting(db, jobId)) return { ok: false, error: 'Job not found.' };
  const fullName = String(body.fullName || '').trim();
  if (fullName.length < 2) return { ok: false, error: 'fullName is required.' };
  const id = newId('HRAPP');
  const now = nowIso();
  const status = APPLICANT_STATUSES.has(String(body.status || '')) ? String(body.status) : 'applied';
  db.prepare(
    `INSERT INTO hr_job_applicants (
      id, job_id, full_name, email, phone, status, notes, applied_at_iso, updated_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    jobId,
    fullName,
    String(body.email || '').trim() || null,
    String(body.phone || '').trim() || null,
    status,
    String(body.notes || '').trim() || null,
    now,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function patchHrApplicant(db, applicantId, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const id = String(applicantId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_job_applicants WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Applicant not found.' };
  const status = body.status !== undefined ? String(body.status || '').trim() : row.status;
  if (!APPLICANT_STATUSES.has(status)) return { ok: false, error: 'Invalid status.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_job_applicants SET
      full_name = COALESCE(?, full_name),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      status = ?,
      notes = COALESCE(?, notes),
      hired_user_id = COALESCE(?, hired_user_id),
      updated_at_iso = ?
     WHERE id = ?`
  ).run(
    body.fullName !== undefined ? String(body.fullName || '').trim() || row.full_name : null,
    body.email !== undefined ? String(body.email || '').trim() || null : null,
    body.phone !== undefined ? String(body.phone || '').trim() || null : null,
    status,
    body.notes !== undefined ? String(body.notes || '').trim() || null : null,
    body.hiredUserId !== undefined ? String(body.hiredUserId || '').trim() || null : null,
    now,
    id
  );
  return { ok: true };
}

/** Prefill for staff registration from applicant + job. */
export function getHrApplicantRegisterPrefill(db, applicantId) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const id = String(applicantId || '').trim();
  const row = db
    .prepare(
      `SELECT a.*, j.title AS jobTitle, j.branch_id AS branchId, j.department
       FROM hr_job_applicants a
       JOIN hr_job_postings j ON j.id = a.job_id
       WHERE a.id = ?`
    )
    .get(id);
  if (!row) return { ok: false, error: 'Applicant not found.' };
  const base = String(row.full_name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 24);
  return {
    ok: true,
    prefill: {
      applicantId: row.id,
      displayName: row.full_name,
      username: base || `hire.${row.id.slice(-6).toLowerCase()}`,
      email: row.email,
      phone: row.phone,
      branchId: row.branchId,
      jobTitle: row.jobTitle,
      department: row.department,
    },
  };
}
