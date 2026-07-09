/**
 * Annex D §D.7 — automated fraud indicator report.
 * Turns the manually-reviewed fraud indicators from the compliance SOP into
 * queryable exceptions so the daily/weekly reviews are evidence-based instead
 * of relying on someone noticing.
 *
 * Every indicator is defensive: if a table/column is missing on an older DB,
 * that indicator returns an `error` string instead of failing the report.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

/** D.7: "Multiple refunds to same customer in 30 days". */
function repeatRefundCustomers(db, { days, branchScope }) {
  const cutoff = isoDaysAgo(days);
  const params = [cutoff];
  let branchSql = '';
  if (branchScope && branchScope !== 'all') {
    branchSql = ' AND IFNULL(branch_id, ?) = ?';
    params.push(branchScope, branchScope);
  }
  return db
    .prepare(
      `SELECT customer_id AS customerId,
              MAX(customer_name) AS customerName,
              COUNT(*) AS refundCount,
              SUM(amount_ngn) AS totalRequestedNgn,
              SUM(CASE WHEN status = 'Paid' THEN IFNULL(paid_amount_ngn, 0) ELSE 0 END) AS totalPaidNgn,
              MIN(requested_at_iso) AS firstRequestIso,
              MAX(requested_at_iso) AS lastRequestIso
       FROM customer_refunds
       WHERE substr(IFNULL(requested_at_iso, ''), 1, 10) >= ?${branchSql}
       GROUP BY customer_id
       HAVING COUNT(*) >= 2
       ORDER BY refundCount DESC, totalRequestedNgn DESC`
    )
    .all(...params);
}

/** D.7: "Payroll line for separated employee". */
function payrollLinesForInactiveStaff(db) {
  if (!tableExists(db, 'hr_payroll_runs') || !tableExists(db, 'hr_payroll_lines')) return [];
  const latest = db
    .prepare(`SELECT id, period_yyyymm, status FROM hr_payroll_runs ORDER BY period_yyyymm DESC LIMIT 3`)
    .all();
  if (!latest.length) return [];
  const out = [];
  for (const run of latest) {
    const rows = db
      .prepare(
        `SELECT l.run_id AS runId, ? AS periodYyyymm, l.user_id AS userId,
                u.display_name AS staffName, u.status AS userStatus, l.net_ngn AS netNgn
         FROM hr_payroll_lines l
         JOIN app_users u ON u.id = l.user_id
         WHERE l.run_id = ? AND u.status <> 'active'`
      )
      .all(run.period_yyyymm, run.id);
    out.push(...rows.map((r) => ({ ...r, runStatus: run.status })));
  }
  return out;
}

/** D.7: "Others expense category >15% of branch spend". */
function othersExpenseShare(db, { days, thresholdPct }) {
  const cutoff = isoDaysAgo(days);
  const totals = db
    .prepare(
      `SELECT SUM(amount_ngn) AS totalNgn,
              SUM(CASE WHEN LOWER(IFNULL(category, '')) LIKE '%other%' THEN amount_ngn ELSE 0 END) AS othersNgn
       FROM expenses
       WHERE substr(IFNULL(date, ''), 1, 10) >= ?`
    )
    .get(cutoff);
  const totalNgn = Number(totals?.totalNgn) || 0;
  const othersNgn = Number(totals?.othersNgn) || 0;
  const sharePct = totalNgn > 0 ? Math.round((othersNgn / totalNgn) * 1000) / 10 : 0;
  return {
    totalNgn,
    othersNgn,
    sharePct,
    thresholdPct,
    flagged: totalNgn > 0 && sharePct > thresholdPct,
  };
}

/** D.7: "Receipts cleared without matching bank credit" proxy — receipts stuck pending clearance. */
function staleUnclearedReceipts(db, { staleDays }) {
  const cutoff = isoDaysAgo(staleDays);
  return db
    .prepare(
      `SELECT id, customer_id AS customerId, customer_name AS customerName,
              quotation_ref AS quotationRef, amount_ngn AS amountNgn, method,
              status, date_iso AS dateIso, handled_by AS handledBy
       FROM sales_receipts
       WHERE LOWER(IFNULL(status, '')) NOT IN ('cleared', 'reversed', 'confirmed')
         AND substr(IFNULL(date_iso, ''), 1, 10) <= ?
         AND substr(IFNULL(date_iso, ''), 1, 10) <> ''
       ORDER BY date_iso ASC
       LIMIT 200`
    )
    .all(cutoff);
}

function safeIndicator(fn) {
  try {
    return { ok: true, rows: fn() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string, days?: number, othersThresholdPct?: number, staleReceiptDays?: number }} [opts]
 */
export function buildFraudIndicatorsReport(db, opts = {}) {
  const days = Number(opts.days) > 0 ? Number(opts.days) : 30;
  const othersThresholdPct = Number(opts.othersThresholdPct) > 0 ? Number(opts.othersThresholdPct) : 15;
  const staleReceiptDays = Number(opts.staleReceiptDays) > 0 ? Number(opts.staleReceiptDays) : 7;
  const branchScope = String(opts.branchScope || 'all');

  const repeatRefunds = safeIndicator(() => repeatRefundCustomers(db, { days, branchScope }));
  const payrollInactive = safeIndicator(() => payrollLinesForInactiveStaff(db));
  const staleReceipts = safeIndicator(() => staleUnclearedReceipts(db, { staleDays: staleReceiptDays }));
  let othersShare;
  try {
    othersShare = { ok: true, ...othersExpenseShare(db, { days, thresholdPct: othersThresholdPct }) };
  } catch (e) {
    othersShare = { ok: false, error: String(e?.message || e) };
  }

  const flaggedCount =
    (repeatRefunds.ok ? repeatRefunds.rows.length : 0) +
    (payrollInactive.ok ? payrollInactive.rows.length : 0) +
    (staleReceipts.ok ? staleReceipts.rows.length : 0) +
    (othersShare.ok && othersShare.flagged ? 1 : 0);

  return {
    generatedAtIso: new Date().toISOString(),
    windowDays: days,
    branchScope,
    flaggedCount,
    indicators: {
      repeatRefundCustomers: repeatRefunds,
      payrollLinesForInactiveStaff: payrollInactive,
      staleUnclearedReceipts: staleReceipts,
      othersExpenseShare: othersShare,
    },
  };
}
