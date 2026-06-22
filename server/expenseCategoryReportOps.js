/**
 * Expense category exception reporting — Others, special, and capex lanes.
 */
import { getExpenseCategoryLane } from '../shared/expenseCategoryLanes.js';
import { isFinanceExceptionExpenseItem, resolveExpenseCategoryPolicyLimits } from '../shared/expenseCategoryPolicy.js';
import { buildAp3CostingReadinessReport } from './ap3CostingReadinessOps.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function isoInRange(iso, startISO, endISO) {
  if (!iso) return false;
  if (startISO && iso < startISO) return false;
  if (endISO && iso > endISO) return false;
  return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ startISO?: string; endISO?: string; branchScope?: string }} opts
 */
export function buildExpenseCategoryExceptionReport(db, opts = {}) {
  const startISO = String(opts.startISO || '').slice(0, 10);
  const endISO = String(opts.endISO || '').slice(0, 10);
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';

  const hasLane = hasColumn(db, 'expenses', 'category_lane');
  const hasJustification = hasColumn(db, 'payment_requests', 'category_justification');

  const rows = db
    .prepare(
      `SELECT pr.request_id, pr.amount_requested_ngn, pr.request_date, pr.approval_status, pr.description,
              pr.paid_amount_ngn, pr.category_justification,
              e.category AS expense_category, e.category_lane AS expense_category_lane, e.branch_id
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       ORDER BY pr.request_date DESC, pr.request_id DESC`
    )
    .all()
    .filter((row) => {
      const category = String(row.expense_category || '').trim();
      const lane = hasLane
        ? String(row.expense_category_lane || '').trim() || getExpenseCategoryLane(category)
        : getExpenseCategoryLane(category);
      if (!isFinanceExceptionExpenseItem(category, lane)) return false;
      const date = String(row.request_date || '').slice(0, 10);
      if (startISO || endISO) {
        if (!isoInRange(date, startISO, endISO)) return false;
      }
      const branchId = String(row.branch_id || '').trim();
      if (branchScope !== 'ALL' && branchId && branchId !== branchScope) return false;
      return true;
    })
    .map((row) => {
      const category = String(row.expense_category || '').trim() || 'Others';
      const lane = hasLane
        ? String(row.expense_category_lane || '').trim() || getExpenseCategoryLane(category)
        : getExpenseCategoryLane(category);
      return {
        requestID: row.request_id,
        requestDate: String(row.request_date || '').slice(0, 10),
        approvalStatus: row.approval_status ?? '',
        description: row.description ?? '',
        expenseCategory: category,
        expenseCategoryLane: lane,
        amountRequestedNgn: roundMoney(row.amount_requested_ngn),
        paidAmountNgn: roundMoney(row.paid_amount_ngn),
        branchId: row.branch_id ?? '',
        categoryJustification: hasJustification ? String(row.category_justification || '').trim() : '',
      };
    });

  const byLane = new Map();
  const byCategory = new Map();
  let totalNgn = 0;
  for (const r of rows) {
    totalNgn += r.amountRequestedNgn;
    byLane.set(r.expenseCategoryLane, (byLane.get(r.expenseCategoryLane) || 0) + r.amountRequestedNgn);
    byCategory.set(r.expenseCategory, (byCategory.get(r.expenseCategory) || 0) + r.amountRequestedNgn);
  }

  return {
    ok: true,
    startISO: startISO || null,
    endISO: endISO || null,
    branchScope,
    summary: {
      rowCount: rows.length,
      totalNgn: roundMoney(totalNgn),
      byLane: [...byLane.entries()].map(([lane, amountNgn]) => ({ lane, amountNgn: roundMoney(amountNgn) })),
      byCategory: [...byCategory.entries()].map(([category, amountNgn]) => ({
        category,
        amountNgn: roundMoney(amountNgn),
      })),
    },
    rows,
  };
}

/**
 * Monthly alert for Finance — exception lanes + AP3 unclassified (current calendar month).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string; startISO?: string; endISO?: string; orgLimits?: object }} opts
 */
export function buildExpenseCategoryMonthlyAlert(db, opts = {}) {
  const now = new Date();
  const startISO =
    String(opts.startISO || '').slice(0, 10) ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const endISO = String(opts.endISO || '').slice(0, 10) || now.toISOString().slice(0, 10);
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const policyLimits = resolveExpenseCategoryPolicyLimits(opts.orgLimits);

  const exceptions = buildExpenseCategoryExceptionReport(db, { startISO, endISO, branchScope });
  const othersRows = exceptions.rows.filter((r) => r.expenseCategory === 'Others');
  const othersNgn = othersRows.reduce((s, r) => s + r.amountRequestedNgn, 0);

  let ap3UnclassifiedNgn = 0;
  try {
    const ap3 = buildAp3CostingReadinessReport(db, {
      branchId: branchScope === 'ALL' ? null : branchScope,
      period: startISO.slice(0, 7),
      limitSamples: 0,
    });
    ap3UnclassifiedNgn = roundMoney(ap3.summary?.unclassifiedExpenseNgn);
  } catch {
    ap3UnclassifiedNgn = 0;
  }

  const ap3ShouldAlert = ap3UnclassifiedNgn >= policyLimits.ap3UnclassifiedAlertThresholdNgn;
  const shouldAlert =
    exceptions.summary.rowCount > 0 || othersRows.length > 0 || ap3ShouldAlert;

  return {
    ok: true,
    startISO,
    endISO,
    branchScope,
    summary: {
      exceptionRowCount: exceptions.summary.rowCount,
      exceptionTotalNgn: exceptions.summary.totalNgn,
      othersCount: othersRows.length,
      othersNgn: roundMoney(othersNgn),
      ap3UnclassifiedNgn,
      ap3AlertThresholdNgn: policyLimits.ap3UnclassifiedAlertThresholdNgn,
      ap3ShouldAlert,
      shouldAlert,
    },
  };
}

function monthKeyFromIso(iso) {
  const s = String(iso || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : '';
}

function monthKeysEndingAt(endDate, count = 6) {
  const end = endDate instanceof Date ? endDate : new Date(endDate || Date.now());
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/**
 * Rolling Others share by branch — last N calendar months of approved payment requests.
 * @param {import('better-sqlite3').Database} db
 * @param {{ months?: number; branchScope?: string; endISO?: string }} opts
 */
export function buildExpenseCategoryOthersTrendReport(db, opts = {}) {
  const months = Math.min(12, Math.max(1, Math.round(Number(opts.months) || 6)));
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const endISO = String(opts.endISO || new Date().toISOString()).slice(0, 10);
  const endDate = new Date(`${endISO}T12:00:00`);
  const monthKeys = monthKeysEndingAt(endDate, months);
  const startISO = `${monthKeys[0]}-01`;

  const rows = db
    .prepare(
      `SELECT pr.amount_requested_ngn, pr.request_date, pr.approval_status,
              e.category AS expense_category, e.branch_id
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE pr.request_date >= ? AND pr.request_date <= ?
         AND pr.approval_status IN ('Approved', 'Paid')`
    )
    .all(startISO, endISO)
    .filter((row) => {
      const branchId = String(row.branch_id || '').trim() || 'UNASSIGNED';
      if (branchScope !== 'ALL' && branchId !== branchScope) return false;
      return true;
    });

  /** @type {Map<string, { branchId: string; byMonth: Map<string, { totalNgn: number; othersNgn: number; count: number; othersCount: number }> }>} */
  const byBranch = new Map();

  for (const row of rows) {
    const monthKey = monthKeyFromIso(row.request_date);
    if (!monthKey || !monthKeys.includes(monthKey)) continue;
    const branchId = String(row.branch_id || '').trim() || 'UNASSIGNED';
    const amountNgn = roundMoney(row.amount_requested_ngn);
    const category = String(row.expense_category || '').trim() || 'Others';
    if (!byBranch.has(branchId)) {
      byBranch.set(branchId, { branchId, byMonth: new Map() });
    }
    const branch = byBranch.get(branchId);
    if (!branch.byMonth.has(monthKey)) {
      branch.byMonth.set(monthKey, { totalNgn: 0, othersNgn: 0, count: 0, othersCount: 0 });
    }
    const bucket = branch.byMonth.get(monthKey);
    bucket.totalNgn += amountNgn;
    bucket.count += 1;
    if (category === 'Others') {
      bucket.othersNgn += amountNgn;
      bucket.othersCount += 1;
    }
  }

  const branches = [...byBranch.values()]
    .map((b) => {
      const monthsOut = monthKeys.map((mk) => {
        const bucket = b.byMonth.get(mk) || { totalNgn: 0, othersNgn: 0, count: 0, othersCount: 0 };
        const othersPct =
          bucket.totalNgn > 0 ? Math.round((bucket.othersNgn / bucket.totalNgn) * 1000) / 10 : 0;
        return {
          monthKey: mk,
          totalNgn: roundMoney(bucket.totalNgn),
          othersNgn: roundMoney(bucket.othersNgn),
          requestCount: bucket.count,
          othersCount: bucket.othersCount,
          othersPct,
        };
      });
      const totalNgn = monthsOut.reduce((s, m) => s + m.totalNgn, 0);
      const othersNgn = monthsOut.reduce((s, m) => s + m.othersNgn, 0);
      return {
        branchId: b.branchId,
        months: monthsOut,
        summary: {
          totalNgn: roundMoney(totalNgn),
          othersNgn: roundMoney(othersNgn),
          othersPct: totalNgn > 0 ? Math.round((othersNgn / totalNgn) * 1000) / 10 : 0,
        },
      };
    })
    .sort((a, b) => b.summary.othersPct - a.summary.othersPct || b.summary.othersNgn - a.summary.othersNgn);

  const companyTotalNgn = branches.reduce((s, b) => s + b.summary.totalNgn, 0);
  const companyOthersNgn = branches.reduce((s, b) => s + b.summary.othersNgn, 0);

  return {
    ok: true,
    startISO,
    endISO,
    branchScope,
    monthKeys,
    summary: {
      branchCount: branches.length,
      totalNgn: roundMoney(companyTotalNgn),
      othersNgn: roundMoney(companyOthersNgn),
      othersPct:
        companyTotalNgn > 0 ? Math.round((companyOthersNgn / companyTotalNgn) * 1000) / 10 : 0,
    },
    branches,
  };
}

/**
 * Branch manager coaching alert when Others share exceeds org threshold (rolling 3 months).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string; orgLimits?: object; months?: number }} opts
 */
export function buildExpenseCategoryBranchCoachAlert(db, opts = {}) {
  const branchScope = String(opts.branchScope || '').trim();
  if (!branchScope || branchScope === 'ALL') {
    return { ok: true, shouldCoach: false, branchScope: branchScope || 'ALL' };
  }
  const policyLimits = resolveExpenseCategoryPolicyLimits(opts.orgLimits);
  const months = Math.min(6, Math.max(1, Math.round(Number(opts.months) || 3)));
  const trend = buildExpenseCategoryOthersTrendReport(db, { months, branchScope });
  const branch =
    trend.branches.find((b) => b.branchId === branchScope) ||
    (trend.branches.length === 1 ? trend.branches[0] : null);
  if (!branch || branch.summary.totalNgn <= 0) {
    return {
      ok: true,
      shouldCoach: false,
      branchScope,
      othersPct: 0,
      coachThresholdPct: policyLimits.othersBranchCoachThresholdPct,
    };
  }
  const othersPct = branch.summary.othersPct;
  const shouldCoach = othersPct >= policyLimits.othersBranchCoachThresholdPct;
  return {
    ok: true,
    shouldCoach,
    branchScope,
    months,
    othersPct,
    othersNgn: branch.summary.othersNgn,
    totalNgn: branch.summary.totalNgn,
    coachThresholdPct: policyLimits.othersBranchCoachThresholdPct,
    message: shouldCoach
      ? `Your branch coded ${othersPct}% of approved payment requests as Others over the last ${months} months. Coach staff to pick standard categories where possible.`
      : null,
  };
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * CSV export for finance exception queue / governance sample.
 * @param {ReturnType<typeof buildExpenseCategoryExceptionReport>} report
 */
export function buildExpenseCategoryExceptionCsv(report) {
  const headers = [
    'Request ID',
    'Request Date',
    'Branch',
    'Category',
    'Lane',
    'Amount NGN',
    'Paid NGN',
    'Approval Status',
    'Description',
    'Justification',
  ];
  const rows = (report.rows || []).map((r) =>
    [
      r.requestID,
      r.requestDate,
      r.branchId,
      r.expenseCategory,
      r.expenseCategoryLane,
      r.amountRequestedNgn,
      r.paidAmountNgn,
      r.approvalStatus,
      r.description,
      r.categoryJustification,
    ]
      .map(csvEscape)
      .join(',')
  );
  return `${headers.join(',')}\n${rows.join('\n')}\n`;
}
