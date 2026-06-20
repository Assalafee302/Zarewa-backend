/**
 * AP3c — production labour from payroll lines (by branch).
 */
import { parsePeriodKey, tableExists, hasColumn } from './ap2ReceivedBasisOps.js';
import { roundMoney } from './ap3MaterialCostShared.js';

/**
 * @param {object} profile
 */
export function isProductionStaffProfile(profile) {
  if (!profile) return false;
  if (Number(profile.is_production_staff) === 1) return true;
  if (Number(profile.is_production_staff) === 0) return false;
  const dept = String(profile.department || '').toLowerCase();
  const title = String(profile.job_title || '').toLowerCase();
  const group = String(profile.payroll_group || '').toLowerCase();
  if (group === 'production' || group === 'factory') return true;
  if (dept.includes('production') || dept.includes('factory')) return true;
  if (title.includes('operator') || title.includes('factory') || title.includes('production')) return true;
  return false;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
function staffProfile(db, userId) {
  if (!tableExists(db, 'hr_staff_profiles')) return null;
  try {
    const hasFlag = hasColumn(db, 'hr_staff_profiles', 'is_production_staff');
    const cols = hasFlag
      ? 'user_id, branch_id, department, job_title, payroll_group, is_production_staff'
      : 'user_id, branch_id, department, job_title, payroll_group';
    return db.prepare(`SELECT ${cols} FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 * @param {'ALL' | string} branchScope
 */
export function computeProductionLabourByBranch(db, periodKey, branchScope = 'ALL') {
  const period = parsePeriodKey(periodKey);
  if (!period) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  if (!tableExists(db, 'hr_payroll_runs') || !tableExists(db, 'hr_payroll_lines')) {
    return {
      ok: true,
      source: 'none',
      totalNgn: 0,
      byBranch: {},
      lineCount: 0,
      notes: ['Payroll tables not available.'],
    };
  }

  /** @type {Record<string, number>} */
  const byBranch = {};
  let total = 0;
  let productionLines = 0;

  const runs = db
    .prepare(
      `SELECT id FROM hr_payroll_runs WHERE period_yyyymm = ? AND status IN ('locked','paid')`
    )
    .all(period.key);

  for (const run of runs) {
    const lines = db
      .prepare(
        `SELECT user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn
         FROM hr_payroll_lines WHERE run_id = ?`
      )
      .all(run.id);

    for (const l of lines) {
      const profile = staffProfile(db, l.user_id);
      if (!isProductionStaffProfile(profile)) continue;

      const bid = String(profile?.branch_id || '').trim() || '(unassigned)';
      if (branchScope !== 'ALL' && bid !== branchScope && bid !== '(unassigned)') continue;

      const gross =
        roundMoney(l.gross_ngn) +
        roundMoney(l.bonus_ngn) -
        roundMoney(l.attendance_deduction_ngn) -
        roundMoney(l.other_deduction_ngn);
      if (gross <= 0) continue;

      productionLines += 1;
      byBranch[bid] = roundMoney((byBranch[bid] || 0) + gross);
      total += gross;
    }
  }

  return {
    ok: true,
    source: productionLines > 0 ? 'payroll' : 'none',
    periodKey: period.key,
    branchScope,
    totalNgn: roundMoney(total),
    byBranch,
    productionLineCount: productionLines,
    runCount: runs.length,
    notes:
      productionLines > 0
        ? [`${productionLines} production payroll line(s) from ${runs.length} run(s).`]
        : ['No production payroll lines — set is_production_staff on HR profiles.'],
  };
}
