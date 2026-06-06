/**
 * HR analytics aggregations (Phase 5).
 * @module server/hrAnalyticsOps
 */

import { hrPhase2TablesReady, listHrAbsenceReports, listHrOvertimeRequests } from './hrPhase2Ops.js';
import { hrTransferRequestsTableReady, listHrTransferRequests } from './hrTransferRequests.js';
import { hrTablesReady, listHrStaff, listPayrollRuns } from './hrOps.js';

export function getHrHeadcountAnalytics(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const byBranch = new Map();
  const byDepartment = new Map();
  const byDesignation = new Map();
  for (const s of staff) {
    const b = s.branchId || 'UNASSIGNED';
    byBranch.set(b, (byBranch.get(b) || 0) + 1);
    const d = s.department || 'Unassigned';
    byDepartment.set(d, (byDepartment.get(d) || 0) + 1);
    const j = s.jobTitle || 'Unassigned';
    byDesignation.set(j, (byDesignation.get(j) || 0) + 1);
  }
  const toRows = (m) => Array.from(m.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return {
    total: staff.length,
    byBranch: toRows(byBranch),
    byDepartment: toRows(byDepartment),
    byDesignation: toRows(byDesignation),
  };
}

export function getHrMovementAnalytics(db, scope) {
  const out = { hires: 0, exits: 0, transfers: 0, transferRows: [] };
  if (!hrTablesReady(db)) return out;
  const staff = listHrStaff(db, scope, { includeInactive: true });
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  out.hires = staff.filter((s) => (s.dateJoinedIso || '') >= cutoff).length;
  out.exits = staff.filter((s) => {
    const sep = s.profileExtra?.lifecycle?.separation;
    return s.status !== 'active' || sep?.status === 'separated';
  }).length;
  if (hrTransferRequestsTableReady(db)) {
    const transfers = listHrTransferRequests(db, scope, { status: 'completed' }).filter(
      (t) => (t.completedAtIso || t.updatedAtIso || '').slice(0, 10) >= cutoff
    );
    out.transfers = transfers.length;
    out.transferRows = transfers.slice(0, 50);
  }
  return out;
}

export function getHrAttendanceTrendAnalytics(db, scope, months = 6) {
  if (!hrPhase2TablesReady(db)) return { months: [], absenceCounts: [], overtimeHours: [] };
  const labels = [];
  const absenceCounts = [];
  const overtimeHours = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    labels.push(ym);
    const from = `${ym}-01`;
    const to = `${ym}-31`;
    const abs = listHrAbsenceReports(db, scope, { fromIso: from, toIso: to });
    absenceCounts.push(abs.length);
    const ot = listHrOvertimeRequests(db, scope, {}).filter((r) => (r.workDateIso || '').startsWith(ym));
    overtimeHours.push(
      Math.round(ot.reduce((s, r) => s + (Number(r.eligibleOvertimeHours ?? r.calculatedHours) || 0), 0) * 10) / 10
    );
  }
  return { months: labels, absenceCounts, overtimeHours };
}

export function getHrLeaveUsageAnalytics(db, scope) {
  if (!hrTablesReady(db)) return { byDepartment: [] };
  const rows = db
    .prepare(
      `SELECT p.department, COUNT(*) AS c
       FROM hr_requests r
       JOIN hr_staff_profiles p ON p.user_id = r.user_id
       WHERE r.kind = 'leave' AND r.status IN ('approved','paid','completed')
       GROUP BY p.department ORDER BY c DESC LIMIT 20`
    )
    .all();
  return { byDepartment: rows.map((r) => ({ department: r.department || 'Unassigned', count: r.c })) };
}

export function getHrPayrollTrendAnalytics(db, canViewSensitive) {
  if (!canViewSensitive || !hrTablesReady(db)) return { periods: [], netTotals: [], headcounts: [] };
  const runs = listPayrollRuns(db).filter((r) => ['locked', 'paid'].includes(r.status)).slice(0, 12);
  return {
    periods: runs.map((r) => r.periodYyyymm),
    netTotals: runs.map((r) => Math.round(Number(r.totals?.netNgn) || 0)),
    headcounts: runs.map((r) => Number(r.totals?.lineCount) || 0),
  };
}

export function getHrComplianceAnalytics(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  let promotionDue = 0;
  let trainingRecords = 0;
  try {
    promotionDue = db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE promotion_grade IS NOT NULL`).get()?.c || 0;
    trainingRecords = db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM hr_training_records`).get()?.c || 0;
  } catch { /* optional tables */ }
  return { activeStaff: staff.length, promotionDue, trainingRecords };
}

export function getHrAnalyticsDashboard(db, scope, { canViewSensitive = false } = {}) {
  return {
    headcount: getHrHeadcountAnalytics(db, scope),
    movement: getHrMovementAnalytics(db, scope),
    attendanceTrend: getHrAttendanceTrendAnalytics(db, scope, 6),
    leaveUsage: getHrLeaveUsageAnalytics(db, scope),
    payrollTrend: getHrPayrollTrendAnalytics(db, canViewSensitive),
    compliance: getHrComplianceAnalytics(db, scope),
  };
}
