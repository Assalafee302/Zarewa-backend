/**
 * HR report CSV exports.
 * @module server/hrReportsExport
 */

import { listHrEngagementSurveys, getHrEngagementSurveySummary } from './hrEngagement.js';
import { hrLearningTablesReady } from './hrLearning.js';
import { listHrStaff } from './hrOps.js';
import {
  getPromotionDueReport,
  getTemporaryEmployeeAlerts,
  listHrAbsenceReports,
  listHrExitClearance,
} from './hrPhase2Ops.js';

function esc(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

export function exportHrHeadcountCsv(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: true });
  const headers = ['userId', 'displayName', 'username', 'status', 'branchId', 'department', 'jobTitle', 'dateJoinedIso', 'lineManagerUserId'];
  const rows = staff.map((s) => [
    s.userId,
    s.displayName,
    s.username,
    s.status,
    s.branchId,
    s.department,
    s.jobTitle,
    s.dateJoinedIso,
    s.lineManagerUserId,
  ]);
  return { ok: true, csv: toCsv(headers, rows), filename: 'hr-headcount.csv' };
}

export function exportHrTurnoverCsv(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: true });
  const headers = ['userId', 'displayName', 'status', 'branchId', 'separationStatus', 'lastWorkingDayIso', 'separationReason'];
  const rows = [];
  for (const s of staff) {
    const sep = safeJsonParse(s.profileExtra?.lifecycle, {}).separation || {};
    if (String(s.status) !== 'inactive' && sep.status !== 'separating' && sep.status !== 'separated') continue;
    rows.push([
      s.userId,
      s.displayName,
      s.status,
      s.branchId,
      sep.status || '',
      sep.lastWorkingDayIso || '',
      sep.reason || '',
    ]);
  }
  return { ok: true, csv: toCsv(headers, rows), filename: 'hr-turnover.csv' };
}

export function exportHrTrainingExpiryCsv(db, scope) {
  if (!hrLearningTablesReady(db)) return { ok: false, error: 'Learning module not initialised.' };
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const ids = new Set(staff.map((s) => s.userId));
  const all = db
    .prepare(
      `SELECT user_id AS userId, title, provider, completed_at_iso AS completedAtIso, expiry_at_iso AS expiryAtIso
       FROM hr_training_records WHERE expiry_at_iso IS NOT NULL AND expiry_at_iso != ''
       ORDER BY expiry_at_iso ASC`
    )
    .all()
    .filter((r) => ids.has(r.userId));
  const nameById = new Map(staff.map((s) => [s.userId, s.displayName || s.userId]));
  const headers = ['userId', 'displayName', 'title', 'provider', 'completedAtIso', 'expiryAtIso'];
  const rows = all.map((r) => [
    r.userId,
    nameById.get(r.userId) || r.userId,
    r.title,
    r.provider,
    r.completedAtIso,
    r.expiryAtIso,
  ]);
  return { ok: true, csv: toCsv(headers, rows), filename: 'hr-training-expiry.csv' };
}

export function exportHrEngagementTrendsCsv(db) {
  const surveys = listHrEngagementSurveys(db);
  const headers = ['surveyId', 'title', 'status', 'responseCount', 'questionId', 'questionText', 'avgRating', 'ratingCount'];
  const rows = [];
  for (const s of surveys) {
    const sum = getHrEngagementSurveySummary(db, s.id);
    if (!sum.ok) continue;
    for (const q of sum.survey?.questions || []) {
      if (q.type !== 'rating') continue;
      const agg = sum.aggregates?.[q.id] || {};
      rows.push([
        s.id,
        s.title,
        s.status,
        sum.responseCount,
        q.id,
        q.text,
        agg.avg ?? '',
        agg.count ?? 0,
      ]);
    }
    if (!(sum.survey?.questions || []).some((q) => q.type === 'rating')) {
      rows.push([s.id, s.title, s.status, sum.responseCount, '', '', '', '']);
    }
  }
  return { ok: true, csv: toCsv(headers, rows), filename: 'hr-engagement-surveys.csv' };
}

export function exportHrAbsenceReportsCsv(db, scope) {
  const rows = listHrAbsenceReports(db, scope, {});
  const headers = ['id', 'userId', 'displayName', 'branchId', 'absenceStartIso', 'expectedReturnIso', 'absenceType', 'status', 'reason'];
  const data = rows.map((r) => [r.id, r.userId, r.displayName, r.branchId, r.absenceStartIso, r.expectedReturnIso, r.absenceType, r.status, r.reason]);
  return { ok: true, csv: toCsv(headers, data), filename: 'hr-absence-reports.csv' };
}

export function exportHrExitClearanceCsv(db, scope) {
  const rows = listHrExitClearance(db, scope, {});
  const headers = ['id', 'userId', 'displayName', 'separationType', 'lastWorkingDayIso', 'status', 'completedAtIso'];
  const data = rows.map((r) => [r.id, r.userId, r.displayName, r.separationType, r.lastWorkingDayIso, r.status, r.completedAtIso || '']);
  return { ok: true, csv: toCsv(headers, data), filename: 'hr-exit-clearance.csv' };
}

export function exportHrPropertyReturnCsv(db, scope) {
  const clearances = listHrExitClearance(db, scope, {});
  const headers = ['clearanceId', 'userId', 'displayName', 'itemName', 'itemCategory', 'returned', 'waived', 'returnedAtIso'];
  const data = [];
  for (const c of clearances) {
    for (const it of c.propertyItems || []) {
      data.push([c.id, c.userId, c.displayName, it.itemName, it.itemCategory, it.returned, it.waived, it.returnedAtIso || '']);
    }
  }
  return { ok: true, csv: toCsv(headers, data), filename: 'hr-property-return.csv' };
}

export function exportHrPromotionDueCsv(db, scope) {
  const rows = getPromotionDueReport(db, scope, { dueOnly: false });
  const headers = ['userId', 'displayName', 'branchId', 'department', 'jobTitle', 'lastPromotionIso', 'yearsSince', 'queryCount', 'eligibility', 'suggestedAction'];
  const data = rows.map((r) => [r.userId, r.displayName, r.branchId, r.department, r.jobTitle, r.lastPromotionIso, r.yearsSince, r.queryCount, r.eligibility, r.suggestedAction]);
  return { ok: true, csv: toCsv(headers, data), filename: 'hr-promotion-due.csv' };
}

export function exportHrTemporaryEmployeeCsv(db, scope) {
  const alerts = getTemporaryEmployeeAlerts(db, scope);
  const headers = ['userId', 'displayName', 'branchId', 'alertType', 'contractEndIso', 'dateJoinedIso'];
  const data = [];
  for (const bucket of ['missingContractEnd', 'contractEndingSoon', 'exceedsSixMonths', 'pastContractEnd']) {
    for (const r of alerts[bucket] || []) {
      data.push([r.userId, r.displayName, r.branchId, r.alertType, r.contractEndIso || '', r.dateJoinedIso || '']);
    }
  }
  return { ok: true, csv: toCsv(headers, data), filename: 'hr-temporary-employees.csv' };
}
