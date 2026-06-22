/**
 * Expense category exception reporting — Others, special, and capex lanes.
 */
import { getExpenseCategoryLane } from '../shared/expenseCategoryLanes.js';
import { isFinanceExceptionExpenseItem } from '../shared/expenseCategoryPolicy.js';

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

  const hasLane = db.prepare(`SELECT 1 FROM pragma_table_info('expenses') WHERE name = 'category_lane'`).get();
  const hasJustification = db
    .prepare(`SELECT 1 FROM pragma_table_info('payment_requests') WHERE name = 'category_justification'`)
    .get();

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
