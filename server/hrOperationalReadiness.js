/**
 * HR operational readiness / data quality checks.
 * @module server/hrOperationalReadiness
 */

import { HR_POLICY_REGISTRY } from './hrPolicy.js';
import {
  getHrAbsenceAlerts,
  getPromotionDueReport,
  getTemporaryEmployeeAlerts,
  hrPhase2TablesReady,
  listHrAbsenceReports,
  listHrExitClearance,
  listHrOvertimeRequests,
} from './hrPhase2Ops.js';
import {
  hrTablesReady,
  listDraftPayrollRunIds,
  listHrLeaveBalances,
  listHrPolicyAcknowledgements,
  listHrStaff,
} from './hrOps.js';
import { listPendingTransfersPastEffective, listHrTransferRequests, hrTransferRequestsTableReady } from './hrTransferRequests.js';
import { listLoanScheduleIssues } from './hrLoanSchedule.js';

function checkList(items, id, label, severity = 'medium', fixPath = null) {
  return {
    id,
    label,
    count: items.length,
    severity,
    fixPath,
    items: items.slice(0, 25).map((item) => ({
      ...item,
      userId: item.userId || item.user_id,
      displayName: item.displayName || item.display_name || item.staffDisplayName,
    })),
  };
}

export function getHrOperationalReadiness(db, scope) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const acks = listHrPolicyAcknowledgements(db);
  const ackSet = new Set(acks.map((a) => `${a.userId}:${a.policyKey}`));
  const today = new Date().toISOString().slice(0, 10);

  const noEmployeeNo = staff.filter((s) => !String(s.employeeNo || '').trim());
  const noDepartment = staff.filter((s) => !String(s.department || '').trim());
  const noBranch = staff.filter((s) => !String(s.branchId || '').trim());
  const noJobTitle = staff.filter((s) => !String(s.jobTitle || '').trim());
  const noSalaryLevel = staff.filter((s) => s.salaryLevel == null && s.salaryStep == null);
  const tempNoContract = staff.filter((s) => {
    const et = String(s.employmentType || '').toLowerCase();
    return (et.includes('temp') || et.includes('contract')) && !s.contractEndIso;
  });

  const missingHandbook = staff.filter((s) => !ackSet.has(`${s.userId}:employee_handbook`));
  const missingConfidentiality = staff.filter((s) => !ackSet.has(`${s.userId}:confidentiality_pledge`));

  const staffIds = new Set(staff.map((s) => s.userId));
  const withLeaveBalance = new Set(listHrLeaveBalances(db).filter((b) => staffIds.has(b.userId)).map((b) => b.userId));
  const missingLeaveBalance = staff.filter((s) => !withLeaveBalance.has(s.userId));

  let missingDocs = [];
  try {
    const docCounts = db.prepare(`SELECT user_id, COUNT(*) AS c FROM hr_staff_documents GROUP BY user_id`).all();
    const hasDoc = new Set(docCounts.map((d) => d.user_id));
    missingDocs = staff.filter((s) => !hasDoc.has(s.userId));
  } catch { missingDocs = []; }

  let expiredDocs = [];
  try {
    expiredDocs = db
      .prepare(
        `SELECT d.user_id, d.doc_kind, d.expiry_date_iso, u.display_name
         FROM hr_staff_documents d JOIN app_users u ON u.id = d.user_id
         WHERE d.expiry_date_iso IS NOT NULL AND d.expiry_date_iso < ?`
      )
      .all(today)
      .filter((d) => staffIds.has(d.user_id))
      .map((d) => ({ userId: d.user_id, displayName: d.display_name, docKind: d.doc_kind, expiryDateIso: d.expiry_date_iso }));
  } catch { expiredDocs = []; }

  const draftPayroll = listDraftPayrollRunIds(db);

  let noBank = [];
  let incompleteOnboarding = [];
  let pendingTransfersOverdue = [];
  let staleExitClearance = [];
  try {
    const profiles = db
      .prepare(
        `SELECT user_id, bank_account_no, bank_account_no_masked, bank_name, onboarding_complete FROM hr_staff_profiles`
      )
      .all();
    const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
    noBank = staff.filter((s) => {
      const p = profileMap.get(s.userId);
      const acct = String(p?.bank_account_no || p?.bank_account_no_masked || '').replace(/\s/g, '');
      return acct.length < 10;
    });
    incompleteOnboarding = staff.filter((s) => {
      const p = profileMap.get(s.userId);
      return p && !p.onboarding_complete;
    });
  } catch { /* ignore */ }

  if (hrTransferRequestsTableReady(db)) {
    pendingTransfersOverdue = listPendingTransfersPastEffective(db, scope);
  }

  if (hrPhase2TablesReady(db)) {
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    staleExitClearance = listHrExitClearance(db, scope, {})
      .filter((c) => !['completed', 'cancelled'].includes(c.status) && (c.createdAtIso || '').slice(0, 10) <= cutoff)
      .map((c) => ({ userId: c.userId, displayName: c.staffDisplayName, status: c.status }));
  }

  const checks = [
    checkList(noEmployeeNo, 'no_employee_no', 'Staff without employee number', 'high', '/hr/employees'),
    checkList(noDepartment, 'no_department', 'Staff without department', 'high', '/hr/settings?tab=departments'),
    checkList(noBranch, 'no_branch', 'Staff without branch/HQ assignment', 'high', '/hr/employees'),
    checkList(noJobTitle, 'no_designation', 'Staff without designation/job title', 'medium', '/hr/settings?tab=designations'),
    checkList(noSalaryLevel, 'no_salary_level', 'Staff without salary level/step', 'medium', '/hr/settings?tab=salary-matrix'),
    checkList(noBank, 'no_bank_details', 'Staff without bank details for payroll', 'high', '/hr/employees'),
    checkList(tempNoContract, 'temp_no_contract_end', 'Temporary staff without contract end date', 'medium', '/hr/employees'),
    checkList(missingDocs, 'missing_documents', 'Staff missing required documents', 'medium', '/hr/documents?tab=documents'),
    checkList(expiredDocs, 'expired_documents', 'Staff with expired documents', 'high', '/hr/documents?tab=reports'),
    checkList(missingHandbook, 'missing_handbook', 'Staff missing handbook acknowledgement', 'low', '/hr/documents?tab=policies'),
    checkList(missingConfidentiality, 'missing_confidentiality', 'Staff missing confidentiality pledge', 'low', '/hr/documents?tab=policies'),
    checkList(incompleteOnboarding, 'incomplete_onboarding', 'Staff with incomplete onboarding', 'medium', '/hr/employees'),
    checkList(missingLeaveBalance, 'missing_leave_balance', 'Active staff without leave balance record', 'medium', '/hr/leave'),
    checkList(pendingTransfersOverdue, 'pending_transfers_overdue', 'Approved transfers past effective date not completed', 'high', '/hr/discipline-exit?tab=transfers'),
    checkList(draftPayroll, 'draft_payroll_runs', 'Payroll run not approved/locked for current period', 'high', '/hr/payroll'),
    checkList(staleExitClearance, 'stale_exit_clearance', 'Exit clearance pending over 14 days', 'medium', '/hr/discipline-exit?tab=exit-clearance'),
  ];

  const totalIssues = checks.reduce((n, c) => n + c.count, 0);
  return {
    ok: true,
    totalIssues,
    checks,
    readyForOperations: totalIssues === 0,
    policies: HR_POLICY_REGISTRY.map((p) => ({ key: p.key, label: p.label, version: p.version })),
  };
}

export function getHrDashboardActionAlerts(db, scope) {
  const out = {
    absenceAwaitingReview: [],
    voluntaryTerminationRisk: [],
    overtimeAwaitingApproval: [],
    exitClearancePending: [],
    pendingTransfers: [],
    temporaryEmployees: [],
    promotionDue: [],
    missingPolicyAck: [],
    expiredDocuments: [],
  };
  if (!hrTablesReady(db)) return out;

  if (hrPhase2TablesReady(db)) {
    out.absenceAwaitingReview = listHrAbsenceReports(db, scope, { status: 'reported' }).slice(0, 20);
    const absenceAlerts = getHrAbsenceAlerts(db, scope);
    out.voluntaryTerminationRisk = absenceAlerts.voluntaryTerminationRisk || [];
    out.overtimeAwaitingApproval = listHrOvertimeRequests(db, scope, { status: 'submitted' })
      .concat(listHrOvertimeRequests(db, scope, { status: 'hr_review' }))
      .slice(0, 20);
    out.exitClearancePending = listHrExitClearance(db, scope, {}).filter((c) =>
      ['in_progress', 'pending_finance', 'pending_admin', 'pending_hr_final'].includes(c.status)
    ).slice(0, 20);
    const temp = getTemporaryEmployeeAlerts(db, scope);
    out.temporaryEmployees = [
      ...(temp.contractEndingSoon || []),
      ...(temp.pastContractEnd || []),
    ].slice(0, 20);
    out.promotionDue = getPromotionDueReport(db, scope, { dueOnly: true }).slice(0, 20);
    if (hrTransferRequestsTableReady(db)) {
      out.pendingTransfers = listHrTransferRequests(db, scope, { pendingOnly: true }).slice(0, 20);
    }
  }

  const readiness = getHrOperationalReadiness(db, scope);
  if (readiness.ok) {
    const hb = readiness.checks.find((c) => c.id === 'missing_handbook');
    const conf = readiness.checks.find((c) => c.id === 'missing_confidentiality');
    out.missingPolicyAck = [...(hb?.items || []), ...(conf?.items || [])].slice(0, 15);
    const exp = readiness.checks.find((c) => c.id === 'expired_documents');
    out.expiredDocuments = exp?.items || [];
  }
  return out;
}

/** Lightweight counts for global notification bell. */
export function getHrNotificationSummary(db, scope, user) {
  const alerts = getHrDashboardActionAlerts(db, scope);
  const readiness = getHrOperationalReadiness(db, scope);
  const perms = user?.permissions || [];
  const has = (p) => perms.includes('*') || perms.includes(p);
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item?.count || seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  if (has('hr.absence.review') || has('hr.staff.manage')) {
    push({ key: 'absence-review', count: alerts.absenceAwaitingReview?.length || 0, path: '/hr/attendance?tab=exceptions', title: 'Absence awaiting HR review' });
  }
  if (has('hr.overtime.approve') || has('hr.staff.manage')) {
    push({ key: 'overtime-approval', count: alerts.overtimeAwaitingApproval?.length || 0, path: '/hr/attendance?tab=overtime', title: 'Overtime awaiting approval' });
  }
  if (has('hr.transfers.manage') || has('hr.team.view') || has('hr.staff.manage')) {
    const pending = alerts.pendingTransfers || [];
    const byStage = {
      branch_review: pending.filter((t) => t.status === 'branch_review').length,
      hr_review: pending.filter((t) => t.status === 'hr_review').length,
      gm_approval: pending.filter((t) => t.status === 'gm_approval').length,
      approved: pending.filter((t) => t.status === 'approved').length,
    };
    if (byStage.branch_review) {
      push({ key: 'transfer-branch', count: byStage.branch_review, path: '/hr/discipline-exit?tab=transfers', title: 'Transfers awaiting branch review' });
    }
    if (byStage.hr_review) {
      push({ key: 'transfer-hr', count: byStage.hr_review, path: '/hr/discipline-exit?tab=transfers', title: 'Transfers awaiting HR review' });
    }
    if (byStage.gm_approval) {
      push({ key: 'transfer-gm', count: byStage.gm_approval, path: '/hr/discipline-exit?tab=transfers', title: 'Transfers awaiting GM/MD approval' });
    }
    if (byStage.approved) {
      push({ key: 'transfer-complete', count: byStage.approved, path: '/hr/discipline-exit?tab=transfers', title: 'Approved transfers pending completion' });
    }
    const overdueComplete = listPendingTransfersPastEffective(db, scope).length;
    if (overdueComplete) {
      push({ key: 'transfer-overdue', count: overdueComplete, path: '/hr/discipline-exit?tab=transfers', title: 'Transfers past effective date' });
    }
  }
  if (has('hr.exit.manage') || has('hr.staff.manage')) {
    push({ key: 'exit-clearance', count: alerts.exitClearancePending?.length || 0, path: '/hr/discipline-exit?tab=exit-clearance', title: 'Exit clearance pending' });
    const staleExit = (alerts.exitClearancePending || []).filter((c) => {
      const d = String(c.updatedAtIso || c.createdAtIso || '').slice(0, 10);
      if (!d) return false;
      const age = (Date.now() - new Date(d).getTime()) / 86400000;
      return age > 14;
    }).length;
    if (staleExit) {
      push({ key: 'exit-stale', count: staleExit, path: '/hr/discipline-exit?tab=exit-clearance', title: 'Exit clearance pending over 14 days' });
    }
  }
  if (has('hr.leave.manage') || has('hr.team.view') || has('hr.staff.manage')) {
    try {
      const staleLeave = db
        .prepare(
          `SELECT COUNT(*) AS c FROM hr_requests WHERE kind = 'leave' AND status IN ('submitted','branch_review','hr_review')
           AND datetime(created_at_iso) < datetime('now', '-5 days')`
        )
        .get()?.c || 0;
      if (staleLeave) {
        push({ key: 'leave-stale', count: staleLeave, path: '/hr/leave-requests', title: 'Leave requests pending over 5 days' });
      }
    } catch { /* ignore */ }
  }
  if (has('hr.reports.view') || has('hr.staff.manage')) {
    const complianceN =
      (alerts.promotionDue?.length || 0) +
      (alerts.missingPolicyAck?.length || 0) +
      (alerts.expiredDocuments?.length || 0) +
      (alerts.temporaryEmployees?.length || 0);
    if (complianceN) {
      push({ key: 'hr-compliance', count: complianceN, path: '/hr/dashboard', title: 'HR compliance & promotion alerts' });
    }
    const expSoon = (readiness.checks || []).find((c) => c.id === 'expired_documents');
    const docExp = (expSoon?.items || []).length;
    if (docExp) {
      push({ key: 'doc-expiry', count: docExp, path: '/hr/reports?tab=readiness', title: 'Documents expired or expiring' });
    }
    const promo = alerts.promotionDue?.length || 0;
    if (promo) {
      push({ key: 'promotion-due', count: promo, path: '/hr/reports?tab=promotion-due', title: 'Promotions due for review' });
    }
    const temp = alerts.temporaryEmployees?.length || 0;
    if (temp) {
      push({ key: 'temp-contract', count: temp, path: '/hr/reports?tab=temp-monitoring', title: 'Temporary contracts ending soon' });
    }
  }
  if (has('hr.payroll.prepare') || has('hr.payroll.manage')) {
    const draft = readiness.checks?.find((c) => c.id === 'draft_payroll_runs');
    if (draft?.count) {
      push({ key: 'payroll-draft', count: draft.count, path: '/hr/payroll', title: 'Payroll pending approval' });
    }
    try {
      const ym = new Date().toISOString().slice(0, 7);
      const day = new Date().getDate();
      if (day >= 20) {
        const approved = db
          .prepare(
            `SELECT COUNT(*) AS c FROM hr_payroll_runs WHERE period_yyyymm = ? AND status IN ('locked','paid','gm_approved','md_approved')`
          )
          .get(ym)?.c || 0;
        if (!approved) {
          push({ key: 'payroll-salary-date', count: 1, path: '/hr/payroll', title: 'Payroll not approved before salary date' });
        }
      }
    } catch { /* ignore */ }
  }
  if (has('hr.loans.manage') || has('hr.payroll.manage')) {
    const loanIssues = listLoanScheduleIssues(db, scope).length;
    if (loanIssues) {
      push({ key: 'loan-schedule', count: loanIssues, path: '/hr/loans', title: 'Loan deduction schedule issues' });
    }
  }
  const risk = alerts.voluntaryTerminationRisk?.length || 0;
  if (risk && (has('hr.absence.review') || has('hr.staff.manage'))) {
    push({ key: 'absence-risk', count: risk, path: '/hr/attendance?tab=exceptions', title: '3-day no-show risk' });
  }
  return { items, totalCount: items.reduce((s, i) => s + i.count, 0) };
}
