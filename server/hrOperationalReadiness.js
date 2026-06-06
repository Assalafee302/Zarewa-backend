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

  if (has('hr.absence.review') || has('hr.staff.manage')) {
    const n = alerts.absenceAwaitingReview?.length || 0;
    if (n) items.push({ key: 'absence-review', count: n, path: '/hr/attendance?tab=exceptions', title: 'Absence awaiting HR review' });
  }
  if (has('hr.overtime.approve') || has('hr.staff.manage')) {
    const n = alerts.overtimeAwaitingApproval?.length || 0;
    if (n) items.push({ key: 'overtime-approval', count: n, path: '/hr/attendance?tab=overtime', title: 'Overtime awaiting approval' });
  }
  if (has('hr.transfers.manage') || has('hr.team.view')) {
    const n = alerts.pendingTransfers?.length || 0;
    if (n) items.push({ key: 'transfer-pending', count: n, path: '/hr/discipline-exit?tab=transfers', title: 'Pending transfer requests' });
  }
  if (has('hr.exit.manage') || has('hr.staff.manage')) {
    const n = alerts.exitClearancePending?.length || 0;
    if (n) items.push({ key: 'exit-clearance', count: n, path: '/hr/discipline-exit?tab=exit-clearance', title: 'Exit clearance pending' });
  }
  if (has('hr.reports.view') || has('hr.staff.manage')) {
    const n = (alerts.promotionDue?.length || 0) + (alerts.missingPolicyAck?.length || 0) + (alerts.expiredDocuments?.length || 0);
    if (n) items.push({ key: 'hr-compliance', count: n, path: '/hr/dashboard', title: 'HR compliance & promotion alerts' });
  }
  if (has('hr.payroll.prepare') || has('hr.payroll.manage')) {
    const draft = readiness.checks?.find((c) => c.id === 'draft_payroll_runs');
    if (draft?.count) items.push({ key: 'payroll-draft', count: draft.count, path: '/hr/payroll', title: 'Payroll pending approval' });
  }
  const risk = alerts.voluntaryTerminationRisk?.length || 0;
  if (risk && (has('hr.absence.review') || has('hr.staff.manage'))) {
    items.push({ key: 'absence-risk', count: risk, path: '/hr/attendance?tab=exceptions', title: '3-day no-show risk' });
  }
  return { items, totalCount: items.reduce((s, i) => s + i.count, 0) };
}
