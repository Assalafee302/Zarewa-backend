/**
 * Sub-ledger vs GL reconciliation hints and treasury cash-flow by type (MVP).
 * @param {import('better-sqlite3').Database} db
 */

import { monthBounds } from './accountingStatementsOps.js';
import { branchPredicate } from './branchSql.js';
import { trialBalanceRows } from './glOps.js';

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function pickGlRow(tb, code) {
  const r = (tb.rows || []).find((x) => x.accountCode === code);
  if (!r) return null;
  return {
    accountCode: r.accountCode,
    accountName: r.accountName,
    debitNgn: r.debitNgn,
    creditNgn: r.creditNgn,
    netNgn: r.netNgn,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey YYYY-MM
 * @param {'ALL' | string} branchScope
 */
export function getReconciliationPack(db, periodKey, branchScope = 'ALL') {
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  const tb = trialBalanceRows(db, b.start, b.end);
  if (!tb.ok) return tb;

  let salesReceiptsPostedNgn = 0;
  if (hasColumn(db, 'sales_receipts', 'date_iso')) {
    const bw = branchPredicate(db, 'sales_receipts', branchScope);
    const statusClause = hasColumn(db, 'sales_receipts', 'status')
      ? ` AND (status IS NULL OR UPPER(TRIM(status)) != 'REVERSED')`
      : '';
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM sales_receipts
         WHERE date_iso >= ? AND date_iso <= ?${statusClause}${bw.sql}`
      )
      .get(b.start, b.end, ...bw.args);
    salesReceiptsPostedNgn = Math.round(Number(row?.s) || 0);
  }

  let ledgerReceiptLikeNgn = 0;
  if (hasColumn(db, 'ledger_entries', 'at_iso')) {
    const lbw = branchPredicate(db, 'ledger_entries', branchScope);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(
          CASE
            WHEN type = 'RECEIPT' THEN amount_ngn
            WHEN type = 'ADVANCE_IN' THEN amount_ngn
            WHEN type = 'RECEIPT_REVERSAL' THEN -amount_ngn
            ELSE 0 END
        ), 0) AS s FROM ledger_entries
         WHERE substr(at_iso, 1, 10) >= ? AND substr(at_iso, 1, 10) <= ?${lbw.sql}`
      )
      .get(b.start, b.end, ...lbw.args);
    ledgerReceiptLikeNgn = Math.round(Number(row?.s) || 0);
  }

  let treasuryCustomerInNgn = 0;
  const rowTm = db
    .prepare(
      `SELECT COALESCE(SUM(m.amount_ngn), 0) AS s
       FROM treasury_movements m
       WHERE substr(m.posted_at_iso, 1, 10) >= ? AND substr(m.posted_at_iso, 1, 10) <= ?
         AND m.type IN ('RECEIPT_IN', 'ADVANCE_IN')`
    )
    .get(b.start, b.end);
  treasuryCustomerInNgn = Math.round(Number(rowTm?.s) || 0);

  return {
    ok: true,
    periodKey: b.periodKey,
    range: { start: b.start, end: b.end },
    branchScope,
    salesReceiptsPostedNgn,
    ledgerReceiptLikeNgn,
    treasuryCustomerInNgn,
    glCash1000Month: pickGlRow(tb, '1000'),
    glAr1200Month: pickGlRow(tb, '1200'),
    note:
      'GL columns are month activity (debits − credits as net). Sub-ledgers respect branch scope where the table has branch_id; treasury movements are not branch-scoped in the schema yet.',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 */
export function getCashFlowPack(db, periodKey) {
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  const raw = db
    .prepare(
      `SELECT type, COALESCE(SUM(amount_ngn), 0) AS totalNgn
       FROM treasury_movements
       WHERE substr(posted_at_iso, 1, 10) >= ? AND substr(posted_at_iso, 1, 10) <= ?
       GROUP BY type
       ORDER BY type`
    )
    .all(b.start, b.end);

  const rows = (raw || []).map((r) => ({
    type: r.type,
    totalNgn: Math.round(Number(r.totalNgn) || 0),
  }));
  const netNgn = rows.reduce((s, r) => s + r.totalNgn, 0);

  return {
    ok: true,
    periodKey: b.periodKey,
    range: { start: b.start, end: b.end },
    rows,
    netTreasuryMovementNgn: netNgn,
    note: 'Sums treasury_movements.amount_ngn by type for the month (signed as stored).',
  };
}
