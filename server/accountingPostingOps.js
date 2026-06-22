/**
 * Phase A — GL posting bridges from treasury / payables / opening balance.
 * @param {import('better-sqlite3').Database} db
 */

import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import { ACCOUNTING_OPENING_DATE_ISO } from '../shared/lib/accountingCutover.js';
import { assertPeriodOpen } from './controlOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { ensureSupplierAdvanceGlAccount } from './ap2SupplierAdvanceGl.js';
import {
  ensureGlSchema,
  getGlAccountIdByCode,
  postBalancedJournal,
  postBalancedJournalTx,
  seedDefaultGlAccounts,
} from './glOps.js';

const OPENING_SOURCE_KIND = 'OPENING_BALANCE';

/** Supplemental COA for architecture v1 (idempotent). */
export function ensureArchitecturalGlAccounts(db) {
  ensureGlSchema(db);
  seedDefaultGlAccounts(db);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  );
  const rows = [
    ['acc-ap-trade', '2000', 'Trade payables — suppliers', 'liability', 38],
    ['acc-loans', '2600', 'Loans payable', 'liability', 77],
    ['acc-capital', '3100', "Owner's capital", 'equity', 5],
    ['acc-drawings', '3200', 'Drawings', 'equity', 6],
    ['acc-retained', '3900', 'Retained earnings', 'equity', 7],
    ['acc-due-from-branch', '1800', 'Due from branch', 'asset', 23],
    ['acc-due-to-branch', '2800', 'Due to branch', 'liability', 78],
    ['acc-fuel', '5010', 'Factory fuel & lubricant', 'expense', 81],
    ['acc-maint', '5020', 'Factory maintenance', 'expense', 82],
    ['acc-corr', '5030', 'Outside corrugation', 'expense', 83],
    ['acc-prod-other', '5040', 'Other production cost', 'expense', 84],
    ['acc-carriage', '5050', 'Carriage inward', 'expense', 85],
    ['acc-admin-sal', '6110', 'Admin salaries', 'expense', 91],
    ['acc-admin', '6120', 'Admin & office expenses', 'expense', 92],
    ['acc-rent', '6130', 'Rent & utilities', 'expense', 93],
    ['acc-it', '6140', 'IT & software', 'expense', 94],
    ['acc-insurance', '6150', 'Insurance & HQ shared', 'expense', 95],
    ['acc-prof', '6160', 'Professional fees & tax', 'expense', 96],
    ['acc-bank-chg', '6170', 'Bank charges', 'expense', 97],
    ['acc-interest', '6300', 'Interest expense', 'expense', 98],
    ['acc-selling', '6400', 'Marketing & selling', 'expense', 99],
    ['acc-fa-land', '1509', 'Land (no depreciation)', 'asset', 33],
    ['acc-payroll-net', '2200', 'Net payroll payable', 'liability', 50],
    ['acc-paye', '2300', 'PAYE payable', 'liability', 60],
    ['acc-pension', '2400', 'Pension payable', 'liability', 70],
    ['acc-payroll-exp', '6000', 'Payroll expense', 'expense', 90],
    ['acc-accum-dep', '1398', 'Accumulated depreciation', 'asset', 31],
    ['acc-dep-exp', '6100', 'Depreciation expense', 'expense', 92],
  ];
  for (const [id, code, name, type, sort] of rows) {
    ins.run(id, code, name, type, sort);
  }
  // Fix legacy mis-map: inter-branch receivable should not reuse inventory 1300.
  try {
    db.prepare(`UPDATE gl_accounts SET code = '1800', name = 'Due from branch', type = 'asset' WHERE id = 'acc-inter-branch' AND code = '1300'`).run();
  } catch {
    /* ignore */
  }
  ins.run('acc-inter-branch', '1800', 'Due from branch', 'asset', 23);
  ins.run('acc-due-to-branch', '2800', 'Due to branch', 'liability', 78);
}

/**
 * Per-bank cash: 1000 + treasury_account.id (e.g. id 1 → 1001).
 * @param {import('better-sqlite3').Database} db
 * @param {number} treasuryAccountId
 */
export function ensureTreasuryCashGlAccount(db, treasuryAccountId) {
  ensureArchitecturalGlAccounts(db);
  const id = Math.round(Number(treasuryAccountId) || 0);
  if (id <= 0) return { ok: false, error: 'treasuryAccountId required.' };
  const code = String(1000 + id);
  const row = db.prepare(`SELECT id, name, bank_name FROM treasury_accounts WHERE id = ?`).get(id);
  const label = row
    ? `Cash — ${String(row.name || row.bank_name || `Account ${id}`).trim()}`
    : `Cash — bank account ${id}`;
  const glId = `acc-cash-${id}`;
  db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  ).run(glId, code, label.slice(0, 120), 'asset', 10 + id);
  if (!getGlAccountIdByCode(db, code)) {
    return { ok: false, error: `Could not ensure GL cash account ${code}.` };
  }
  return { ok: true, accountCode: code, accountName: label };
}

export function treasuryCashGlCode(treasuryAccountId) {
  const id = Math.round(Number(treasuryAccountId) || 0);
  if (id <= 0) return '1000';
  return String(1000 + id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 */
function poReceivedValueNgn(db, poId) {
  const pid = String(poId || '').trim();
  if (!pid) return 0;
  try {
    const rows = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(landed_cost_ngn, 0)), 0) AS s
         FROM coil_lots WHERE po_ref = ?`
      )
      .get(pid);
    return Math.round(Number(rows?.s) || 0);
  } catch {
    return 0;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {number} paymentNgn
 */
export function resolveSupplierPaymentDebitCode(db, poId, paymentNgn) {
  const flags = readFinanceFeatureFlags();
  if (!flags.supplierAdvanceAccountingEnabled) return '2000';
  void paymentNgn;
  const received = poReceivedValueNgn(db, poId);
  const po = db.prepare(`SELECT supplier_paid_ngn FROM purchase_orders WHERE po_id = ?`).get(String(poId || '').trim());
  const paidAfter = Math.round(Number(po?.supplier_paid_ngn) || 0);
  if (received <= 0 || paidAfter > received) {
    ensureSupplierAdvanceGlAccount(db);
    return '1400';
  }
  return '2000';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   treasuryAccountId: number;
 *   amountNgn: number;
 *   entryDateISO: string;
 *   sourceKind: string;
 *   sourceId: string;
 *   poId?: string;
 *   apId?: string;
 *   branchId?: string | null;
 *   createdByUserId?: string | null;
 *   memo?: string;
 *   forceDebitCode?: string;
 * }} payload
 */
export function tryPostSupplierPaymentGlTx(db, payload) {
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };
  const cash = ensureTreasuryCashGlAccount(db, payload.treasuryAccountId);
  if (!cash.ok) return cash;
  const debitCode =
    payload.forceDebitCode ||
    (payload.poId ? resolveSupplierPaymentDebitCode(db, payload.poId, amt) : '2000');
  ensureArchitecturalGlAccounts(db);
  const sk = String(payload.sourceKind || 'SUPPLIER_PAYMENT_GL').trim();
  const sid = String(payload.sourceId || '').trim();
  if (!sid) return { ok: false, error: 'sourceId required for supplier payment GL.' };
  return postBalancedJournalTx(db, {
    entryDateISO: String(payload.entryDateISO || '').slice(0, 10),
    memo: payload.memo || `Supplier payment ${sid}`,
    sourceKind: sk,
    sourceId: sid,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: debitCode, debitNgn: amt, memo: payload.poId || payload.apId || sid },
      { accountCode: cash.accountCode, creditNgn: amt, memo: sid },
    ],
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   treasuryAccountId: number;
 *   amountNgn: number;
 *   entryDateISO: string;
 *   sourceId: string;
 *   expenseCategory?: string;
 *   branchId?: string | null;
 *   createdByUserId?: string | null;
 *   memo?: string;
 *   paymentRequestId?: string;
 * }} payload
 */
export function tryPostExpensePaymentGlTx(db, payload) {
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };
  const cash = ensureTreasuryCashGlAccount(db, payload.treasuryAccountId);
  if (!cash.ok) return cash;
  const { accountCode } = glAccountForExpenseCategory(payload.expenseCategory || 'Others', {
    capexAsAsset: true,
  });
  ensureArchitecturalGlAccounts(db);
  const sid = String(payload.sourceId || '').trim();
  if (!sid) return { ok: false, error: 'sourceId required for expense payment GL.' };
  return postBalancedJournalTx(db, {
    entryDateISO: String(payload.entryDateISO || '').slice(0, 10),
    memo: payload.memo || `Expense payment ${sid}`,
    sourceKind: 'EXPENSE_PAYMENT_GL',
    sourceId: sid,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode, debitNgn: amt, memo: payload.paymentRequestId || sid },
      { accountCode: cash.accountCode, creditNgn: amt, memo: sid },
    ],
  });
}

/**
 * Reclass expense debit between GL accounts after payout (Dr new / Cr old).
 * @param {import('better-sqlite3').Database} db
 */
export function tryPostExpenseCategoryReclassGlTx(db, payload) {
  const amt = Math.round(Number(payload.amountNgn) || 0);
  const fromCode = String(payload.fromAccountCode || '').trim();
  const toCode = String(payload.toAccountCode || '').trim();
  if (amt <= 0 || !fromCode || !toCode) return { ok: true, skipped: true, reason: 'missing_inputs' };
  if (fromCode === toCode) return { ok: true, skipped: true, reason: 'same_account' };

  ensureArchitecturalGlAccounts(db);
  const movementId = String(payload.movementId || '').trim();
  const entityId = String(payload.requestId || payload.expenseId || '').trim();
  const sourceId = String(payload.sourceId || `${entityId}:${movementId}:reclass`).trim();
  if (!sourceId) return { ok: false, error: 'sourceId required for category reclass GL.' };

  return postBalancedJournalTx(db, {
    entryDateISO: String(payload.entryDateISO || '').slice(0, 10),
    memo: payload.memo || `Expense category reclass ${fromCode} → ${toCode}`,
    sourceKind: 'EXPENSE_CATEGORY_RECLASS_GL',
    sourceId,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: toCode, debitNgn: amt, memo: payload.memo || entityId },
      { accountCode: fromCode, creditNgn: amt, memo: payload.memo || entityId },
    ],
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   entryDateISO: string;
 *   sourceId?: string;
 *   branchId?: string | null;
 *   createdByUserId?: string | null;
 *   memo?: string;
 *   lines: Array<{ accountCode: string; debitNgn?: number; creditNgn?: number; memo?: string }>;
 * }} payload
 */
export function postOpeningBalanceJournal(db, payload) {
  ensureArchitecturalGlAccounts(db);
  const entryDate = String(payload.entryDateISO || ACCOUNTING_OPENING_DATE_ISO).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { ok: false, error: 'entryDateISO must be YYYY-MM-DD.' };
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length < 2) {
    return { ok: false, error: 'Opening balance requires at least two lines.' };
  }
  try {
    assertPeriodOpen(db, entryDate, 'Opening balance date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  for (const line of lines) {
    const code = String(line.accountCode || '').trim();
    if (!getGlAccountIdByCode(db, code)) {
      return { ok: false, error: `Unknown GL account code: ${code}` };
    }
  }
  const sourceId = String(payload.sourceId || `OPENING_${entryDate}`).trim();
  return postBalancedJournal(db, {
    entryDateISO: entryDate,
    memo: payload.memo || `Opening balance ${entryDate}`,
    sourceKind: OPENING_SOURCE_KIND,
    sourceId,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines,
  });
}

/** @param {import('better-sqlite3').Database} db */
export function getOpeningBalanceStatus(db) {
  ensureArchitecturalGlAccounts(db);
  const rows = db
    .prepare(
      `SELECT id, entry_date_iso, memo, source_id, created_at_iso
       FROM gl_journal_entries WHERE source_kind = ? ORDER BY created_at_iso DESC LIMIT 5`
    )
    .all(OPENING_SOURCE_KIND);
  return { ok: true, posted: rows.length > 0, journals: rows };
}
