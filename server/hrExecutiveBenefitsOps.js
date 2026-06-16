/**
 * Phase 9 — executive benefits: scholarships, stipends, domestic staff, beneficiary payments.
 * Separate from normal employee payroll.
 * @module server/hrExecutiveBenefitsOps
 */

import crypto from 'node:crypto';
import {
  decryptBankAccount,
  encryptBankAccount,
  storedBankToMasked,
} from './hrBankCrypto.js';
import { appendHrAuditEvent } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { createHrNotification, notifyScholarshipPaymentApproved, notifyScholarshipPaymentPaid } from './hrNotifications.js';
import { hrUserHas } from './hrPermissions.js';
import {
  isDomesticStaff,
  isScholarshipBeneficiary,
  normalizePayrollGroup,
  usesExecutiveBenefitsMonthlyPay,
} from '../shared/lib/hrStaffCohorts.js';

const PAYMENT_STATUSES = ['draft', 'submitted', 'finance_review', 'md_review', 'approved', 'exported', 'paid', 'rejected', 'cancelled'];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
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

/**
 * Link HR employee file to executive-benefits monthly pay (stipend or domestic salary).
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string; displayName?: string; payrollGroup?: string; profileExtra?: object }} staff
 */
export function getExecutiveBenefitsPayrollForStaff(db, staff) {
  if (!staff?.userId && !staff?.displayName) return null;
  const pg = normalizePayrollGroup(staff.payrollGroup);
  if (!usesExecutiveBenefitsMonthlyPay(pg)) return null;

  if (isScholarshipBeneficiary(pg)) {
    const managePath = '/executive-hr/benefits?tab=stipends';
    if (!hrTableExists(db, 'hr_executive_stipends')) {
      return {
        payChannel: 'executive_stipend',
        linked: false,
        managePath,
        label: 'Monthly allowance (Executive benefits)',
        note: 'Executive family beneficiaries are paid through Executive benefits → Monthly allowances, not branch payroll.',
      };
    }
    const extra = staff.profileExtra && typeof staff.profileExtra === 'object' ? staff.profileExtra : {};
    const beneficiaryId = String(extra?.schoolProfile?.beneficiaryId || '').trim();
    const name = String(staff.displayName || '').trim();
    let row = null;
    if (beneficiaryId) {
      row = db
        .prepare(
          `SELECT * FROM hr_executive_stipends WHERE beneficiary_id = ? ORDER BY updated_at_iso DESC LIMIT 1`
        )
        .get(beneficiaryId);
    }
    if (!row && name) {
      row = db
        .prepare(
          `SELECT * FROM hr_executive_stipends WHERE beneficiary_name = ? ORDER BY updated_at_iso DESC LIMIT 1`
        )
        .get(name);
    }
    const stipend = row ? mapStipendRow(row) : null;
    return {
      payChannel: 'executive_stipend',
      linked: Boolean(stipend && stipend.status === 'active'),
      managePath,
      label: 'Monthly allowance (Executive benefits)',
      note: 'This register is the personnel file. Monthly pay is the allowance in Executive benefits.',
      monthlyAmountNgn: stipend?.monthlyAmountNgn ?? null,
      lastPaidPeriod: stipend?.lastPaidPeriod ?? null,
      paymentFrequency: stipend?.paymentFrequency ?? 'monthly',
      stipendId: stipend?.id ?? null,
      status: stipend?.status ?? null,
    };
  }

  if (isDomesticStaff(pg)) {
    const managePath = '/executive-hr/benefits?tab=domestic';
    if (!hrTableExists(db, 'hr_domestic_staff_profiles')) {
      return {
        payChannel: 'executive_domestic',
        linked: false,
        managePath,
        label: 'Monthly salary (Executive benefits)',
        note: 'Household staff are paid through Executive benefits → Household staff, not branch payroll.',
      };
    }
    const uid = String(staff.userId || '').trim();
    let row = uid
      ? db.prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE user_id = ? ORDER BY updated_at_iso DESC LIMIT 1`).get(uid)
      : null;
    if (!row && staff.displayName) {
      row = db
        .prepare(
          `SELECT * FROM hr_domestic_staff_profiles WHERE staff_name = ? ORDER BY updated_at_iso DESC LIMIT 1`
        )
        .get(String(staff.displayName).trim());
    }
    const domestic = row ? mapDomesticRow(row) : null;
    return {
      payChannel: 'executive_domestic',
      linked: Boolean(domestic && domestic.status === 'active'),
      managePath,
      label: 'Monthly salary (Executive benefits)',
      note: 'This register is the personnel file. Monthly pay is managed in Executive benefits household staff.',
      monthlyAmountNgn: domestic?.salaryAmountNgn ?? null,
      domesticProfileId: domestic?.id ?? null,
      assignedExecutive: domestic?.assignedExecutive ?? null,
      status: domestic?.status ?? null,
    };
  }

  return null;
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
  notifyScholarshipPaymentApproved(db, row);
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
  notifyScholarshipPaymentPaid(db, row);
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

function safeJsonParse(raw, fallback = {}) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function currentPeriodYyyymm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function daysUntilIso(iso) {
  const d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const end = new Date(`${d}T12:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function executiveDisplayLabel(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'chairman' || v.includes('chairman')) return 'Chairman';
  if (v === 'ceo' || v.includes('chief executive')) return 'Chief Executive Officer';
  if (v === 'md' || v.includes('managing director')) return 'Managing Director';
  return String(raw).replace(/_/g, ' ');
}

function familyBeneficiaryTypeLabel(raw) {
  const v = String(raw || '').trim().toLowerCase();
  const map = {
    chairman_child: "Chairman's child",
    ceo_child: "CEO's child",
    director_child: "Director's child",
    sponsored_student: 'Executive family',
  };
  return map[v] || (v ? String(raw).replace(/_/g, ' ') : null);
}

function linkedExecutiveMatchesFilter(linkedExecutive, filter) {
  if (!filter) return true;
  const le = String(linkedExecutive || '').trim().toLowerCase();
  const lf = String(filter).trim().toLowerCase();
  if (!le) return false;
  return le === lf || le.includes(lf) || lf.includes(le);
}

/** @param {import('better-sqlite3').Database} db @param {string} displayName @param {object} [schoolProfile] */
function resolveFamilyBeneficiaryLink(db, displayName, schoolProfile = {}) {
  const bid = String(schoolProfile?.beneficiaryId || '').trim();
  let linkedExecutive = schoolProfile?.linkedExecutive || null;
  let beneficiaryType = schoolProfile?.beneficiaryType || null;
  let beneficiaryId = bid || null;

  if (hrTableExists(db, 'hr_executive_beneficiaries')) {
    let row = bid ? db.prepare(`SELECT * FROM hr_executive_beneficiaries WHERE id = ?`).get(bid) : null;
    if (!row && displayName) {
      row = db
        .prepare(
          `SELECT * FROM hr_executive_beneficiaries WHERE name = ? ORDER BY updated_at_iso DESC LIMIT 1`
        )
        .get(displayName);
    }
    if (row) {
      beneficiaryId = row.id;
      linkedExecutive = row.linked_executive || linkedExecutive;
      beneficiaryType = row.beneficiary_type || beneficiaryType;
    }
  }

  if (!linkedExecutive && hrTableExists(db, 'hr_executive_stipends') && displayName) {
    const stip = db
      .prepare(
        `SELECT linked_executive, beneficiary_type, beneficiary_id FROM hr_executive_stipends
         WHERE beneficiary_name = ? OR beneficiary_id = ?
         ORDER BY updated_at_iso DESC LIMIT 1`
      )
      .get(displayName, bid);
    if (stip) {
      linkedExecutive = stip.linked_executive || linkedExecutive;
      beneficiaryType = stip.beneficiary_type || beneficiaryType;
      beneficiaryId = stip.beneficiary_id || beneficiaryId;
    }
  }

  return {
    beneficiaryId,
    linkedExecutive,
    linkedExecutiveLabel: executiveDisplayLabel(linkedExecutive),
    beneficiaryType,
    beneficiaryTypeLabel: familyBeneficiaryTypeLabel(beneficiaryType),
  };
}

function familyFeeStatusLabel(status) {
  const s = String(status || 'draft').toLowerCase();
  const map = {
    draft: 'Being prepared',
    submitted: 'Submitted',
    approved: 'Approved',
    paid: 'Paid',
    rejected: 'Not approved',
    cancelled: 'Cancelled',
  };
  return map[s] || s.replace(/_/g, ' ');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} input
 */
function buildExecutiveFamilyChildRow(db, input) {
  const {
    userId,
    displayName,
    employeeNo,
    school = {},
    familyLink,
    currentPeriod,
    beneficiaryOnly = false,
  } = input;
  const name = String(displayName || '').trim();
  const beneficiaryId = familyLink?.beneficiaryId || school?.beneficiaryId || null;

  let stipend = null;
  if (hrTableExists(db, 'hr_executive_stipends')) {
    let row = beneficiaryId
      ? db
          .prepare(
            `SELECT * FROM hr_executive_stipends WHERE beneficiary_id = ? ORDER BY updated_at_iso DESC LIMIT 1`
          )
          .get(beneficiaryId)
      : null;
    if (!row && name) {
      row = db
        .prepare(
          `SELECT * FROM hr_executive_stipends WHERE beneficiary_name = ? ORDER BY updated_at_iso DESC LIMIT 1`
        )
        .get(name);
    }
    stipend = row ? mapStipendRow(row) : null;
  }

  /** @type {object[]} */
  let feeRows = [];
  if (hrTableExists(db, 'hr_chairman_school_fees')) {
    if (beneficiaryId) {
      feeRows = db
        .prepare(
          `SELECT * FROM hr_chairman_school_fees WHERE beneficiary_id = ? ORDER BY COALESCE(due_date_iso, created_at_iso) DESC LIMIT 12`
        )
        .all(beneficiaryId);
    }
    if (!feeRows.length && name) {
      feeRows = db
        .prepare(
          `SELECT * FROM hr_chairman_school_fees WHERE child_name = ? ORDER BY COALESCE(due_date_iso, created_at_iso) DESC LIMIT 12`
        )
        .all(name);
    }
  }
  const fees = feeRows.map(mapSchoolFeeRow);
  const pendingFee = fees.find((f) => !['paid', 'cancelled', 'rejected'].includes(String(f.paymentStatus || '').toLowerCase())) || null;
  const lastPaidFee = fees.find((f) => String(f.paymentStatus || '').toLowerCase() === 'paid') || null;

  let pendingRequestsCount = 0;
  if (userId && hrTableExists(db, 'hr_requests')) {
    pendingRequestsCount =
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM hr_requests
           WHERE user_id = ? AND kind IN ('scholarship_profile_update', 'scholarship_fee_request')
             AND lower(status) NOT IN ('approved', 'rejected', 'cancelled')`
        )
        .get(userId)?.c || 0;
  }

  const paidThisMonth = Boolean(
    stipend?.lastPaidPeriod && String(stipend.lastPaidPeriod) === currentPeriod
  );
  const allowanceActive = stipend?.status === 'active';

  let paymentHealth = 'on_track';
  if (!beneficiaryId || !allowanceActive) paymentHealth = 'setup_incomplete';
  else if (pendingFee?.dueDateIso && daysUntilIso(pendingFee.dueDateIso) < 0) paymentHealth = 'overdue';
  else if (pendingFee || pendingRequestsCount > 0 || !paidThisMonth) paymentHealth = 'action_needed';

  return {
    userId: userId || null,
    displayName: name,
    employeeNo: employeeNo || null,
    beneficiaryId,
    beneficiaryOnly,
    hasLogin: Boolean(userId),
    schoolName: school.schoolName || pendingFee?.schoolName || lastPaidFee?.schoolName || null,
    classLevel: school.classLevel || pendingFee?.classLevel || null,
    academicSession: school.academicSession || pendingFee?.academicSession || lastPaidFee?.academicSession || null,
    currentTerm: school.currentTerm || pendingFee?.term || null,
    termEndIso: school.termEndIso || pendingFee?.dueDateIso || null,
    linkedExecutive: familyLink?.linkedExecutive || null,
    linkedExecutiveLabel: familyLink?.linkedExecutiveLabel || null,
    beneficiaryTypeLabel: familyLink?.beneficiaryTypeLabel || null,
    allowance: stipend
      ? {
          monthlyAmountNgn: stipend.monthlyAmountNgn,
          lastPaidPeriod: stipend.lastPaidPeriod,
          status: stipend.status,
          paidThisMonth,
          statusLabel: paidThisMonth ? 'Paid this month' : allowanceActive ? 'Due this month' : String(stipend.status || 'inactive'),
        }
      : null,
    schoolFees: {
      pending: pendingFee
        ? {
            id: pendingFee.id,
            term: pendingFee.term,
            academicSession: pendingFee.academicSession,
            amountNgn: pendingFee.amountRequestedNgn ?? pendingFee.amountApprovedNgn,
            dueDateIso: pendingFee.dueDateIso,
            status: pendingFee.paymentStatus,
            statusLabel: familyFeeStatusLabel(pendingFee.paymentStatus),
          }
        : null,
      lastPaid: lastPaidFee
        ? {
            term: lastPaidFee.term,
            academicSession: lastPaidFee.academicSession,
            amountNgn: lastPaidFee.amountPaidNgn ?? lastPaidFee.amountRequestedNgn,
            paidAtIso: lastPaidFee.paymentDateIso,
          }
        : null,
    },
    pendingRequestsCount,
    paymentHealth,
    staffProfilePath: userId ? `/hr/employees/${encodeURIComponent(userId)}` : null,
  };
}

/**
 * CEO / Chairman overview — all executive-family children with allowance and school fee status.
 * @param {import('better-sqlite3').Database} db
 * @param {{ linkedExecutive?: string }} [filters]
 */
export function getExecutiveFamilyDashboard(db, filters = {}) {
  const linkedFilter = String(filters.linkedExecutive || '').trim();
  const currentPeriod = currentPeriodYyyymm();
  /** @type {Map<string, object>} */
  const byKey = new Map();

  if (hrTableExists(db, 'hr_staff_profiles') && hrTableExists(db, 'users')) {
    const staffRows = db
      .prepare(
        `SELECT p.user_id AS userId, u.display_name AS displayName, p.employee_no AS employeeNo,
                p.profile_extra_json AS profileExtraJson
         FROM hr_staff_profiles p
         JOIN app_users u ON u.id = p.user_id
         WHERE p.payroll_group = 'scholarship'
         ORDER BY u.display_name ASC`
      )
      .all();
    for (const row of staffRows) {
      const extra = safeJsonParse(row.profileExtraJson, {});
      const school = extra.schoolProfile && typeof extra.schoolProfile === 'object' ? extra.schoolProfile : {};
      const familyLink = resolveFamilyBeneficiaryLink(db, row.displayName, school);
      if (!linkedExecutiveMatchesFilter(familyLink.linkedExecutive, linkedFilter)) continue;
      byKey.set(String(row.userId), buildExecutiveFamilyChildRow(db, {
        userId: row.userId,
        displayName: row.displayName,
        employeeNo: row.employeeNo,
        school,
        familyLink,
        currentPeriod,
      }));
    }
  }

  if (hrTableExists(db, 'hr_executive_beneficiaries')) {
    const benRows = db
      .prepare(
        `SELECT * FROM hr_executive_beneficiaries
         WHERE beneficiary_type IN ('ceo_child', 'chairman_child', 'director_child', 'sponsored_student')
           AND COALESCE(status, 'active') = 'active'
         ORDER BY name ASC`
      )
      .all();
    for (const ben of benRows) {
      if (!linkedExecutiveMatchesFilter(ben.linked_executive, linkedFilter)) continue;
      const already = [...byKey.values()].some((c) => c.beneficiaryId === ben.id);
      if (already) continue;
      const familyLink = resolveFamilyBeneficiaryLink(db, ben.name, {
        beneficiaryId: ben.id,
        linkedExecutive: ben.linked_executive,
        beneficiaryType: ben.beneficiary_type,
      });
      byKey.set(`ben:${ben.id}`, buildExecutiveFamilyChildRow(db, {
        displayName: ben.name,
        school: { schoolName: ben.school_name, beneficiaryId: ben.id },
        familyLink,
        currentPeriod,
        beneficiaryOnly: true,
      }));
    }
  }

  const children = [...byKey.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  const executives = [
    ...new Set(children.map((c) => c.linkedExecutiveLabel).filter(Boolean)),
  ].sort();

  return {
    periodYyyymm: currentPeriod,
    executives,
    summary: {
      childCount: children.length,
      totalMonthlyAllowanceNgn: children.reduce((sum, c) => sum + (c.allowance?.monthlyAmountNgn || 0), 0),
      allowancePaidThisMonth: children.filter((c) => c.allowance?.paidThisMonth).length,
      pendingFeeCount: children.filter((c) => c.schoolFees?.pending).length,
      actionNeededCount: children.filter((c) => c.paymentHealth !== 'on_track').length,
      pendingRequestsCount: children.reduce((sum, c) => sum + (c.pendingRequestsCount || 0), 0),
    },
    children,
  };
}

/**
 * CEO / Chairman overview — all household staff with salary payment status.
 * @param {import('better-sqlite3').Database} db
 * @param {{ assignedExecutive?: string; linkedExecutive?: string }} [filters]
 */
export function getExecutiveDomesticDashboard(db, filters = {}) {
  const execFilter = String(filters.assignedExecutive || filters.linkedExecutive || '').trim();
  const currentPeriod = currentPeriodYyyymm();
  /** @type {Map<string, object>} */
  const byKey = new Map();

  if (hrTableExists(db, 'hr_staff_profiles') && hrTableExists(db, 'users')) {
    const staffRows = db
      .prepare(
        `SELECT p.user_id AS userId, u.display_name AS displayName, p.employee_no AS employeeNo,
                p.job_title AS jobTitle, p.department AS department
         FROM hr_staff_profiles p
         JOIN app_users u ON u.id = p.user_id
         WHERE p.payroll_group = 'chairman_staffs'
         ORDER BY u.display_name ASC`
      )
      .all();
    for (const row of staffRows) {
      let domestic = null;
      if (hrTableExists(db, 'hr_domestic_staff_profiles')) {
        domestic =
          db.prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE user_id = ? ORDER BY updated_at_iso DESC LIMIT 1`).get(row.userId) ||
          db.prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE staff_name = ? ORDER BY updated_at_iso DESC LIMIT 1`).get(row.displayName);
      }
      const assignedExecutive = domestic?.assigned_executive || null;
      if (!linkedExecutiveMatchesFilter(assignedExecutive, execFilter)) continue;
      byKey.set(String(row.userId), buildExecutiveDomesticStaffRow(db, {
        userId: row.userId,
        displayName: row.displayName,
        employeeNo: row.employeeNo,
        domesticProfile: domestic,
        fallbackDesignation: row.jobTitle,
        fallbackLocation: row.department,
        currentPeriod,
      }));
    }
  }

  if (hrTableExists(db, 'hr_domestic_staff_profiles')) {
    const profiles = db
      .prepare(`SELECT * FROM hr_domestic_staff_profiles WHERE COALESCE(status, 'active') = 'active' ORDER BY staff_name ASC`)
      .all();
    for (const domestic of profiles) {
      if (!linkedExecutiveMatchesFilter(domestic.assigned_executive, execFilter)) continue;
      const linkedUserId = String(domestic.user_id || '').trim();
      if (linkedUserId && byKey.has(linkedUserId)) continue;
      const key = linkedUserId || `dom:${domestic.id}`;
      if (byKey.has(key)) continue;
      byKey.set(key, buildExecutiveDomesticStaffRow(db, {
        userId: linkedUserId || null,
        displayName: domestic.staff_name,
        employeeNo: domestic.employee_no,
        domesticProfile: domestic,
        currentPeriod,
        profileOnly: !linkedUserId,
      }));
    }
  }

  const staff = [...byKey.values()].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  const executives = [...new Set(staff.map((s) => s.assignedExecutiveLabel).filter(Boolean))].sort();

  return {
    periodYyyymm: currentPeriod,
    executives,
    summary: {
      staffCount: staff.length,
      adminManagedCount: staff.filter((s) => !s.hasLogin).length,
      withLoginCount: staff.filter((s) => s.hasLogin).length,
      totalMonthlySalaryNgn: staff.reduce((sum, s) => sum + (s.salary?.monthlyAmountNgn || 0), 0),
      salaryPaidThisMonth: staff.filter((s) => s.salary?.paidThisMonth).length,
      actionNeededCount: staff.filter((s) => s.paymentHealth !== 'on_track').length,
    },
    staff,
  };
}

function buildExecutiveDomesticStaffRow(db, input) {
  const {
    userId,
    displayName,
    employeeNo,
    domesticProfile,
    fallbackDesignation,
    fallbackLocation,
    currentPeriod,
    profileOnly = false,
  } = input;
  const domestic = domesticProfile || null;
  const domesticProfileId = domestic?.id || null;
  const assignedExecutive = domestic?.assigned_executive || null;
  const assignedExecutiveLabel = executiveDisplayLabel(assignedExecutive);
  const monthlyAmountNgn = domestic?.salary_amount_ngn != null
    ? Math.round(Number(domestic.salary_amount_ngn) || 0)
    : null;

  let lastPaidPeriod = null;
  let paidThisMonth = false;
  let pendingPayment = null;
  if (hrTableExists(db, 'hr_executive_payments') && (domesticProfileId || displayName)) {
    const payments = domesticProfileId
      ? db
          .prepare(
            `SELECT * FROM hr_executive_payments
             WHERE payee_name = ? OR (source_kind = 'domestic_staff' AND source_id = ?)
             ORDER BY COALESCE(paid_at_iso, updated_at_iso, created_at_iso) DESC LIMIT 8`
          )
          .all(displayName, domesticProfileId)
      : db
          .prepare(
            `SELECT * FROM hr_executive_payments WHERE payee_name = ? ORDER BY COALESCE(paid_at_iso, updated_at_iso, created_at_iso) DESC LIMIT 8`
          )
          .all(displayName);
    const paidRows = payments.filter((p) => String(p.status).toLowerCase() === 'paid');
    if (paidRows[0]?.period_yyyymm) lastPaidPeriod = paidRows[0].period_yyyymm;
    paidThisMonth = paidRows.some((p) => String(p.period_yyyymm || '') === currentPeriod);
    const pending = payments.find((p) => !['paid', 'cancelled', 'rejected'].includes(String(p.status || '').toLowerCase()));
    if (pending) {
      pendingPayment = {
        amountNgn: Math.round(Number(pending.amount_ngn) || 0),
        status: pending.status,
        statusLabel: familyFeeStatusLabel(pending.status),
        periodYyyymm: pending.period_yyyymm,
      };
    }
  }

  let paymentHealth = 'on_track';
  if (!domesticProfileId || domestic?.status !== 'active') paymentHealth = 'setup_incomplete';
  else if (!paidThisMonth || pendingPayment) paymentHealth = 'action_needed';

  return {
    userId: userId || null,
    displayName: String(displayName || '').trim(),
    employeeNo: employeeNo || domestic?.employee_no || null,
    domesticProfileId,
    profileOnly,
    hasLogin: Boolean(userId),
    designation: domestic?.designation || fallbackDesignation || null,
    workLocation: domestic?.work_location || fallbackLocation || null,
    assignedExecutive,
    assignedExecutiveLabel,
    executiveEmployerLine: assignedExecutiveLabel ? `Employed by ${assignedExecutiveLabel}` : 'Executive household staff',
    salary: monthlyAmountNgn != null
      ? {
          monthlyAmountNgn,
          lastPaidPeriod,
          paidThisMonth,
          statusLabel: paidThisMonth ? 'Paid this month' : domestic?.status === 'active' ? 'Due this month' : String(domestic?.status || 'inactive'),
        }
      : null,
    pendingPayment,
    paymentHealth,
    staffProfilePath: userId ? `/hr/employees/${encodeURIComponent(userId)}` : null,
  };
}

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
