/**
 * Phase 7 — professional discipline case management.
 * @module server/hrDisciplineCasesOps
 */

import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createHrNotification } from './hrNotifications.js';
import { createDraftLetter, listEmploymentLettersByIds } from './hrLetterWorkflowOps.js';
import { notifyDisciplineAppealResolved } from './hrNotifications.js';
import { appendHrAuditEvent, hrTablesReady, listHrAuditEventsGlobal } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import {
  assertCaseClosureReady,
  syncRegistryFromDisciplineCase,
  finalizeLinkedIncidentsOnCaseClose,
  upsertCaseResponsibility,
  listCaseResponsibility,
  deleteCaseResponsibilityParty,
  validateHighRiskDisciplinePayload,
  normalizeDecisionType,
  DECISION_TYPES,
} from './hrAccountabilityOps.js';
import { createRecoverySchedulesFromCase } from './hrIncidentRecoveryOps.js';

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

export const DISCIPLINE_CASE_TYPES = [
  'query',
  'verbal_warning',
  'written_warning',
  'final_warning',
  'suspension',
  'investigation',
  'gross_misconduct',
  'negligence',
  'absenteeism',
  'lateness',
  'harassment_complaint',
  'insubordination',
  'theft_fraud',
  'property_damage',
  'confidentiality_breach',
  'policy_violation',
  'performance_misconduct',
  'dismissal_recommendation',
];

export const DISCIPLINE_CASE_STATUSES = [
  'draft',
  'open',
  'awaiting_employee_response',
  'under_investigation',
  'awaiting_hr_review',
  'awaiting_management_decision',
  'action_issued',
  'appealed',
  'closed',
  'cancelled',
];

export const DISCIPLINE_SEVERITIES = ['low', 'medium', 'high', 'critical'];

const LETTER_KIND_BY_CASE_TYPE = {
  query: 'query',
  verbal_warning: 'warning',
  written_warning: 'warning',
  final_warning: 'warning',
  suspension: 'suspension',
  dismissal_recommendation: 'dismissal',
  gross_misconduct: 'investigation_notice',
};

export function hrDisciplineCaseTablesReady(db) {
  return hrTableExists(db, 'hr_discipline_cases');
}

function nextCaseNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `HR-DIS-${year}-`;
  let max = 0;
  try {
    const rows = db
      .prepare(`SELECT case_number FROM hr_discipline_cases WHERE case_number LIKE ?`)
      .all(`${prefix}%`);
    for (const r of rows) {
      const n = Number(String(r.case_number || '').slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
  } catch {
    /* column may not exist pre-migration */
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`;
}

function loadStaffContext(db, userId) {
  const u = db.prepare(`SELECT id, display_name, username FROM app_users WHERE id = ?`).get(userId);
  if (!u) return null;
  const p = db.prepare(`SELECT branch_id, department, job_title, employee_no FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  return {
    userId: String(u.id),
    displayName: u.display_name || u.username,
    username: u.username,
    branchId: p?.branch_id || DEFAULT_BRANCH_ID,
    department: p?.department || '',
    designation: p?.job_title || '',
    employeeNo: p?.employee_no || '',
  };
}

function mapCaseRow(row, db) {
  if (!row) return null;
  const staff = loadStaffContext(db, row.user_id);
  return {
    id: row.id,
    caseNumber: row.case_number || null,
    userId: row.user_id,
    staffDisplayName: staff?.displayName || '',
    staffEmployeeNo: staff?.employeeNo || '',
    branchId: row.branch_id,
    department: row.department || staff?.department || '',
    designation: row.designation || staff?.designation || '',
    status: row.status,
    caseType: row.case_type || row.offence_category || 'query',
    severity: row.severity || 'medium',
    summary: row.summary || '',
    description: row.description || row.summary || '',
    incidentDateIso: row.incident_date_iso || null,
    reportedDateIso: row.reported_date_iso || row.opened_at_iso || null,
    reportedByUserId: row.reported_by_user_id || row.opened_by_user_id || null,
    employeeResponse: row.employee_response || null,
    investigationOfficerUserId: row.investigation_officer_user_id || null,
    investigationFindings: row.investigation_findings || null,
    hrRecommendation: row.hr_recommendation || null,
    managementDecision: row.management_decision || null,
    sanction: row.sanction || null,
    appealStatus: row.appeal_status || null,
    finalOutcome: row.final_outcome || null,
    closureDateIso: row.closure_date_iso || null,
    openedAtIso: row.opened_at_iso,
    openedByUserId: row.opened_by_user_id,
    relatedLetterIds: safeJsonParse(row.related_letter_ids_json, []),
    payrollBlockFlags: safeJsonParse(row.payroll_block_flags_json, {}),
    meta: safeJsonParse(row.meta_json, {}),
    registryId: row.registry_id ?? null,
    assetId: row.asset_id ?? null,
    machineId: row.machine_id ?? null,
    lossValueNgn: row.loss_value_ngn != null ? Math.round(Number(row.loss_value_ngn) || 0) : null,
    decisionType: row.decision_type ?? null,
  };
}

function notifyCaseStakeholders(db, caseRow, title, body, routePath, opts = {}) {
  const exclude = new Set((opts.excludeUserIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const targets = new Set();
  if (caseRow.user_id) targets.add(caseRow.user_id);
  if (caseRow.opened_by_user_id) targets.add(caseRow.opened_by_user_id);
  if (caseRow.investigation_officer_user_id) targets.add(caseRow.investigation_officer_user_id);
  for (const uid of targets) {
    if (exclude.has(uid)) continue;
    createHrNotification(db, {
      userId: uid,
      kind: 'discipline_case',
      title,
      body,
      routePath: routePath || `/hr/discipline-exit?tab=accountability&caseId=${caseRow.id}`,
      entityKind: 'hr_discipline_case',
      entityId: caseRow.id,
    });
  }
}

export function getDisciplineCaseDashboard(db, scope) {
  const cases = listDisciplineCases(db, scope, {});
  const byStatus = {};
  const bySeverity = {};
  for (const s of DISCIPLINE_CASE_STATUSES) byStatus[s] = 0;
  for (const s of DISCIPLINE_SEVERITIES) bySeverity[s] = 0;
  let openCount = 0;
  let pendingApproval = 0;
  for (const c of cases) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
    if (!['closed', 'cancelled'].includes(c.status)) openCount += 1;
    if (['awaiting_hr_review', 'awaiting_management_decision'].includes(c.status)) pendingApproval += 1;
  }
  return {
    total: cases.length,
    openCount,
    pendingApproval,
    byStatus,
    bySeverity,
  };
}

export function listDisciplineCases(db, scope, filters = {}) {
  if (!hrDisciplineCaseTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_discipline_cases WHERE 1=1`;
  const args = [];
  const subjectUserId = String(scope?.subjectUserId || filters.userId || '').trim();
  if (subjectUserId) {
    sql += ` AND user_id = ?`;
    args.push(subjectUserId);
  } else if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  if (filters.status) {
    sql += ` AND status = ?`;
    args.push(String(filters.status).trim());
  }
  if (filters.caseType) {
    sql += ` AND (case_type = ? OR offence_category = ?)`;
    args.push(String(filters.caseType).trim(), String(filters.caseType).trim());
  }
  if (filters.severity) {
    sql += ` AND severity = ?`;
    args.push(String(filters.severity).trim());
  }
  if (filters.fromIso) {
    sql += ` AND date(COALESCE(reported_date_iso, opened_at_iso)) >= date(?)`;
    args.push(String(filters.fromIso).slice(0, 10));
  }
  if (filters.toIso) {
    sql += ` AND date(COALESCE(reported_date_iso, opened_at_iso)) <= date(?)`;
    args.push(String(filters.toIso).slice(0, 10));
  }
  sql += ` ORDER BY opened_at_iso DESC LIMIT 500`;
  try {
    return db.prepare(sql).all(...args).map((r) => mapCaseRow(r, db));
  } catch {
    return [];
  }
}

export function getDisciplineCase(db, caseId) {
  if (!hrDisciplineCaseTablesReady(db)) return null;
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return null;
  const base = mapCaseRow(row, db);
  return {
    ...base,
    events: listDisciplineCaseEvents(db, caseId),
    evidence: listDisciplineCaseEvidence(db, caseId),
    witnesses: listDisciplineCaseWitnesses(db, caseId),
    appeals: listDisciplineCaseAppeals(db, caseId),
    relatedLetters: listEmploymentLettersByIds(db, base.relatedLetterIds),
  };
}

export function listDisciplineCaseEvents(db, caseId) {
  try {
    return db
      .prepare(
        `SELECT id, case_id AS caseId, event_kind AS eventKind, note, actor_user_id AS actorUserId, created_at_iso AS createdAtIso
         FROM hr_discipline_events WHERE case_id = ? ORDER BY created_at_iso ASC`
      )
      .all(String(caseId || '').trim());
  } catch {
    return [];
  }
}

export function listDisciplineCaseEvidence(db, caseId) {
  if (!hrTableExists(db, 'hr_discipline_case_evidence')) return [];
  try {
    return db
      .prepare(
        `SELECT id, case_id AS caseId, description, file_ref AS fileRef, document_id AS documentId,
                uploaded_by_user_id AS uploadedByUserId, created_at_iso AS createdAtIso
         FROM hr_discipline_case_evidence WHERE case_id = ? ORDER BY created_at_iso ASC`
      )
      .all(String(caseId || '').trim());
  } catch {
    return [];
  }
}

export function listDisciplineCaseWitnesses(db, caseId) {
  if (!hrTableExists(db, 'hr_discipline_case_witnesses')) return [];
  try {
    return db
      .prepare(
        `SELECT id, case_id AS caseId, witness_name AS witnessName, witness_role AS witnessRole,
                statement, contact, created_at_iso AS createdAtIso
         FROM hr_discipline_case_witnesses WHERE case_id = ? ORDER BY created_at_iso ASC`
      )
      .all(String(caseId || '').trim());
  } catch {
    return [];
  }
}

export function listDisciplineCaseAppeals(db, caseId) {
  if (!hrTableExists(db, 'hr_discipline_appeals')) return [];
  try {
    return db
      .prepare(
        `SELECT id, case_id AS caseId, grounds, status, outcome, filed_at_iso AS filedAtIso, decided_at_iso AS decidedAtIso
         FROM hr_discipline_appeals WHERE case_id = ? ORDER BY filed_at_iso DESC`
      )
      .all(String(caseId || '').trim());
  } catch {
    return [];
  }
}

export function createDisciplineCase(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body.userId || '').trim();
  const description = String(body.description || body.summary || '').trim();
  if (!userId || description.length < 10) {
    return { ok: false, error: 'Employee and description (min 10 chars) are required.' };
  }
  const riskCheck = validateHighRiskDisciplinePayload(body);
  if (!riskCheck.ok) return riskCheck;
  const staff = loadStaffContext(db, userId);
  if (!staff) return { ok: false, error: 'Employee not found.' };
  const id = newId('HRDIS');
  const now = nowIso();
  const caseNumber = nextCaseNumber(db);
  const caseType = String(body.caseType || body.offenceCategory || 'query').trim();
  const status = String(body.status || 'open').trim() || 'open';
  const severity = DISCIPLINE_SEVERITIES.includes(String(body.severity || '').trim())
    ? String(body.severity).trim()
    : 'medium';
  const row = {
    id,
    user_id: userId,
    branch_id: String(body.branchId || staff.branchId || DEFAULT_BRANCH_ID).trim(),
    status,
    offence_category: caseType,
    case_type: caseType,
    case_number: caseNumber,
    severity,
    summary: description.slice(0, 500),
    description,
    department: String(body.department || staff.department || '').trim() || null,
    designation: String(body.designation || staff.designation || '').trim() || null,
    incident_date_iso: String(body.incidentDateIso || '').slice(0, 10) || null,
    reported_date_iso: String(body.reportedDateIso || now).slice(0, 10),
    reported_by_user_id: String(body.reportedByUserId || actor?.id || '').trim() || null,
    opened_at_iso: now,
    opened_by_user_id: actor?.id || null,
    payroll_block_flags_json: JSON.stringify(body.payrollBlockFlags || {}),
    meta_json: JSON.stringify(body.meta || {}),
    loss_value_ngn:
      body.lossValueNgn != null ? Math.max(0, Math.round(Number(body.lossValueNgn) || 0)) : null,
    asset_id: String(body.assetId || '').trim() || null,
    machine_id: String(body.machineId || '').trim() || null,
    decision_type: String(body.decisionType || '').trim() || null,
  };
  try {
    db.prepare(
      `INSERT INTO hr_discipline_cases (
        id, user_id, branch_id, status, offence_category, summary, opened_at_iso, opened_by_user_id,
        case_number, case_type, severity, description, department, designation,
        incident_date_iso, reported_date_iso, reported_by_user_id, payroll_block_flags_json, meta_json,
        loss_value_ngn, asset_id, machine_id, decision_type
      ) VALUES (
        @id, @user_id, @branch_id, @status, @offence_category, @summary, @opened_at_iso, @opened_by_user_id,
        @case_number, @case_type, @severity, @description, @department, @designation,
        @incident_date_iso, @reported_date_iso, @reported_by_user_id, @payroll_block_flags_json, @meta_json,
        @loss_value_ngn, @asset_id, @machine_id, @decision_type
      )`
    ).run(row);
  } catch {
    try {
      db.prepare(
        `INSERT INTO hr_discipline_cases (id, user_id, branch_id, status, offence_category, summary, opened_at_iso, opened_by_user_id)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, userId, row.branch_id, status, caseType, row.summary, now, actor?.id || null);
    } catch (e2) {
      return { ok: false, error: String(e2.message || e2) };
    }
  }
  appendDisciplineCaseEvent(db, actor, id, {
    eventKind: 'case_opened',
    note: `Case ${caseNumber} opened — ${caseType.replace(/_/g, ' ')}.`,
  });
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.discipline.case_open',
    entityKind: 'hr_discipline_case',
    entityId: id,
    branchId: row.branch_id,
    details: { userId, caseNumber, caseType },
  });
  notifyCaseStakeholders(db, row, `Discipline case ${caseNumber}`, description.slice(0, 200));
  syncRegistryFromDisciplineCase(db, id);
  return { ok: true, id, caseNumber };
}

export function appendDisciplineCaseEvent(db, actor, caseId, body = {}) {
  if (!hrDisciplineCaseTablesReady(db)) return { ok: false, error: 'Discipline cases not initialised.' };
  const cid = String(caseId || '').trim();
  const eventKind = String(body.eventKind || 'note').trim();
  const note = String(body.note || '').trim();
  if (!cid || note.length < 2) return { ok: false, error: 'caseId and note are required.' };
  const id = newId('HRDISev');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_discipline_events (id, case_id, event_kind, note, actor_user_id, created_at_iso)
     VALUES (?,?,?,?,?,?)`
  ).run(id, cid, eventKind, note, actor?.id || null, now);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.discipline.event',
    entityKind: 'hr_discipline_case',
    entityId: cid,
    details: { eventKind },
  });
  return { ok: true, id };
}

export function patchDisciplineCase(db, actor, caseId, body = {}) {
  if (!hrDisciplineCaseTablesReady(db)) return { ok: false, error: 'Discipline cases not initialised.' };
  const cid = String(caseId || '').trim();
  const existing = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(cid);
  if (!existing) return { ok: false, error: 'Case not found.' };
  const action = String(body.action || '').trim();
  const now = nowIso();
  const updates = {};
  const notes = [];

  if (body.status && DISCIPLINE_CASE_STATUSES.includes(String(body.status))) {
    updates.status = String(body.status);
  }
  if (body.employeeResponse != null) {
    updates.employee_response = String(body.employeeResponse).trim();
    updates.status = 'awaiting_hr_review';
    notes.push('Employee response recorded.');
  }
  if (body.investigationFindings != null) {
    updates.investigation_findings = String(body.investigationFindings).trim();
    updates.status = 'awaiting_hr_review';
    notes.push('Investigation findings recorded.');
  }
  if (body.investigationOfficerUserId != null) {
    updates.investigation_officer_user_id = String(body.investigationOfficerUserId).trim() || null;
    updates.status = 'under_investigation';
    notes.push('Investigation officer assigned.');
  }
  if (body.hrRecommendation != null) {
    updates.hr_recommendation = String(body.hrRecommendation).trim();
    updates.status = 'awaiting_management_decision';
    notes.push('HR recommendation submitted.');
  }
  if (body.managementDecision != null) {
    updates.management_decision = String(body.managementDecision).trim();
    updates.status = 'action_issued';
    notes.push('Management decision recorded.');
  }
  if (body.decisionType != null) {
    const dt = normalizeDecisionType(body.decisionType);
    if (!DECISION_TYPES.has(dt)) return { ok: false, error: 'Invalid decision_type.' };
    updates.decision_type = dt;
  }
  if (body.assetId != null) updates.asset_id = String(body.assetId).trim() || null;
  if (body.machineId != null) updates.machine_id = String(body.machineId).trim() || null;
  if (body.lossValueNgn != null) updates.loss_value_ngn = Math.max(0, Math.round(Number(body.lossValueNgn) || 0));
  if (body.sanction != null) updates.sanction = String(body.sanction).trim();
  if (body.finalOutcome != null) updates.final_outcome = String(body.finalOutcome).trim();
  if (body.payrollBlockFlags != null) {
    updates.payroll_block_flags_json = JSON.stringify(body.payrollBlockFlags);
  }
  if (body.meta != null && typeof body.meta === 'object') {
    const prev = safeJsonParse(existing.meta_json, {});
    updates.meta_json = JSON.stringify({ ...prev, ...body.meta });
  }

  if (action === 'request_employee_response') {
    updates.status = 'awaiting_employee_response';
    notes.push('Employee response requested.');
  } else if (action === 'start_investigation') {
    updates.status = 'under_investigation';
    notes.push('Investigation started.');
  } else if (action === 'apply_decision') {
    const dt = normalizeDecisionType(body.decisionType || existing.decision_type || '');
    if (!DECISION_TYPES.has(dt)) return { ok: false, error: 'decisionType is required for apply_decision.' };
    const ar = applyDecisionActions(db, actor, cid, dt, body);
    if (!ar.ok) return ar;
    updates.status = 'action_issued';
    updates.decision_type = dt;
    notes.push(`Decision applied: ${dt}.`);
  } else if (action === 'close') {
    const gate = assertCaseClosureReady(db, cid);
    if (!gate.ok) return { ok: false, error: 'Case cannot be closed.', blockers: gate.blockers };
    updates.status = 'closed';
    updates.closure_date_iso = now.slice(0, 10);
    updates.final_outcome = updates.final_outcome || body.finalOutcome || existing.final_outcome || 'closed';
    notes.push('Case closed.');
  } else if (action === 'cancel') {
    updates.status = 'cancelled';
    notes.push('Case cancelled.');
  } else if (action === 'resolve_appeal') {
    const outcome = String(body.appealOutcome || '').trim();
    if (!['upheld', 'rejected'].includes(outcome)) {
      return { ok: false, error: 'appealOutcome must be upheld or rejected.' };
    }
    updates.appeal_status = outcome;
    updates.status = outcome === 'upheld' ? 'closed' : 'action_issued';
    updates.final_outcome =
      String(body.finalOutcome || '').trim() ||
      (outcome === 'upheld' ? 'Appeal upheld — case closed.' : 'Appeal rejected — original decision stands.');
    if (outcome === 'upheld') {
      updates.closure_date_iso = now.slice(0, 10);
    }
    if (hrTableExists(db, 'hr_discipline_appeals')) {
      db.prepare(
        `UPDATE hr_discipline_appeals SET status = ?, outcome = ?, decided_at_iso = ? WHERE case_id = ? AND status = 'pending'`
      ).run(outcome, String(body.appealNote || body.appealOutcome || outcome).trim(), now, cid);
    }
    notes.push(`Appeal ${outcome}.`);
  }

  const setParts = [];
  const args = [];
  for (const [col, val] of Object.entries(updates)) {
    setParts.push(`${col} = ?`);
    args.push(val);
  }
  if (!setParts.length) return { ok: false, error: 'No updates provided.' };
  args.push(cid);
  try {
    db.prepare(`UPDATE hr_discipline_cases SET ${setParts.join(', ')} WHERE id = ?`).run(...args);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  for (const n of notes) {
    appendDisciplineCaseEvent(db, actor, cid, { eventKind: action || 'update', note: n });
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.discipline.case_update',
    entityKind: 'hr_discipline_case',
    entityId: cid,
    details: { action, status: updates.status },
  });
  const refreshed = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(cid);
  if (action === 'resolve_appeal') {
    notifyDisciplineAppealResolved(db, refreshed, updates.appeal_status, updates.final_outcome);
    notifyCaseStakeholders(
      db,
      refreshed,
      `Appeal ${updates.appeal_status}`,
      notes.join(' ') || 'Appeal decision recorded.',
      undefined,
      { excludeUserIds: [refreshed.user_id] }
    );
  } else {
    notifyCaseStakeholders(
      db,
      refreshed,
      `Discipline case updated`,
      notes.join(' ') || 'Case status changed.'
    );
  }
  if (updates.status === 'closed' || updates.status === 'cancelled') {
    finalizeLinkedIncidentsOnCaseClose(db, cid, updates.status);
  }
  syncRegistryFromDisciplineCase(db, cid);
  return { ok: true, case: getDisciplineCase(db, cid) };
}

export function addDisciplineCaseEvidence(db, actor, caseId, body = {}) {
  if (!hrTableExists(db, 'hr_discipline_case_evidence')) {
    return { ok: false, error: 'Evidence module not initialised. Run db:migrate.' };
  }
  const cid = String(caseId || '').trim();
  const description = String(body.description || '').trim();
  if (!cid || description.length < 3) return { ok: false, error: 'Description is required.' };
  const id = newId('HRDISevd');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_discipline_case_evidence (id, case_id, description, file_ref, document_id, uploaded_by_user_id, created_at_iso)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    id,
    cid,
    description,
    String(body.fileRef || '').trim() || null,
    String(body.documentId || '').trim() || null,
    actor?.id || null,
    now,
  );
  appendDisciplineCaseEvent(db, actor, cid, { eventKind: 'evidence_added', note: `Evidence: ${description}` });
  return { ok: true, id };
}

export function addDisciplineCaseWitness(db, actor, caseId, body = {}) {
  if (!hrTableExists(db, 'hr_discipline_case_witnesses')) {
    return { ok: false, error: 'Witness module not initialised. Run db:migrate.' };
  }
  const cid = String(caseId || '').trim();
  const witnessName = String(body.witnessName || body.name || '').trim();
  if (!cid || witnessName.length < 2) return { ok: false, error: 'Witness name is required.' };
  const id = newId('HRDISwit');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_discipline_case_witnesses (id, case_id, witness_name, witness_role, statement, contact, created_at_iso)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    id,
    cid,
    witnessName,
    String(body.witnessRole || body.role || '').trim() || null,
    String(body.statement || '').trim() || null,
    String(body.contact || '').trim() || null,
    now,
  );
  appendDisciplineCaseEvent(db, actor, cid, { eventKind: 'witness_added', note: `Witness: ${witnessName}` });
  return { ok: true, id };
}

export function fileDisciplineCaseAppeal(db, actor, caseId, body = {}) {
  if (!hrTableExists(db, 'hr_discipline_appeals')) {
    return { ok: false, error: 'Appeals module not initialised. Run db:migrate.' };
  }
  const cid = String(caseId || '').trim();
  const grounds = String(body.grounds || '').trim();
  if (!cid || grounds.length < 10) return { ok: false, error: 'Appeal grounds (min 10 chars) required.' };
  const id = newId('HRDISapp');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_discipline_appeals (id, case_id, grounds, status, filed_at_iso)
     VALUES (?,?,?,?,?)`
  ).run(id, cid, grounds, 'pending', now);
  db.prepare(`UPDATE hr_discipline_cases SET status = 'appealed', appeal_status = 'pending' WHERE id = ?`).run(cid);
  appendDisciplineCaseEvent(db, actor, cid, { eventKind: 'appeal_filed', note: `Appeal filed: ${grounds.slice(0, 120)}` });
  return { ok: true, id };
}

export function generateDisciplineCaseLetter(db, actor, caseId, letterType, extra = {}) {
  const c = getDisciplineCase(db, caseId);
  if (!c) return { ok: false, error: 'Case not found.' };
  const letterKind = String(letterType || LETTER_KIND_BY_CASE_TYPE[c.caseType] || 'query').trim();
  const letterExtra = {
    ...extra,
    sourceRecordKind: 'hr_discipline_case',
    sourceRecordId: c.id,
    incidentDescription: c.description || c.summary,
    offenseDescription: c.description || c.summary,
    suspensionReason: c.sanction || c.description,
    terminationReason: c.finalOutcome || c.managementDecision || c.description,
    caseNumber: c.caseNumber,
    responseDeadline: extra.responseDeadline || '',
  };
  const r = createDraftLetter(db, actor, {
    userId: c.userId,
    letterKind,
    extra: letterExtra,
    sourceRecordKind: 'hr_discipline_case',
    sourceRecordId: c.id,
  });
  if (!r.ok) return r;
  try {
    const related = Array.isArray(c.relatedLetterIds) ? [...c.relatedLetterIds, r.id] : [r.id];
    db.prepare(`UPDATE hr_discipline_cases SET related_letter_ids_json = ? WHERE id = ?`).run(
      JSON.stringify(related),
      c.id,
    );
    appendDisciplineCaseEvent(db, actor, c.id, {
      eventKind: 'letter_generated',
      note: `${letterKind} letter generated (${r.id}).`,
    });
  } catch {
    /* column optional */
  }
  return r;
}

export function getDisciplineCaseAudit(db, caseId, limit = 100) {
  const cid = String(caseId || '').trim();
  const events = listDisciplineCaseEvents(db, cid);
  const audit = listHrAuditEventsGlobal(db, { viewAll: true }, { limit: 500 })
    .filter((e) => e.entityId === cid || e.details?.caseId === cid)
    .slice(0, limit);
  const responsibility = listCaseResponsibility(db, cid);
  return { events, audit, responsibility };
}

export function applyDecisionActions(db, actor, caseId, decisionType, extra = {}) {
  const dt = normalizeDecisionType(decisionType);
  if (!DECISION_TYPES.has(dt)) return { ok: false, error: 'Invalid decision_type.' };
  const c = getDisciplineCase(db, caseId);
  if (!c) return { ok: false, error: 'Case not found.' };

  const actions = [];
  try {
    db.transaction(() => {
      db.prepare(`UPDATE hr_discipline_cases SET decision_type = ? WHERE id = ?`).run(dt, c.id);

      if (dt === 'warning') {
        const lr = generateDisciplineCaseLetter(db, actor, c.id, 'warning', extra);
        if (!lr.ok) throw new Error(lr.error || 'Letter generation failed.');
        actions.push({ kind: 'letter', letterId: lr.id, letterType: 'warning' });
      } else if (dt === 'deduction') {
        const sr = createRecoverySchedulesFromCase(db, actor, c.id, { activate: true });
        if (!sr.ok) throw new Error(sr.error || 'Recovery schedule creation failed.');
        actions.push({ kind: 'recovery_schedules', schedules: sr.schedules });
        const parties = listCaseResponsibility(db, c.id);
        const scheduleByUser = new Map((sr.schedules || []).map((s) => [s.userId, s]));
        const relatedLetterIds = Array.isArray(c.relatedLetterIds) ? [...c.relatedLetterIds] : [];
        for (const p of parties) {
          const sched = scheduleByUser.get(p.userId);
          const lr = createDraftLetter(db, actor, {
            userId: p.userId,
            letterKind: 'salary_recovery',
            sourceRecordKind: 'hr_discipline_case',
            sourceRecordId: c.id,
            extra: {
              caseNumber: c.caseNumber,
              incidentDescription: c.description || c.summary,
              incidentDate: c.incidentDateIso,
              offenseDescription: extra.sanction || c.sanction || c.description,
              sanction: extra.sanction || c.sanction,
              responsibilityRole: p.role,
              responsibilityWeight: p.responsibilityWeight,
              recoveryTotalNgn: sched?.totalAmountNgn,
              installmentAmountNgn: sched?.installmentAmountNgn,
              durationMonths: sched?.durationMonths,
              assetId: c.assetId,
            },
          });
          if (!lr.ok) throw new Error(lr.error || `Recovery letter failed for ${p.userId}.`);
          relatedLetterIds.push(lr.id);
          appendDisciplineCaseEvent(db, actor, c.id, {
            eventKind: 'letter_generated',
            note: `Salary recovery letter generated for ${p.staffDisplayName || p.userId} (${p.role}, ${p.responsibilityWeight}%) — ${lr.id}.`,
          });
          actions.push({ kind: 'letter', letterId: lr.id, letterType: 'salary_recovery', userId: p.userId });
        }
        if (relatedLetterIds.length) {
          db.prepare(`UPDATE hr_discipline_cases SET related_letter_ids_json = ? WHERE id = ?`).run(
            JSON.stringify(relatedLetterIds),
            c.id
          );
        }
      } else if (dt === 'suspension') {
        const lr = generateDisciplineCaseLetter(db, actor, c.id, 'suspension', extra);
        if (!lr.ok) throw new Error(lr.error || 'Suspension letter failed.');
        const prof = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(c.userId);
        const extraProf = safeJsonParse(prof?.profile_extra_json, {});
        extraProf.employmentMeta = {
          ...(extraProf.employmentMeta || {}),
          salaryStatus: 'suspended',
          payrollHoldReason: `Discipline case ${c.caseNumber || c.id}`,
        };
        db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ? WHERE user_id = ?`).run(
          JSON.stringify(extraProf),
          c.userId
        );
        actions.push({ kind: 'letter', letterId: lr.id, letterType: 'suspension' });
        actions.push({ kind: 'salary_hold', userId: c.userId });
      } else if (dt === 'termination') {
        const lr = generateDisciplineCaseLetter(db, actor, c.id, 'dismissal', extra);
        if (!lr.ok) throw new Error(lr.error || 'Dismissal letter failed.');
        actions.push({ kind: 'letter', letterId: lr.id, letterType: 'dismissal' });
      }

      syncRegistryFromDisciplineCase(db, c.id);
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.discipline.decision_applied',
    entityKind: 'hr_discipline_case',
    entityId: c.id,
    details: { decisionType: dt, actions },
  });
  return { ok: true, decisionType: dt, actions };
}

export {
  upsertCaseResponsibility,
  listCaseResponsibility,
  deleteCaseResponsibilityParty,
  assertCaseClosureReady,
  validateHighRiskDisciplinePayload,
  normalizeDecisionType,
  DECISION_TYPES,
} from './hrAccountabilityOps.js';

export function staffHasOpenDisciplineCase(db, userId) {
  const rows = listDisciplineCases(db, { viewAll: true }, { userId });
  return rows.some((c) => !['closed', 'cancelled'].includes(c.status));
}

export function staffDisciplinePayrollBlocks(db, userId) {
  const rows = listDisciplineCases(db, { viewAll: true }, { userId });
  const blocks = { promotionBlocked: false, salaryChangeBlocked: false, reasons: [] };
  for (const c of rows) {
    if (['closed', 'cancelled'].includes(c.status)) continue;
    const flags = c.payrollBlockFlags || {};
    if (flags.promotionBlocked) {
      blocks.promotionBlocked = true;
      blocks.reasons.push(`Case ${c.caseNumber || c.id}: promotion hold`);
    }
    if (flags.salaryChangeBlocked) {
      blocks.salaryChangeBlocked = true;
      blocks.reasons.push(`Case ${c.caseNumber || c.id}: salary change hold`);
    }
    if (['suspension', 'final_warning', 'dismissal_recommendation'].includes(c.caseType)) {
      blocks.promotionBlocked = true;
      blocks.reasons.push(`Case ${c.caseNumber || c.id}: active ${c.caseType}`);
    }
  }
  return blocks;
}
