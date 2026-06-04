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

/** @param {string} periodKey */
export function isValidFinancePackPeriodKey(periodKey) {
  return monthBounds(periodKey) != null;
}

/**
 * Warnings when operational cash sources diverge (receipt confirmation tie-out).
 * @param {ReturnType<typeof getReconciliationPack>} pack
 * @param {ReturnType<typeof getCashFlowPack>} cashFlowSummary
 */
export function buildReconciliationPackWarnings(pack, cashFlowSummary) {
  const notes = [];
  if (!pack?.ok) return notes;

  const sales = Math.round(Number(pack.salesReceiptsPostedNgn) || 0);
  const ledger = Math.round(Number(pack.ledgerReceiptLikeNgn) || 0);
  const treasuryIn = Math.round(Number(pack.treasuryCustomerInNgn) || 0);

  if (sales !== ledger) {
    notes.push({
      severity: 'warn',
      code: 'sales_receipts_vs_ledger',
      message:
        'Confirmed sales receipts total differs from ledger receipt-like total for the period. Review cashier confirmation and ledger postings.',
      salesReceiptsPostedNgn: sales,
      ledgerReceiptLikeNgn: ledger,
      differenceNgn: sales - ledger,
    });
  }
  if (sales !== treasuryIn && (sales > 0 || treasuryIn > 0)) {
    notes.push({
      severity: 'warn',
      code: 'sales_receipts_vs_treasury',
      message:
        'Confirmed sales receipts differ from treasury customer inflows (RECEIPT_IN + ADVANCE_IN). Treasury movements are not branch-scoped in the schema yet.',
      salesReceiptsPostedNgn: sales,
      treasuryCustomerInNgn: treasuryIn,
      differenceNgn: sales - treasuryIn,
    });
  }
  if (ledger !== treasuryIn && (ledger > 0 || treasuryIn > 0)) {
    notes.push({
      severity: 'info',
      code: 'ledger_vs_treasury',
      message: 'Ledger receipt-like total differs from treasury customer inflows for the period.',
      ledgerReceiptLikeNgn: ledger,
      treasuryCustomerInNgn: treasuryIn,
      differenceNgn: ledger - treasuryIn,
    });
  }

  const glCashNet = Math.round(Number(pack.glCash1000Month?.netNgn) || 0);
  if (treasuryIn !== 0 && glCashNet !== 0 && Math.abs(treasuryIn - glCashNet) > 1) {
    notes.push({
      severity: 'info',
      code: 'treasury_vs_gl_cash_activity',
      message:
        'Treasury customer inflows do not match GL cash (1000) month activity. GL column is period journal activity, not bank balance.',
      treasuryCustomerInNgn: treasuryIn,
      glCash1000NetActivityNgn: glCashNet,
      differenceNgn: treasuryIn - glCashNet,
    });
  }

  if (String(pack.note || '').trim()) {
    notes.push({
      severity: 'info',
      code: 'pack_methodology',
      message: String(pack.note),
    });
  }
  if (cashFlowSummary?.ok && String(cashFlowSummary.note || '').trim()) {
    notes.push({
      severity: 'info',
      code: 'cash_flow_methodology',
      message: String(cashFlowSummary.note),
    });
  }

  notes.push({
    severity: 'info',
    code: 'head_of_accounts_review',
    message: 'Requires Head of Accounts review before month-end close sign-off.',
  });
  notes.push({
    severity: 'info',
    code: 'formal_bank_reconciliation_pending',
    message: 'Formal bank statement reconciliation is partial / future; do not use bank line import as the primary control.',
  });

  return notes;
}

/**
 * API envelope for GET /api/finance/reconciliation-pack (read-only, management draft).
 * @param {{
 *   pack: ReturnType<typeof getReconciliationPack>;
 *   cashFlowSummary: ReturnType<typeof getCashFlowPack>;
 *   periodKey: string;
 *   branchScope: 'ALL' | string;
 * }} input
 */
export function buildFinanceReconciliationPackEnvelope({ pack, cashFlowSummary, periodKey, branchScope }) {
  const tieOutSections = pack?.ok
    ? [
        {
          id: 'confirmed_sales_receipts',
          label: 'Confirmed sales receipts (posted)',
          description: 'Operational tie-out from sales_receipts (cashier/receipt confirmation basis).',
          amountNgn: pack.salesReceiptsPostedNgn,
        },
        {
          id: 'ledger_receipt_like',
          label: 'Customer ledger receipt-like',
          description: 'RECEIPT, ADVANCE_IN, and RECEIPT_REVERSAL in ledger_entries for the period.',
          amountNgn: pack.ledgerReceiptLikeNgn,
        },
        {
          id: 'treasury_customer_inflow',
          label: 'Treasury customer inflows',
          description: 'treasury_movements RECEIPT_IN and ADVANCE_IN (not formal bank reconciliation).',
          amountNgn: pack.treasuryCustomerInNgn,
        },
        {
          id: 'gl_cash_1000',
          label: 'GL cash (1000) month activity',
          description: 'Period journal net on account 1000 — not bank statement balance.',
          gl: pack.glCash1000Month,
        },
        {
          id: 'gl_ar_1200',
          label: 'GL AR (1200) month activity',
          description: 'Period journal net on account 1200 — not full AR subledger balance.',
          gl: pack.glAr1200Month,
        },
      ]
    : [];

  return {
    ok: true,
    label: 'Finance reconciliation and cash confirmation pack',
    status: 'management_draft',
    disclaimer:
      'This is an operational finance tie-out. It is not statutory reconciliation or audited financial reporting.',
    periodKey,
    branchScope,
    cashConfirmationBasis:
      'Receipt confirmation / cashier confirmation is the current primary cash verification control.',
    formalBankReconciliationStatus: 'Partial / future',
    departmentOwnership: {
      accounting:
        'Head of Accounts owns reconciliation review, GL, reports, and month-end close.',
      cashier: 'Cashier/Treasury owns receipt confirmation and actual cash movement.',
      audit: 'MD reviews exceptions and high-value control issues.',
    },
    pack,
    cashFlowSummary,
    tieOutSections,
    notes: buildReconciliationPackWarnings(pack, cashFlowSummary),
  };
}
