/**
 * Cashier till snapshot: Cash / POS / Bank from live treasury_accounts.balance
 * (same column payouts debit), plus last movement and uncleared receipts.
 */
import { branchWhere, listTreasuryAccounts } from '../readModel.js';
import { composeTreasuryTillTruth } from '../../shared/lib/treasuryTillLane.js';

function lastMovementsByAccountId(db, accountIds) {
  const ids = (accountIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.treasury_account_id AS id, m.posted_at_iso AS postedAtISO, m.amount_ngn AS amountNgn
       FROM treasury_movements m
       INNER JOIN (
         SELECT treasury_account_id, MAX(posted_at_iso) AS mx
         FROM treasury_movements
         WHERE treasury_account_id IN (${ph})
         GROUP BY treasury_account_id
       ) latest
         ON latest.treasury_account_id = m.treasury_account_id
        AND latest.mx = m.posted_at_iso
       ORDER BY m.posted_at_iso DESC, m.id DESC`
    )
    .all(...ids);
  const map = {};
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || map[id]) continue;
    map[id] = {
      postedAtISO: String(row.postedAtISO || '').trim(),
      amountNgn: Math.round(Number(row.amountNgn) || 0),
    };
  }
  return map;
}

function unclearedReceiptsSummary(db, branchScope) {
  try {
    const b = branchWhere(db, 'sales_receipts', branchScope);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(amount_ngn), 0) AS s
         FROM sales_receipts
         WHERE 1=1${b.sql}
           AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed', 'cleared', 'confirmed'))
           AND (finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '')`
      )
      .get(...b.args);
    return {
      unclearedCount: Math.max(0, Math.round(Number(row?.c) || 0)),
      unclearedNgn: Math.round(Number(row?.s) || 0),
    };
  } catch {
    return { unclearedCount: 0, unclearedNgn: 0 };
  }
}

/**
 * Cash / POS / Bank from live `treasury_accounts.balance` (the column payouts debit).
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope]
 */
export function buildCashierTillTruth(db, branchScope = 'ALL') {
  const accounts = listTreasuryAccounts(db, branchScope);
  const lastByAccountId = lastMovementsByAccountId(
    db,
    accounts.map((a) => a.id)
  );
  const uncleared = unclearedReceiptsSummary(db, branchScope);
  return composeTreasuryTillTruth({
    accounts,
    lastByAccountId,
    unclearedCount: uncleared.unclearedCount,
    unclearedNgn: uncleared.unclearedNgn,
  });
}
