/**
 * Auto-register fixed assets when capex expenses are fully paid via treasury.
 * @param {import('better-sqlite3').Database} db
 */

import { capexExpenseAssetMeta, isCapexExpenseCategory } from '../shared/expenseCategories.js';
import { ensureAccountingPhase2Schema, mapFixedAssetRow } from './accountingPhase2Ops.js';
import { assertPeriodOpen } from './controlOps.js';
import { postBalancedJournalTx } from './glOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function nextFixedAssetId() {
  return `FA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {import('better-sqlite3').Database} db @param {string} expenseId */
export function expenseTreasuryPaidNgn(db, expenseId) {
  const eid = String(expenseId || '').trim();
  const direct = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_ngn)), 0) AS n
       FROM treasury_movements
       WHERE source_kind = 'EXPENSE' AND source_id = ?
         AND amount_ngn < 0
         AND (reverses_movement_id IS NULL OR TRIM(COALESCE(reverses_movement_id, '')) = '')`
    )
    .get(eid);
  const pr = db
    .prepare(`SELECT COALESCE(SUM(paid_amount_ngn), 0) AS n FROM payment_requests WHERE expense_id = ?`)
    .get(eid);
  return roundMoney((Number(direct?.n) || 0) + (Number(pr?.n) || 0));
}

function buildAssetName(exp) {
  const type = String(exp.expense_type || '').trim();
  const ref = String(exp.reference || '').trim();
  const category = String(exp.category || '').trim();
  if (type) return type;
  if (ref) return ref;
  return category ? `${category} (${exp.expense_id})` : String(exp.expense_id);
}

function tryPostCapexCapitalizationJournalTx(db, { expenseId, entryDateISO, amountNgn, glAccountCode, assetName, branchId, createdByUserId }) {
  const amt = roundMoney(amountNgn);
  if (amt <= 0) return { ok: true, skipped: true };
  return postBalancedJournalTx(db, {
    entryDateISO,
    memo: `Capex capitalization — ${assetName}`,
    sourceKind: 'CAPEX_CAPITALIZE',
    sourceId: expenseId,
    branchId,
    createdByUserId,
    lines: [
      { accountCode: glAccountCode, debitNgn: amt, memo: assetName },
      { accountCode: '1000', creditNgn: amt, memo: expenseId },
    ],
  });
}

/**
 * When a capex expense is fully paid, create the fixed-asset register row and GL capitalization.
 * Safe to call inside an existing transaction; idempotent per expense id.
 * @param {import('better-sqlite3').Database} db
 * @param {string} expenseId
 * @param {{ acquisitionDateIso?: string, actor?: { id?: string } | null }} [opts]
 */
export function syncFixedAssetFromCapexExpense(db, expenseId, opts = {}) {
  ensureAccountingPhase2Schema(db);
  const eid = String(expenseId || '').trim();
  if (!eid) return { ok: false, error: 'Expense id is required.' };

  const existing = db.prepare(`SELECT * FROM fixed_assets WHERE source_expense_id = ?`).get(eid);
  if (existing) {
    return { ok: true, duplicate: true, asset: mapFixedAssetRow(existing) };
  }

  const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(eid);
  if (!exp) return { ok: false, error: 'Expense not found.' };

  const category = String(exp.category || '').trim();
  if (!isCapexExpenseCategory(category)) {
    return { ok: true, skipped: true, reason: 'not_capex' };
  }

  const amountNgn = roundMoney(exp.amount_ngn);
  if (amountNgn <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };

  const paidNgn = expenseTreasuryPaidNgn(db, eid);
  if (paidNgn < amountNgn) {
    return { ok: true, skipped: true, reason: 'not_fully_paid', paidNgn, amountNgn };
  }

  const acquisitionDateIso =
    String(opts.acquisitionDateIso || exp.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDateIso)) {
    return { ok: false, error: 'Valid acquisition date is required for capex capitalization.' };
  }

  try {
    assertPeriodOpen(db, acquisitionDateIso, 'Fixed asset acquisition date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const meta = capexExpenseAssetMeta(category);
  const branchId = String(exp.branch_id || '').trim();
  if (!branchId) return { ok: false, error: 'Expense branch is required for fixed asset registration.' };

  const name = buildAssetName(exp);
  const now = new Date().toISOString();
  const uid = opts.actor?.id ? String(opts.actor.id) : null;
  const id = nextFixedAssetId();
  const notes = `Auto-registered from capex expense ${eid}.`;
  const treasuryReference = String(exp.reference || '').trim() || eid;

  db.prepare(
    `INSERT INTO fixed_assets (
      id, name, category, branch_id, acquisition_date_iso, cost_ngn, salvage_ngn, useful_life_months,
      depreciation_method, status, disposal_date_iso, treasury_reference, source_expense_id, notes,
      created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    meta.assetCategory,
    branchId,
    acquisitionDateIso,
    amountNgn,
    0,
    meta.usefulLifeMonths,
    'straight_line',
    'active',
    null,
    treasuryReference,
    eid,
    notes,
    now,
    now,
    uid,
    uid
  );

  const gl = tryPostCapexCapitalizationJournalTx(db, {
    expenseId: eid,
    entryDateISO: acquisitionDateIso,
    amountNgn,
    glAccountCode: meta.glAccountCode,
    assetName: name,
    branchId,
    createdByUserId: uid,
  });
  if (!gl.ok) {
    throw new Error(gl.error || 'Capex GL capitalization failed.');
  }

  const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  return {
    ok: true,
    created: true,
    asset: mapFixedAssetRow(row),
    journalId: gl.journalId ?? null,
    glDuplicate: Boolean(gl.duplicate),
  };
}
