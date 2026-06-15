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

export const DEFAULT_INTERVIEW_CRITERIA = [
  { key: 'role_fit', label: 'Role fit' },
  { key: 'experience', label: 'Experience' },
  { key: 'communication', label: 'Communication' },
  { key: 'culture', label: 'Culture / values' },
  { key: 'overall', label: 'Overall recommendation' },
];

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

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
                    hired_user_id AS hiredUserId, interview_scores_json AS interviewScoresJson,
                    offer_letter_text AS offerLetterText
             FROM hr_job_applicants`;
  const args = [];
  if (jid) {
    sql += ` WHERE job_id = ?`;
    args.push(jid);
  }
  sql += ` ORDER BY applied_at_iso DESC LIMIT 500`;
  return db
    .prepare(sql)
    .all(...args)
    .map((r) => ({
      ...r,
      interviewScores: safeJsonParse(r.interviewScoresJson, null),
      interviewScoresJson: undefined,
    }));
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
  const scoresJson =
    body.interviewScores != null ? JSON.stringify(body.interviewScores) : body.interviewScores === null ? null : undefined;
  db.prepare(
    `UPDATE hr_job_applicants SET
      full_name = COALESCE(?, full_name),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      status = ?,
      notes = COALESCE(?, notes),
      hired_user_id = COALESCE(?, hired_user_id),
      interview_scores_json = COALESCE(?, interview_scores_json),
      offer_letter_text = COALESCE(?, offer_letter_text),
      updated_at_iso = ?
     WHERE id = ?`
  ).run(
    body.fullName !== undefined ? String(body.fullName || '').trim() || row.full_name : null,
    body.email !== undefined ? String(body.email || '').trim() || null : null,
    body.phone !== undefined ? String(body.phone || '').trim() || null : null,
    status,
    body.notes !== undefined ? String(body.notes || '').trim() || null : null,
    body.hiredUserId !== undefined ? String(body.hiredUserId || '').trim() || null : null,
    scoresJson !== undefined ? scoresJson : null,
    body.offerLetterText !== undefined ? String(body.offerLetterText || '').trim() || null : null,
    now,
    id
  );
  return { ok: true };
}

export function listPublicOpenJobs(db) {
  if (!hrRecruitingTablesReady(db)) return [];
  return listHrJobPostings(db, { status: 'open' }).map((j) => ({
    id: j.id,
    title: j.title,
    branchId: j.branchId,
    department: j.department,
    description: j.description,
    openings: j.openings,
  }));
}

const PUBLIC_APPLY_MAX_NOTES_LEN = 2000;
const PUBLIC_APPLY_MAX_EMAIL_LEN = 254;
const PUBLIC_APPLY_MAX_PHONE_LEN = 32;

function normalizePublicApplicantEmail(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length > PUBLIC_APPLY_MAX_EMAIL_LEN) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s.toLowerCase();
}

export function publicApplyToJob(db, jobId, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting not available.' };
  const job = getHrJobPosting(db, jobId);
  if (!job || job.status !== 'open') return { ok: false, error: 'This position is not open for applications.' };
  const emailRaw = body.email;
  if (emailRaw != null && String(emailRaw).trim()) {
    const email = normalizePublicApplicantEmail(emailRaw);
    if (!email) return { ok: false, error: 'Enter a valid email address.' };
  }
  const phone = String(body.phone ?? '').trim();
  if (phone.length > PUBLIC_APPLY_MAX_PHONE_LEN) {
    return { ok: false, error: 'Phone number is too long.' };
  }
  const notes = String(body.coverNote ?? body.notes ?? '').trim();
  if (notes.length > PUBLIC_APPLY_MAX_NOTES_LEN) {
    return { ok: false, error: `Cover note must be ${PUBLIC_APPLY_MAX_NOTES_LEN} characters or fewer.` };
  }
  return createHrApplicant(db, null, {
    jobId,
    fullName: body.fullName,
    email: body.email,
    phone: body.phone,
    notes,
    status: 'applied',
  });
}

export function generateOfferLetter(db, applicantId, actor = {}, body = {}) {
  if (!hrRecruitingTablesReady(db)) return { ok: false, error: 'Recruiting module not initialised.' };
  const id = String(applicantId || '').trim();
  const row = db
    .prepare(
      `SELECT a.*, j.title AS jobTitle, j.branch_id AS branchId, j.department
       FROM hr_job_applicants a JOIN hr_job_postings j ON j.id = a.job_id WHERE a.id = ?`
    )
    .get(id);
  if (!row) return { ok: false, error: 'Applicant not found.' };
  const company = 'Zarewa Aluminium and Plastics Ltd';
  const startDate = String(body.startDateIso || '').slice(0, 10) || 'to be confirmed';
  const salary = body.salaryNgn
    ? `NGN ${Math.round(Number(body.salaryNgn)).toLocaleString('en-NG')}`
    : 'as agreed with HR';
  const content = [
    company,
    '',
    `Date: ${nowIso().slice(0, 10)}`,
    '',
    `Dear ${row.full_name},`,
    '',
    `We are pleased to offer you the position of ${row.jobTitle}${row.department ? ` (${row.department})` : ''} at ${company}.`,
    '',
    `Proposed start date: ${startDate}`,
    `Monthly gross salary: ${salary}`,
    `Work location: ${row.branchId || 'as assigned'}`,
    '',
    `This offer is subject to satisfactory completion of onboarding requirements, including identity verification and required HR documents.`,
    '',
    `Please confirm your acceptance in writing to the Human Resources department.`,
    '',
    'Yours faithfully,',
    `${actor.displayName || actor.username || 'Human Resources'}`,
    'Human Resources (HQ)',
  ].join('\n');
  db.prepare(`UPDATE hr_job_applicants SET offer_letter_text = ?, updated_at_iso = ? WHERE id = ?`).run(content, nowIso(), id);
  return { ok: true, offerLetterText: content };
}

import { allowRateLimit, clientIp } from './rateLimit.js';

const careersApplyBuckets = new Map();
const careersListBuckets = new Map();

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerPublicCareersApi(app, db) {
  app.get('/api/public/careers/jobs', (req, res) => {
    try {
      const ip = clientIp(req);
      if (!allowRateLimit(careersListBuckets, ip, 120, 60 * 60 * 1000)) {
        return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
      }
      return res.json({ ok: true, jobs: listPublicOpenJobs(db) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load careers.' });
    }
  });

  app.post('/api/public/careers/jobs/:jobId/apply', (req, res) => {
    try {
      const ip = clientIp(req);
      const jobKey = String(req.params.jobId || '').trim();
      if (!allowRateLimit(careersApplyBuckets, `${ip}:${jobKey}`, 10, 60 * 60 * 1000)) {
        return res.status(429).json({ ok: false, error: 'Too many applications. Try again in an hour.' });
      }
      const r = publicApplyToJob(db, req.params.jobId, req.body || {});
      if (!r.ok) return res.status(400).json(r);
      return res.status(201).json(r);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Application failed.' });
    }
  });
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
