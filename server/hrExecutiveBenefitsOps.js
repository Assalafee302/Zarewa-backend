/**
 * Phase 9 — executive benefits: scholarships, stipends, domestic staff, beneficiary payments.
 * Separate from normal employee payroll.
 * @module server/hrExecutiveBenefitsOps
 */

import crypto from 'node:crypto';
import {
  decryptBankAccount,
  encryptBankAccount,
  maskBankAccount,
  storedBankToMasked,
} from './hrBankCrypto.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { createHrNotification } from './hrNotifications.js';
import { hrUserHas } from './hrPermissions.js';

const PAYMENT_STATUSES = ['draft', 'submitted', 'finance_review', 'md_review', 'approved', 'exported', 'paid', 'rejected', 'cancelled'];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === typeof fallback ? v : fallback;
  } catch {
    return fallback;
  }
}

function csvEsc(v) {
  const t = String(v ?? '');
  if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

export function executiveBenefitsTablesReady(db) {
  return (
    hrTableExists(db, 'hr_executive_beneficiaries') &&
    hrTableExists(db, 'hr_executive_stipends') &&
    hrTableExists(db, 'hr_executive_payments') &&
    hrTableExists(db, 'hr_domestic_staff_profiles')
  );
}

export function userCanViewExecutiveBenefits(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    hrUserHas(user, 'hr.executive.benefits.view') ||
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.special_beneficiary.manage') ||
    hrUserHas(user, 'hr.executive.view')
  );
}

export function userCanManageExecutiveBenefits(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.special_beneficiary.manage') ||
    hrUserHas(user, 'hr.payroll.md_approve')
  );
}

export function userCanExportExecutiveBenefits(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    userCanManageExecutiveBenefits(user) ||
    hrUserHas(user, 'hr.payroll.export') ||
    hrUserHas(user, 'hr.executive.benefits.export')
  );
}

function mapBeneficiaryRow(row, { revealBank = false } = {}) {
  if (!row) return null;
  const bankAccountNo = row.bank_account_enc
    ? revealBank
      ? decryptBankAccount(row.bank_account_enc)
      : storedBankToMasked(row.bank_account_enc)
    : null;
  return {
    id: row.id,
    name: row.name,
    beneficiaryType: row.beneficiary_type,
    relationship: row.relationship,
    linkedExecutive: row.linked_executive,
    schoolName: row.school_name,
    notes: row.notes,
    status: row.status || 'active',
    bankName: row.bank_name,
    bankCode: row.bank_code,
    bankAccountName: row.bank_account_name,
    bankAccountNo,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

function mapSchoolFeeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    beneficiaryId: row.beneficiary_id,
    beneficiaryName: row.child_name || row.beneficiary_name,
    beneficiaryType: row.beneficiary_type,
    linkedExecutive: row.linked_executive,
    relationship: row.relationship,
    schoolName: row.school_name,
    classLevel: row.class_level,
    academicSession: row.academic_year || row.academic_session,
    term: row.term,
    feeType: row.fee_type,
    amountRequestedNgn: row.amount_requested_ngn ?? row.fee_amount_ngn,
    amountApprovedNgn: row.amount_approved_ngn,
    amountPaidNgn: row.amount_paid_ngn ?? 0,
    dueDateIso: row.due_date_iso,
    paymentStatus: row.workflow_status || row.payment_status || 'draft',
    approvalStatus: row.approval_status || row.payment_status,
    approvedByUserId: row.approved_by_user_id,
    paidByUserId: row.paid_by_user_id,
    paymentDateIso: row.payment_date_iso,
    documentRef: row.document_ref,
    notes: row.notes,
    paymentId: row.payment_id,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

function mapStipendRow(row, { revealBank = false } = {}) {
  if (!row) return null;
  const bankAccountNo = row.bank_account_enc
    ? revealBank
      ? decryptBankAccount(row.bank_account_enc)
      : storedBankToMasked(row.bank_account_enc)
    : null;
  return {
    id: row.id,
    beneficiaryId: row.beneficiary_id,
    beneficiaryName: row.beneficiary_name,
    beneficiaryType: row.beneficiary_type,
    linkedExecutive: row.linked_executive,
    monthlyAmountNgn: row.monthly_amount_ngn,
    startDateIso: row.start_date_iso,
    endDateIso: row.end_date_iso,
    paymentFrequency: row.payment_frequency || 'monthly',
    bankName: row.bank_name,
    bankCode: row.bank_code,
    bankAccountName: row.bank_account_name,
    bankAccountNo,
    narration: row.narration,
    status: row.status || 'active',
    approvalStatus: row.approval_status || 'draft',
    approvedByUserId: row.approved_by_user_id,
    lastPaidPeriod: row.last_paid_period,
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

function mapDomesticRow(row, { revealBank = false } = {}) {
  if (!row) return null;
  const bankAccountNo = row.bank_account_enc
    ? revealBank
      ? decryptBankAccount(row.bank_account_enc)
      : storedBankToMasked(row.bank_account_enc)
    : null;
  return {
    id: row.id,
    userId: row.user_id,
    staffName: row.staff_name,
    employeeNo: row.employee_no,
    designation: row.designation,
    assignedExecutive: row.assigned_executive,
    workLocation: row.work_location,
    employmentType: row.employment_type,
    dateJoinedIso: row.date_joined_iso,
    salaryAmountNgn: row.salary_amount_ngn,
    bankName: row.bank_name,
    bankCode: row.bank_code,
    bankAccountName: row.bank_account_name,
    bankAccountNo,
    emergencyContact: row.emergency_contact,
    nextOfKin: row.next_of_kin,
    status: row.status || 'active',
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

function mapPaymentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    paymentType: row.payment_type,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    payeeName: row.payee_name,
    amountNgn: row.amount_ngn,
    periodYyyymm: row.period_yyyymm,
    term: row.term,
    session: row.academic_session,
    bankName: row.bank_name,
    bankCode: row.bank_code,
    bankAccountName: row.bank_account_name,
    bankAccountMasked: row.bank_account_enc ? storedBankToMasked(row.bank_account_enc) : null,
    narration: row.narration,
    status: row.status || 'draft',
    requestedByUserId: row.requested_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    paidByUserId: row.paid_by_user_id,
    paidAtIso: row.paid_at_iso,
    documentRef: row.document_ref,
    proofRef: row.proof_ref,
    rejectionReason: row.rejection_reason,
    exportId: row.export_id,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

// ── Beneficiaries ─────────────────────────────────────────────

export function listExecutiveBeneficiaries(db, filters = {}) {
  if (!hrTableExists(db, 'hr_executive_beneficiaries')) return [];
  let sql = `SELECT * FROM hr_executive_beneficiaries WHERE 1=1`;
  const args = [];
  if (filters.linkedExecutive) {
    sql += ` AND linked_executive = ?`;
    args.push(filters.linkedExecutive);
  }
  if (filters.beneficiaryType) {
    sql += ` AND beneficiary_type = ?`;
    args.push(filters.beneficiaryType);
  }
  sql += ` ORDER BY name ASC`;
  return db.prepare(sql).all(...args).map((r) => mapBeneficiaryRow(r));
}

export function upsertExecutiveBeneficiary(db, actor, data = {}) {
  if (!hrTableExists(db, 'hr_executive_beneficiaries')) {
    return { ok: false, error: 'Executive benefits tables not initialised. Run db:migrate.' };
  }
  const id = String(data.id || newId('EXBEN')).trim();
  const now = nowIso();
  const bankEnc = data.bankAccountNo ? encryptBankAccount(String(data.bankAccountNo).trim()) : null;
  const existing = db.prepare(`SELECT id FROM hr_executive_beneficiaries WHERE id = ?`).get(id);
  if (existing) {
    db.prepare(
      `UPDATE hr_executive_beneficiaries SET name=?, beneficiary_type=?, relationship=?, linked_executive=?, school_name=?, notes=?, status=?, bank_name=?, bank_code=?, bank_account_name=?, bank_account_enc=COALESCE(?, bank_account_enc), updated_at_iso=? WHERE id=?`
    ).run(
      data.name,
      data.beneficiaryType,
      data.relationship,
      data.linkedExecutive,
      data.schoolName,
      data.notes,
      data.status || 'active',
      data.bankName,
      data.bankCode,
      data.bankAccountName,
      bankEnc,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO hr_executive_beneficiaries (id, name, beneficiary_type, relationship, linked_executive, school_name, notes, status, bank_name, bank_code, bank_account_name, bank_account_enc, created_at_iso, created_by_user_id, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      data.name,
      data.beneficiaryType,
      data.relationship,
      data.linkedExecutive,
      data.schoolName,
      data.notes,
      data.status || 'active',
      data.bankName,
      data.bankCode,
      data.bankAccountName,
      bankEnc,
      now,
      actor?.id,
      now,
    );
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: existing ? 'hr.executive_beneficiary.updated' : 'hr.executive_beneficiary.created',
    entityKind: 'hr_executive_beneficiary',
    entityId: id,
  });
  return { ok: true, beneficiary: mapBeneficiaryRow(db.prepare(`SELECT * FROM hr_executive_beneficiaries WHERE id = ?`).get(id)) };
}

// ── School fees ───────────────────────────────────────────────

export function listExecutiveSchoolFees(db, filters = {}) {
  if (!hrTableExists(db, 'hr_chairman_school_fees')) return [];
  let sql = `SELECT * FROM hr_chairman_school_fees WHERE 1=1`;
  const args = [];
  if (filters.linkedExecutive) {
    sql += ` AND linked_executive = ?`;
    args.push(filters.linkedExecutive);
  }
  if (filters.paymentStatus) {
    sql += ` AND COALESCE(workflow_status, payment_status) = ?`;
    args.push(filters.paymentStatus);
  }
  sql += ` ORDER BY COALESCE(due_date_iso, created_at_iso) DESC`;
  return db.prepare(sql).all(...args).map(mapSchoolFeeRow);
}

export function upsertExecutiveSchoolFee(db, actor, data = {}) {
  if (!hrTableExists(db, 'hr_chairman_school_fees')) {
    return { ok: false, error: 'School fees table not initialised.' };
  }
  const id = String(data.id || newId('EXSCH')).trim();
  const now = nowIso();
  const amountRequested = Math.round(Number(data.amountRequestedNgn ?? data.amountNgn ?? data.feeAmountNgn) || 0);
  const amountApproved = data.amountApprovedNgn != null ? Math.round(Number(data.amountApprovedNgn) || 0) : null;
  const amountPaid = Math.round(Number(data.amountPaidNgn ?? data.paid ?? 0) || 0);
  const workflowStatus = data.paymentStatus || data.workflowStatus || data.status || 'draft';
  const existing = db.prepare(`SELECT id FROM hr_chairman_school_fees WHERE id = ?`).get(id);
  const core = [
    data.beneficiaryName || data.childName,
    data.schoolName || data.school,
    data.term,
    data.academicSession || data.year || data.academicYear,
    amountRequested,
    data.feeType || 'tuition',
    workflowStatus,
    amountPaid,
    data.paymentDateIso,
    data.notes,
  ];
  const extended = [
    data.beneficiaryId,
    data.beneficiaryType,
    data.linkedExecutive,
    data.relationship,
    data.classLevel,
    data.academicSession || data.year,
    amountRequested,
    amountApproved,
    data.dueDateIso,
    data.approvalStatus || workflowStatus,
    data.approvedByUserId,
    data.paidByUserId,
    data.documentRef,
    workflowStatus,
    data.paymentId,
  ];
  if (existing) {
    db.prepare(
      `UPDATE hr_chairman_school_fees SET child_name=?, school_name=?, term=?, academic_year=?, fee_amount_ngn=?, fee_type=?, payment_status=?, amount_paid_ngn=?, payment_date_iso=?, notes=?,
       beneficiary_id=?, beneficiary_type=?, linked_executive=?, relationship=?, class_level=?, academic_session=?, amount_requested_ngn=?, amount_approved_ngn=?, due_date_iso=?, approval_status=?, approved_by_user_id=?, paid_by_user_id=?, document_ref=?, workflow_status=?, payment_id=?, updated_at_iso=? WHERE id=?`
    ).run(...core, ...extended, now, id);
  } else {
    db.prepare(
      `INSERT INTO hr_chairman_school_fees (id, child_name, school_name, term, academic_year, fee_amount_ngn, fee_type, payment_status, amount_paid_ngn, payment_date_iso, notes, beneficiary_id, beneficiary_type, linked_executive, relationship, class_level, academic_session, amount_requested_ngn, amount_approved_ngn, due_date_iso, approval_status, approved_by_user_id, paid_by_user_id, document_ref, workflow_status, payment_id, created_at_iso, created_by_user_id, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, ...core, ...extended, now, actor?.id, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: existing ? 'hr.executive_school_fee.updated' : 'hr.executive_school_fee.created',
    entityKind: 'hr_executive_school_fee',
    entityId: id,
  });
  return { ok: true, fee: mapSchoolFeeRow(db.prepare(`SELECT * FROM hr_chairman_school_fees WHERE id = ?`).get(id)) };
}

export function submitExecutiveSchoolFee(db, actor, feeId) {
  const row = db.prepare(`SELECT * FROM hr_chairman_school_fees WHERE id = ?`).get(feeId);
  if (!row) return { ok: false, error: 'School fee record not found.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_chairman_school_fees SET workflow_status='submitted', approval_status='submitted', updated_at_iso=? WHERE id=?`
  ).run(now, feeId);
  createExecutivePaymentFromSchoolFee(db, actor, row);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_school_fee.submitted',
    entityKind: 'hr_executive_school_fee',
    entityId: feeId,
  });
  createHrNotification(db, {
    userId: actor?.id,
    kind: 'executive_school_fee_pending',
    title: 'School fee pending approval',
    body: `${row.child_name || 'Beneficiary'} — ${row.school_name || 'school fee'}`,
    routePath: '/executive-hr/benefits?tab=school-fees',
    entityKind: 'hr_executive_school_fee',
    entityId: feeId,
  });
  return { ok: true, fee: mapSchoolFeeRow(db.prepare(`SELECT * FROM hr_chairman_school_fees WHERE id = ?`).get(feeId)) };
}

function createExecutivePaymentFromSchoolFee(db, actor, feeRow) {
  if (!hrTableExists(db, 'hr_executive_payments')) return null;
  const existing = db.prepare(`SELECT id FROM hr_executive_payments WHERE source_kind='school_fee' AND source_id=?`).get(feeRow.id);
  if (existing) return existing.id;
  const id = newId('EXPAY');
  const amount = Math.round(Number(feeRow.amount_approved_ngn ?? feeRow.amount_requested_ngn ?? feeRow.fee_amount_ngn) || 0);
  db.prepare(
    `INSERT INTO hr_executive_payments (id, payment_type, source_kind, source_id, payee_name, amount_ngn, term, academic_session, narration, status, requested_by_user_id, created_at_iso, updated_at_iso)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    'school_fee',
    'school_fee',
    feeRow.id,
    feeRow.child_name,
    amount,
    feeRow.term,
    feeRow.academic_year || feeRow.academic_session,
    `School fee — ${feeRow.school_name || ''}`.trim(),
    'submitted',
    actor?.id,
    nowIso(),
    nowIso(),
  );
  db.prepare(`UPDATE hr_chairman_school_fees SET payment_id=? WHERE id=?`).run(id, feeRow.id);
  return id;
}

export function deleteExecutiveSchoolFee(db, actor, feeId) {
  db.prepare(`DELETE FROM hr_chairman_school_fees WHERE id = ?`).run(feeId);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_school_fee.deleted',
    entityKind: 'hr_executive_school_fee',
    entityId: feeId,
  });
  return { ok: true };
}

// ── Stipends ──────────────────────────────────────────────────

export function listExecutiveStipends(db, filters = {}) {
  if (!hrTableExists(db, 'hr_executive_stipends')) return [];
  let sql = `SELECT * FROM hr_executive_stipends WHERE 1=1`;
  const args = [];
  if (filters.status) {
    sql += ` AND status = ?`;
    args.push(filters.status);
  }
  sql += ` ORDER BY beneficiary_name ASC`;
  return db.prepare(sql).all(...args).map((r) => mapStipendRow(r));
}

export function upsertExecutiveStipend(db, actor, data = {}, { revealBank = false } = {}) {
  if (!hrTableExists(db, 'hr_executive_stipends')) {
    return { ok: false, error: 'Stipends table not initialised.' };
  }
  const id = String(data.id || newId('EXSTP')).trim();
  const now = nowIso();
  const bankEnc = data.bankAccountNo ? encryptBankAccount(String(data.bankAccountNo).trim()) : null;
  const existing = db.prepare(`SELECT id FROM hr_executive_stipends WHERE id = ?`).get(id);
  const fields = [
    data.beneficiaryId,
    data.beneficiaryName,
    data.beneficiaryType,
    data.linkedExecutive,
    Math.round(Number(data.monthlyAmountNgn) || 0),
    data.startDateIso,
    data.endDateIso,
    data.paymentFrequency || 'monthly',
    data.bankName,
    data.bankCode,
    data.bankAccountName,
    bankEnc,
    data.narration,
    data.status || 'active',
    data.approvalStatus || 'draft',
    data.approvedByUserId,
    data.lastPaidPeriod,
    data.notes,
    now,
  ];
  if (existing) {
    db.prepare(
      `UPDATE hr_executive_stipends SET beneficiary_id=?, beneficiary_name=?, beneficiary_type=?, linked_executive=?, monthly_amount_ngn=?, start_date_iso=?, end_date_iso=?, payment_frequency=?, bank_name=?, bank_code=?, bank_account_name=?, bank_account_enc=COALESCE(?, bank_account_enc), narration=?, status=?, approval_status=?, approved_by_user_id=?, last_paid_period=?, notes=?, updated_at_iso=? WHERE id=?`
    ).run(...fields, id);
  } else {
    db.prepare(
      `INSERT INTO hr_executive_stipends (id, beneficiary_id, beneficiary_name, beneficiary_type, linked_executive, monthly_amount_ngn, start_date_iso, end_date_iso, payment_frequency, bank_name, bank_code, bank_account_name, bank_account_enc, narration, status, approval_status, approved_by_user_id, last_paid_period, notes, created_at_iso, created_by_user_id, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, ...fields, now, actor?.id, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: existing ? 'hr.executive_stipend.updated' : 'hr.executive_stipend.created',
    entityKind: 'hr_executive_stipend',
    entityId: id,
  });
  return {
    ok: true,
    stipend: mapStipendRow(db.prepare(`SELECT * FROM hr_executive_stipends WHERE id = ?`).get(id), { revealBank }),
  };
}

// ── Domestic staff ────────────────────────────────────────────

export function listDomesticStaffProfiles(db, filters = {}) {
  if (!hrTableExists(db, 'hr_domestic_staff_profiles')) return [];
  let sql = `SELECT * FROM hr_domestic_staff_profiles WHERE 1=1`;
  const args = [];
  if (filters.assignedExecutive) {
    sql += ` AND assigned_executive = ?`;
    args.push(filters.assignedExecutive);
  }
  if (filters.status) {
    sql += ` AND status = ?`;
    args.push(filters.status);
  }
  sql += ` ORDER BY staff_name ASC`;
  return db.prepare(sql).all(...args).map((r) => mapDomesticRow(r));
}

export function upsertDomesticStaffProfile(db, actor, data = {}) {
  if (!hrTableExists(db, 'hr_domestic_staff_profiles')) {
    return { ok: false, error: 'Domestic staff table not initialised.' };
  }
  const id = String(data.id || newId('DOMST')).trim();
  const now = nowIso();
  const bankEnc = data.bankAccountNo ? encryptBankAccount(String(data.bankAccountNo).trim()) : null;
  const existing = db.prepare(`SELECT id FROM hr_domestic_staff_profiles WHERE id = ?`).get(id);
  const fields = [
    data.userId,
    data.staffName,
    data.employeeNo,
    data.designation,
    data.assignedExecutive,
    data.workLocation,
    data.employmentType,
    data.dateJoinedIso,
    Math.round(Number(data.salaryAmountNgn) || 0),
    data.bankName,
    data.bankCode,
    data.bankAccountName,
    bankEnc,
    data.emergencyContact,
    data.nextOfKin,
    data.status || 'active',
    data.notes,
    now,
  ];
  if (existing) {
    db.prepare(
      `UPDATE hr_domestic_staff_profiles SET user_id=?, staff_name=?, employee_no=?, designation=?, assigned_executive=?, work_location=?, employment_type=?, date_joined_iso=?, salary_amount_ngn=?, bank_name=?, bank_code=?, bank_account_name=?, bank_account_enc=COALESCE(?, bank_account_enc), emergency_contact=?, next_of_kin=?, status=?, notes=?, updated_at_iso=? WHERE id=?`
    ).run(...fields, id);
  } else {
    db.prepare(
      `INSERT INTO hr_domestic_staff_profiles (id, user_id, staff_name, employee_no, designation, assigned_executive, work_location, employment_type, date_joined_iso, salary_amount_ngn, bank_name, bank_code, bank_account_name, bank_account_enc, emergency_contact, next_of_kin, status, notes, created_at_iso, created_by_user_id, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, ...fields, now, actor?.id, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: existing ? 'hr.domestic_staff.updated' : 'hr.domestic_staff.created',
    entityKind: 'hr_domestic_staff_profile',
    entityId: id,
  });
  return { ok: true, profile: mapDomesticRow(db.prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE id = ?`).get(id)) };
}

// ── Payments workflow ─────────────────────────────────────────

export function listExecutivePayments(db, filters = {}) {
  if (!hrTableExists(db, 'hr_executive_payments')) return [];
  let sql = `SELECT * FROM hr_executive_payments WHERE 1=1`;
  const args = [];
  if (filters.status) {
    sql += ` AND status = ?`;
    args.push(filters.status);
  }
  if (filters.paymentType) {
    sql += ` AND payment_type = ?`;
    args.push(filters.paymentType);
  }
  sql += ` ORDER BY created_at_iso DESC LIMIT 500`;
  return db.prepare(sql).all(...args).map(mapPaymentRow);
}

export function getExecutivePayment(db, paymentId) {
  const row = db.prepare(`SELECT * FROM hr_executive_payments WHERE id = ?`).get(paymentId);
  return mapPaymentRow(row);
}

export function approveExecutivePayment(db, actor, paymentId, { note } = {}) {
  const row = db.prepare(`SELECT * FROM hr_executive_payments WHERE id = ?`).get(paymentId);
  if (!row) return { ok: false, error: 'Payment not found.' };
  if (!['submitted', 'finance_review', 'md_review'].includes(String(row.status))) {
    return { ok: false, error: 'Payment is not pending approval.' };
  }
  const now = nowIso();
  db.prepare(
    `UPDATE hr_executive_payments SET status='approved', approved_by_user_id=?, updated_at_iso=? WHERE id=?`
  ).run(actor?.id, now, paymentId);
  if (row.source_kind === 'school_fee' && row.source_id) {
    db.prepare(
      `UPDATE hr_chairman_school_fees SET workflow_status='approved', approval_status='approved', approved_by_user_id=?, amount_approved_ngn=COALESCE(amount_approved_ngn, amount_requested_ngn, fee_amount_ngn) WHERE id=?`
    ).run(actor?.id, row.source_id);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_payment.approved',
    entityKind: 'hr_executive_payment',
    entityId: paymentId,
    details: { note },
  });
  return { ok: true, payment: getExecutivePayment(db, paymentId) };
}

export function rejectExecutivePayment(db, actor, paymentId, reason) {
  const row = db.prepare(`SELECT * FROM hr_executive_payments WHERE id = ?`).get(paymentId);
  if (!row) return { ok: false, error: 'Payment not found.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_executive_payments SET status='rejected', rejection_reason=?, updated_at_iso=? WHERE id=?`
  ).run(String(reason || 'Rejected').trim(), now, paymentId);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_payment.rejected',
    entityKind: 'hr_executive_payment',
    entityId: paymentId,
    details: { reason },
  });
  return { ok: true, payment: getExecutivePayment(db, paymentId) };
}

export function markExecutivePaymentPaid(db, actor, paymentId, { proofRef } = {}) {
  const row = db.prepare(`SELECT * FROM hr_executive_payments WHERE id = ?`).get(paymentId);
  if (!row) return { ok: false, error: 'Payment not found.' };
  if (String(row.status) !== 'approved' && String(row.status) !== 'exported') {
    return { ok: false, error: 'Payment must be approved before marking paid.' };
  }
  const now = nowIso();
  db.prepare(
    `UPDATE hr_executive_payments SET status='paid', paid_by_user_id=?, paid_at_iso=?, proof_ref=COALESCE(?, proof_ref), updated_at_iso=? WHERE id=?`
  ).run(actor?.id, now, proofRef || null, now, paymentId);
  if (row.source_kind === 'school_fee' && row.source_id) {
    db.prepare(
      `UPDATE hr_chairman_school_fees SET workflow_status='paid', payment_status='paid', amount_paid_ngn=?, payment_date_iso=?, paid_by_user_id=? WHERE id=?`
    ).run(row.amount_ngn, now.slice(0, 10), actor?.id, row.source_id);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_payment.paid',
    entityKind: 'hr_executive_payment',
    entityId: paymentId,
  });
  return { ok: true, payment: getExecutivePayment(db, paymentId) };
}

// ── Bank export ───────────────────────────────────────────────

export function buildExecutiveBeneficiaryBankExport(db, actor, { paymentIds = [], periodYyyymm, paymentType } = {}) {
  if (!hrTableExists(db, 'hr_executive_payments')) {
    return { ok: false, error: 'Payments table not initialised.' };
  }
  let payments = db
    .prepare(`SELECT * FROM hr_executive_payments WHERE status = 'approved' ORDER BY created_at_iso ASC`)
    .all();
  if (paymentIds?.length) {
    const set = new Set(paymentIds.map(String));
    payments = payments.filter((p) => set.has(p.id));
  }
  if (periodYyyymm) {
    payments = payments.filter((p) => String(p.period_yyyymm || '') === String(periodYyyymm));
  }
  if (paymentType) {
    payments = payments.filter((p) => String(p.payment_type) === String(paymentType));
  }
  const rows = [];
  const missing = [];
  for (const p of payments) {
    let accountNo = '';
    let receiverName = p.payee_name || '';
    let bankCode = p.bank_code || '';
    if (p.bank_account_enc) {
      accountNo = decryptBankAccount(p.bank_account_enc);
    } else if (p.source_kind === 'stipend') {
      const s = db.prepare(`SELECT * FROM hr_executive_stipends WHERE id = ?`).get(p.source_id);
      if (s?.bank_account_enc) {
        accountNo = decryptBankAccount(s.bank_account_enc);
        receiverName = s.bank_account_name || s.beneficiary_name;
        bankCode = s.bank_code || bankCode;
      }
    } else if (p.source_kind === 'domestic_staff') {
      const d = db.prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE id = ?`).get(p.source_id);
      if (d?.bank_account_enc) {
        accountNo = decryptBankAccount(d.bank_account_enc);
        receiverName = d.bank_account_name || d.staff_name;
        bankCode = d.bank_code || bankCode;
      }
    }
    if (!accountNo || accountNo.length < 10) {
      missing.push(p.payee_name || p.id);
      continue;
    }
    const narration = p.narration || `Beneficiary Stipend Payment Export ${periodYyyymm || ''}`.trim();
    rows.push([receiverName, accountNo, Math.round(Number(p.amount_ngn) || 0), narration, bankCode]);
  }
  if (!rows.length) {
    return { ok: false, error: 'No approved payments with valid bank details to export.', missing };
  }
  const headers = ['Receiver Name', 'Receiver Account No', 'Amount', 'Sender Narration', 'Bank Code'];
  const csv = [headers.join(','), ...rows.map((r) => r.map(csvEsc).join(','))].join('\r\n');
  const exportId = newId('EXEXP');
  if (hrTableExists(db, 'hr_executive_payment_exports')) {
    db.prepare(
      `INSERT INTO hr_executive_payment_exports (id, period_yyyymm, payment_type, row_count, total_ngn, exported_by_user_id, exported_at_iso, meta_json)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      exportId,
      periodYyyymm || null,
      paymentType || 'mixed',
      rows.length,
      rows.reduce((s, r) => s + Number(r[2] || 0), 0),
      actor?.id,
      nowIso(),
      JSON.stringify({ paymentIds: payments.map((p) => p.id) }),
    );
    for (const p of payments) {
      if (rows.some((r) => r[0] === (p.payee_name || ''))) {
        db.prepare(`UPDATE hr_executive_payments SET status='exported', export_id=?, updated_at_iso=? WHERE id=? AND status='approved'`).run(
          exportId,
          nowIso(),
          p.id,
        );
      }
    }
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.executive_payment.bank_export',
    entityKind: 'hr_executive_payment_export',
    entityId: exportId,
    details: { rowCount: rows.length, periodYyyymm, paymentType },
  });
  return {
    ok: true,
    csv,
    exportId,
    filename: `beneficiary-stipend-export-${periodYyyymm || 'batch'}.csv`,
    rowCount: rows.length,
    missing,
  };
}

// ── Dashboard summary ─────────────────────────────────────────

export function getExecutiveBenefitsDashboard(db) {
  const pendingSchoolFees = hrTableExists(db, 'hr_chairman_school_fees')
    ? db.prepare(`SELECT COUNT(*) AS c FROM hr_chairman_school_fees WHERE COALESCE(workflow_status, payment_status) IN ('submitted','draft')`).get()?.c || 0
    : 0;
  const activeStipends = hrTableExists(db, 'hr_executive_stipends')
    ? db.prepare(`SELECT COUNT(*) AS c FROM hr_executive_stipends WHERE status='active'`).get()?.c || 0
    : 0;
  const domesticCount = hrTableExists(db, 'hr_domestic_staff_profiles')
    ? db.prepare(`SELECT COUNT(*) AS c FROM hr_domestic_staff_profiles WHERE status='active'`).get()?.c || 0
    : 0;
  const pendingPayments = hrTableExists(db, 'hr_executive_payments')
    ? db.prepare(`SELECT COUNT(*) AS c FROM hr_executive_payments WHERE status IN ('submitted','finance_review','md_review')`).get()?.c || 0
    : 0;
  const approvedUnexported = hrTableExists(db, 'hr_executive_payments')
    ? db.prepare(`SELECT COUNT(*) AS c FROM hr_executive_payments WHERE status='approved'`).get()?.c || 0
    : 0;
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const schoolFeesPaidYear = hrTableExists(db, 'hr_chairman_school_fees')
    ? db
        .prepare(
          `SELECT COALESCE(SUM(amount_paid_ngn),0) AS t FROM hr_chairman_school_fees WHERE COALESCE(workflow_status, payment_status)='paid' AND payment_date_iso >= ?`
        )
        .get(yearStart)?.t || 0
    : 0;
  const period = new Date().toISOString().slice(0, 7).replace('-', '');
  const stipendsDueMonth = hrTableExists(db, 'hr_executive_stipends')
    ? db
        .prepare(`SELECT COALESCE(SUM(monthly_amount_ngn),0) AS t FROM hr_executive_stipends WHERE status='active'`)
        .get()?.t || 0
    : 0;
  return {
    pendingSchoolFees,
    activeStipends,
    domesticCount,
    pendingPayments,
    approvedUnexported,
    schoolFeesPaidYear: Math.round(Number(schoolFeesPaidYear) || 0),
    stipendsDueMonth: Math.round(Number(stipendsDueMonth) || 0),
    domesticPayrollTotal: hrTableExists(db, 'hr_domestic_staff_profiles')
      ? Math.round(
          Number(
            db.prepare(`SELECT COALESCE(SUM(salary_amount_ngn),0) AS t FROM hr_domestic_staff_profiles WHERE status='active'`).get()?.t || 0,
          ),
        )
      : 0,
    periodYyyymm: period,
  };
}

// Chairman expenses (legacy operational tab)
export function listChairmanExpensesMapped(db, periodYyyymm) {
  if (!hrTableExists(db, 'hr_chairman_expenses')) return [];
  const rows = periodYyyymm
    ? db.prepare(`SELECT * FROM hr_chairman_expenses WHERE period_yyyymm=? ORDER BY created_at_iso DESC`).all(periodYyyymm)
    : db.prepare(`SELECT * FROM hr_chairman_expenses ORDER BY created_at_iso DESC`).all();
  return rows.map((r) => ({
    id: r.id,
    expenseType: r.expense_type,
    description: r.description,
    amountNgn: r.amount_ngn,
    quantity: r.quantity,
    unit: r.unit,
    periodYyyymm: r.period_yyyymm,
    paymentStatus: r.payment_status,
    paymentDateIso: r.payment_date_iso,
    vendorName: r.vendor_name,
    notes: r.notes,
    createdAtIso: r.created_at_iso,
  }));
}

export function upsertChairmanExpenseMapped(db, actor, data = {}) {
  if (!hrTableExists(db, 'hr_chairman_expenses')) return { ok: false, error: 'Expenses table missing.' };
  const id = String(data.id || newId('CHEXP')).trim();
  const now = nowIso();
  const existing = db.prepare(`SELECT id FROM hr_chairman_expenses WHERE id=?`).get(id);
  const payload = [
    data.expenseType || data.type,
    data.description,
    Math.round(Number(data.amountNgn) || 0),
    data.quantity || 1,
    data.unit,
    data.periodYyyymm || data.period,
    data.paymentStatus || data.status,
    data.paymentDateIso,
    data.vendorName || data.vendor,
    data.notes,
  ];
  if (existing) {
    db.prepare(
      `UPDATE hr_chairman_expenses SET expense_type=?, description=?, amount_ngn=?, quantity=?, unit=?, period_yyyymm=?, payment_status=?, payment_date_iso=?, vendor_name=?, notes=? WHERE id=?`
    ).run(...payload, id);
  } else {
    db.prepare(
      `INSERT INTO hr_chairman_expenses (id, expense_type, description, amount_ngn, quantity, unit, period_yyyymm, payment_status, payment_date_iso, vendor_name, notes, created_at_iso, created_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, ...payload, now, actor?.id);
  }
  return { ok: true, expense: listChairmanExpensesMapped(db).find((e) => e.id === id) };
}

export function deleteChairmanExpenseMapped(db, id) {
  db.prepare(`DELETE FROM hr_chairman_expenses WHERE id=?`).run(id);
  return { ok: true };
}

export { PAYMENT_STATUSES };
