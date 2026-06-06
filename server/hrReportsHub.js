/**
 * HR Reports Hub — catalog, preview, and standardized exports (CSV / XLSX / PDF).
 * @module server/hrReportsHub
 */

import XLSX from 'xlsx';
import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { HR_POLICY_REGISTRY } from './hrPolicy.js';
import {
  getPromotionDueReport,
  getTemporaryEmployeeAlerts,
  hrPhase2TablesReady,
  listHrAbsenceReports,
  listHrExitClearance,
  listHrOvertimeRequests,
} from './hrPhase2Ops.js';
import { listHrTransferRequests } from './hrTransferRequests.js';
import {
  hrTablesReady,
  listHrAuditEventsGlobal,
  listHrLeaveBalances,
  listHrPolicyAcknowledgements,
  listHrRequests,
  listHrStaff,
  listPayrollLines,
  listPayrollRuns,
  listRecentDisciplinaryEvents,
} from './hrOps.js';
import { listGrievances } from './hrGovernanceOps.js';
import { getPayrollReconciliation } from './hrPayrollControl.js';

const COMPANY = 'Zarewa Aluminium & Plastics Ltd';

export const HR_REPORT_CATALOG = [
  { id: 'employee-master', category: 'employee', label: 'Employee master list', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'department', 'employmentType', 'status'] },
  { id: 'active-employees', category: 'employee', label: 'Active employees', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'department'] },
  { id: 'on-probation', category: 'employee', label: 'Employees on probation', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'department'] },
  { id: 'confirmed-employees', category: 'employee', label: 'Confirmed employees', csv: true, xlsx: true, pdf: true, filters: ['branch', 'department'] },
  { id: 'temporary-employees', category: 'employee', label: 'Temporary / contract staff', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch'] },
  { id: 'department-staff', category: 'employee', label: 'Department staff', csv: true, xlsx: true, pdf: true, filters: ['branch', 'department'] },
  { id: 'branch-staff', category: 'employee', label: 'Branch staff', csv: true, xlsx: true, pdf: true, filters: ['branch'] },
  { id: 'attendance-report', category: 'attendance', label: 'Attendance report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'userId', 'fromIso', 'toIso', 'status'] },
  { id: 'late-coming', category: 'attendance', label: 'Late coming report', csv: true, xlsx: true, pdf: true, filters: ['branch', 'fromIso', 'toIso'] },
  { id: 'absence-reports', category: 'attendance', label: 'Absence report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'userId', 'fromIso', 'toIso', 'status'] },
  { id: 'overtime', category: 'attendance', label: 'Overtime report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'userId', 'fromIso', 'toIso', 'status'] },
  { id: 'leave-balance', category: 'leave', label: 'Leave balance report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'userId', 'periodYyyymm'] },
  { id: 'leave-history', category: 'leave', label: 'Leave history report', csv: true, xlsx: true, pdf: true, filters: ['branch', 'fromIso', 'toIso', 'status'] },
  { id: 'payroll-summary', category: 'payroll', label: 'Payroll summary', csv: true, xlsx: true, pdf: true, priority: true, filters: ['periodYyyymm'], sensitive: true },
  { id: 'staff-loan', category: 'payroll', label: 'Staff loan report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'status'] },
  { id: 'promotion-due', category: 'development', label: 'Promotion due report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'department'] },
  { id: 'training-expiry', category: 'development', label: 'Training expiry report', csv: true, xlsx: false, pdf: false, filters: ['branch'] },
  { id: 'engagement-trends', category: 'development', label: 'Engagement trends', csv: true, xlsx: false, pdf: false },
  { id: 'disciplinary-report', category: 'discipline', label: 'Disciplinary report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'fromIso', 'toIso'] },
  { id: 'exit-clearance', category: 'discipline', label: 'Exit report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'status'] },
  { id: 'property-return', category: 'discipline', label: 'Property return report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch'] },
  { id: 'document-expiry', category: 'compliance', label: 'Document expiry / missing', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch'] },
  { id: 'policy-acknowledgement', category: 'compliance', label: 'Policy acknowledgement report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch'] },
  { id: 'hr-audit-trail', category: 'compliance', label: 'HR audit trail', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'fromIso', 'toIso'] },
  { id: 'grievance-report', category: 'compliance', label: 'Grievance report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['branch', 'fromIso', 'toIso', 'status'] },
  { id: 'payroll-exceptions', category: 'payroll', label: 'Payroll exception report', csv: true, xlsx: true, pdf: true, priority: true, filters: ['periodYyyymm'], sensitive: true },
  { id: 'headcount', category: 'employee', label: 'Headcount (legacy)', csv: true, xlsx: true, pdf: true, hidden: true },
  { id: 'turnover', category: 'discipline', label: 'Turnover / exit (legacy)', csv: true, xlsx: false, pdf: false, hidden: true },
  { id: 'pending-transfers', category: 'discipline', label: 'Pending transfers', csv: true, xlsx: true, pdf: true, filters: ['branch', 'status'] },
  { id: 'completed-transfers', category: 'discipline', label: 'Completed transfers', csv: true, xlsx: true, pdf: true, filters: ['branch', 'fromIso', 'toIso'] },
  { id: 'inter-branch-transfers', category: 'discipline', label: 'Inter-branch transfer report', csv: true, xlsx: true, pdf: true, filters: ['branch'] },
  { id: 'transfer-history', category: 'discipline', label: 'Employee transfer history', csv: true, xlsx: true, pdf: true, filters: ['userId', 'branch'] },
];

export const LEGACY_EXPORT_KIND_MAP = {
  headcount: 'active-employees',
  turnover: 'turnover',
  'training-expiry': 'training-expiry',
  'engagement-trends': 'engagement-trends',
  'absence-reports': 'absence-reports',
  overtime: 'overtime',
  'exit-clearance': 'exit-clearance',
  'property-return': 'property-return',
  'promotion-due': 'promotion-due',
  'temporary-employees': 'temporary-employees',
};

export function getHrReportCatalog(opts = {}) {
  const list = HR_REPORT_CATALOG.filter((r) => !r.hidden || opts.includeHidden);
  const byCategory = {};
  for (const r of list) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }
  return { reports: list, byCategory };
}

export function parseReportFilters(query = {}) {
  return {
    branchId: String(query.branchId || '').trim() || null,
    department: String(query.department || '').trim() || null,
    userId: String(query.userId || '').trim() || null,
    fromIso: String(query.fromIso || '').slice(0, 10) || null,
    toIso: String(query.toIso || '').slice(0, 10) || null,
    periodYyyymm: String(query.periodYyyymm || query.period || '').replace(/\D/g, '').slice(0, 6) || null,
    status: String(query.status || '').trim() || null,
    employmentType: String(query.employmentType || '').trim() || null,
  };
}

function filtersSummary(filters) {
  const parts = [];
  if (filters.branchId) parts.push(`Branch: ${filters.branchId}`);
  if (filters.department) parts.push(`Department: ${filters.department}`);
  if (filters.userId) parts.push(`Staff ID: ${filters.userId}`);
  if (filters.fromIso) parts.push(`From: ${filters.fromIso}`);
  if (filters.toIso) parts.push(`To: ${filters.toIso}`);
  if (filters.periodYyyymm) parts.push(`Period: ${filters.periodYyyymm}`);
  if (filters.status) parts.push(`Status: ${filters.status}`);
  if (filters.employmentType) parts.push(`Employment: ${filters.employmentType}`);
  return parts.length ? parts.join(' · ') : 'All records (no filters applied)';
}

function wrapResult(reportId, title, columns, rows, filters, actor) {
  return {
    ok: true,
    reportId,
    title,
    columns,
    rows,
    totalCount: rows.length,
    filtersSummary: filtersSummary(filters),
    generatedAtIso: new Date().toISOString(),
    generatedBy: actor?.displayName || actor?.username || null,
  };
}

function filterStaffList(staff, filters) {
  return staff.filter((s) => {
    if (filters.branchId && String(s.branchId) !== filters.branchId) return false;
    if (filters.department && String(s.department || '') !== filters.department) return false;
    if (filters.userId && String(s.userId) !== filters.userId) return false;
    if (filters.employmentType && !String(s.employmentType || '').toLowerCase().includes(filters.employmentType.toLowerCase())) return false;
    if (filters.status && String(s.status) !== filters.status) return false;
    return true;
  });
}

function staffRow(s, includeSalary = false) {
  const row = {
    displayName: s.displayName,
    employeeNo: s.employeeNo || '',
    branchId: s.branchId || '',
    department: s.department || '',
    jobTitle: s.jobTitle || '',
    employmentType: s.employmentType || '',
    dateJoinedIso: s.dateJoinedIso || '',
    probationEndIso: s.probationEndIso || '',
    contractEndIso: s.contractEndIso || '',
    status: s.status || '',
  };
  if (includeSalary) row.baseSalaryNgn = s.baseSalaryNgn ?? '';
  return row;
}

const STAFF_COLS = [
  { key: 'displayName', label: 'Staff' },
  { key: 'employeeNo', label: 'Employee No' },
  { key: 'branchId', label: 'Branch' },
  { key: 'department', label: 'Department' },
  { key: 'jobTitle', label: 'Job Title' },
  { key: 'employmentType', label: 'Employment Type' },
  { key: 'dateJoinedIso', label: 'Date Joined' },
  { key: 'status', label: 'Status' },
];

function runEmployeeMaster(db, scope, filters, opts) {
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: true }), filters);
  const cols = opts.canViewSensitive ? [...STAFF_COLS, { key: 'baseSalaryNgn', label: 'Base Salary (NGN)' }] : STAFF_COLS;
  return wrapResult('employee-master', 'Employee Master List', cols, staff.map((s) => staffRow(s, opts.canViewSensitive)), filters, opts.actor);
}

function runActiveEmployees(db, scope, filters, opts) {
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: false }), { ...filters, status: 'active' });
  return wrapResult('active-employees', 'Active Employees', STAFF_COLS, staff.map((s) => staffRow(s)), filters, opts.actor);
}

function runOnProbation(db, scope, filters, opts) {
  const today = new Date().toISOString().slice(0, 10);
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: false }), filters).filter(
    (s) => s.probationEndIso && s.probationEndIso >= today
  );
  return wrapResult('on-probation', 'Employees on Probation', [...STAFF_COLS, { key: 'probationEndIso', label: 'Probation End' }], staff.map((s) => ({ ...staffRow(s), probationEndIso: s.probationEndIso })), filters, opts.actor);
}

function runConfirmedEmployees(db, scope, filters, opts) {
  const today = new Date().toISOString().slice(0, 10);
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: false }), filters).filter(
    (s) => !s.probationEndIso || s.probationEndIso < today
  );
  return wrapResult('confirmed-employees', 'Confirmed Employees', STAFF_COLS, staff.map((s) => staffRow(s)), filters, opts.actor);
}

function runTemporaryEmployees(db, scope, filters, opts) {
  const alerts = getTemporaryEmployeeAlerts(db, scope);
  const rows = [];
  for (const bucket of ['missingContractEnd', 'contractEndingSoon', 'exceedsSixMonths', 'pastContractEnd']) {
    for (const r of alerts[bucket] || []) {
      if (filters.branchId && r.branchId !== filters.branchId) continue;
      rows.push({
        displayName: r.displayName,
        branchId: r.branchId || '',
        alertType: r.alertType || bucket,
        contractEndIso: r.contractEndIso || '',
        dateJoinedIso: r.dateJoinedIso || '',
      });
    }
  }
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'alertType', label: 'Alert' },
    { key: 'contractEndIso', label: 'Contract End' },
    { key: 'dateJoinedIso', label: 'Date Joined' },
  ];
  return wrapResult('temporary-employees', 'Temporary / Contract Staff', cols, rows, filters, opts.actor);
}

function runAttendanceReport(db, scope, filters, opts) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  let sql = `SELECT ae.user_id, ae.branch_id, ae.event_date_iso, ae.status, ae.minutes_late, u.display_name
    FROM hr_attendance_events ae JOIN app_users u ON u.id = ae.user_id WHERE 1=1`;
  const args = [];
  if (!scope.viewAll) { sql += ' AND ae.branch_id = ?'; args.push(scope.branchId); }
  if (filters.branchId) { sql += ' AND ae.branch_id = ?'; args.push(filters.branchId); }
  if (filters.userId) { sql += ' AND ae.user_id = ?'; args.push(filters.userId); }
  if (filters.fromIso) { sql += ' AND ae.event_date_iso >= ?'; args.push(filters.fromIso); }
  if (filters.toIso) { sql += ' AND ae.event_date_iso <= ?'; args.push(filters.toIso); }
  if (filters.status) { sql += ' AND ae.status = ?'; args.push(filters.status); }
  sql += ' ORDER BY ae.event_date_iso DESC LIMIT 2000';
  const rows = db.prepare(sql).all(...args).map((r) => ({
    displayName: r.display_name,
    branchId: r.branch_id,
    eventDateIso: r.event_date_iso,
    status: r.status,
    minutesLate: r.minutes_late,
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'eventDateIso', label: 'Date' },
    { key: 'status', label: 'Status' },
    { key: 'minutesLate', label: 'Minutes Late' },
  ];
  return wrapResult('attendance-report', 'Attendance Report', cols, rows, filters, opts.actor);
}

function runLateComing(db, scope, filters, opts) {
  return runAttendanceReport(db, scope, { ...filters, status: 'late' }, opts);
}

function runAbsenceReports(db, scope, filters, opts) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Absence reporting not available.' };
  const rows = listHrAbsenceReports(db, scope, filters).map((r) => ({
    displayName: r.displayName,
    branchId: r.branchId || '',
    absenceStartIso: r.absenceStartIso,
    expectedReturnIso: r.expectedReturnIso,
    absenceType: r.absenceType,
    status: r.status,
    reason: r.reason || '',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'absenceStartIso', label: 'Start' },
    { key: 'expectedReturnIso', label: 'Expected Return' },
    { key: 'absenceType', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'reason', label: 'Reason' },
  ];
  return wrapResult('absence-reports', 'Absence Report', cols, rows, filters, opts.actor);
}

function runOvertime(db, scope, filters, opts) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Overtime module not available.' };
  const rows = listHrOvertimeRequests(db, scope, filters).map((r) => ({
    displayName: r.displayName,
    branchId: r.branchId || '',
    workDateIso: r.workDateIso,
    calculatedHours: r.calculatedHours,
    eligibleOvertimeHours: r.eligibleOvertimeHours,
    status: r.status,
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'workDateIso', label: 'Date' },
    { key: 'calculatedHours', label: 'Hours Worked' },
    { key: 'eligibleOvertimeHours', label: 'OT Hours' },
    { key: 'status', label: 'Status' },
  ];
  return wrapResult('overtime', 'Overtime Report', cols, rows, filters, opts.actor);
}

function runLeaveBalance(db, scope, filters, opts) {
  const staffIds = new Set(filterStaffList(listHrStaff(db, scope, { includeInactive: false }), filters).map((s) => s.userId));
  const nameById = new Map(listHrStaff(db, scope).map((s) => [s.userId, s.displayName]));
  const balances = listHrLeaveBalances(db, { userId: filters.userId || undefined, periodYyyymm: filters.periodYyyymm || undefined })
    .filter((b) => staffIds.has(b.userId));
  const rows = balances.map((b) => ({
    displayName: nameById.get(b.userId) || b.userId,
    leaveType: b.leaveType,
    periodYyyymm: b.periodYyyymm,
    openingDays: b.openingDays,
    usedDays: b.usedDays,
    closingDays: b.closingDays,
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'leaveType', label: 'Leave Type' },
    { key: 'periodYyyymm', label: 'Period' },
    { key: 'openingDays', label: 'Opening' },
    { key: 'usedDays', label: 'Used' },
    { key: 'closingDays', label: 'Balance' },
  ];
  return wrapResult('leave-balance', 'Leave Balance Report', cols, rows, filters, opts.actor);
}

function runLeaveHistory(db, scope, filters, opts) {
  const requests = listHrRequests(db, scope, { kind: 'leave' }).filter((r) => {
    if (filters.status && r.status !== filters.status) return false;
    if (filters.fromIso && String(r.submittedAtIso || '').slice(0, 10) < filters.fromIso) return false;
    if (filters.toIso && String(r.submittedAtIso || '').slice(0, 10) > filters.toIso) return false;
    return true;
  });
  const rows = requests.slice(0, 500).map((r) => ({
    displayName: r.displayName || r.userId,
    branchId: r.branchId || '',
    leaveType: r.leaveType || r.payload?.leaveType || '',
    startDateIso: r.leaveStartIso || r.payload?.startDateIso || '',
    endDateIso: r.leaveEndIso || r.payload?.endDateIso || '',
    status: r.status,
    submittedAtIso: r.submittedAtIso || '',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'leaveType', label: 'Type' },
    { key: 'startDateIso', label: 'Start' },
    { key: 'endDateIso', label: 'End' },
    { key: 'status', label: 'Status' },
  ];
  return wrapResult('leave-history', 'Leave History Report', cols, rows, filters, opts.actor);
}

function runPayrollSummary(db, scope, filters, opts) {
  if (!opts.canViewSensitive) return { ok: false, error: 'Payroll summary requires sensitive HR permission.' };
  const runs = listPayrollRuns(db);
  let run = runs.find((r) => r.periodYyyymm === filters.periodYyyymm);
  if (!run && runs.length) run = runs[0];
  if (!run) return wrapResult('payroll-summary', 'Payroll Summary', [], [], filters, opts.actor);
  const lines = listPayrollLines(db, run.id);
  const rows = lines.map((l) => ({
    displayName: l.displayName,
    grossNgn: l.grossNgn,
    taxNgn: l.taxNgn,
    pensionNgn: l.pensionNgn,
    netNgn: l.netNgn,
    attendanceDeductionNgn: l.attendanceDeductionNgn,
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'grossNgn', label: 'Gross (NGN)' },
    { key: 'taxNgn', label: 'Tax (NGN)' },
    { key: 'pensionNgn', label: 'Pension (NGN)' },
    { key: 'netNgn', label: 'Net (NGN)' },
    { key: 'attendanceDeductionNgn', label: 'Attendance Ded. (NGN)' },
  ];
  return wrapResult('payroll-summary', `Payroll Summary — ${run.periodYyyymm}`, cols, rows, filters, opts.actor);
}

function runStaffLoan(db, scope, filters, opts) {
  const requests = listHrRequests(db, scope, { kind: 'loan' }).filter((r) => {
    if (filters.status && r.status !== filters.status) return false;
    return true;
  });
  const rows = requests.map((r) => ({
    displayName: r.displayName || r.userId,
    branchId: r.branchId || '',
    amountNgn: r.payload?.amountNgn ?? r.loanAmountNgn ?? '',
    status: r.status,
    repaymentMonths: r.payload?.repaymentMonths ?? '',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'amountNgn', label: 'Amount (NGN)' },
    { key: 'repaymentMonths', label: 'Months' },
    { key: 'status', label: 'Status' },
  ];
  return wrapResult('staff-loan', 'Staff Loan Report', cols, rows, filters, opts.actor);
}

function runPromotionDue(db, scope, filters, opts) {
  let rows = getPromotionDueReport(db, scope, { dueOnly: false });
  if (filters.branchId) rows = rows.filter((r) => r.branchId === filters.branchId);
  if (filters.department) rows = rows.filter((r) => r.department === filters.department);
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'jobTitle', label: 'Role' },
    { key: 'yearsSince', label: 'Years Since Promotion' },
    { key: 'queryCount', label: 'Queries' },
    { key: 'eligibility', label: 'Eligibility' },
    { key: 'suggestedAction', label: 'Suggested Action' },
  ];
  return wrapResult('promotion-due', 'Promotion Due Report', cols, rows, filters, opts.actor);
}

function runDisciplinary(db, scope, filters, opts) {
  const events = listRecentDisciplinaryEvents(db, scope, { includeInactive: true }).filter((e) => {
    if (filters.fromIso && String(e.dateIso || e.createdAtIso || '').slice(0, 10) < filters.fromIso) return false;
    if (filters.toIso && String(e.dateIso || e.createdAtIso || '').slice(0, 10) > filters.toIso) return false;
    return true;
  });
  const rows = events.map((e) => ({
    displayName: e.staffDisplayName || '',
    employeeNo: e.staffEmployeeNo || '',
    kind: e.kind || '',
    dateIso: e.dateIso || e.createdAtIso || '',
    summary: e.summary || '',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'employeeNo', label: 'Employee No' },
    { key: 'kind', label: 'Type' },
    { key: 'dateIso', label: 'Date' },
    { key: 'summary', label: 'Summary' },
  ];
  return wrapResult('disciplinary-report', 'Disciplinary Report', cols, rows, filters, opts.actor);
}

function runExitClearance(db, scope, filters, opts) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Exit clearance not available.' };
  const rows = listHrExitClearance(db, scope, filters).map((c) => ({
    displayName: c.displayName,
    separationType: c.separationType,
    lastWorkingDayIso: c.lastWorkingDayIso,
    status: c.status,
    completedAtIso: c.completedAtIso || '',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'separationType', label: 'Separation Type' },
    { key: 'lastWorkingDayIso', label: 'Last Working Day' },
    { key: 'status', label: 'Status' },
    { key: 'completedAtIso', label: 'Completed' },
  ];
  return wrapResult('exit-clearance', 'Exit Clearance Report', cols, rows, filters, opts.actor);
}

function runPropertyReturn(db, scope, filters, opts) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Exit clearance not available.' };
  const clearances = listHrExitClearance(db, scope, filters);
  const rows = [];
  for (const c of clearances) {
    for (const it of c.propertyItems || []) {
      rows.push({
        displayName: c.displayName,
        itemName: it.itemName,
        itemCategory: it.itemCategory,
        returned: it.returned ? 'Yes' : 'No',
        waived: it.waived ? 'Yes' : 'No',
      });
    }
  }
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'itemName', label: 'Item' },
    { key: 'itemCategory', label: 'Category' },
    { key: 'returned', label: 'Returned' },
    { key: 'waived', label: 'Waived' },
  ];
  return wrapResult('property-return', 'Property Return Report', cols, rows, filters, opts.actor);
}

function runDocumentExpiry(db, scope, filters, opts) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: false }), filters);
  const ids = new Set(staff.map((s) => s.userId));
  const nameById = new Map(staff.map((s) => [s.userId, s.displayName]));
  const today = new Date().toISOString().slice(0, 10);
  let docs = [];
  try {
    docs = db.prepare(`SELECT user_id, doc_kind, file_name, expiry_date_iso FROM hr_staff_documents WHERE expiry_date_iso IS NOT NULL`).all();
  } catch { docs = []; }
  const rows = docs
    .filter((d) => ids.has(d.user_id))
    .map((d) => ({
      displayName: nameById.get(d.user_id) || d.user_id,
      docKind: d.doc_kind,
      fileName: d.file_name,
      expiryDateIso: d.expiry_date_iso,
      expired: d.expiry_date_iso < today ? 'Yes' : 'No',
    }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'docKind', label: 'Document Type' },
    { key: 'fileName', label: 'File' },
    { key: 'expiryDateIso', label: 'Expiry' },
    { key: 'expired', label: 'Expired' },
  ];
  return wrapResult('document-expiry', 'Document Expiry Report', cols, rows, filters, opts.actor);
}

function runPolicyAcknowledgement(db, scope, filters, opts) {
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: false }), filters);
  const acks = listHrPolicyAcknowledgements(db);
  const ackSet = new Set(acks.map((a) => `${a.userId}:${a.policyKey}`));
  const rows = staff.map((s) => ({
    displayName: s.displayName,
    branchId: s.branchId || '',
    handbookAck: ackSet.has(`${s.userId}:employee_handbook`) ? 'Yes' : 'No',
    confidentialityAck: ackSet.has(`${s.userId}:confidentiality_pledge`) ? 'Yes' : 'No',
  }));
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'branchId', label: 'Branch' },
    { key: 'handbookAck', label: 'Handbook' },
    { key: 'confidentialityAck', label: 'Confidentiality' },
  ];
  return wrapResult('policy-acknowledgement', 'Policy Acknowledgement Report', cols, rows, filters, opts.actor);
}

function runHrAuditTrail(db, scope, filters, opts) {
  const events = listHrAuditEventsGlobal(db, scope, {
    limit: 300,
    fromIso: filters.fromIso,
    toIso: filters.toIso,
  });
  const rows = events.map((e) => ({
    atIso: e.atIso || '',
    actorDisplayName: e.actorDisplayName || e.actorUserId || '',
    action: e.action || '',
    entityKind: e.entityKind || '',
    entityId: e.entityId || '',
    branchId: e.branchId || '',
    reason: e.reason || '',
  }));
  const cols = [
    { key: 'atIso', label: 'When' },
    { key: 'actorDisplayName', label: 'Actor' },
    { key: 'action', label: 'Action' },
    { key: 'entityKind', label: 'Entity' },
    { key: 'entityId', label: 'Entity ID' },
    { key: 'branchId', label: 'Branch' },
    { key: 'reason', label: 'Reason' },
  ];
  return wrapResult('hr-audit-trail', 'HR Audit Trail', cols, rows, filters, opts.actor);
}

function runGrievanceReport(db, scope, filters, opts) {
  let items = listGrievances(db, scope);
  if (filters.status) items = items.filter((g) => g.status === filters.status);
  if (filters.fromIso) items = items.filter((g) => String(g.createdAtIso || '').slice(0, 10) >= filters.fromIso);
  if (filters.toIso) items = items.filter((g) => String(g.createdAtIso || '').slice(0, 10) <= filters.toIso);
  const rows = items.map((g) => ({
    summary: g.summary,
    category: g.category,
    status: g.status,
    submitterDisplayName: g.submitterDisplayName,
    branchId: g.branchId || '',
    createdAtIso: g.createdAtIso || '',
    resolvedAtIso: g.resolvedAtIso || '',
  }));
  const cols = [
    { key: 'summary', label: 'Summary' },
    { key: 'category', label: 'Category' },
    { key: 'status', label: 'Status' },
    { key: 'submitterDisplayName', label: 'Submitter' },
    { key: 'branchId', label: 'Branch' },
    { key: 'createdAtIso', label: 'Submitted' },
    { key: 'resolvedAtIso', label: 'Resolved' },
  ];
  return wrapResult('grievance-report', 'Grievance Report', cols, rows, filters, opts.actor);
}

function runPayrollExceptions(db, scope, filters, opts) {
  const runs = listPayrollRuns(db, scope).filter((r) => {
    if (filters.periodYyyymm && String(r.periodYyyymm) !== String(filters.periodYyyymm)) return false;
    return r.status !== 'draft';
  });
  const rows = [];
  for (const run of runs.slice(0, 12)) {
    const recon = getPayrollReconciliation(db, run.id);
    if (!recon?.ok) continue;
    for (const a of recon.anomalies || []) {
      rows.push({
        periodYyyymm: run.periodYyyymm,
        runStatus: run.status,
        anomalyType: a.type,
        message: a.message,
        heldCount: recon.heldCount ?? '',
        varianceNgn: recon.varianceNgn ?? '',
      });
    }
    if (!(recon.anomalies || []).length && recon.heldCount > 0) {
      rows.push({
        periodYyyymm: run.periodYyyymm,
        runStatus: run.status,
        anomalyType: 'held_lines',
        message: `${recon.heldCount} staff on hold`,
        heldCount: recon.heldCount,
        varianceNgn: recon.varianceNgn ?? 0,
      });
    }
  }
  const cols = [
    { key: 'periodYyyymm', label: 'Period' },
    { key: 'runStatus', label: 'Run Status' },
    { key: 'anomalyType', label: 'Type' },
    { key: 'message', label: 'Detail' },
    { key: 'heldCount', label: 'Held Count' },
    { key: 'varianceNgn', label: 'Variance (NGN)' },
  ];
  return wrapResult('payroll-exceptions', 'Payroll Exception Report', cols, rows, filters, opts.actor);
}

function runTurnover(db, scope, filters, opts) {
  const staff = filterStaffList(listHrStaff(db, scope, { includeInactive: true }), filters);
  const rows = staff
    .filter((s) => {
      const sep = s.profileExtra?.lifecycle?.separation;
      return String(s.status) !== 'active' || sep?.status === 'separating' || sep?.status === 'separated';
    })
    .map((s) => {
      const sep = s.profileExtra?.lifecycle?.separation || {};
      return {
        displayName: s.displayName,
        status: s.status,
        separationStatus: sep.status || '',
        lastWorkingDayIso: sep.lastWorkingDayIso || '',
        reason: sep.reason || '',
      };
    });
  const cols = [
    { key: 'displayName', label: 'Staff' },
    { key: 'status', label: 'Status' },
    { key: 'separationStatus', label: 'Separation' },
    { key: 'lastWorkingDayIso', label: 'Last Day' },
    { key: 'reason', label: 'Reason' },
  ];
  return wrapResult('turnover', 'Turnover / Exit Report', cols, rows, filters, opts.actor);
}

function runTransferReport(db, scope, filters, opts, { pendingOnly, completedOnly, interBranchOnly } = {}) {
  let rows = listHrTransferRequests(db, scope, {
    status: filters.status,
    userId: filters.userId,
    pendingOnly,
  });
  if (completedOnly) rows = rows.filter((t) => t.status === 'completed');
  if (interBranchOnly) rows = rows.filter((t) => t.transferType === 'inter_branch' || t.fromBranchId !== t.toBranchId);
  if (filters.fromIso) rows = rows.filter((t) => (t.effectiveDateIso || '') >= filters.fromIso);
  if (filters.toIso) rows = rows.filter((t) => (t.effectiveDateIso || '') <= filters.toIso);
  const cols = [
    { key: 'staffDisplayName', label: 'Employee' },
    { key: 'transferType', label: 'Type' },
    { key: 'fromBranchId', label: 'From Branch' },
    { key: 'toBranchId', label: 'To Branch' },
    { key: 'fromDepartment', label: 'From Dept' },
    { key: 'toDepartment', label: 'To Dept' },
    { key: 'effectiveDateIso', label: 'Effective' },
    { key: 'status', label: 'Status' },
  ];
  return wrapResult('transfers', 'Transfer Report', cols, rows, filters, opts.actor);
}

const RUNNERS = {
  'employee-master': runEmployeeMaster,
  'active-employees': runActiveEmployees,
  'on-probation': runOnProbation,
  'confirmed-employees': runConfirmedEmployees,
  'temporary-employees': runTemporaryEmployees,
  'department-staff': runEmployeeMaster,
  'branch-staff': runEmployeeMaster,
  'attendance-report': runAttendanceReport,
  'late-coming': runLateComing,
  'absence-reports': runAbsenceReports,
  overtime: runOvertime,
  'leave-balance': runLeaveBalance,
  'leave-history': runLeaveHistory,
  'payroll-summary': runPayrollSummary,
  'staff-loan': runStaffLoan,
  'promotion-due': runPromotionDue,
  'disciplinary-report': runDisciplinary,
  'exit-clearance': runExitClearance,
  'property-return': runPropertyReturn,
  'document-expiry': runDocumentExpiry,
  'policy-acknowledgement': runPolicyAcknowledgement,
  'hr-audit-trail': runHrAuditTrail,
  'grievance-report': runGrievanceReport,
  'payroll-exceptions': runPayrollExceptions,
  turnover: runTurnover,
  'pending-transfers': (db, scope, f, o) => runTransferReport(db, scope, f, o, { pendingOnly: true }),
  'completed-transfers': (db, scope, f, o) => runTransferReport(db, scope, f, o, { completedOnly: true }),
  'inter-branch-transfers': (db, scope, f, o) => runTransferReport(db, scope, f, o, { interBranchOnly: true }),
  'transfer-history': (db, scope, f, o) => runTransferReport(db, scope, f, o, {}),
  headcount: runActiveEmployees,
};

export function previewHrReport(db, scope, reportId, filters, opts = {}) {
  const id = LEGACY_EXPORT_KIND_MAP[reportId] || reportId;
  const meta = HR_REPORT_CATALOG.find((r) => r.id === id);
  if (!meta) return { ok: false, error: 'Unknown report.' };
  if (meta.sensitive && !opts.canViewSensitive) {
    return { ok: false, error: 'This report requires payroll sensitive permission.' };
  }
  const runner = RUNNERS[id];
  if (!runner) return { ok: false, error: 'Report runner not implemented.' };
  return runner(db, scope, filters, opts);
}

function escCsv(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function reportPreviewToCsv(preview) {
  const headers = preview.columns.map((c) => c.label);
  const keys = preview.columns.map((c) => c.key);
  const lines = [
    headers.map(escCsv).join(','),
    ...preview.rows.map((row) => keys.map((k) => escCsv(row[k])).join(',')),
  ];
  return lines.join('\r\n');
}

export function reportPreviewToXlsx(preview) {
  const wb = XLSX.utils.book_new();
  const metaRows = [
    [COMPANY],
    [preview.title],
    [`Generated: ${preview.generatedAtIso?.slice(0, 19).replace('T', ' ') || ''}`],
    [`Filters: ${preview.filtersSummary}`],
    [],
  ];
  const header = preview.columns.map((c) => c.label);
  const data = preview.rows.map((row) => preview.columns.map((c) => row[c.key] ?? ''));
  const ws = XLSX.utils.aoa_to_sheet([...metaRows, header, ...data]);
  ws['!cols'] = preview.columns.map((c) => ({ wch: Math.min(40, Math.max(10, c.label.length + 4)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function reportPreviewToPdf(preview) {
  const lines = [
    COMPANY,
    preview.title,
    `Generated: ${preview.generatedAtIso?.slice(0, 10) || ''}`,
    preview.filtersSummary,
    `Total records: ${preview.totalCount}`,
    '',
    preview.columns.map((c) => c.label).join(' | '),
    '-'.repeat(72),
    ...preview.rows.slice(0, 80).map((row) => preview.columns.map((c) => String(row[c.key] ?? '')).join(' | ')),
  ];
  if (preview.rows.length > 80) lines.push(`… and ${preview.rows.length - 80} more rows (export CSV/XLSX for full data)`);
  return buildSimpleTextPdf([{ lines }]);
}

export function exportHrReportDocument(db, scope, reportId, filters, format, opts = {}) {
  const preview = previewHrReport(db, scope, reportId, filters, opts);
  if (!preview.ok) return preview;
  const slug = String(reportId).replace(/[^a-z0-9-]/gi, '-');
  const date = new Date().toISOString().slice(0, 10);
  const id = LEGACY_EXPORT_KIND_MAP[reportId] || reportId;
  const meta = HR_REPORT_CATALOG.find((r) => r.id === id);
  if (format === 'csv') {
    return { ok: true, contentType: 'text/csv; charset=utf-8', filename: `hr-${slug}-${date}.csv`, body: reportPreviewToCsv(preview) };
  }
  if (format === 'xlsx') {
    if (meta && meta.xlsx === false) return { ok: false, error: 'Excel export not available for this report.' };
    return { ok: true, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `hr-${slug}-${date}.xlsx`, body: reportPreviewToXlsx(preview) };
  }
  if (format === 'pdf') {
    if (meta && meta.pdf === false) return { ok: false, error: 'PDF export not available for this report.' };
    return { ok: true, contentType: 'application/pdf', filename: `hr-${slug}-${date}.pdf`, body: reportPreviewToPdf(preview) };
  }
  return { ok: false, error: 'Unsupported format.' };
}
