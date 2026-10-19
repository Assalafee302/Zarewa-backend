#!/usr/bin/env node
/**
 * Phase 2 data corrections — APPLY the READY items of a dry-run plan.
 *
 *   node scripts/phase2-apply.mjs --database <schema> --plan exports/phase2-dry-run-<date>.plan.json \
 *        --approver "Name" [--apply]
 *
 * Without --apply it is a CHECK: every item is verified against the database (no writes).
 *
 * Safety:
 * - Refuses any schema whose name does not contain "rehearsal", "fixture" or "test", and any host other than
 *   localhost / 127.0.0.1, unless --live is given AND ZAREWA_PHASE2_LIVE_CONFIRM equals the schema name.
 * - Correct, never delete: field updates are made only when the current value equals the planned "before"
 *   (otherwise the item is skipped and reported); treasury fixes are new reversal lines linked to the original.
 * - Every change writes an audit_log row (hash-chained, via appendAuditLog): before, after, reason, approver.
 * - One transaction per group (A → D → C → B); a failure rolls that group back and stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : '';
};
const has = (name) => args.includes(`--${name}`);
const database = opt('database');
const planPath = opt('plan');
const approver = opt('approver');
const doApply = has('apply');
const live = has('live');
if (!database || !planPath || !approver) {
  console.error('Usage: node scripts/phase2-apply.mjs --database <schema> --plan <plan.json> --approver "Name" [--apply] [--live]');
  process.exit(2);
}

if (live) {
  const { loadLiveMysqlEnv } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2LiveEnv.mjs')).href);
  try {
    loadLiveMysqlEnv(process.env.ZAREWA_PHASE2_ENV_ROOT || BE, database);
  } catch (e) {
    console.error(`Refused: ${e.message}`);
    process.exit(3);
  }
}
const { mysqlConfigFromEnv, createMysqlDatabase, databaseLabel } = await imp('server/mysqlDatabase.js');
const cfg = { ...mysqlConfigFromEnv(), database };
const localHost = /^(localhost|127\.0\.0\.1|::1)$/i.test(cfg.host);
const rehearsalName = /rehearsal|fixture|test/i.test(database);
if (!live && (!localHost || !rehearsalName)) {
  console.error(`Refused: ${databaseLabel(cfg)} — only a local rehearsal/fixture/test schema without --live.`);
  process.exit(3);
}
/** Capex assets post in the open period (owner, 14 Oct: "October adjustment"), not on the locked Sep expense date. */
const adjustmentDate = opt('adjustment-date') || new Date().toISOString().slice(0, 10);
/**
 * Owner, 14 Oct: the capex expenses in the plan are two payments for ONE transformer → one asset, cost = their sum.
 */
const ASSET_NAME = opt('asset-name') || 'Transformer (EXP-KD-26-0362 + 0397)';
const ASSET_NOTE = opt('asset-note') || 'Acquired Sep 2026, transformer, paid in 2 parts';

const { appendAuditLog } = await imp('server/controlOps.js');
const { postBalancedJournalTx, amendBalancedJournalAmountTx } = await imp('server/glOps.js');
const { capexExpenseAssetMeta } = await imp('shared/expenseCategories.js');
const { insertTreasuryMovementTx } = await imp('server/writeOps.js');
const { nextExpenseHumanId } = await imp('server/humanId.js');
const { tryPostExpensePaymentGlTx } = await imp('server/accountingPostingOps.js');
const { assertPeriodOpen } = await imp('server/controlOps.js');
const { getExpenseCategoryLane } = await imp('shared/expenseCategoryLanes.js');
const { reclassifyPaidPaymentRequestCategory } = await imp('server/expenseCategoryReclassOps.js');
const { createInvestigationCase, ensureInvestigationSchema } = await imp('server/office/investigationOps.js');
const { syncFixedAssetFromCapexExpense } = await imp('server/fixedAssetAutomationOps.js');
const { ensureAccountingPhase2Schema } = await imp('server/accountingPhase2Ops.js');
const { ensureTreasuryCashGlAccount } = await imp('server/accountingPostingOps.js');
const { tryPostCustomerRefundPayoutGlTx } = await imp('server/glOps.js');
const { evaluateRefundPayoutGlPolicy } = await imp('server/ap1cReversalRefundOps.js');
const { resolveRefundStatus } = await imp('server/sales/refundPayoutStatus.js');
const { insertLedgerRows, insertAdvanceInEvent, recordCustomerAdvanceCash, insertCustomer } = await imp('server/writeOps.js');
const { tryPostCustomerAdvanceGl } = await imp('server/glOps.js');
const { planAdvanceIn } = await imp('shared/lib/customerLedgerCore.js');
const { tryPostCustomerReceiptRefundFundUnwindGl } = await imp('server/glOps.js');
const { applyFinanceConfirmedReceiptBookAmountTx, payRefundEntry, payPaymentRequest, expenseOutflowTreasuryMovementCorrectTx, reverseTreasurySourceTx, reverseReceiptEntry } = await imp('server/writeOps.js');
const { tryPostExpensePaymentReversalGlTx } = await imp('server/accountingPostingOps.js');
const { buildRefundSettlementSummary, correctRefundPaidAmountNgn, resolveRefundStatus: resolveRefundStatusNow } = await imp('server/sales/refundPayoutStatus.js');
const { refundHeldNetCashDueNgn } = await imp('server/finance/partnerWalletCredit.js');
const { refundTillPayableNgn } = await imp('server/refundHandlers.js');
const { payAccountsPayable, postPurchaseOrderTransport, syncPurchaseOrderTransportPaymentState, updateBankReconciliationLine, patchSalesReceiptFinanceSettlement } = await imp('server/writeOps.js');
const { lockAccountingPeriod, unlockAccountingPeriod } = await imp('server/controlOps.js');
const { insertRefundRequest, previewRefundRequest } = await imp('server/controlOps.js');
const { poSupplierPaymentCapBlock } = await imp('server/procurement/poSupplierAdvanceGuard.js');
const { closeRefundUnpaidRemainder } = await imp('server/sales/payoutRoundingCloseOps.js');
const { PAYOUT_ROUNDING_CLOSE_MAX_NGN } = await imp('shared/lib/payoutRoundingClose.js');
const { nextTreasuryTransferBatchHumanId } = await imp('server/humanId.js');
const { syncQuotationPaidFromReceipts } = await imp('server/writeOps.js');
const { refundStaffAllocationDeductionAmounts } = await imp('shared/lib/refundStaffAllocationDeduction.js');

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
// --only <item id>: run one item of the plan (one short connection per item — the live host resets long ones).
if (opt('only')) {
  plan.items = plan.items.filter((i) => i.id === opt('only'));
  if (!plan.items.length) {
    console.error(`--only ${opt('only')}: not in the plan`);
    process.exit(2);
  }
}
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const actor = {
  id: null,
  displayName: approver,
  name: approver,
  jobTitle: 'Operations Manager',
  permissions: ['investigation.manage'],
};
const approvedAtISO = new Date().toISOString();
/** The owner's own ERP user, for ERP pay functions that check who pays (admin passes segregation checks). */
const ownerActor = { id: 'USR-ADMIN', displayName: approver, name: approver, username: 'admin', roleKey: 'admin', jobTitle: 'Operations Manager', permissions: ['*'] };
const ALLOWED = {
  coil_lots: { key: 'coil_no', cols: ['unit_cost_ngn_per_kg', 'received_at_iso', 'gauge_label'] },
  production_jobs: { key: 'job_id', cols: ['status'] },
  sales_receipts: { key: 'id', cols: ['method', 'status'] },
  expenses: { key: 'expense_id', cols: ['category', 'expense_type'] },
  customer_refunds: { key: 'refund_id', cols: ['amount_ngn', 'approved_amount_ngn'] },
};

const same = (current, expected, compare) => {
  if (expected == null || expected === '' || expected === '(none)') return current == null || current === '' || Number(current) === 0;
  if (compare === 'day') return String(current || '').slice(0, 10) === String(expected).slice(0, 10);
  if (typeof expected === 'number' || (/^-?\d+(\.\d+)?$/.test(String(expected)) && /^-?\d+(\.\d+)?$/.test(String(current ?? '')))) {
    return Number(current) === Number(expected);
  }
  return String(current ?? '').trim() === String(expected).trim();
};
/** Locked accounting month → reason text (CHECK reports it as BLOCKED; APPLY refuses). */
const lockedPeriodWhy = (dateISO, label) => {
  try {
    assertPeriodOpen(db, String(dateISO).slice(0, 10), label);
    return '';
  } catch (e) {
    return String(e.message || e);
  }
};
const blockedOrThrow = (item, why) => {
  if (doApply) throw new Error(`${item.id}: ${why}`);
  return { outcome: 'BLOCKED', why };
};
/** Ledger balance of a treasury account before a cut-off (opening + movements posted before it). */
const accountBalanceAt = (accountId, cutISO) => {
  const a = db.prepare(`SELECT opening_balance_ngn AS o FROM treasury_accounts WHERE id = ?`).get(accountId);
  const s = db.prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ? AND posted_at_iso < ?`).get(accountId, cutISO);
  return Math.round(Number(a?.o || 0) + Number(s?.s || 0));
};
/** Live RECEIPT_IN lines of a receipt (not reversed). */
const receiptLinesTotalNgn = (receiptId) =>
  Math.round(
    Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(tm.amount_ngn), 0) AS s FROM treasury_movements tm
           WHERE tm.source_kind = 'LEDGER_RECEIPT' AND tm.type = 'RECEIPT_IN' AND tm.source_id = ?
             AND (tm.reverses_movement_id IS NULL OR TRIM(tm.reverses_movement_id) = '')
             AND NOT EXISTS (SELECT 1 FROM treasury_movements r WHERE r.reverses_movement_id = tm.id)`
        )
        .get(receiptId)?.s
    ) || 0
  );
/**
 * A cleared receipt must carry one amount in three places: receipt book (amount_ngn), confirmed field
 * (bank_received_amount_ngn — what refunds, credit caps and quotation paid read) and its live treasury lines.
 * Returns '' when aligned, else the mismatch text. (R2–R4 corrections left the confirmed field behind, 19 Oct.)
 */
const confirmedFieldMismatch = (receiptId) => {
  const sr = db
    .prepare(`SELECT amount_ngn, bank_received_amount_ngn, status, finance_reconciliation_saved_at_iso AS saved FROM sales_receipts WHERE id = ?`)
    .get(receiptId);
  if (!sr || sr.bank_received_amount_ngn == null || /reversed/i.test(String(sr.status || ''))) return '';
  // Partial split confirms are not finished yet; only a cleared receipt must agree everywhere.
  if (!/^(cleared|confirmed)$/i.test(String(sr.status || '').trim()) && !String(sr.saved || '').trim()) return '';
  const book = Math.round(Number(sr.amount_ngn));
  const confirmed = Math.round(Number(sr.bank_received_amount_ngn));
  const lines = receiptLinesTotalNgn(receiptId);
  if (book === confirmed && (lines === confirmed || confirmed === 0)) return '';
  return `${receiptId}: receipt ₦${book} / confirmed field ₦${confirmed} / treasury lines ₦${lines} do not agree`;
};
const assertConfirmedFieldAligned = (item, receiptId) => {
  const why = confirmedFieldMismatch(receiptId);
  if (why) throw new Error(`${item.id}: ${why}`);
};
const audit = (item, op, details) =>
  appendAuditLog(db, {
    actor,
    action: 'phase2.correction',
    entityKind: op.table || op.kind,
    entityId: op.key || op.coilNo || op.movementId || item.record,
    status: 'applied',
    note: `${item.id} ${item.reason}`.slice(0, 900),
    details: { correctionId: item.id, field: item.field, approver, approvedAtISO, ...details },
  });

/**
 * Capex expenses whose fixed asset is still to register. The ERP's sync runs DDL (implicit MySQL commit), so it runs
 * after the group transaction has committed — never inside it.
 */
const pendingCapex = [];
const assetFor = (expenseId) =>
  db.prepare(`SELECT id, name, notes, cost_ngn, acquisition_date_iso FROM fixed_assets WHERE source_expense_id = ?`).get(expenseId);
/** Capex expenses of the plan, in plan order: the first carries the asset row, the others add to its cost. */
const capexKeys = plan.items.flatMap((i) => i.ops.filter((o) => o.afterHook === 'capexSync').map((o) => o.key));
const expenseAmount = (id) => Math.round(Number(db.prepare(`SELECT amount_ngn AS a FROM expenses WHERE expense_id = ?`).get(id)?.a) || 0);
const capexJournalFor = (id) =>
  db.prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'CAPEX_CAPITALIZE' AND source_id = ?`).get(id);
const capexTotal = () => capexKeys.reduce((s, k) => s + expenseAmount(k), 0);

function combinedCapexDone() {
  if (!capexKeys.length) return true;
  const a = assetFor(capexKeys[0]);
  if (!a || a.name !== ASSET_NAME || a.notes !== ASSET_NOTE || Number(a.cost_ngn) !== capexTotal()) return false;
  return capexKeys.slice(1).every((k) => capexJournalFor(k) && !assetFor(k));
}

/**
 * ONE fixed asset for all capex expenses of the plan (owner: two payments for one transformer), dated in the open
 * period (October adjustment). The first expense goes through the ERP's own sync (asset row + capitalisation
 * journal); every further expense gets the same kind of capitalisation journal (no second asset), and the asset's
 * cost becomes the sum. Journals total = asset cost. Name / notes ≤ 100 characters. Re-runs finish half-done work.
 */
function registerCombinedCapexAsset(item) {
  const [primary, ...others] = capexKeys;
  let asset = assetFor(primary);
  if (!asset) {
    const r = syncFixedAssetFromCapexExpense(db, primary, { actor, acquisitionDateIso: adjustmentDate });
    if (r?.skipped) return `fixed asset not created (${r.reason})`;
    if (!r?.ok) throw new Error(`${item.id}: fixed asset — ${r?.error}`);
    asset = assetFor(primary);
  }
  for (const k of others) {
    const own = assetFor(k);
    if (own) throw new Error(`${item.id}: expense ${k} already has its own fixed asset ${own.id} — resolve before combining`);
    if (capexJournalFor(k)) continue;
    const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(k);
    const amt = expenseAmount(k);
    const meta = capexExpenseAssetMeta(exp.category);
    const journal = postBalancedJournalTx(db, {
      entryDateISO: asset.acquisition_date_iso,
      memo: `Capex capitalization — ${ASSET_NAME}`,
      sourceKind: 'CAPEX_CAPITALIZE',
      sourceId: k,
      branchId: exp.branch_id,
      createdByUserId: null,
      lines: [
        { accountCode: meta.glAccountCode, debitNgn: amt, memo: ASSET_NAME },
        { accountCode: '1000', creditNgn: amt, memo: k },
      ],
    });
    audit(item, { kind: 'capexJournal', table: 'gl_journal_entries', key: k }, { sourceExpense: k, amountNgn: amt, asset: asset.id, journal });
  }
  const total = capexTotal();
  const name = ASSET_NAME.slice(0, 100);
  const notes = ASSET_NOTE.slice(0, 100);
  if (asset.name !== name || asset.notes !== notes || Number(asset.cost_ngn) !== total) {
    db.prepare(`UPDATE fixed_assets SET name = ?, notes = ?, cost_ngn = ?, updated_at_iso = ? WHERE id = ?`).run(
      name, notes, total, new Date().toISOString(), asset.id
    );
    audit(item, { kind: 'capexAsset', table: 'fixed_assets', key: asset.id }, {
      table: 'fixed_assets', key: asset.id, expenses: capexKeys, acquisitionDateIso: asset.acquisition_date_iso,
      before: { name: asset.name, notes: asset.notes, cost_ngn: asset.cost_ngn }, after: { name, notes, cost_ngn: total },
    });
  }
  return `fixed asset ${asset.id} "${name}", cost ₦${total.toLocaleString('en-NG')}, dated ${asset.acquisition_date_iso}`;
}

function runOp(item, op) {
  if (op.kind === 'update') {
    const t = ALLOWED[op.table];
    if (!t || t.key !== op.keyCol || !t.cols.includes(op.col)) throw new Error(`${item.id}: ${op.table}.${op.col} not allowed`);
    const row = db.prepare(`SELECT ${op.col} AS v FROM ${op.table} WHERE ${op.keyCol} = ?`).get(op.key);
    if (!row) return { outcome: 'skipped', why: 'record not found' };
    if (same(row.v, op.after, op.compare)) {
      // Category already corrected but its fixed asset not yet registered / named: finish it after the group commits.
      if (op.afterHook === 'capexSync' && !combinedCapexDone()) {
        if (!doApply) return { outcome: 'would apply', capex: `fixed asset to register (${adjustmentDate})` };
        pendingCapex.push({ item, op });
        return { outcome: 'applied', capex: 'fixed asset queued' };
      }
      return { outcome: 'skipped', why: 'already at the planned value' };
    }
    if (!same(row.v, op.before, op.compare)) return { outcome: 'skipped', why: `current value ${JSON.stringify(row.v)} ≠ planned before ${JSON.stringify(op.before)}` };
    if (!doApply) return { outcome: 'would apply' };
    let after = op.after;
    if (op.compare === 'day') after = `${op.after}${String(row.v || '').slice(10)}`;
    db.prepare(`UPDATE ${op.table} SET ${op.col} = ? WHERE ${op.keyCol} = ?`).run(after, op.key);
    audit(item, op, { table: op.table, key: op.key, column: op.col, before: row.v, after });
    if (op.afterHook === 'capexSync') {
      pendingCapex.push({ item, op });
      return { outcome: 'applied', capex: 'fixed asset queued' };
    }
    return { outcome: 'applied' };
  }
  if (op.kind === 'grnDate') {
    const rows = db
      .prepare(`SELECT id, date_iso, at_iso FROM stock_movements WHERE type = 'STORE_GRN' AND detail LIKE ?`)
      .all(`${op.coilNo} %`)
      .concat(db.prepare(`SELECT id, date_iso, at_iso FROM stock_movements WHERE type = 'STORE_GRN' AND detail = ?`).all(op.coilNo));
    if (!rows.length) return { outcome: 'skipped', why: 'GRN movement not found' };
    const todo = rows.filter((r) => String(r.date_iso).slice(0, 10) === op.before);
    if (!todo.length) {
      return rows.every((r) => String(r.date_iso).slice(0, 10) === op.after)
        ? { outcome: 'skipped', why: 'already at the planned value' }
        : { outcome: 'skipped', why: `GRN dated ${rows.map((r) => r.date_iso).join(', ')} ≠ planned before ${op.before}` };
    }
    if (!doApply) return { outcome: 'would apply', movements: todo.map((r) => r.id) };
    for (const r of todo) {
      const atISO = `${op.after}${String(r.at_iso || '').slice(10) || 'T12:00:00'}`;
      db.prepare(`UPDATE stock_movements SET date_iso = ?, at_iso = ? WHERE id = ?`).run(op.after, atISO, r.id);
      audit(item, { ...op, table: 'stock_movements', key: r.id }, { table: 'stock_movements', key: r.id, coilNo: op.coilNo, before: { date_iso: r.date_iso, at_iso: r.at_iso }, after: { date_iso: op.after, at_iso: atISO } });
    }
    return { outcome: 'applied', movements: todo.map((r) => r.id) };
  }
  if (op.kind === 'reverseTreasuryLine') {
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    const rev = db.prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`).get(op.movementId);
    if (rev) return { outcome: 'skipped', why: `already reversed by ${rev.id}` };
    if (!doApply) return { outcome: 'would apply' };
    const created = insertTreasuryMovementTx(db, {
      type: 'RECEIPT_REVERSAL_OUT',
      treasuryAccountId: tm.treasury_account_id,
      amountNgn: -Number(tm.amount_ngn),
      postedAtISO: approvedAtISO,
      reference: tm.reference,
      counterpartyKind: tm.counterparty_kind,
      counterpartyId: tm.counterparty_id,
      counterpartyName: tm.counterparty_name,
      sourceKind: tm.source_kind,
      sourceId: tm.source_id,
      note: `Phase 2 ${item.id}: ${item.reason}. Approved by ${approver}.`.slice(0, 500),
      createdBy: approver,
      reversesMovementId: tm.id,
      branchId: 'BR-KD',
      allowNegativeBalance: true,
    });
    audit(item, op, { table: 'treasury_movements', reversed: tm.id, created: created?.id, amountNgn: -Number(tm.amount_ngn) });
    return { outcome: 'applied', created: created?.id };
  }
  if (op.kind === 'investigationCase') {
    const linked = db
      .prepare(
        `SELECT l.case_id FROM investigation_links l WHERE l.entity_type = ? AND l.entity_id IN (${op.links.map(() => '?').join(',')})`
      )
      .get(op.links[0].entityType, ...op.links.map((l) => l.entityId));
    if (linked) return { outcome: 'skipped', why: `already on case ${linked.case_id}` };
    if (!doApply) return { outcome: 'would apply' };
    const r = createInvestigationCase(
      db,
      { ...op, note: `Phase 2 ${item.id}: ${item.reason}. Approved by ${approver}.`, alreadyInTransaction: true },
      actor
    );
    if (!r?.ok && r?.ok !== undefined) throw new Error(`${item.id}: ${r.error}`);
    const caseId = r?.case?.id || r?.id || r?.investigation?.id || '';
    audit(item, op, { table: 'investigation_cases', caseId, links: op.links });
    return { outcome: 'applied', caseId };
  }
  if (op.kind === 'postExpense') {
    // A paid expense on its real date, the way the ERP posts one (insertExpenseEntry): expense row, treasury EXPENSE
    // line, expense-payment GL journal, `expense.create` audit — plus the Phase 2 audit. Never posted twice: an expense
    // with the same date, amount, category and description means it is already there.
    const existing = db
      .prepare(
        `SELECT expense_id FROM expenses WHERE date = ? AND amount_ngn = ? AND category = ? AND expense_type = ? AND branch_id = ?`
      )
      .get(op.date, op.amountNgn, op.category, op.expenseType, op.branchId);
    if (existing) return { outcome: 'skipped', why: `already posted as ${existing.expense_id}` };
    const account = db.prepare(`SELECT id, name, bank_name, branch_id FROM treasury_accounts WHERE id = ?`).get(op.treasuryAccountId);
    if (!account || account.branch_id !== op.branchId) return { outcome: 'skipped', why: `treasury account ${op.treasuryAccountId} not found on ${op.branchId}` };
    assertPeriodOpen(db, op.date, 'Expense date');
    const asset = op.addToAsset ? db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(op.addToAsset.assetId) : null;
    if (op.addToAsset) {
      if (!asset) return { outcome: 'skipped', why: `fixed asset ${op.addToAsset.assetId} not found` };
      if (Number(asset.cost_ngn) !== op.addToAsset.expectedCostNgn) {
        return { outcome: 'skipped', why: `asset cost ₦${asset.cost_ngn} ≠ planned before ₦${op.addToAsset.expectedCostNgn}` };
      }
      assertPeriodOpen(db, asset.acquisition_date_iso, 'Asset capitalisation date');
    }
    if (!doApply) {
      return {
        outcome: 'would apply',
        account: `${account.name} (${account.bank_name})`,
        ...(asset ? { asset: `${asset.id} cost ₦${asset.cost_ngn} → ₦${Number(asset.cost_ngn) + op.amountNgn}, capitalised ${asset.acquisition_date_iso}` } : {}),
      };
    }
    const expenseID = nextExpenseHumanId(db, op.branchId);
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id, category_lane)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(expenseID, op.expenseType, op.amountNgn, op.date, op.category, op.paymentMethod, op.reference, op.branchId, getExpenseCategoryLane(op.category));
    const movement = insertTreasuryMovementTx(db, {
      type: 'EXPENSE',
      treasuryAccountId: op.treasuryAccountId,
      amountNgn: -op.amountNgn,
      // Optional bank time (e.g. a charge at 09:44) — default noon UTC on the expense date.
      postedAtISO: op.postedAtISO || `${op.date}T12:00:00.000Z`,
      reference: op.reference,
      counterpartyKind: 'EXPENSE',
      counterpartyId: expenseID,
      counterpartyName: op.category,
      sourceKind: 'EXPENSE',
      sourceId: expenseID,
      note: op.expenseType,
      createdBy: approver,
      branchId: op.branchId,
      allowNegativeBalance: true,
    });
    const gl = tryPostExpensePaymentGlTx(db, {
      treasuryAccountId: op.treasuryAccountId,
      amountNgn: op.amountNgn,
      entryDateISO: op.date,
      sourceId: movement.id,
      expenseCategory: op.category,
      branchId: op.branchId,
      createdByUserId: null,
      memo: op.expenseType,
    });
    if (!gl.ok && !gl.skipped && !gl.duplicate) throw new Error(`${item.id}: GL — ${gl.error}`);
    appendAuditLog(db, {
      actor,
      action: 'expense.create',
      entityKind: 'expense',
      entityId: expenseID,
      note: op.expenseType,
      details: { amountNgn: op.amountNgn, treasuryAccountId: op.treasuryAccountId },
    });
    audit(item, { ...op, table: 'expenses', key: expenseID }, {
      table: 'expenses', key: expenseID, treasuryMovementId: movement.id, glJournal: gl.id || gl.journalId || null,
      date: op.date, amountNgn: op.amountNgn, account: `${account.name} (${account.bank_name})`,
    });
    if (asset) {
      // Additional cost on an existing capex asset, the way the combined transformer asset was built: capitalisation
      // journal on the asset's date (open period), asset cost += amount, name / notes updated.
      const meta = capexExpenseAssetMeta(op.category);
      const name = op.addToAsset.name.replace('{expenseId}', expenseID.replace('EXP-KD-26-', '')).slice(0, 100);
      const notes = op.addToAsset.notes.slice(0, 100);
      const journal = postBalancedJournalTx(db, {
        entryDateISO: asset.acquisition_date_iso,
        memo: `Capex capitalization — ${name}`,
        sourceKind: 'CAPEX_CAPITALIZE',
        sourceId: expenseID,
        branchId: op.branchId,
        createdByUserId: null,
        lines: [
          { accountCode: meta.glAccountCode, debitNgn: op.amountNgn, memo: name },
          { accountCode: '1000', creditNgn: op.amountNgn, memo: expenseID },
        ],
      });
      const cost = Number(asset.cost_ngn) + op.amountNgn;
      db.prepare(`UPDATE fixed_assets SET name = ?, notes = ?, cost_ngn = ?, updated_at_iso = ? WHERE id = ?`).run(name, notes, cost, new Date().toISOString(), asset.id);
      audit(item, { kind: 'capexAsset', table: 'fixed_assets', key: asset.id }, {
        table: 'fixed_assets', key: asset.id, addedExpense: expenseID, journal,
        before: { name: asset.name, notes: asset.notes, cost_ngn: asset.cost_ngn }, after: { name, notes, cost_ngn: cost },
      });
      return { outcome: 'applied', expenseID, treasuryMovementId: movement.id, asset: `${asset.id} cost ₦${cost}` };
    }
    return { outcome: 'applied', expenseID, treasuryMovementId: movement.id };
  }
  if (op.kind === 'moveTreasury') {
    // Bank line booked on the wrong account / date: correct the treasury line in place (account + date), keep its
    // links, move the stored balances, and reclass any GL line that sits on the old account's cash code.
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    const cur = String(tm.posted_at_iso || '').slice(0, 10);
    if (Number(tm.treasury_account_id) === op.toAccountId && cur === op.toDate) return { outcome: 'skipped', why: 'already at the planned value' };
    if (Number(tm.treasury_account_id) !== op.fromAccountId || cur !== op.fromDate) {
      return { outcome: 'skipped', why: `current account ${tm.treasury_account_id} / ${cur} ≠ planned before ${op.fromAccountId} / ${op.fromDate}` };
    }
    const rev = db.prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`).get(tm.id);
    if (rev) return { outcome: 'skipped', why: `line is reversed by ${rev.id}` };
    assertPeriodOpen(db, op.fromDate, 'Current treasury date');
    assertPeriodOpen(db, op.toDate, 'New treasury date');
    const fromGl = `acc-cash-${op.fromAccountId}`;
    const glLines = db
      .prepare(
        `SELECT l.journal_id, l.debit_ngn, l.credit_ngn FROM gl_journal_lines l JOIN gl_journal_entries j ON j.id = l.journal_id
         WHERE l.account_id = ? AND (j.source_id = ? OR l.memo = ?)`
      )
      .all(fromGl, tm.id, tm.id);
    const glNet = glLines.reduce((s, l) => s + Number(l.debit_ngn || 0) - Number(l.credit_ngn || 0), 0);
    if (!doApply) return { outcome: 'would apply', amountNgn: tm.amount_ngn, glReclassNgn: glNet };
    const after = `${op.toDate}${String(tm.posted_at_iso).slice(10) || 'T12:00:00.000Z'}`;
    db.prepare(`UPDATE treasury_movements SET treasury_account_id = ?, posted_at_iso = ? WHERE id = ?`).run(op.toAccountId, after, tm.id);
    const amt = Number(tm.amount_ngn);
    db.prepare(`UPDATE treasury_accounts SET balance = balance - ? WHERE id = ?`).run(amt, op.fromAccountId);
    db.prepare(`UPDATE treasury_accounts SET balance = balance + ? WHERE id = ?`).run(amt, op.toAccountId);
    let journal = null;
    if (glNet !== 0) {
      const from = ensureTreasuryCashGlAccount(db, op.fromAccountId);
      const to = ensureTreasuryCashGlAccount(db, op.toAccountId);
      const a = Math.abs(glNet);
      // Original journal credited (money out) or debited (money in) the old account: move that side to the new one.
      const lines = glNet < 0
        ? [{ accountCode: from.accountCode, debitNgn: a, memo: tm.id }, { accountCode: to.accountCode, creditNgn: a, memo: tm.id }]
        : [{ accountCode: to.accountCode, debitNgn: a, memo: tm.id }, { accountCode: from.accountCode, creditNgn: a, memo: tm.id }];
      journal = postBalancedJournalTx(db, {
        entryDateISO: op.fromDate,
        memo: `Phase 2 ${item.id}: ${tm.id} moved to ${to.accountName}`.slice(0, 200),
        sourceKind: 'PHASE2_TREASURY_MOVE',
        sourceId: tm.id,
        branchId: 'BR-KD',
        createdByUserId: null,
        lines,
      });
    }
    audit(item, { ...op, table: 'treasury_movements', key: tm.id }, {
      table: 'treasury_movements', key: tm.id, note: op.note,
      before: { treasury_account_id: tm.treasury_account_id, posted_at_iso: tm.posted_at_iso },
      after: { treasury_account_id: op.toAccountId, posted_at_iso: after }, glReclassNgn: glNet, journal,
    });
    return { outcome: 'applied', glReclassNgn: glNet };
  }
  if (op.kind === 'refundRepay') {
    // Refund recorded paid on the wrong date / amount / payee. Corrected in place (the ERP's payout reversal would
    // delete the REFUND_ADVANCE ledger slice): treasury line, ledger slice and refund row get the bank's date and
    // amount; GL: the old payout journal is reversed on its date and a new one posted on the bank date.
    const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (!r) return { outcome: 'skipped', why: 'refund not found' };
    const lines = db
      .prepare(`SELECT * FROM treasury_movements WHERE source_kind = 'REFUND' AND source_id = ? AND type IN ('REFUND_PAYOUT', 'REFUND_PAYOUT_REVERSAL_IN')`)
      .all(op.refundId);
    const tm = lines.find((l) => l.id === op.originalMovementId);
    if (!tm || lines.length !== 1) return { outcome: 'skipped', why: `payout lines ${lines.map((l) => l.id).join(', ') || 'none'} ≠ planned ${op.originalMovementId}` };
    if (Number(r.paid_amount_ngn) === op.amountNgn && String(r.paid_at_iso).slice(0, 10) === op.payDate) return { outcome: 'skipped', why: 'already at the planned value' };
    if (Number(r.paid_amount_ngn) !== op.expectedPaidNgn || Number(tm.amount_ngn) !== -op.expectedPaidNgn) {
      return { outcome: 'skipped', why: `paid ₦${r.paid_amount_ngn} / line ₦${tm.amount_ngn} ≠ planned ₦${op.expectedPaidNgn}` };
    }
    const slices = db.prepare(`SELECT * FROM ledger_entries WHERE bank_reference = ? AND type IN ('REFUND_ADVANCE', 'REFUND_OVERPAY', 'REFUND_CONCESSION')`).all(op.refundId);
    if (slices.length > 1) return { outcome: 'skipped', why: `${slices.length} ledger slices — split by hand` };
    const oldJournals = db.prepare(`SELECT id, entry_date_iso, source_id FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_REFUND_PAYOUT_GL' AND source_id LIKE ?`).all(`${op.refundId}:%`);
    assertPeriodOpen(db, op.reverseDate, 'Old payout date');
    assertPeriodOpen(db, op.payDate, 'Bank payout date');
    const current = { paidNgn: r.paid_amount_ngn, paidAt: r.paid_at_iso, payee: r.payee_name, status: r.status, line: `${tm.id} acct ${tm.treasury_account_id} ${tm.posted_at_iso} ₦${tm.amount_ngn}`, slices: slices.map((s) => `${s.id} ${s.type} ₦${s.amount_ngn}`), journals: oldJournals.map((j) => j.id) };
    if (!doApply) return { outcome: 'would apply', current };
    const atISO = `${op.payDate}T12:00:00.000Z`;
    db.prepare(`UPDATE treasury_movements SET treasury_account_id = ?, posted_at_iso = ?, amount_ngn = ?, note = ? WHERE id = ?`).run(
      op.treasuryAccountId, atISO, -op.amountNgn, `${op.payeeName}. ${op.note}`.slice(0, 500), tm.id
    );
    db.prepare(`UPDATE treasury_accounts SET balance = balance - ? WHERE id = ?`).run(Number(tm.amount_ngn), tm.treasury_account_id);
    db.prepare(`UPDATE treasury_accounts SET balance = balance - ? WHERE id = ?`).run(op.amountNgn, op.treasuryAccountId);
    for (const s of slices) {
      db.prepare(`UPDATE ledger_entries SET amount_ngn = ?, at_iso = ? WHERE id = ?`).run(Math.min(Number(s.amount_ngn), op.amountNgn), atISO, s.id);
    }
    const reversals = [];
    for (const j of oldJournals) {
      const jl = db.prepare(`SELECT l.debit_ngn, l.credit_ngn, l.memo, a.code FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.journal_id = ?`).all(j.id);
      reversals.push(
        postBalancedJournalTx(db, {
          entryDateISO: String(j.entry_date_iso).slice(0, 10),
          memo: `Phase 2 ${item.id}: reverse ${j.id} (${op.refundId} not paid on this date)`,
          sourceKind: 'PHASE2_REFUND_CORRECTION',
          sourceId: `${op.refundId}:${j.id}`,
          branchId: r.branch_id,
          createdByUserId: null,
          lines: jl.map((l) => ({ accountCode: l.code, debitNgn: Number(l.credit_ngn) || 0, creditNgn: Number(l.debit_ngn) || 0, memo: l.memo })),
        })
      );
    }
    const policy = evaluateRefundPayoutGlPolicy(db, {
      quotationRef: r.quotation_ref, customerId: r.customer_id, refundId: op.refundId,
      reasonCategories: (() => { try { return JSON.parse(r.reason_category); } catch { return [r.reason_category]; } })(),
      calculationLines: (() => { try { return JSON.parse(r.calculation_lines_json); } catch { return []; } })(),
    });
    const gl = tryPostCustomerRefundPayoutGlTx(db, {
      refundId: op.refundId, payoutAmountNgn: op.amountNgn, payoutMovementIds: [tm.id], entryDateISO: op.payDate,
      branchId: r.branch_id, createdByUserId: null, needsRevenueReview: policy.needsRevenueReview, debitAccountCode: policy.debitAccountCode,
      // Keyed on the correction: the original journal (same movement) was just reversed and must not swallow this one.
      correctionId: item.id,
    });
    if (!gl.ok || gl.skipped || gl.duplicate) {
      throw new Error(`${item.id}: corrected payout journal not posted (${gl.duplicate ? `duplicate of ${gl.journalId}` : gl.error || 'skipped'})`);
    }
    const nextRow = { ...r, paid_amount_ngn: op.amountNgn };
    const status = resolveRefundStatus(db, nextRow);
    db.prepare(
      `UPDATE customer_refunds SET paid_amount_ngn = ?, paid_at_iso = ?, payee_name = ?, payment_note = ?, status = ? WHERE refund_id = ?`
    ).run(op.amountNgn, op.payDate, op.payeeName, op.note, status, op.refundId);
    audit(item, { ...op, table: 'customer_refunds', key: op.refundId }, {
      table: 'customer_refunds', key: op.refundId, before: current,
      after: { paidNgn: op.amountNgn, paidAt: op.payDate, payee: op.payeeName, status, line: `${tm.id} acct ${op.treasuryAccountId} ${atISO} ₦${-op.amountNgn}`, unpaidNgn: Number(r.approved_amount_ngn) - op.amountNgn },
      glReversals: reversals, glPayout: gl,
    });
    return { outcome: 'applied', status };
  }
  if (op.kind === 'reconLink') {
    // One bank line ↔ ERP treasury lines, as a bank-reconciliation row; its description carries the payer name
    // (the sales report's "Paid by" falls back to the matched bank narration).
    const tms = db.prepare(`SELECT id, amount_ngn, treasury_account_id FROM treasury_movements WHERE id IN (${op.movementIds.map(() => '?').join(',')})`).all(...op.movementIds);
    if (tms.length !== op.movementIds.length) return { outcome: 'skipped', why: 'treasury line(s) not found' };
    if (tms.some((t) => Number(t.treasury_account_id) !== op.treasuryAccountId)) return { outcome: 'skipped', why: 'treasury line(s) not on the planned account' };
    const linked = db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE ${op.movementIds.map(() => 'system_match LIKE ?').join(' OR ')}`).get(...op.movementIds.map((id) => `%${id}%`));
    if (linked) return { outcome: 'skipped', why: `already linked on ${linked.id}` };
    const erpNgn = tms.reduce((s, t) => s + Number(t.amount_ngn), 0);
    const varianceNgn = op.amountNgn - erpNgn;
    if (!doApply) return { outcome: 'would apply', erpNgn, varianceNgn };
    const last = db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE id LIKE 'BKR-KD-26-%' ORDER BY id DESC LIMIT 1`).get();
    const id = `BKR-KD-26-${String((Number(String(last?.id || '0').replace(/\D+/g, '').slice(-4)) || 0) + 1).padStart(4, '0')}`;
    const match = `${op.movementIds.join(' + ')}${varianceNgn ? ` · bank ₦${varianceNgn.toLocaleString('en-NG')} more than the receipts` : ''}`;
    db.prepare(
      `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id,
         matched_system_amount_ngn, variance_ngn, variance_percent, treasury_account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, op.bankDateISO, op.description, op.amountNgn, match, 'Matched', op.branchId, erpNgn, varianceNgn, erpNgn ? Math.round((varianceNgn / erpNgn) * 10000) / 100 : null, op.treasuryAccountId);
    audit(item, { ...op, table: 'bank_reconciliation_lines', key: id }, { table: 'bank_reconciliation_lines', key: id, after: { description: op.description, amountNgn: op.amountNgn, systemMatch: match, varianceNgn } });
    return { outcome: 'applied', id, varianceNgn };
  }
  if (op.kind === 'setNote') {
    // Treasury line description (note) only, when it still equals the planned "before".
    const tm = db.prepare(`SELECT id, note FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    if (String(tm.note ?? '') === op.after) return { outcome: 'skipped', why: 'already at the planned value' };
    if (String(tm.note ?? '') !== String(op.before ?? '')) return { outcome: 'skipped', why: `current note ${JSON.stringify(tm.note)} ≠ planned before` };
    if (!doApply) return { outcome: 'would apply' };
    db.prepare(`UPDATE treasury_movements SET note = ? WHERE id = ?`).run(op.after, tm.id);
    audit(item, { ...op, table: 'treasury_movements', key: tm.id }, { table: 'treasury_movements', key: tm.id, column: 'note', before: tm.note, after: op.after });
    return { outcome: 'applied' };
  }
  if (op.kind === 'customerAdvance') {
    // Money received with no quotation to apply it to → customer advance (unapplied credit, not income), the way the
    // ERP's advance desk posts one: ADVANCE_IN ledger row + advance event + treasury ADVANCE_IN + advance GL. The
    // payer becomes a customer when not on file. Then the bank-recon link that showed the excess names this advance.
    // op.customerId pins the customer when the name is not unique (e.g. "SURAJO").
    let cust = op.customerId
      ? db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(op.customerId)
      : db.prepare(`SELECT customer_id, name FROM customers WHERE LOWER(name) = LOWER(?) AND branch_id = ?`).get(op.customerName, op.branchId);
    if (op.customerId && !cust) return { outcome: 'skipped', why: `customer ${op.customerId} not found` };
    const dup = cust
      ? db.prepare(`SELECT id FROM ledger_entries WHERE type = 'ADVANCE_IN' AND customer_id = ? AND amount_ngn = ? AND at_iso LIKE ?`).get(cust.customer_id, op.amountNgn, `${op.date}%`)
      : null;
    if (dup) return { outcome: 'skipped', why: `already posted as ${dup.id}` };
    assertPeriodOpen(db, op.date, 'Advance date');
    if (!doApply) return { outcome: 'would apply', customer: cust ? cust.customer_id : `new customer "${op.customerName}"` };
    if (!cust) {
      insertCustomer(db, { name: op.customerName, createdBy: approver, crmProfileNotes: op.note }, op.branchId);
      cust = db.prepare(`SELECT customer_id, name FROM customers WHERE LOWER(name) = LOWER(?) AND branch_id = ?`).get(op.customerName, op.branchId);
      audit(item, { ...op, table: 'customers', key: cust.customer_id }, { table: 'customers', key: cust.customer_id, after: { name: op.customerName } });
    }
    const plan = planAdvanceIn({ customerID: cust.customer_id, customerName: cust.name, amountNgn: op.amountNgn, paymentMethod: op.paymentMethod, bankReference: op.bankReference, purpose: op.note, dateISO: op.date });
    const saved = insertLedgerRows(db, plan.rows.map((r) => ({ ...r, createdByName: approver })), op.branchId);
    for (const row of saved) insertAdvanceInEvent(db, row);
    const [created] = saved;
    const movements = recordCustomerAdvanceCash(db, {
      sourceId: created.id, customerID: cust.customer_id, customerName: cust.name, dateISO: op.date, reference: op.bankReference, note: op.note,
      paymentLines: [{ treasuryAccountId: op.treasuryAccountId, amountNgn: op.amountNgn, postedAtISO: `${op.date}T12:00:00.000Z` }],
      createdBy: approver, workspaceBranchId: op.branchId, actor: { ...actor, permissions: ['*'] },
    });
    const gl = tryPostCustomerAdvanceGl(db, { ledgerEntryId: created.id, amountNgn: op.amountNgn, entryDateISO: op.date, branchId: op.branchId, createdByUserId: null });
    if (!gl.ok && !gl.skipped && !gl.duplicate) throw new Error(`${item.id}: GL — ${gl.error}`);
    appendAuditLog(db, { actor, action: 'ledger.advance', entityKind: 'ledger_entry', entityId: created.id, note: op.note, details: { customerID: cust.customer_id, amountNgn: op.amountNgn } });
    const tmIds = (movements || []).map((m) => m.id);
    let recon = null;
    if (op.reconForMovementId) {
      recon = db.prepare(`SELECT id, system_match, matched_system_amount_ngn, variance_ngn FROM bank_reconciliation_lines WHERE system_match LIKE ?`).get(`%${op.reconForMovementId}%`);
      if (recon) {
        const match = `${String(recon.system_match).split(' · ')[0]} + ${tmIds.join(' + ')} (₦${op.amountNgn.toLocaleString('en-NG')} excess → advance ${created.id})`;
        db.prepare(`UPDATE bank_reconciliation_lines SET system_match = ?, matched_system_amount_ngn = ?, variance_ngn = 0, variance_percent = 0 WHERE id = ?`).run(
          match, Number(recon.matched_system_amount_ngn) + op.amountNgn, recon.id
        );
        audit(item, { ...op, table: 'bank_reconciliation_lines', key: recon.id }, { table: 'bank_reconciliation_lines', key: recon.id, before: recon, after: { system_match: match, variance_ngn: 0 } });
      }
    }
    audit(item, { ...op, table: 'ledger_entries', key: created.id }, { table: 'ledger_entries', key: created.id, customerId: cust.customer_id, treasuryMovementIds: tmIds, gl, recon: recon?.id || null });
    return { outcome: 'applied', ledgerEntryId: created.id, customer: cust.customer_id, treasuryMovementIds: tmIds };
  }
  if (op.kind === 'reconLinkUpsert') {
    // One bank-statement line (or one charge group) ↔ ERP treasury line(s) as a Matched bank-recon row. An existing
    // row for the same bank line (same account, date and amount, or already naming one of the lines) only gets the
    // missing movement ids appended; its description is kept.
    if (op.expenseRef) {
      // Line of an expense posted earlier in this plan (looked up by its date, amount, category and description).
      const e = op.expenseRef;
      const tm = db
        .prepare(
          `SELECT m.id FROM treasury_movements m JOIN expenses x ON x.expense_id = m.source_id
           WHERE x.date = ? AND x.amount_ngn = ? AND x.category = ? AND x.expense_type = ? AND x.branch_id = ?`
        )
        .get(e.date, e.amountNgn, e.category, e.expenseType, op.branchId);
      if (!tm) {
        if (!doApply) return { outcome: 'would apply', action: 'insert (after the expense above posts)' };
        return { outcome: 'skipped', why: 'expense line not found' };
      }
      op = { ...op, movementIds: [tm.id], systemMatch: `${tm.id} · ${op.systemMatch}` };
    }
    const tms = db.prepare(`SELECT id, amount_ngn, treasury_account_id FROM treasury_movements WHERE id IN (${op.movementIds.map(() => '?').join(',')})`).all(...op.movementIds);
    if (tms.length !== op.movementIds.length) {
      const have = new Set(tms.map((t) => t.id));
      return { outcome: 'skipped', why: `treasury line(s) not found: ${op.movementIds.filter((i) => !have.has(i)).join(', ')}` };
    }
    const elsewhere = db
      .prepare(`SELECT id, system_match FROM bank_reconciliation_lines WHERE bank_date_iso NOT LIKE ? AND (${op.movementIds.map(() => 'system_match LIKE ?').join(' OR ')})`)
      .get(`${op.bankDateISO.slice(0, 7)}%`, ...op.movementIds.map((i) => `%${i}%`));
    if (elsewhere) return { outcome: 'skipped', why: `a line is already linked on ${elsewhere.id} (${elsewhere.system_match})` };
    // Same bank line = its bank id in the match text, or (rows from round 2, no bank id) same account, date and
    // amount AND already naming one of the lines — so two bank lines of one ERP line, or two equal transfers on one
    // day, stay separate rows.
    const existing =
      db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE system_match LIKE ?`).get(`%· ${op.bankId}%`) ||
      db
        .prepare(
          `SELECT * FROM bank_reconciliation_lines WHERE treasury_account_id = ? AND bank_date_iso = ? AND amount_ngn = ?
             AND system_match NOT LIKE '%· MP-%' AND system_match NOT LIKE '%· TJ-%' AND system_match NOT LIKE '%· CHG-%'
             AND (${op.movementIds.map(() => 'system_match LIKE ?').join(' OR ')})`
        )
        .get(op.treasuryAccountId, op.bankDateISO, op.amountNgn, ...op.movementIds.map((i) => `%${i}%`));
    const erpNgn = tms.reduce((s, t) => s + Number(t.amount_ngn), 0);
    if (existing) {
      const missing = op.movementIds.filter((i) => !String(existing.system_match || '').includes(i));
      if (!missing.length) return { outcome: 'skipped', why: `already linked on ${existing.id}` };
      if (!doApply) return { outcome: 'would apply', action: `update ${existing.id}: add ${missing.join(', ')}` };
      const [head, ...tail] = String(existing.system_match || '').split(' · ');
      const match = [`${head} + ${missing.join(' + ')}`, ...tail].join(' · ');
      db.prepare(`UPDATE bank_reconciliation_lines SET system_match = ?, matched_system_amount_ngn = ? WHERE id = ?`).run(match, erpNgn, existing.id);
      audit(item, { ...op, table: 'bank_reconciliation_lines', key: existing.id }, { table: 'bank_reconciliation_lines', key: existing.id, before: { system_match: existing.system_match }, after: { system_match: match } });
      return { outcome: 'applied', action: `updated ${existing.id}` };
    }
    if (!doApply) return { outcome: 'would apply', action: 'insert', erpNgn };
    const last = db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE id LIKE 'BKR-KD-26-%' ORDER BY id DESC LIMIT 1`).get();
    const id = `BKR-KD-26-${String((Number(String(last?.id || '0').replace(/\D+/g, '').slice(-4)) || 0) + 1).padStart(4, '0')}`;
    db.prepare(
      `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id,
         settled_amount_ngn, matched_system_amount_ngn, variance_ngn, variance_percent, treasury_account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, op.bankDateISO, op.description, op.amountNgn, op.systemMatch, 'Matched', op.branchId, op.settledAmountNgn ?? null, erpNgn, op.varianceNgn, null, op.treasuryAccountId);
    audit(item, { ...op, table: 'bank_reconciliation_lines', key: id }, { table: 'bank_reconciliation_lines', key: id, after: { bankId: op.bankId, systemMatch: op.systemMatch, amountNgn: op.amountNgn, varianceNgn: op.varianceNgn } });
    return { outcome: 'applied', action: `inserted ${id}` };
  }
  if (op.kind === 'reversePhantomInflow') {
    // Receipt confirmed from credit (ledger RECEIPT ₦0) whose RECEIPT_IN stayed on the till (commit b50d502). Reversed
    // the way the ERP reverses refund-funded receipts since de1bb99 — RECEIPT_REVERSAL_OUT + refund-fund GL unwind —
    // but on the original movement's date. Ledger, receipt and quotation are not touched.
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    const rev = db.prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`).get(tm.id);
    if (rev) return { outcome: 'skipped', why: `already reversed by ${rev.id}` };
    if (tm.type !== 'RECEIPT_IN' || tm.source_id !== op.sourceId || Number(tm.treasury_account_id) !== op.accountId
      || Number(tm.amount_ngn) !== op.amountNgn || String(tm.posted_at_iso).slice(0, 10) !== op.date) {
      return { outcome: 'skipped', why: `line is ${tm.type} ${tm.source_id} acct ${tm.treasury_account_id} ₦${tm.amount_ngn} ${String(tm.posted_at_iso).slice(0, 10)} — not as planned` };
    }
    const le = db.prepare(`SELECT amount_ngn, quotation_ref, customer_id FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(op.sourceId);
    if (!le || Number(le.amount_ngn) !== 0) return { outcome: 'skipped', why: `ledger RECEIPT ${op.sourceId} is ₦${le?.amount_ngn ?? 'missing'}, not ₦0` };
    const settle = db.prepare(`SELECT details_json FROM audit_log WHERE action = 'receipt.finance_settlement' AND entity_id = ?`).all(op.sourceId);
    const creditNgn = settle.reduce((m, a) => { try { return Math.max(m, Number(JSON.parse(a.details_json).refundCreditAppliedNgn) || 0); } catch { return m; } }, 0);
    if (!(creditNgn > 0)) return { outcome: 'skipped', why: 'no refund-credit confirmation on this receipt' };
    assertPeriodOpen(db, op.date, 'Original movement date');
    const q = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(le.quotation_ref);
    const paidBefore = q ? Number(q.paid_ngn) : null;
    if (!doApply) return { outcome: 'would apply', creditNgn, quotation: le.quotation_ref, paidNgn: paidBefore };
    const created = insertTreasuryMovementTx(db, {
      type: 'RECEIPT_REVERSAL_OUT',
      treasuryAccountId: tm.treasury_account_id,
      amountNgn: -Number(tm.amount_ngn),
      postedAtISO: `${op.date}T12:00:00.000Z`,
      reference: tm.reference,
      counterpartyKind: tm.counterparty_kind,
      counterpartyId: tm.counterparty_id,
      counterpartyName: tm.counterparty_name,
      sourceKind: tm.source_kind,
      sourceId: tm.source_id,
      note: op.note,
      createdBy: approver,
      reversesMovementId: tm.id,
      branchId: 'BR-KD',
      allowNegativeBalance: true,
    });
    const gl = tryPostCustomerReceiptRefundFundUnwindGl(db, { ledgerEntryId: op.sourceId, keepCashNgn: 0, entryDateISO: op.date, branchId: 'BR-KD', createdByUserId: null });
    if (!gl.ok && !gl.skipped && !gl.duplicate) throw new Error(`${item.id}: GL — ${gl.error}`);
    // Method → "Refund fund", as the ERP's refund-funded unwind does (ledger RECEIPT and receipt mirror, when present).
    let relabel = null;
    if (op.relabelMethod) {
      const lm = db.prepare(`SELECT payment_method FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(op.sourceId);
      const sr = db.prepare(`SELECT method FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`).get(op.sourceId, op.sourceId);
      db.prepare(`UPDATE ledger_entries SET payment_method = ? WHERE id = ? AND type = 'RECEIPT'`).run(op.relabelMethod, op.sourceId);
      if (sr) db.prepare(`UPDATE sales_receipts SET method = ? WHERE id = ? OR ledger_entry_id = ?`).run(op.relabelMethod, op.sourceId, op.sourceId);
      relabel = { before: { ledger: lm?.payment_method ?? null, receipt: sr?.method ?? null }, after: op.relabelMethod, receiptMirror: Boolean(sr) };
    }
    const paidAfter = q ? Number(db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(le.quotation_ref).paid_ngn) : null;
    if (paidAfter !== paidBefore) throw new Error(`${item.id}: quotation ${le.quotation_ref} paid changed ${paidBefore} → ${paidAfter}`);
    audit(item, { ...op, table: 'treasury_movements', key: created?.id }, { table: 'treasury_movements', reversed: tm.id, created: created?.id, amountNgn: -Number(tm.amount_ngn), date: op.date, gl, creditNgn, quotation: le.quotation_ref, paidNgn: paidBefore, relabel });
    return { outcome: 'applied', created: created?.id, paidNgn: paidBefore, receiptMirror: relabel?.receiptMirror };
  }
  if (op.kind === 'relabelReceiptMethod') {
    // Method / reference text only, so they name the account the treasury line sits on. No money moves.
    const tm = db.prepare(`SELECT treasury_account_id FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm || Number(tm.treasury_account_id) !== op.accountId) return { outcome: 'skipped', why: `treasury line not on account ${op.accountId}` };
    const le = db.prepare(`SELECT payment_method, bank_reference FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(op.receiptId);
    const sr = db.prepare(`SELECT method FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!le || !sr) return { outcome: 'skipped', why: 'receipt not found' };
    if (le.payment_method === op.afterMethod && sr.method === op.afterMethod) return { outcome: 'skipped', why: 'already at the planned value' };
    if (le.payment_method !== op.beforeMethod || sr.method !== op.beforeMethod) return { outcome: 'skipped', why: `current method ${JSON.stringify(sr.method)} ≠ planned before` };
    const afterRef = String(le.bank_reference || '').split(op.beforeRefToken).join(op.afterRefToken);
    if (!doApply) return { outcome: 'would apply', after: op.afterMethod };
    db.prepare(`UPDATE ledger_entries SET payment_method = ?, bank_reference = ? WHERE id = ? AND type = 'RECEIPT'`).run(op.afterMethod, afterRef, op.receiptId);
    db.prepare(`UPDATE sales_receipts SET method = ? WHERE id = ?`).run(op.afterMethod, op.receiptId);
    audit(item, { ...op, table: 'ledger_entries', key: op.receiptId }, {
      table: 'ledger_entries+sales_receipts', key: op.receiptId,
      before: { method: sr.method, payment_method: le.payment_method, bank_reference: le.bank_reference },
      after: { method: op.afterMethod, payment_method: op.afterMethod, bank_reference: afterRef },
    });
    return { outcome: 'applied' };
  }
  if (op.kind === 'setOpening') {
    // Opening balance, as the ERP's treasury-account edit does it (opening only; stored balance untouched), with the
    // ERP's opening_change audit and the Phase 2 audit.
    const a = db.prepare(`SELECT id, name, opening_balance_ngn FROM treasury_accounts WHERE id = ?`).get(op.treasuryAccountId);
    if (!a) return { outcome: 'skipped', why: 'treasury account not found' };
    if (Number(a.opening_balance_ngn) === op.after) return { outcome: 'skipped', why: 'already at the planned value' };
    if (Number(a.opening_balance_ngn) !== op.before) return { outcome: 'skipped', why: `current opening ₦${a.opening_balance_ngn} ≠ planned before ₦${op.before}` };
    if (!doApply) return { outcome: 'would apply', current: a.opening_balance_ngn };
    db.prepare(`UPDATE treasury_accounts SET opening_balance_ngn = ? WHERE id = ?`).run(op.after, a.id);
    appendAuditLog(db, {
      actor,
      action: 'treasury_account.opening_change',
      entityKind: 'treasury_account',
      entityId: String(a.id),
      note: item.reason.slice(0, 900),
      details: { oldOpening: op.before, newOpening: op.after, reason: item.reason },
    });
    audit(item, { ...op, table: 'treasury_accounts', key: String(a.id) }, { table: 'treasury_accounts', key: a.id, column: 'opening_balance_ngn', before: op.before, after: op.after });
    return { outcome: 'applied' };
  }
  if (op.kind === 'recodePaidRequest') {
    // Category of a paid payment request via the ERP's post-pay reclass (category, GL reclass journal per payout
    // line, audit); the payer note goes into the request description. Only when the category still equals "before".
    const pr = db
      .prepare(
        `SELECT pr.request_id, pr.description, pr.paid_amount_ngn, e.expense_id, e.category, e.amount_ngn, e.date
         FROM payment_requests pr JOIN expenses e ON e.expense_id = pr.expense_id WHERE pr.request_id = ?`
      )
      .get(op.requestId);
    if (!pr) return { outcome: 'skipped', why: 'payment request not found' };
    if (pr.expense_id !== op.expenseId) return { outcome: 'skipped', why: `request is on ${pr.expense_id}, not ${op.expenseId}` };
    if (pr.category === op.after && String(pr.description || '') === op.note) return { outcome: 'skipped', why: 'already at the planned value' };
    if (pr.category !== op.before && pr.category !== op.after) return { outcome: 'skipped', why: `current category ${pr.category} ≠ planned before ${op.before}` };
    assertPeriodOpen(db, op.reclassDateISO, 'Category reclass date');
    const current = { category: pr.category, description: pr.description, paidNgn: pr.paid_amount_ngn, date: pr.date };
    if (!doApply) return { outcome: 'would apply', current };
    if (pr.category !== op.after) {
      const r = reclassifyPaidPaymentRequestCategory(
        db,
        op.requestId,
        { expenseCategory: op.after, categoryJustification: op.note, reclassDateISO: op.reclassDateISO },
        { ...actor, permissions: ['*'] }
      );
      if (!r?.ok) throw new Error(`${item.id}: ${r?.error || 'reclass failed'}`);
    }
    db.prepare(`UPDATE payment_requests SET description = ? WHERE request_id = ?`).run(op.note, op.requestId);
    audit(item, { ...op, table: 'payment_requests', key: op.requestId }, {
      table: 'payment_requests', key: op.requestId, expenseId: op.expenseId,
      before: { category: pr.category, description: pr.description }, after: { category: op.after, description: op.note },
      reclassDateISO: op.reclassDateISO,
    });
    return { outcome: 'applied', current };
  }
  if (op.kind === 'redateTreasury') {
    // Treasury posting date only, when it still equals the planned "before"; linked receipt / ledger / GL untouched.
    const tm = db.prepare(`SELECT id, posted_at_iso, amount_ngn, treasury_account_id FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    const cur = String(tm.posted_at_iso || '').slice(0, 10);
    if (cur === op.after) return { outcome: 'skipped', why: 'already at the planned value' };
    if (cur !== op.before) return { outcome: 'skipped', why: `current date ${cur} ≠ planned before ${op.before}` };
    assertPeriodOpen(db, op.before, 'Current treasury date');
    assertPeriodOpen(db, op.after, 'New treasury date');
    if (!doApply) return { outcome: 'would apply' };
    const after = `${op.after}${String(tm.posted_at_iso).slice(10) || 'T12:00:00.000Z'}`;
    const hasReason = db.prepare(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'treasury_movements' AND column_name = 'date_override_reason'`).get();
    if (hasReason) {
      db.prepare(`UPDATE treasury_movements SET posted_at_iso = ?, date_override_reason = ? WHERE id = ?`).run(after, op.note, tm.id);
    } else {
      db.prepare(`UPDATE treasury_movements SET posted_at_iso = ? WHERE id = ?`).run(after, tm.id);
    }
    audit(item, { ...op, table: 'treasury_movements', key: tm.id }, {
      table: 'treasury_movements', key: tm.id, column: 'posted_at_iso', before: tm.posted_at_iso, after, note: op.note,
    });
    return { outcome: 'applied' };
  }
  if (op.kind === 'bankAdjustment') {
    // One statement alignment line (BANK_RECON_ADJUSTMENT, treasury only — like the Sept recon adjustments), keyed by
    // its schedule reference so it is never posted twice.
    const dup = db.prepare(`SELECT id, amount_ngn FROM treasury_movements WHERE source_kind = 'BANK_RECON_LINE' AND source_id = ?`).get(op.scheduleRef);
    if (dup) return { outcome: 'skipped', why: `already posted as ${dup.id} (₦${dup.amount_ngn})` };
    const bal = accountBalanceAt(op.treasuryAccountId, op.balanceCutISO);
    // CHECK does not run the earlier groups, so a planned redate into the period is not in the balance yet.
    const pending = doApply ? 0 : Number(op.checkModePendingNgn || 0);
    if (op.targetBalanceNgn != null) {
      // Recomputed at run time: target statement balance − ERP balance now. Must still be the approved amount.
      const recomputed = op.targetBalanceNgn - (bal + pending);
      if (recomputed !== op.amountNgn) {
        return { outcome: 'skipped', why: `recomputed ₦${recomputed} (= ₦${op.targetBalanceNgn} − ₦${bal + pending}) ≠ approved ₦${op.amountNgn} — ask the owner` };
      }
    } else if (bal + pending !== op.expectedBalanceBeforeNgn) {
      return { outcome: 'skipped', why: `balance at ${op.balanceCutISO} is ₦${bal}, planned ₦${op.expectedBalanceBeforeNgn} — recompute the adjustment` };
    }
    // Lock checked after the recompute so a CHECK on a locked month still shows the figure.
    const blocked = lockedPeriodWhy(op.date, 'Alignment date');
    if (blocked) return { ...blockedOrThrow(item, blocked), balanceBeforeNgn: bal + pending, amountNgn: op.amountNgn };
    if (!doApply) return { outcome: 'would apply', balanceBeforeNgn: bal, balanceAfterNgn: bal + op.amountNgn };
    const mv = insertTreasuryMovementTx(db, {
      type: 'BANK_RECON_ADJUSTMENT',
      treasuryAccountId: op.treasuryAccountId,
      amountNgn: op.amountNgn,
      postedAtISO: `${op.date}T12:00:00.000Z`,
      reference: op.scheduleRef,
      counterpartyKind: 'BANK_RECON',
      counterpartyId: op.scheduleRef,
      counterpartyName: 'Bank reconciliation',
      sourceKind: 'BANK_RECON_LINE',
      sourceId: op.scheduleRef,
      note: op.label,
      createdBy: approver,
      branchId: op.branchId,
      allowNegativeBalance: true,
    });
    audit(item, { ...op, table: 'treasury_movements', key: mv.id }, { table: 'treasury_movements', key: mv.id, amountNgn: op.amountNgn, date: op.date, balanceBeforeNgn: bal });
    return { outcome: 'applied', created: mv.id };
  }
  if (op.kind === 'internalTransfer') {
    // Sweep between two accounts of the branch: both sides, the way the ERP's transferTreasuryFunds posts it
    // (INTERNAL_TRANSFER_OUT / _IN pair, one batch id, treasury.transfer audit). Never twice: same accounts, day, amount.
    const from = db.prepare(`SELECT id, name, branch_id FROM treasury_accounts WHERE id = ?`).get(op.fromId);
    const to = db.prepare(`SELECT id, name, branch_id FROM treasury_accounts WHERE id = ?`).get(op.toId);
    if (!from || !to || from.branch_id !== op.branchId || to.branch_id !== op.branchId) return { outcome: 'skipped', why: 'accounts not both on the branch' };
    const dup = db
      .prepare(
        `SELECT id FROM treasury_movements WHERE type = 'INTERNAL_TRANSFER_OUT' AND treasury_account_id = ? AND counterparty_id = ?
           AND amount_ngn = ? AND posted_at_iso LIKE ?`
      )
      .get(op.fromId, String(op.toId), -op.amountNgn, `${op.date}%`);
    if (dup) return { outcome: 'skipped', why: `already posted as ${dup.id}` };
    const blocked = lockedPeriodWhy(op.date, 'Transfer date');
    if (blocked) return blockedOrThrow(item, blocked);
    if (!doApply) return { outcome: 'would apply', from: from.name, to: to.name };
    const batchId = nextTreasuryTransferBatchHumanId(db);
    const leg = (type, accountId, amountNgn, other) =>
      insertTreasuryMovementTx(db, {
        type,
        treasuryAccountId: accountId,
        amountNgn,
        postedAtISO: `${op.date}T${op.time || '12:00'}:00.000Z`,
        reference: op.reference,
        counterpartyKind: 'INTERNAL',
        counterpartyId: String(other),
        sourceKind: 'TREASURY_TRANSFER',
        sourceId: batchId,
        note: op.reference,
        createdBy: approver,
        batchId,
        branchId: op.branchId,
        allowNegativeBalance: true,
      });
    const out = leg('INTERNAL_TRANSFER_OUT', op.fromId, -op.amountNgn, op.toId);
    const inn = leg('INTERNAL_TRANSFER_IN', op.toId, op.amountNgn, op.fromId);
    appendAuditLog(db, {
      actor,
      action: 'treasury.transfer',
      entityKind: 'treasury_transfer',
      entityId: batchId,
      note: op.reference,
      details: { fromId: op.fromId, toId: op.toId, amountNgn: op.amountNgn, branchId: op.branchId },
    });
    audit(item, { ...op, table: 'treasury_movements', key: batchId }, { table: 'treasury_movements', key: batchId, out: out.id, in: inn.id, amountNgn: op.amountNgn, date: op.date });
    return { outcome: 'applied', batchId, movements: [out.id, inn.id] };
  }
  if (op.kind === 'receiptConfirmedField') {
    // Cleared receipt whose book amount and treasury lines were corrected but whose confirmed field
    // (bank_received_amount_ngn, read by refunds / credit caps / quotation paid) kept the old figure.
    // Only when book and live lines already equal the planned after, and the field still equals the planned before.
    const rec = db.prepare(`SELECT * FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!rec) return { outcome: 'skipped', why: 'receipt not found' };
    const cur = rec.bank_received_amount_ngn == null ? null : Math.round(Number(rec.bank_received_amount_ngn));
    if (cur === op.afterNgn) return { outcome: 'skipped', why: 'already at the planned value' };
    if (cur !== op.beforeNgn) return { outcome: 'skipped', why: `confirmed field ₦${cur} ≠ planned before ₦${op.beforeNgn}` };
    const book = Math.round(Number(rec.amount_ngn));
    const lines = receiptLinesTotalNgn(op.receiptId);
    if (book !== op.afterNgn || lines !== op.afterNgn) {
      return { outcome: 'skipped', why: `receipt ₦${book} / treasury lines ₦${lines} ≠ planned after ₦${op.afterNgn}` };
    }
    if (String(rec.quotation_ref || '') !== op.quotationRef) return { outcome: 'skipped', why: `receipt is on ${rec.quotation_ref}, not ${op.quotationRef}` };
    const blocked = lockedPeriodWhy(rec.date_iso, 'Receipt date');
    if (blocked) return blockedOrThrow(item, blocked);
    const paidBefore = Math.round(Number(db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(op.quotationRef)?.paid_ngn || 0));
    const view = { quotation: op.quotationRef, paidBefore, paidAfterExpected: paidBefore + op.afterNgn - op.beforeNgn };
    if (!doApply) return { outcome: 'would apply', ...view };
    // One transaction: field, quotation paid, audit — a failed check leaves nothing behind.
    return db.transaction(() => {
      db.prepare(`UPDATE sales_receipts SET bank_received_amount_ngn = ? WHERE id = ? AND bank_received_amount_ngn = ?`).run(op.afterNgn, op.receiptId, op.beforeNgn);
      syncQuotationPaidFromReceipts(db, op.quotationRef);
      const paidAfter = Math.round(Number(db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(op.quotationRef)?.paid_ngn || 0));
      if (paidAfter !== view.paidAfterExpected) throw new Error(`${item.id}: quotation paid ₦${paidAfter} after sync, expected ₦${view.paidAfterExpected}`);
      assertConfirmedFieldAligned(item, op.receiptId);
      audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, {
        table: 'sales_receipts', key: op.receiptId, column: 'bank_received_amount_ngn', before: op.beforeNgn, after: op.afterNgn,
        quotationRef: op.quotationRef, quotationPaidBefore: paidBefore, quotationPaidAfter: paidAfter,
      });
      return { outcome: 'applied', ...view, paidAfter };
    })();
  }
  if (op.kind === 'refundRecalc') {
    // Unpaid refund recalculated on the corrected cash, keeping its number: calculation lines, split gross per payee
    // (each split keeps its own company-cut rate), amount (and approved amount when already approved), snapshot.
    const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (!r) return { outcome: 'skipped', why: 'refund not found' };
    const total = op.lines.reduce((s, l) => s + l.amountNgn, 0);
    const splits = JSON.parse(r.split_distributions_json || '[]');
    const nextSplits = splits.map((s) => {
      const gross = op.splitGrossByRecipient[String(s.recipientCustomerID || s.recipientAssociatedStaffID || '')];
      if (gross == null) throw new Error(`${item.id}: no planned gross for split ${s.recipientCustomerID || s.recipientAssociatedStaffID}`);
      const calc = refundStaffAllocationDeductionAmounts(gross, Number(s.deductionRate) || 0);
      return { ...s, amountNgn: gross, companyDeductionNgn: calc.companyDeductionNgn, netPayoutNgn: calc.netPayoutNgn };
    });
    const splitTotal = nextSplits.reduce((s, x) => s + x.amountNgn, 0);
    if (splitTotal !== total) throw new Error(`${item.id}: splits ₦${splitTotal} ≠ lines ₦${total}`);
    const netOf = (list) => list.reduce((s, x) => s + Math.round(Number(x.netPayoutNgn ?? x.amountNgn) || 0), 0);
    const view = {
      status: r.status, amountBefore: Number(r.amount_ngn), amountAfter: total,
      approvedBefore: Number(r.approved_amount_ngn), paid: Number(r.paid_amount_ngn),
      payableBefore: netOf(splits) - Number(r.paid_amount_ngn), payableAfter: netOf(nextSplits) - Number(r.paid_amount_ngn),
      splitsAfter: nextSplits.map((s) => `${s.recipientCustomerID} gross ₦${s.amountNgn} cut ₦${s.companyDeductionNgn} net ₦${s.netPayoutNgn}`),
    };
    if (Number(r.amount_ngn) === total) return { outcome: 'skipped', why: 'already at the planned value', ...view };
    const e = op.expect;
    if (r.status !== e.status || Number(r.amount_ngn) !== e.amountNgn || Number(r.approved_amount_ngn) !== e.approvedNgn || Number(r.paid_amount_ngn) !== e.paidNgn) {
      return { outcome: 'skipped', why: `refund ${r.status} ₦${r.amount_ngn} approved ₦${r.approved_amount_ngn} paid ₦${r.paid_amount_ngn} ≠ planned before`, ...view };
    }
    // Leave the refund being recalculated out, else its own lines count as already refunded.
    const prev = previewRefundRequest(db, { quotationRef: op.quotationRef, excludeRefundId: op.refundId });
    const p = prev?.preview || {};
    view.previewCashInNgn = p.quotationCashInNgn;
    view.previewOverpaymentResidualNgn = p.overpaymentResidualNgn;
    // CHECK runs before the confirmed-field items are posted, so the preview may still show the old cash.
    if (!doApply) return { outcome: 'would apply', ...view, previewNote: `after the confirmed-field fix the preview must show cash ₦${op.expectPreview.cashInNgn}` };
    if (!prev?.ok || Number(p.quotationCashInNgn) !== op.expectPreview.cashInNgn) {
      throw new Error(`${item.id}: refund preview cash ₦${p.quotationCashInNgn} ≠ planned ₦${op.expectPreview.cashInNgn} — post the confirmed-field item first`);
    }
    const overLine = op.lines.filter((l) => l.category === 'Overpayment').reduce((s, l) => s + l.amountNgn, 0);
    if (overLine > Math.round(Number(p.overpaymentResidualNgn ?? p.overpaymentExcessNgn) || 0)) {
      throw new Error(`${item.id}: Overpayment ₦${overLine} above the preview's refundable ₦${p.overpaymentResidualNgn}`);
    }
    const snapOld = (() => { try { return JSON.parse(r.preview_snapshot_json || '{}'); } catch { return {}; } })();
    const snap = { ...snapOld, ...p, capturedAtISO: approvedAtISO, recalculatedFromNgn: Number(r.amount_ngn), recalculatedReason: item.reason };
    const approvedAfter = r.status === 'Approved' ? total : Number(r.approved_amount_ngn);
    return db.transaction(() => {
    db.prepare(
      `UPDATE customer_refunds SET amount_ngn = ?, approved_amount_ngn = ?, calculation_lines_json = ?, split_distributions_json = ?, preview_snapshot_json = ?
       WHERE refund_id = ? AND amount_ngn = ? AND paid_amount_ngn = ?`
    ).run(total, approvedAfter, JSON.stringify(op.lines), JSON.stringify(nextSplits), JSON.stringify(snap).slice(0, 120_000), op.refundId, e.amountNgn, e.paidNgn);
    const after = db.prepare(`SELECT amount_ngn, approved_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (Number(after.amount_ngn) !== total) throw new Error(`${item.id}: refund is ₦${after.amount_ngn} after update, planned ₦${total}`);
    audit(item, { ...op, table: 'customer_refunds', key: op.refundId }, {
      table: 'customer_refunds', key: op.refundId,
      before: { amountNgn: e.amountNgn, approvedNgn: e.approvedNgn, lines: JSON.parse(r.calculation_lines_json || '[]'), splits: splits.map((s) => ({ id: s.recipientCustomerID, gross: s.amountNgn, net: s.netPayoutNgn })) },
      after: { amountNgn: total, approvedNgn: approvedAfter, lines: op.lines, splits: nextSplits.map((s) => ({ id: s.recipientCustomerID, gross: s.amountNgn, net: s.netPayoutNgn })) },
    });
    return { outcome: 'applied', ...view, approvedAfter };
    })();
  }
  if (op.kind === 'receiptConfirmedAmount') {
    // Receipt booked below the bank amount: the ERP's finance-confirm path (receipt / overpay split, sales receipt,
    // treasury line, quotation paid, receipt.finance_amount_sync audit). Only when the current amount is the planned before.
    const rec = db.prepare(`SELECT id, amount_ngn, date_iso, quotation_ref FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!rec) return { outcome: 'skipped', why: 'receipt not found' };
    const tm = db.prepare(`SELECT id, amount_ngn, treasury_account_id FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm || Number(tm.treasury_account_id) !== op.treasuryAccountId) return { outcome: 'skipped', why: `treasury line ${op.movementId} not on account ${op.treasuryAccountId}` };
    if (Number(rec.amount_ngn) === op.amountNgn && Number(tm.amount_ngn) === op.amountNgn) return { outcome: 'skipped', why: 'already at the planned value' };
    if (Number(rec.amount_ngn) !== op.expectedNgn || Number(tm.amount_ngn) !== op.expectedNgn) {
      return { outcome: 'skipped', why: `receipt ₦${rec.amount_ngn} / line ₦${tm.amount_ngn} ≠ planned before ₦${op.expectedNgn}` };
    }
    const blocked = lockedPeriodWhy(rec.date_iso, 'Receipt date');
    if (blocked) return blockedOrThrow(item, blocked);
    if (!doApply) return { outcome: 'would apply', quotation: rec.quotation_ref };
    const r = applyFinanceConfirmedReceiptBookAmountTx(db, op.receiptId, op.amountNgn, actor, { allowNegativeBalance: true });
    if (!r?.ok) throw new Error(`${item.id}: ${r?.error}`);
    const after = db.prepare(`SELECT amount_ngn FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (Number(after?.amount_ngn) !== op.amountNgn) throw new Error(`${item.id}: treasury line is ₦${after?.amount_ngn} after confirm, planned ₦${op.amountNgn}`);
    assertConfirmedFieldAligned(item, op.receiptId);
    audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, { table: 'sales_receipts', key: op.receiptId, before: op.expectedNgn, after: op.amountNgn, movementId: op.movementId });
    return { outcome: 'applied' };
  }
  if (op.kind === 'refundPay') {
    // Bank payout(s) already made on an approved refund, recorded through the ERP's own payRefundEntry (ledger slices,
    // treasury lines, payout journal, status). CHECK shows the ERP's settlement figures; never pays above them.
    let r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (!r) return { outcome: 'skipped', why: 'refund not found' };
    const total = op.lines.reduce((s, l) => s + l.amountNgn, 0);
    if (op.repairPaidFirst) {
      // Stored paid / status are stale (e.g. RF-9782 marked Paid with no payout line). payRefundEntry repairs them from
      // treasury + wallet + credit before paying; here the same repair is evaluated on the row (with the approved amount
      // a preceding op sets, when CHECK has not applied it yet).
      const approvedNow = doApply ? Number(r.approved_amount_ngn) : Number(op.approvedAfterNgn ?? r.approved_amount_ngn);
      const sim = { ...r, approved_amount_ngn: approvedNow };
      const repaired = Math.round(correctRefundPaidAmountNgn(db, sim));
      const lineCount = db.prepare(`SELECT COUNT(*) n FROM treasury_movements WHERE source_kind = 'REFUND' AND source_id = ? AND type = 'REFUND_PAYOUT'`).get(op.refundId).n;
      if (Number(lineCount) > 0 && repaired >= op.expectedPaidBeforeNgn + total) return { outcome: 'skipped', why: `already paid (repaired paid ₦${repaired})` };
      if (repaired !== op.expectedPaidBeforeNgn) return { outcome: 'skipped', why: `repaired paid ₦${repaired} ≠ planned before ₦${op.expectedPaidBeforeNgn}` };
      r = { ...sim, paid_amount_ngn: repaired, status: resolveRefundStatusNow(db, { ...sim, paid_amount_ngn: repaired }) };
    }
    const paid = Math.round(Number(r.paid_amount_ngn) || 0);
    if (paid === op.expectedPaidBeforeNgn + total) return { outcome: 'skipped', why: `already paid (₦${paid})` };
    if (paid !== op.expectedPaidBeforeNgn) return { outcome: 'skipped', why: `paid ₦${paid} ≠ planned before ₦${op.expectedPaidBeforeNgn}` };
    for (const l of op.lines) {
      const blocked = lockedPeriodWhy(l.postedAtISO, 'Payout date');
      if (blocked) return blockedOrThrow(item, blocked);
    }
    const approved = Math.round(Number(r.approved_amount_ngn || r.amount_ngn) || 0);
    const summary = buildRefundSettlementSummary(db, r, {});
    const held = refundHeldNetCashDueNgn(db, r, approved, {});
    const tillPayable = refundTillPayableNgn({ cashOutstandingNgn: summary.cashOutstandingNgn, heldNetNgn: held, adminMayPayUncleared: true, openWalletNgn: summary.walletOpenNgn });
    const view = { status: r.status, approvedNgn: approved, paidBeforeNgn: paid, cashOutstandingNgn: summary.cashOutstandingNgn, heldUnclearedNgn: held, walletOpenNgn: summary.walletOpenNgn, tillPayableNgn: tillPayable, payNgn: total, remainderAfterNgn: summary.cashOutstandingNgn - total };
    if (total > tillPayable) return { outcome: 'BLOCKED', why: `payout ₦${total} > ERP payable now ₦${tillPayable}`, ...view };
    if (!doApply) return { outcome: 'would apply', ...view };
    const res = payRefundEntry(db, op.refundId, {
      actor: ownerActor, paidBy: approver, workspaceBranchId: 'BR-KD', workspaceViewAll: true,
      paymentNote: `${op.note} Recorded from the bank statement (payout already made). Phase 2 ${item.id}, approved by ${approver}.`.slice(0, 500),
      paymentLines: op.lines.map((l) => ({ treasuryAccountId: l.treasuryAccountId, amountNgn: l.amountNgn, postedAtISO: l.postedAtISO, reference: l.reference, note: l.note })),
    });
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error || 'refund payout failed'}${res?.code ? ` (${res.code})` : ''}`);
    audit(item, { ...op, table: 'customer_refunds', key: op.refundId }, { table: 'customer_refunds', key: op.refundId, lines: op.lines, before: view, movements: (res.movements || []).map((m) => m?.id || m) });
    return { outcome: 'applied', ...view };
  }
  if (op.kind === 'preqPay') {
    // Approved payment request paid from the bank (lines = bank debits), through the ERP's payPaymentRequest.
    const p = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(op.requestId);
    if (!p) return { outcome: 'skipped', why: 'payment request not found' };
    const total = op.lines.reduce((s, l) => s + l.amountNgn, 0);
    const paid = Math.round(Number(p.paid_amount_ngn) || 0);
    // CHECK of a payout that only becomes due after an earlier item of the same run (e.g. a line split before it): that
    // item has not posted in a CHECK, so the request still shows the old paid amount.
    const posted = db.prepare(`SELECT id FROM treasury_movements WHERE source_kind = 'PAYMENT_REQUEST' AND source_id = ? AND reference = ?`).get(op.requestId, op.lines[0].reference);
    if (posted) return { outcome: 'skipped', why: `already paid (${posted.id})` };
    const pendingEarlier = !doApply && op.afterItem && paid !== op.expectedPaidBeforeNgn;
    if (pendingEarlier) {
      return { outcome: 'would apply', why: `paid ₦${op.expectedPaidBeforeNgn} expected once ${op.afterItem} has posted (now ₦${paid})` };
    }
    if (paid >= total && paid === op.expectedPaidBeforeNgn + total) return { outcome: 'skipped', why: `already paid (₦${paid})` };
    if (paid !== op.expectedPaidBeforeNgn) return { outcome: 'skipped', why: `paid ₦${paid} ≠ planned before ₦${op.expectedPaidBeforeNgn}` };
    if (!/approved/i.test(String(p.approval_status))) return { outcome: 'skipped', why: `status ${p.approval_status}` };
    if (Number(p.amount_requested_ngn) - paid < total) return { outcome: 'BLOCKED', why: `outstanding ₦${Number(p.amount_requested_ngn) - paid} < payout ₦${total}` };
    for (const l of op.lines) {
      const blocked = lockedPeriodWhy(l.postedAtISO, 'Payout date');
      if (blocked) return blockedOrThrow(item, blocked);
    }
    const view = { requested: Number(p.amount_requested_ngn), paidBeforeNgn: paid, payNgn: total, approvedBy: p.approved_by };
    if (!doApply) return { outcome: 'would apply', ...view };
    const res = payPaymentRequest(db, op.requestId, {
      actor: ownerActor, paidBy: approver, createdBy: approver, workspaceBranchId: 'BR-KD', workspaceViewAll: true,
      note: `${op.note} Recorded from the bank statement. Phase 2 ${item.id}.`.slice(0, 500),
      paymentLines: op.lines.map((l) => ({ treasuryAccountId: l.treasuryAccountId, amountNgn: l.amountNgn, postedAtISO: l.postedAtISO, reference: l.reference, note: l.note })),
    });
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error || 'payment request payout failed'}`);
    if (op.payeeName && !String(p.payee_name || '').trim()) {
      // Payee named on the bank line, request had none (owner instruction).
      db.prepare(`UPDATE payment_requests SET payee_name = ? WHERE request_id = ?`).run(op.payeeName, op.requestId);
      audit(item, { ...op, table: 'payment_requests', key: op.requestId }, { table: 'payment_requests', key: op.requestId, column: 'payee_name', before: p.payee_name || '', after: op.payeeName });
    }
    audit(item, { ...op, table: 'payment_requests', key: op.requestId }, { table: 'payment_requests', key: op.requestId, lines: op.lines, before: view });
    return { outcome: 'applied', ...view };
  }
  if (op.kind === 'refundRequestCreate') {
    // A refund REQUEST only (status Pending), requested by the owner through the ERP's insertRefundRequest.
    // Approval is left to the named approver in the app (never self-approved here); payout is a later item.
    const qt = db.prepare(`SELECT id, customer_id, customer_name, branch_id FROM quotations WHERE id = ?`).get(op.quotationRef);
    if (!qt) return { outcome: 'skipped', why: 'quotation not found' };
    const dup = db
      .prepare(`SELECT refund_id, status FROM customer_refunds WHERE quotation_ref = ? AND amount_ngn = ? AND reason_category LIKE ? AND status NOT IN ('Cancelled','Rejected')`)
      .get(op.quotationRef, op.amountNgn, `%${op.category}%`);
    if (dup) return { outcome: 'skipped', why: `already requested as ${dup.refund_id} (${dup.status})` };
    const payload = {
      customerID: qt.customer_id, quotationRef: op.quotationRef, amountNgn: op.amountNgn, reasonCategory: [op.category],
      calculationLines: [{ label: op.label, amountNgn: op.amountNgn, category: op.category }],
      payeeName: op.payeeName, product: op.product || '', requestedAtISO: op.requestedAtISO,
    };
    let preview = null;
    try {
      preview = previewRefundRequest(db, { ...payload, actor: ownerActor });
    } catch (e) {
      preview = { ok: false, error: String(e.message || e) };
    }
    const view = {
      customer: `${qt.customer_id} ${qt.customer_name}`,
      previewOk: preview?.ok !== false,
      previewError: preview?.ok === false ? preview.error : undefined,
      suggestedNgn: preview?.suggestedAmountNgn ?? preview?.preview?.suggestedAmountNgn ?? undefined,
      approver: op.approverNote,
    };
    // The ERP's own eligibility verdict (the refund form refuses on it) counts as a block too.
    const elig = preview?.preview ?? preview;
    if (elig?.refundEligibilityOk === false) { view.previewOk = false; view.previewError = elig.refundEligibilityError || 'refund eligibility failed'; }
    if (!doApply) return { outcome: view.previewOk === false ? 'BLOCKED' : 'would apply', why: view.previewError, ...view };
    if (view.previewOk === false) throw new Error(`${item.id}: ERP refused the refund — ${view.previewError}`);
    const r = insertRefundRequest(db, payload, ownerActor, qt.branch_id || 'BR-KD');
    if (!r?.ok) throw new Error(`${item.id}: ${r?.error || 'refund request failed'}`);
    const id = r.refundID || r.refundId || r.refund?.refund_id || r.id;
    audit(item, { ...op, table: 'customer_refunds', key: id }, { table: 'customer_refunds', key: id, status: 'Pending', approver: op.approverNote, payload });
    return { outcome: 'applied', refundId: id, ...view };
  }
  if (op.kind === 'apPay') {
    // Supplier invoice payment from the bank, through the ERP's payAccountsPayable (AP row, PO paid, treasury, GL).
    const ap = db.prepare(`SELECT * FROM accounts_payable WHERE ap_id = ?`).get(op.apId);
    if (!ap) return { outcome: 'skipped', why: 'payable not found' };
    const paid = Math.round(Number(ap.paid_ngn) || 0);
    const dup = db
      .prepare(`SELECT id FROM treasury_movements WHERE type = 'AP_PAYMENT' AND source_id = ? AND treasury_account_id = ? AND amount_ngn = ? AND posted_at_iso LIKE ?`)
      .get(op.apId, op.treasuryAccountId, -op.amountNgn, `${op.postedAtISO.slice(0, 10)}%`);
    if (dup) return { outcome: 'skipped', why: `already paid as ${dup.id}` };
    if (paid !== op.expectedPaidBeforeNgn) return { outcome: 'skipped', why: `paid ₦${paid} ≠ planned before ₦${op.expectedPaidBeforeNgn}` };
    const blocked = lockedPeriodWhy(op.postedAtISO, 'AP payment date');
    if (blocked) return blockedOrThrow(item, blocked);
    const cap = ap.po_ref ? poSupplierPaymentCapBlock(db, ap.po_ref, '') : null;
    const view = { supplier: ap.supplier_name, invoiceNgn: Number(ap.amount_ngn), paidBeforeNgn: paid, payNgn: op.amountNgn, outstandingAfterNgn: Number(ap.amount_ngn) - paid - op.amountNgn };
    if (cap) return { outcome: 'BLOCKED', why: cap.error || 'PO payment cap', ...view };
    if (!doApply) return { outcome: 'would apply', ...view };
    const r = payAccountsPayable(db, op.apId, {
      actor: ownerActor, createdBy: approver, amountNgn: op.amountNgn, treasuryAccountId: op.treasuryAccountId, postedAtISO: op.postedAtISO,
      dateISO: op.postedAtISO.slice(0, 10), paymentMethod: 'Bank Transfer', reference: op.reference, workspaceBranchId: 'BR-KD', workspaceViewAll: true,
    });
    if (!r?.ok) throw new Error(`${item.id}: ${r?.error || 'supplier payment failed'}`);
    audit(item, { ...op, table: 'accounts_payable', key: op.apId }, { table: 'accounts_payable', key: op.apId, before: view, note: op.note });
    return { outcome: 'applied', ...view };
  }
  if (op.kind === 'receiptConfirmedSplit') {
    // Split receipt: confirm the bank total through the ERP's finance-confirm path, which corrects the largest line.
    const rec = db.prepare(`SELECT id, amount_ngn, date_iso, quotation_ref FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!rec) return { outcome: 'skipped', why: 'receipt not found' };
    const tm = db.prepare(`SELECT id, amount_ngn FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (Number(rec.amount_ngn) === op.totalAfterNgn && Number(tm?.amount_ngn) === op.lineAfterNgn) return { outcome: 'skipped', why: 'already at the planned value' };
    if (Number(rec.amount_ngn) !== op.totalBeforeNgn || Number(tm?.amount_ngn) !== op.lineBeforeNgn) {
      return { outcome: 'skipped', why: `receipt ₦${rec.amount_ngn} / line ₦${tm?.amount_ngn} ≠ planned ₦${op.totalBeforeNgn} / ₦${op.lineBeforeNgn}` };
    }
    const lines = db.prepare(`SELECT id, amount_ngn FROM treasury_movements WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ? AND type = 'RECEIPT_IN' ORDER BY ABS(amount_ngn) DESC`).all(op.receiptId);
    if (lines[0]?.id !== op.movementId) return { outcome: 'skipped', why: `largest line is ${lines[0]?.id}, not ${op.movementId}` };
    const blocked = lockedPeriodWhy(rec.date_iso, 'Receipt date');
    if (blocked) return blockedOrThrow(item, blocked);
    if (!doApply) return { outcome: 'would apply', quotation: rec.quotation_ref, lines: lines.map((l) => `${l.id} ₦${l.amount_ngn}`) };
    const r = applyFinanceConfirmedReceiptBookAmountTx(db, op.receiptId, op.totalAfterNgn, actor, { allowNegativeBalance: true });
    if (!r?.ok) throw new Error(`${item.id}: ${r?.error}`);
    const after = db.prepare(`SELECT amount_ngn FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (Number(after?.amount_ngn) !== op.lineAfterNgn) throw new Error(`${item.id}: line is ₦${after?.amount_ngn} after confirm, planned ₦${op.lineAfterNgn}`);
    assertConfirmedFieldAligned(item, op.receiptId);
    audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, { table: 'sales_receipts', key: op.receiptId, before: op.totalBeforeNgn, after: op.totalAfterNgn, line: `${op.movementId} ${op.lineBeforeNgn} → ${op.lineAfterNgn}` });
    return { outcome: 'applied' };
  }
  if (op.kind === 'receiptReverse') {
    // ERP receipt reversal (reverseReceiptEntry: RECEIPT_REVERSAL ledger row, receipt → Reversed, treasury lines
    // reversed, GL reversal, quotation paid re-synced) — for a receipt keyed twice. The twin must stay as it is.
    const le = db.prepare(`SELECT * FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(op.receiptId);
    if (!le) return { outcome: 'skipped', why: 'receipt not found' };
    const done = db.prepare(`SELECT id FROM ledger_entries WHERE type = 'RECEIPT_REVERSAL' AND (bank_reference LIKE ? OR note LIKE ?)`).get(`%${op.receiptId}%`, `%${op.receiptId}%`);
    if (done) return { outcome: 'skipped', why: `already reversed by ${done.id}` };
    if (Number(le.amount_ngn) !== op.expectedNgn) return { outcome: 'skipped', why: `receipt is ₦${le.amount_ngn}, not ₦${op.expectedNgn}` };
    const sr = db.prepare(`SELECT status FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`).get(op.receiptId, op.receiptId);
    if (String(sr?.status || '') !== op.expectedStatus) return { outcome: 'skipped', why: `receipt status "${sr?.status}", not "${op.expectedStatus}"` };
    const tms = db.prepare(`SELECT id, type, treasury_account_id, amount_ngn FROM treasury_movements WHERE source_id = ?`).all(op.receiptId);
    const want = Object.entries(op.expectedMovements);
    const tmOk = tms.length === want.length && want.every(([id, amt]) => tms.some((t) => t.id === id && t.type === 'RECEIPT_IN' && Number(t.amount_ngn) === amt && Number(t.treasury_account_id) === op.accountId));
    if (!tmOk) return { outcome: 'skipped', why: `treasury lines not as planned: ${tms.map((t) => `${t.id} ${t.type} ₦${t.amount_ngn} acct ${t.treasury_account_id}`).join('; ')}` };
    if (op.requireNoBankLink) {
      const linked = tms.find((t) => db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE system_match LIKE ?`).get(`%${t.id}%`));
      if (linked) return { outcome: 'skipped', why: `${linked.id} is on a bank-recon row — the money may be on the bank` };
    }
    const twin = op.twinReceiptId ? db.prepare(`SELECT * FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(op.twinReceiptId) : null;
    if (op.twinReceiptId && (!twin || Number(twin.amount_ngn) !== op.expectedNgn || twin.quotation_ref !== le.quotation_ref || twin.customer_id !== le.customer_id)) {
      return { outcome: 'skipped', why: `twin ${op.twinReceiptId} not the same receipt (amount/quotation/customer)` };
    }
    const twinRev = op.twinReceiptId && db.prepare(`SELECT id FROM ledger_entries WHERE type = 'RECEIPT_REVERSAL' AND (bank_reference LIKE ? OR note LIKE ?)`).get(`%${op.twinReceiptId}%`, `%${op.twinReceiptId}%`);
    if (twinRev) return { outcome: 'skipped', why: `twin ${op.twinReceiptId} is itself reversed (${twinRev.id})` };
    const q = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(le.quotation_ref);
    const paidBefore = Number(q?.paid_ngn ?? 0);
    if (!doApply) return { outcome: 'would apply', quotation: le.quotation_ref, paidBeforeNgn: paidBefore, paidAfterNgn: paidBefore - op.expectedNgn };
    const res = reverseReceiptEntry(db, op.receiptId, `Phase 2 ${item.id}: ${op.note} Approved by ${approver}.`.slice(0, 500), ownerActor);
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error}`);
    const paidAfter = Number(db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get(le.quotation_ref)?.paid_ngn ?? 0);
    if (paidAfter !== paidBefore - op.expectedNgn) throw new Error(`${item.id}: quotation ${le.quotation_ref} paid ${paidBefore} → ${paidAfter}, expected −${op.expectedNgn}`);
    audit(item, { ...op, table: 'ledger_entries', key: op.receiptId }, { table: 'ledger_entries', reversed: op.receiptId, reversal: res.entry?.id, quotation: le.quotation_ref, paidBeforeNgn: paidBefore, paidAfterNgn: paidAfter });
    return { outcome: 'applied', reversal: res.entry?.id, paidAfterNgn: paidAfter };
  }
  if (op.kind === 'receiptHoldRelease') {
    // Receipt held "Suspended — no bank receipt" (holdReceiptAwaitingCreditCheck) whose money is on the bank: back to
    // the status it had before the hold. The ERP has no release action; the treasury line was never touched.
    const sr = db.prepare(`SELECT id, status, amount_ngn FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!sr) return { outcome: 'skipped', why: 'receipt not found' };
    if (String(sr.status) === op.after) return { outcome: 'skipped', why: 'already at the planned value' };
    if (String(sr.status) !== op.before) return { outcome: 'skipped', why: `status "${sr.status}" ≠ planned before` };
    const tms = db.prepare(`SELECT id, type, treasury_account_id, amount_ngn FROM treasury_movements WHERE source_id = ?`).all(op.receiptId);
    const live = tms.filter((t) => t.type === 'RECEIPT_IN' && !tms.some((x) => x.type === 'RECEIPT_REVERSAL_OUT'));
    if (live.length !== 1 || live[0].id !== op.movementId || Number(live[0].amount_ngn) !== op.amountNgn || Number(live[0].treasury_account_id) !== op.accountId) {
      return { outcome: 'skipped', why: `treasury lines not as planned: ${tms.map((t) => `${t.id} ${t.type} ₦${t.amount_ngn}`).join('; ')}` };
    }
    if (!doApply) return { outcome: 'would apply', before: sr.status, after: op.after };
    db.prepare(`UPDATE sales_receipts SET status = ? WHERE id = ?`).run(op.after, op.receiptId);
    appendAuditLog(db, { actor: ownerActor, action: 'receipt.bank_check_release', entityKind: 'sales_receipt', entityId: op.receiptId, note: op.note, details: { previousStatus: sr.status, status: op.after, movementId: op.movementId } });
    audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, { table: 'sales_receipts', key: op.receiptId, column: 'status', before: sr.status, after: op.after });
    return { outcome: 'applied' };
  }
  if (op.kind === 'poTransportPay') {
    // PO haulage paid from the bank, through the ERP's postPurchaseOrderTransport (TRANSPORT_PAYMENT line, duplicate
    // guard, PO transport state). The agreed fee on the PO is not changed here.
    const po = db.prepare(`SELECT po_id, status, transport_agent_name, transport_amount_ngn FROM purchase_orders WHERE po_id = ?`).get(op.poId);
    if (!po) return { outcome: 'skipped', why: 'PO not found' };
    if (String(po.transport_agent_name || '').trim().toLowerCase() !== op.agentName.toLowerCase()) return { outcome: 'skipped', why: `transport agent "${po.transport_agent_name}", not "${op.agentName}"` };
    const lines = db.prepare(`SELECT id, amount_ngn, posted_at_iso FROM treasury_movements WHERE source_kind = 'PURCHASE_ORDER' AND source_id = ? AND type = 'TRANSPORT_PAYMENT'`).all(op.poId);
    const same = lines.find((l) => Number(l.amount_ngn) === -op.amountNgn && String(l.posted_at_iso).slice(0, 10) === op.postedAtISO.slice(0, 10));
    if (same) return { outcome: 'skipped', why: `already posted as ${same.id}` };
    if (op.expectedLinesBefore != null && lines.length !== op.expectedLinesBefore) return { outcome: 'skipped', why: `${lines.length} transport lines on ${op.poId}, planned ${op.expectedLinesBefore}` };
    const blocked = lockedPeriodWhy(op.postedAtISO, 'Payout date');
    if (blocked) return blockedOrThrow(item, blocked);
    const view = { po: op.poId, status: po.status, feeNgn: Number(po.transport_amount_ngn), paidBeforeNgn: -lines.reduce((s, l) => s + Number(l.amount_ngn), 0), payNgn: op.amountNgn };
    if (!doApply) return { outcome: 'would apply', ...view };
    const res = postPurchaseOrderTransport(db, op.poId, {
      treasuryAccountId: op.treasuryAccountId, amountNgn: op.amountNgn, dateISO: op.postedAtISO.slice(0, 10), postedAtISO: op.postedAtISO,
      reference: op.reference, note: `${op.note} Phase 2 ${item.id}.`.slice(0, 500), createdBy: approver, actor: ownerActor,
      workspaceBranchId: 'BR-KD', workspaceViewAll: true,
    });
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error || 'transport payment failed'}`);
    const after = db.prepare(`SELECT id FROM treasury_movements WHERE source_kind = 'PURCHASE_ORDER' AND source_id = ? AND type = 'TRANSPORT_PAYMENT' AND amount_ngn = ?`).all(op.poId, -op.amountNgn);
    if (after.length !== 1) throw new Error(`${item.id}: ${after.length} lines of ₦${op.amountNgn} after posting`);
    audit(item, { ...op, table: 'treasury_movements', key: after[0].id }, { table: 'treasury_movements', key: after[0].id, po: op.poId, amountNgn: op.amountNgn, before: view });
    return { outcome: 'applied', movementId: after[0].id, ...view };
  }
  if (op.kind === 'poHaulageFeeSet') {
    // Agreed haulage on the PO set to the actual cost on the owner's instruction. The ERP's own path
    // (agreePoHaulageFeeTx) only lowers a fee; this sets it directly with the same audit action, then lets the ERP
    // re-derive the PO's transport state (syncPurchaseOrderTransportPaymentState).
    const po = db.prepare(`SELECT po_id, transport_amount_ngn, transport_paid_ngn FROM purchase_orders WHERE po_id = ?`).get(op.poId);
    if (!po) return { outcome: 'skipped', why: 'PO not found' };
    const fee = Math.round(Number(po.transport_amount_ngn) || 0);
    if (fee === op.after) return { outcome: 'skipped', why: 'already at the planned value' };
    if (fee !== op.before) return { outcome: 'skipped', why: `fee ₦${fee} ≠ planned before ₦${op.before}` };
    const paidLines = -Math.round(Number(db.prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE source_kind = 'PURCHASE_ORDER' AND source_id = ? AND type = 'TRANSPORT_PAYMENT'`).get(op.poId).s) || 0);
    if (op.expectedPaidNgn != null && paidLines !== op.expectedPaidNgn) return { outcome: 'skipped', why: `haulage paid ₦${paidLines} ≠ planned ₦${op.expectedPaidNgn}` };
    const view = { po: op.poId, feeBeforeNgn: fee, feeAfterNgn: op.after, haulagePaidNgn: paidLines };
    if (!doApply) return { outcome: 'would apply', ...view };
    db.prepare(`UPDATE purchase_orders SET transport_amount_ngn = ? WHERE po_id = ?`).run(op.after, op.poId);
    appendAuditLog(db, { actor: ownerActor, action: 'purchase_order.haulage_fee_agreed', entityKind: 'purchase_order', entityId: op.poId, note: op.note, details: { poId: op.poId, previousAmountNgn: fee, agreedAmountNgn: op.after, phase2: item.id } });
    syncPurchaseOrderTransportPaymentState(db, op.poId, ownerActor);
    const after = db.prepare(`SELECT transport_amount_ngn, transport_paid_ngn, transport_paid FROM purchase_orders WHERE po_id = ?`).get(op.poId);
    if (Math.round(Number(after.transport_amount_ngn)) !== op.after) throw new Error(`${item.id}: fee is ₦${after.transport_amount_ngn} after set`);
    audit(item, { ...op, table: 'purchase_orders', key: op.poId }, { table: 'purchase_orders', key: op.poId, column: 'transport_amount_ngn', before: fee, after: op.after, state: after });
    return { outcome: 'applied', ...view, state: after };
  }
  if (op.kind === 'reconImportBatch') {
    // Statement lines → bank_reconciliation_lines, one row per bank line (September layout): signed settlement amount,
    // system_match "<ERP line(s)> · <bank id> · <note>", Matched or Review. A bank id already on file is skipped; an
    // ERP line already linked to a bank line of another month stops the batch (listed, nothing inserted).
    const plannedIds = [...new Set(op.rows.flatMap((r) => r.movementIds))];
    const tms = plannedIds.length ? db.prepare(`SELECT id, treasury_account_id FROM treasury_movements WHERE id IN (${plannedIds.map(() => '?').join(',')})`).all(...plannedIds) : [];
    const missing = plannedIds.filter((id) => !tms.some((t) => t.id === id && Number(t.treasury_account_id) === op.treasuryAccountId));
    if (missing.length) return { outcome: 'skipped', why: `ERP line(s) not on account ${op.treasuryAccountId}: ${missing.join(', ')}` };
    const conflicts = [];
    for (const id of plannedIds) {
      const other = db.prepare(`SELECT id, bank_date_iso FROM bank_reconciliation_lines WHERE system_match LIKE ? AND bank_date_iso NOT LIKE ?`).get(`%${id}%`, `${op.month}%`);
      if (other) conflicts.push(`${id} on ${other.id} (${other.bank_date_iso})`);
    }
    if (conflicts.length) return { outcome: 'skipped', why: `already linked in another month: ${conflicts.join('; ')}` };
    const todo = op.rows.filter((r) => !db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE system_match LIKE ?`).get(`%· ${r.bankId}%`));
    if (!todo.length) return { outcome: 'skipped', why: 'all bank lines already imported' };
    const view = { rows: op.rows.length, toInsert: todo.length, matched: todo.filter((r) => r.status === 'Matched').length, review: todo.filter((r) => r.status === 'Review').length };
    if (!doApply) return { outcome: 'would apply', ...view };
    const last = db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE id LIKE 'BKR-KD-26-%' ORDER BY id DESC LIMIT 1`).get();
    let n = Number(String(last?.id || '0').replace(/\D+/g, '').slice(-4)) || 0;
    const ins = db.prepare(
      `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id, treasury_account_id) VALUES (?,?,?,?,?,?,?,?)`
    );
    const created = [];
    for (const r of todo) {
      const id = `BKR-KD-26-${String(++n).padStart(4, '0')}`;
      const match = [r.movementIds.length ? r.movementIds.join(' + ') : '—', r.bankId, r.note].filter(Boolean).join(' · ');
      ins.run(id, r.bankDateISO, r.description, r.amountNgn, match, r.status, op.branchId, op.treasuryAccountId);
      created.push(id);
    }
    audit(item, { ...op, rows: undefined, table: 'bank_reconciliation_lines', key: `${created[0]}..${created.at(-1)}` }, { table: 'bank_reconciliation_lines', inserted: created.length, first: created[0], last: created.at(-1), matched: view.matched, review: view.review });
    return { outcome: 'applied', ...view, first: created[0], last: created.at(-1) };
  }
  if (op.kind === 'reconRepoint') {
    // One ERP line linked to the wrong bank line: the old row goes to Review (link removed, reason kept in the text),
    // the right row becomes Matched to it — both through the ERP's updateBankReconciliationLine (metadata only; a
    // payout line takes the plain path: no settlement, no treasury adjustment).
    const from = db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE id = ?`).get(op.fromId);
    const to = db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE id = ?`).get(op.toId);
    if (!from || !to) return { outcome: 'skipped', why: `bank line not found (${!from ? op.fromId : op.toId})` };
    if (to.status === 'Matched' && String(to.system_match).startsWith(op.movementId) && from.status === 'Review') return { outcome: 'skipped', why: 'already re-pointed' };
    if (from.status !== 'Matched' || !String(from.system_match || '').includes(op.movementId)) return { outcome: 'skipped', why: `${op.fromId} is ${from.status} "${from.system_match}", not Matched to ${op.movementId}` };
    if (to.status !== 'Review' || !String(to.system_match || '').includes(`matches ${op.movementId}`)) return { outcome: 'skipped', why: `${op.toId} is ${to.status} "${to.system_match}", not the planned Review row` };
    if (Number(from.amount_ngn) >= 0 || Number(to.amount_ngn) >= 0) return { outcome: 'skipped', why: 'only payout lines are re-pointed here' };
    const others = db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE system_match LIKE ? AND id NOT IN (?, ?)`).all(`%${op.movementId}%`, op.fromId, op.toId);
    if (others.length) return { outcome: 'skipped', why: `${op.movementId} also on ${others.map((o) => o.id).join(', ')}` };
    const fromMatch = `— · was ${from.system_match} · re-pointed to ${op.toId} (${op.reason})`.slice(0, 900);
    const bankId = (String(to.system_match).match(/MP-[^ ·]+/) || [''])[0];
    const toMatch = [op.movementId, bankId, op.toNote].filter(Boolean).join(' · ');
    const view = { from: { id: op.fromId, date: from.bank_date_iso, ngn: Number(from.amount_ngn), before: from.system_match, after: fromMatch, status: 'Review' }, to: { id: op.toId, date: to.bank_date_iso, ngn: Number(to.amount_ngn), before: to.system_match, after: toMatch, status: 'Matched' } };
    if (!doApply) return { outcome: 'would apply', ...view };
    const a = updateBankReconciliationLine(db, op.fromId, { systemMatch: fromMatch, status: 'Review' }, ownerActor);
    if (!a?.ok) throw new Error(`${item.id}: ${op.fromId} — ${a?.error}`);
    const b = updateBankReconciliationLine(db, op.toId, { systemMatch: toMatch, status: 'Matched' }, ownerActor);
    if (!b?.ok) throw new Error(`${item.id}: ${op.toId} — ${b?.error}`);
    audit(item, { ...op, table: 'bank_reconciliation_lines', key: `${op.fromId}→${op.toId}` }, { table: 'bank_reconciliation_lines', ...view });
    return { outcome: 'applied', ...view };
  }
  if (op.kind === 'reconMatchToExpense') {
    // Review bank row(s) (charges with no BC line yet) → Matched to the BC line posted earlier in this plan, found by its
    // expense reference; through the ERP's updateBankReconciliationLine.
    const tm = db
      .prepare(`SELECT m.id FROM treasury_movements m JOIN expenses x ON x.expense_id = m.source_id WHERE x.reference = ? AND m.treasury_account_id = ?`)
      .get(op.expenseReference, op.treasuryAccountId);
    const rows = op.bankIds.map((b) => db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE system_match LIKE ?`).get(`%· ${b}%`));
    if (rows.some((r) => !r)) return { outcome: 'skipped', why: 'bank row not found' };
    if (rows.every((r) => r.status === 'Matched' && tm && String(r.system_match).startsWith(tm.id))) return { outcome: 'skipped', why: 'already matched' };
    if (rows.some((r) => r.status !== 'Review')) return { outcome: 'skipped', why: `row(s) not in Review: ${rows.filter((r) => r.status !== 'Review').map((r) => r.id).join(', ')}` };
    if (!tm) {
      if (!doApply) return { outcome: 'would apply', why: `after ${op.afterItem} posts the BC line (${op.expenseReference})`, rows: rows.map((r) => r.id) };
      return { outcome: 'skipped', why: `BC line ${op.expenseReference} not found` };
    }
    if (!doApply) return { outcome: 'would apply', rows: rows.map((r) => r.id), movementId: tm.id };
    for (const r of rows) {
      const bankId = (String(r.system_match).match(/MP-[^ ·]+/) || [''])[0];
      const res = updateBankReconciliationLine(db, r.id, { systemMatch: [tm.id, bankId, 'daily bank charges (BC)'].join(' · '), status: 'Matched' }, ownerActor);
      if (!res?.ok) throw new Error(`${item.id}: ${r.id} — ${res?.error}`);
    }
    audit(item, { ...op, table: 'bank_reconciliation_lines', key: rows.map((r) => r.id).join(',') }, { table: 'bank_reconciliation_lines', rows: rows.map((r) => r.id), movementId: tm.id });
    return { outcome: 'applied', rows: rows.map((r) => r.id), movementId: tm.id };
  }
  if (op.kind === 'receiptBankConfirm') {
    // Finance confirmation of a receipt whose money is on the bank (every treasury line of it is linked to a Matched
    // bank-recon row), through the ERP's patchSalesReceiptFinanceSettlement (bank received = the linked lines' total).
    const sr = db.prepare(`SELECT id, status, amount_ngn, bank_confirmed_at_iso, date_iso, quotation_ref FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!sr) return { outcome: 'skipped', why: 'receipt not found' };
    if (sr.bank_confirmed_at_iso) return { outcome: 'skipped', why: `already confirmed ${sr.bank_confirmed_at_iso}` };
    if (String(sr.status) !== op.expectedStatus) return { outcome: 'skipped', why: `status "${sr.status}", not "${op.expectedStatus}"` };
    const tms = db.prepare(`SELECT id, type, amount_ngn, treasury_account_id FROM treasury_movements WHERE source_id = ?`).all(op.receiptId);
    if (tms.some((t) => t.type !== 'RECEIPT_IN')) return { outcome: 'skipped', why: 'receipt has reversal lines' };
    const links = tms.map((t) => ({ t, r: db.prepare(`SELECT id, status, amount_ngn FROM bank_reconciliation_lines WHERE system_match LIKE ? AND status = 'Matched'`).get(`${t.id} ·%`) }));
    const unlinked = links.filter((l) => !l.r).map((l) => l.t.id);
    if (unlinked.length) return { outcome: 'skipped', why: `not on the bank (no Matched recon row): ${unlinked.join(', ')}` };
    const total = tms.reduce((s, t) => s + Number(t.amount_ngn), 0);
    if (total !== op.amountNgn || Number(sr.amount_ngn) !== op.amountNgn) return { outcome: 'skipped', why: `receipt ₦${sr.amount_ngn} / lines ₦${total} ≠ planned ₦${op.amountNgn}` };
    const blocked = lockedPeriodWhy(sr.date_iso, 'Receipt date');
    if (blocked) return blockedOrThrow(item, blocked);
    const view = { receipt: op.receiptId, quotation: sr.quotation_ref, amountNgn: total, bankRows: links.map((l) => l.r.id) };
    if (!doApply) return { outcome: 'would apply', ...view };
    const res = patchSalesReceiptFinanceSettlement(db, op.receiptId, { bankReceivedAmountNgn: total, clearForDelivery: true }, ownerActor);
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error}`);
    const after = db.prepare(`SELECT status, bank_confirmed_at_iso, bank_received_amount_ngn FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    const tmAfter = db.prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE source_id = ?`).get(op.receiptId);
    if (Number(tmAfter.s) !== total) throw new Error(`${item.id}: treasury lines ₦${tmAfter.s} after confirm, were ₦${total}`);
    audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, { table: 'sales_receipts', key: op.receiptId, ...view, after });
    return { outcome: 'applied', ...view, after };
  }
  if (op.kind === 'septReceiptConfirm') {
    // A September receipt on hold whose money is on the bank (owner-approved): unlock September (audited), release
    // the hold, confirm through the ERP's finance settlement, and relock September with its original reason — the
    // relock runs even when a step fails.
    const lock = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(op.periodKey);
    const sr = db.prepare(`SELECT id, status, amount_ngn, bank_confirmed_at_iso, date_iso FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    if (!sr) return { outcome: 'skipped', why: 'receipt not found' };
    if (sr.bank_confirmed_at_iso) return { outcome: 'skipped', why: `already confirmed ${sr.bank_confirmed_at_iso}` };
    if (String(sr.status) !== op.holdStatus) return { outcome: 'skipped', why: `status "${sr.status}", not the planned hold` };
    const tms = db.prepare(`SELECT id, type, amount_ngn, treasury_account_id FROM treasury_movements WHERE source_id = ?`).all(op.receiptId);
    if (tms.length !== 1 || tms[0].type !== 'RECEIPT_IN' || Number(tms[0].amount_ngn) !== op.amountNgn) return { outcome: 'skipped', why: 'treasury line not as planned' };
    if (!lock) return { outcome: 'skipped', why: `${op.periodKey} is not locked — nothing to unlock (stop: check with the owner)` };
    const view = { receipt: op.receiptId, date: sr.date_iso, amountNgn: op.amountNgn, lock: { reason: lock.reason, lockedAt: lock.locked_at_iso, by: lock.locked_by_name } };
    if (!doApply) return { outcome: 'would apply', ...view };
    const un = unlockAccountingPeriod(db, op.periodKey, ownerActor, `${item.id}: ${op.unlockReason}`);
    if (!un?.ok) throw new Error(`${item.id}: unlock — ${un?.error}`);
    let res;
    let after;
    try {
      db.prepare(`UPDATE sales_receipts SET status = 'Pending clearance' WHERE id = ?`).run(op.receiptId);
      appendAuditLog(db, { actor: ownerActor, action: 'receipt.bank_check_release', entityKind: 'sales_receipt', entityId: op.receiptId, note: op.note, details: { previousStatus: sr.status, status: 'Pending clearance' } });
      res = patchSalesReceiptFinanceSettlement(db, op.receiptId, { bankReceivedAmountNgn: op.amountNgn, clearForDelivery: true }, ownerActor);
      if (!res?.ok) throw new Error(`${item.id}: confirm — ${res?.error}`);
      after = db.prepare(`SELECT status, bank_confirmed_at_iso, bank_received_amount_ngn FROM sales_receipts WHERE id = ?`).get(op.receiptId);
    } finally {
      const re = lockAccountingPeriod(db, { periodKey: op.periodKey, reason: lock.reason || op.relockReason }, ownerActor);
      if (!re?.ok) throw new Error(`${item.id}: RELOCK FAILED — ${re?.error}. Lock ${op.periodKey} in the app now.`);
    }
    audit(item, { ...op, table: 'sales_receipts', key: op.receiptId }, { table: 'sales_receipts', key: op.receiptId, ...view, after, relocked: true });
    return { outcome: 'applied', ...view, after, relocked: true };
  }
  if (op.kind === 'reconMatchReviewRow') {
    // One Review bank row → Matched to the ERP line posted earlier in this plan, found by account, type, amount and Lagos
    // day (and source id when known) and not yet linked anywhere; through the ERP's updateBankReconciliationLine.
    const row = db.prepare(`SELECT * FROM bank_reconciliation_lines WHERE id = ?`).get(op.rowId);
    if (!row) return { outcome: 'skipped', why: 'bank row not found' };
    const f = op.find;
    const start = new Date(`${f.day}T00:00:00+01:00`).toISOString();
    const end = new Date(`${f.day}T23:59:59.999+01:00`).toISOString();
    const cands = db
      .prepare(`SELECT id, source_id FROM treasury_movements WHERE treasury_account_id = ? AND type = ? AND amount_ngn = ? AND posted_at_iso BETWEEN ? AND ?`)
      .all(op.treasuryAccountId, f.type, f.amountNgn, start, end)
      .filter((t) => !f.sourceId || t.source_id === f.sourceId)
      .filter((t) => !db.prepare(`SELECT id FROM bank_reconciliation_lines WHERE system_match LIKE ? AND id <> ?`).get(`%${t.id}%`, op.rowId));
    if (row.status === 'Matched' && cands.some((t) => String(row.system_match).startsWith(t.id))) return { outcome: 'skipped', why: 'already matched' };
    if (row.status !== 'Review') return { outcome: 'skipped', why: `${op.rowId} is ${row.status}` };
    if (!cands.length) {
      if (!doApply) return { outcome: 'would apply', why: `after ${op.afterItem} posts the line`, row: op.rowId };
      return { outcome: 'skipped', why: 'ERP line not found' };
    }
    if (cands.length > 1) return { outcome: 'skipped', why: `more than one candidate: ${cands.map((t) => t.id).join(', ')}` };
    const bankId = (String(row.system_match).match(/MP-[^ ·]+/) || [''])[0];
    const match = [cands[0].id, bankId, op.note].filter(Boolean).join(' · ');
    if (!doApply) return { outcome: 'would apply', row: op.rowId, movementId: cands[0].id };
    const res = updateBankReconciliationLine(db, op.rowId, { systemMatch: match, status: 'Matched' }, ownerActor);
    if (!res?.ok) throw new Error(`${item.id}: ${op.rowId} — ${res?.error}`);
    audit(item, { ...op, table: 'bank_reconciliation_lines', key: op.rowId }, { table: 'bank_reconciliation_lines', key: op.rowId, before: row.system_match, after: match });
    return { outcome: 'applied', row: op.rowId, movementId: cands[0].id };
  }
  if (op.kind === 'refundRoundingClose') {
    // ERP rounding close (no money out) — only within the ERP's own limit.
    const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (!r) return { outcome: 'skipped', why: 'refund not found' };
    const out = Math.round(Number(buildRefundSettlementSummary(db, r, {}).cashOutstandingNgn) || 0);
    // CHECK of a close that only exists after an earlier item of the same run (e.g. the payout before it).
    if (!doApply && op.afterItem && out !== op.expectedRemainderNgn) {
      return { outcome: 'would apply', why: `remainder ₦${op.expectedRemainderNgn} expected once ${op.afterItem} has posted (now ₦${out})` };
    }
    if (out <= 1) return { outcome: 'skipped', why: `nothing outstanding (₦${out})` };
    if (out !== op.expectedRemainderNgn) return { outcome: 'skipped', why: `outstanding ₦${out} ≠ planned ₦${op.expectedRemainderNgn}` };
    if (out > PAYOUT_ROUNDING_CLOSE_MAX_NGN) return { outcome: 'BLOCKED', why: `₦${out} is above the ERP rounding limit ₦${PAYOUT_ROUNDING_CLOSE_MAX_NGN}` };
    if (!doApply) return { outcome: 'would apply', remainderNgn: out };
    const res = closeRefundUnpaidRemainder(db, op.refundId, ownerActor, 'rounding');
    if (!res?.ok) throw new Error(`${item.id}: ${res?.error}`);
    if (op.reasonNote) {
      // The ERP's close note names the September investigation; add the owner's reason for this close.
      db.prepare(`UPDATE customer_refunds SET payment_note = TRIM(CONCAT(COALESCE(payment_note, ''), ' ', ?)) WHERE refund_id = ?`).run(`(${op.reasonNote}, ₦${out}, ${approvedAtISO.slice(0, 10)})`, op.refundId);
    }
    audit(item, { ...op, table: 'customer_refunds', key: op.refundId }, { table: 'customer_refunds', key: op.refundId, remainderClosedNgn: out, after: res.after });
    return { outcome: 'applied', remainderNgn: out };
  }
  if (op.kind === 'refundRemainderWriteOff') {
    // Owner decision: a small unpaid refund remainder above the rounding limit is written off — a REFUND_CONCESSION
    // ledger row records it, and remainder_closed_ngn (the ERP's no-money-out close) settles the refund. No cash moves.
    const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    if (!r) return { outcome: 'skipped', why: 'refund not found' };
    const dup = db.prepare(`SELECT id FROM ledger_entries WHERE type = 'REFUND_CONCESSION' AND bank_reference = ? AND amount_ngn = ?`).get(op.refundId, op.amountNgn);
    const out = Math.round(Number(buildRefundSettlementSummary(db, r, {}).cashOutstandingNgn) || 0);
    if (dup && out <= 1) return { outcome: 'skipped', why: `already written off (${dup.id})` };
    if (out !== op.amountNgn) return { outcome: 'skipped', why: `outstanding ₦${out} ≠ planned ₦${op.amountNgn}` };
    const view = { customer: r.customer_name, quotation: r.quotation_ref, approvedNgn: Number(r.approved_amount_ngn), paidNgn: Number(r.paid_amount_ngn), remainderNgn: out };
    if (!doApply) return { outcome: 'would apply', ...view };
    if (!dup) {
      insertLedgerRows(db, [{
        type: 'REFUND_CONCESSION', customerID: r.customer_id, customerName: r.customer_name, amountNgn: op.amountNgn, quotationRef: r.quotation_ref || '',
        paymentMethod: null, bankReference: op.refundId, purpose: 'Sales refund payout', note: `Refund ${op.refundId} — ${op.reason} (₦${op.amountNgn}). Phase 2 ${item.id}.`,
        atISO: new Date().toISOString(), createdByUserId: ownerActor.id, createdByName: approver,
      }], r.branch_id || 'BR-KD', { allowManagerClearedQuotationRefs: r.quotation_ref ? [r.quotation_ref] : undefined });
    }
    const sentence = `${op.reason}: remainder ₦${out.toLocaleString('en-NG')} closed with no money out (owner, ${approvedAtISO.slice(0, 10)}).`;
    db.prepare(`UPDATE customer_refunds SET remainder_closed_ngn = COALESCE(remainder_closed_ngn, 0) + ?, remainder_closed_reason = ?, payment_note = TRIM(CONCAT(COALESCE(payment_note, ''), ' ', ?)) WHERE refund_id = ?`)
      .run(out, op.reason, sentence, op.refundId);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    const status = resolveRefundStatusNow(db, row);
    if (status && status !== row.status) db.prepare(`UPDATE customer_refunds SET status = ? WHERE refund_id = ?`).run(status, op.refundId);
    appendAuditLog(db, { actor: ownerActor, action: 'refund.remainder_written_off', entityKind: 'refund', entityId: op.refundId, note: sentence, details: { remainderClosedNgn: out, previousStatus: r.status, status } });
    audit(item, { ...op, table: 'customer_refunds', key: op.refundId }, { table: 'customer_refunds', key: op.refundId, before: view, status, concessionNgn: op.amountNgn });
    return { outcome: 'applied', status, ...view };
  }
  if (op.kind === 'payoutLineCorrect') {
    // Payout line recorded at a different amount from the bank debit: the ERP's treasury-line correction
    // (expenseOutflowTreasuryMovementCorrectTx) sets it to the bank amount and updates the refund / request and journal.
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!tm) return { outcome: 'skipped', why: 'treasury line not found' };
    const cur = Math.round(Number(tm.amount_ngn));
    // Optional bank date/time (op.postedAtISO); amount defaults to the current one when only the date moves.
    const targetAmt = op.amountNgn ?? op.expectedNgn;
    const curDay = String(tm.posted_at_iso).slice(0, 10);
    const dayOk = !op.postedAtISO || String(tm.posted_at_iso) === op.postedAtISO;
    if (cur === -targetAmt && dayOk) return { outcome: 'skipped', why: 'already at the planned value' };
    if (cur !== -op.expectedNgn) return { outcome: 'skipped', why: `line ₦${cur} ≠ planned before −₦${op.expectedNgn}` };
    if (op.expectedDay && curDay !== op.expectedDay) return { outcome: 'skipped', why: `line dated ${curDay} ≠ planned before ${op.expectedDay}` };
    const blocked = lockedPeriodWhy(tm.posted_at_iso, 'Payout date') || (op.postedAtISO ? lockedPeriodWhy(op.postedAtISO, 'Bank date') : '');
    if (blocked) return blockedOrThrow(item, blocked);
    let refund = null;
    if (tm.source_kind === 'REFUND') {
      const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(tm.source_id);
      const s = r ? buildRefundSettlementSummary(db, r, {}) : null;
      refund = r ? { refundId: r.refund_id, approvedNgn: Number(r.approved_amount_ngn), paidBeforeNgn: Number(r.paid_amount_ngn), paidAfterNgn: Number(r.paid_amount_ngn) - (op.expectedNgn - op.amountNgn), outstandingBeforeNgn: s?.cashOutstandingNgn, outstandingAfterNgn: (s?.cashOutstandingNgn || 0) + (op.expectedNgn - op.amountNgn) } : null;
    }
    // Payment request line whose amount changes: the ERP correction moves the line and the journal date only, so the
    // request's paid amount and the payout journal (EXPENSE_PAYMENT_GL keyed by the line) are set to the bank amount here.
    let preq = null;
    if (tm.source_kind === 'PAYMENT_REQUEST' && targetAmt !== op.expectedNgn) {
      const p = db.prepare(`SELECT paid_amount_ngn FROM payment_requests WHERE request_id = ?`).get(tm.source_id);
      const je = db.prepare(`SELECT id, entry_date_iso FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`).all(tm.id);
      const paidBefore = Math.round(Number(p?.paid_amount_ngn) || 0);
      if (op.expectedPaidBeforeNgn != null && paidBefore !== op.expectedPaidBeforeNgn) return { outcome: 'skipped', why: `${tm.source_id} paid ₦${paidBefore} ≠ planned ₦${op.expectedPaidBeforeNgn}` };
      if (je.length !== 1) return { outcome: 'skipped', why: `${je.length} payout journals for ${tm.id} (need exactly 1)` };
      preq = { requestId: tm.source_id, paidBeforeNgn: paidBefore, paidAfterNgn: paidBefore - (op.expectedNgn - targetAmt), journalId: je[0].id, journalDateBefore: je[0].entry_date_iso };
    }
    const view = { line: `${tm.id} ${tm.type} ${tm.source_id}`, beforeNgn: cur, afterNgn: -targetAmt, beforeAt: tm.posted_at_iso, afterAt: op.postedAtISO || tm.posted_at_iso, ...(refund ? { refund } : {}), ...(preq ? { preq } : {}) };
    if (!doApply) return { outcome: 'would apply', ...view };
    const r = expenseOutflowTreasuryMovementCorrectTx(
      db,
      op.movementId,
      { amountNgn: targetAmt, ...(op.postedAtISO ? { postedAtISO: op.postedAtISO } : {}), note: op.note, workspaceBranchId: 'BR-KD', workspaceViewAll: true },
      ownerActor
    );
    if (!r?.ok) throw new Error(`${item.id}: ${r?.error || 'payout line correction failed'}`);
    const after = db.prepare(`SELECT amount_ngn, posted_at_iso FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (Math.round(Number(after.amount_ngn)) !== -targetAmt) throw new Error(`${item.id}: line is ₦${after.amount_ngn} after correction`);
    if (op.postedAtISO && String(after.posted_at_iso).slice(0, 16) !== op.postedAtISO.slice(0, 16)) throw new Error(`${item.id}: line dated ${after.posted_at_iso} after correction`);
    if (preq) {
      db.prepare(`UPDATE payment_requests SET paid_amount_ngn = ? WHERE request_id = ?`).run(preq.paidAfterNgn, preq.requestId);
      const day = String(after.posted_at_iso).slice(0, 10);
      const am = amendBalancedJournalAmountTx(db, preq.journalId, { nextAmountNgn: targetAmt, entryDateISO: day });
      if (!am?.ok) throw new Error(`${item.id}: journal ${preq.journalId} — ${am?.error}`);
      const jl = db.prepare(`SELECT SUM(debit_ngn) d, SUM(credit_ngn) c FROM gl_journal_lines WHERE journal_id = ?`).get(preq.journalId);
      const jd = db.prepare(`SELECT entry_date_iso FROM gl_journal_entries WHERE id = ?`).get(preq.journalId);
      if (Number(jl.d) !== targetAmt || Number(jl.c) !== targetAmt || String(jd.entry_date_iso).slice(0, 10) !== day) throw new Error(`${item.id}: journal ${preq.journalId} is ${jl.d}/${jl.c} on ${jd.entry_date_iso} after amend`);
      audit(item, { ...op, table: 'payment_requests', key: preq.requestId }, { table: 'payment_requests', key: preq.requestId, column: 'paid_amount_ngn', before: preq.paidBeforeNgn, after: preq.paidAfterNgn, journal: { id: preq.journalId, amountNgn: targetAmt, date: day } });
    }
    audit(item, { ...op, table: 'treasury_movements', key: op.movementId }, { table: 'treasury_movements', key: op.movementId, before: { amount: cur, at: tm.posted_at_iso }, after: { amount: -targetAmt, at: after.posted_at_iso }, note: op.note });
    return { outcome: 'applied', ...view };
  }
  if (op.kind === 'expenseReverse') {
    // Reverse a direct expense's treasury line (EXPENSE_REVERSAL_IN on the line's own date) and its payment journal;
    // the expense record stays, marked with the reason. Replaced by other postings in the same plan.
    const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(op.expenseId);
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE source_kind = 'EXPENSE' AND source_id = ? AND type = 'EXPENSE'`).get(op.expenseId);
    if (!exp || !tm) return { outcome: 'skipped', why: 'expense or its treasury line not found' };
    const rev = db.prepare(`SELECT id FROM treasury_movements WHERE reverses_movement_id = ?`).get(tm.id);
    if (rev) return { outcome: 'skipped', why: `already reversed by ${rev.id}` };
    if (Number(exp.amount_ngn) !== op.expectedNgn) return { outcome: 'skipped', why: `expense ₦${exp.amount_ngn} ≠ planned ₦${op.expectedNgn}` };
    const blocked = lockedPeriodWhy(tm.posted_at_iso, 'Reversal date');
    if (blocked) return blockedOrThrow(item, blocked);
    if (!doApply) return { outcome: 'would apply', line: tm.id, amountNgn: Number(tm.amount_ngn), reversalAt: tm.posted_at_iso };
    const created = reverseTreasurySourceTx(db, 'EXPENSE', op.expenseId, 'EXPENSE_REVERSAL_IN', op.reason, ownerActor, { postedAtISO: tm.posted_at_iso, allowNegativeBalance: true });
    const mv = (created || [])[0];
    if (!mv?.id) throw new Error(`${item.id}: reversal not created`);
    const gl = tryPostExpensePaymentReversalGlTx(db, {
      treasuryAccountId: tm.treasury_account_id, amountNgn: Number(exp.amount_ngn), entryDateISO: String(tm.posted_at_iso).slice(0, 10), sourceId: mv.id,
      expenseCategory: exp.category, branchId: exp.branch_id, createdByUserId: null, memo: `${op.reason} (${op.expenseId})`,
    });
    if (!gl.ok && !gl.skipped && !gl.duplicate) throw new Error(`${item.id}: reversal journal — ${gl.error}`);
    db.prepare(`UPDATE expenses SET expense_type = ? WHERE expense_id = ?`).run(`${exp.expense_type} — REVERSED: ${op.reason}`.slice(0, 250), op.expenseId);
    audit(item, { ...op, table: 'expenses', key: op.expenseId }, { table: 'expenses', key: op.expenseId, reversal: mv.id, journal: gl.id || gl.journalId || null, reason: op.reason });
    return { outcome: 'applied', reversal: mv.id };
  }
  if (op.kind === 'expenseGlRepair') {
    // A postExpense cut off after its expense row and treasury line: add what is missing — the expense-payment
    // journal (keyed on the treasury line, so never twice) and the expense.create / phase2 audit rows.
    const exp = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(op.expenseId);
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!exp || !tm) return { outcome: 'skipped', why: 'expense or treasury line not found' };
    if (tm.source_id !== op.expenseId || Number(tm.amount_ngn) !== -Number(exp.amount_ngn) || Number(exp.amount_ngn) !== op.amountNgn) {
      return { outcome: 'skipped', why: `expense ₦${exp.amount_ngn} / line ${tm.source_id} ₦${tm.amount_ngn} ≠ planned ₦${op.amountNgn}` };
    }
    const je = db.prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`).get(op.movementId);
    const created = db.prepare(`SELECT id FROM audit_log WHERE action = 'expense.create' AND entity_id = ?`).get(op.expenseId);
    if (je && created) return { outcome: 'skipped', why: `already complete (${je.id}, audit ${created.id})` };
    const blocked = lockedPeriodWhy(exp.date, 'Expense date');
    if (blocked) return blockedOrThrow(item, blocked);
    if (!doApply) return { outcome: 'would apply', journal: je ? `exists ${je.id}` : 'to post', audit: created ? 'exists' : 'to write' };
    let gl = { id: je?.id };
    if (!je) {
      gl = tryPostExpensePaymentGlTx(db, {
        treasuryAccountId: tm.treasury_account_id, amountNgn: op.amountNgn, entryDateISO: exp.date, sourceId: tm.id,
        expenseCategory: exp.category, branchId: exp.branch_id, createdByUserId: null, memo: exp.expense_type,
      });
      if (!gl.ok || gl.skipped || gl.duplicate) throw new Error(`${item.id}: expense journal not posted (${gl.error || (gl.duplicate ? 'duplicate' : 'skipped')})`);
    }
    if (!created) {
      appendAuditLog(db, { actor, action: 'expense.create', entityKind: 'expense', entityId: op.expenseId, note: exp.expense_type, details: { amountNgn: op.amountNgn, treasuryAccountId: tm.treasury_account_id } });
    }
    audit(item, { ...op, table: 'expenses', key: op.expenseId }, { table: 'expenses', key: op.expenseId, treasuryMovementId: tm.id, glJournal: gl.id || gl.journalId || null, repairOf: op.repairOf });
    return { outcome: 'applied', journal: gl.id || gl.journalId };
  }
  if (op.kind === 'refundPayoutGlRepair') {
    // Corrected payout whose journal was skipped as a duplicate of the reversed original: post it on the payout
    // date, keyed on this correction id (refundPayoutGlSourceId … #<correction id>).
    const r = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(op.refundId);
    const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(op.movementId);
    if (!r || !tm) return { outcome: 'skipped', why: 'refund or payout line not found' };
    if (Number(tm.amount_ngn) !== -op.amountNgn || String(tm.posted_at_iso).slice(0, 10) !== op.payDate || Number(r.paid_amount_ngn) !== op.amountNgn) {
      return { outcome: 'skipped', why: `payout ${tm.posted_at_iso.slice(0, 10)} ₦${tm.amount_ngn} / paid ₦${r.paid_amount_ngn} ≠ planned ${op.payDate} ₦${op.amountNgn}` };
    }
    const live = db
      .prepare(`SELECT id, source_id FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_REFUND_PAYOUT_GL' AND source_id LIKE ? AND id NOT IN (${op.reversedJournalIds.map(() => '?').join(',')})`)
      .get(`${op.refundId}:paid:%`, ...op.reversedJournalIds);
    if (live) return { outcome: 'skipped', why: `payout journal already there (${live.id} ${live.source_id})` };
    const blocked = lockedPeriodWhy(op.payDate, 'Payout date');
    if (blocked) return blockedOrThrow(item, blocked);
    const policy = evaluateRefundPayoutGlPolicy(db, {
      quotationRef: r.quotation_ref, customerId: r.customer_id, refundId: op.refundId,
      reasonCategories: (() => { try { return JSON.parse(r.reason_category); } catch { return [r.reason_category]; } })(),
      calculationLines: (() => { try { return JSON.parse(r.calculation_lines_json); } catch { return []; } })(),
    });
    if (!doApply) return { outcome: 'would apply', debit: policy.debitAccountCode || '2500', revenueReview: Boolean(policy.needsRevenueReview) };
    const gl = tryPostCustomerRefundPayoutGlTx(db, {
      refundId: op.refundId, payoutAmountNgn: op.amountNgn, payoutMovementIds: [tm.id], entryDateISO: op.payDate,
      branchId: r.branch_id, createdByUserId: null, needsRevenueReview: policy.needsRevenueReview, debitAccountCode: policy.debitAccountCode,
      correctionId: op.correctionId,
    });
    if (!gl.ok || gl.skipped || gl.duplicate) throw new Error(`${item.id}: payout journal not posted (${gl.error || (gl.duplicate ? `duplicate of ${gl.journalId}` : 'skipped')})`);
    audit(item, { ...op, table: 'gl_journal_entries', key: gl.id || gl.journalId }, { table: 'gl_journal_entries', key: gl.id || gl.journalId, refundId: op.refundId, amountNgn: op.amountNgn, payDate: op.payDate, repairOf: op.repairOf });
    return { outcome: 'applied', journal: gl.id || gl.journalId };
  }
  throw new Error(`${item.id}: unknown operation ${op.kind}`);
}

// DDL (CREATE TABLE IF NOT EXISTS) outside the transactions: MySQL commits implicitly on DDL.
// CHECK runs no DDL: it must stay read-only on a live schema.
if (doApply) {
  ensureInvestigationSchema(db);
  ensureAccountingPhase2Schema(db);
}

const results = [];
let failed = null;

/**
 * --per-item: one item at a time, in plan order (the MySQL wrapper commits nested ERP transactions, so a group
 * transaction is not all-or-nothing). Before / after each item: every planned account's ledger total (opening +
 * movements) and stored balance; the change must equal the item's expectDeltaNgn (0 when the check finds it already
 * done) and stored must equal ledger. Each step is appended to --progress (JSON lines). First error or mismatch stops.
 */
const perItem = has('per-item');
const progressPath = opt('progress');
const progress = (row) => {
  if (progressPath) fs.appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
};
const balancesOf = (ids) =>
  Object.fromEntries(
    ids.map((id) => {
      const a = db.prepare(`SELECT balance, opening_balance_ngn AS o FROM treasury_accounts WHERE id = ?`).get(id);
      const s = db.prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`).get(id);
      return [id, { ledger: Math.round(Number(a?.o || 0) + Number(s?.s || 0)), stored: Math.round(Number(a?.balance || 0)) }];
    })
  );
/** id → { account, amount } for every movement on the watched accounts. */
const rowsOf = (ids) =>
  new Map(
    db
      .prepare(`SELECT id, treasury_account_id AS a, amount_ngn AS n, type FROM treasury_movements WHERE treasury_account_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .map((r) => [r.id, { a: Number(r.a), n: Math.round(Number(r.n)), type: r.type }])
  );
/**
 * Change per account caused by the item: rows that existed before (amount / account changes) plus new rows of the
 * item's own movement types. Other new rows (cashiers working meanwhile) are returned as concurrent, not counted.
 */
const itemDelta = (ids, beforeRows, afterRows, types) => {
  const delta = Object.fromEntries(ids.map((id) => [id, 0]));
  const concurrent = [];
  for (const [id, r] of beforeRows) if (r.a in delta) delta[r.a] -= r.n;
  for (const [id, r] of afterRows) {
    if (!beforeRows.has(id) && !types.includes(r.type)) {
      concurrent.push(`${id} ${r.type} acct ${r.a} ₦${r.n}`);
      continue;
    }
    if (r.a in delta) delta[r.a] += r.n;
  }
  // A row moved off a watched account is gone from afterRows: its before amount stays subtracted (correct).
  return { delta, concurrent };
};
if (perItem) {
  const watch = [...new Set(plan.items.flatMap((i) => Object.keys(i.expectDeltaNgn || {}).map(Number)))];
  progress({ event: 'start', mode: doApply ? 'apply' : 'check', plan: path.basename(planPath), balances: balancesOf(watch) });
  for (const item of plan.items) {
    const before = balancesOf(watch);
    const beforeRows = rowsOf(watch);
    const itemResults = [];
    try {
      for (const op of item.ops) itemResults.push({ id: item.id, record: item.record, field: item.field, op: op.kind, ...runOp(item, op) });
    } catch (e) {
      failed = { item: item.id, error: String(e.message || e) };
      results.push(...itemResults, { id: item.id, outcome: 'FAILED', why: failed.error });
      progress({ event: 'failed', item: item.id, error: failed.error, before, after: balancesOf(watch) });
      break;
    }
    results.push(...itemResults);
    const after = balancesOf(watch);
    const { delta, concurrent } = itemDelta(watch, beforeRows, rowsOf(watch), item.expectTypes || []);
    const posted = itemResults.some((r) => r.outcome === 'applied');
    const mismatch = [];
    for (const id of watch) {
      const want = doApply && posted ? Number(item.expectDeltaNgn?.[id] || 0) : 0;
      if (delta[id] !== want) mismatch.push(`account ${id}: item moved ₦${delta[id]}, expected ₦${want}`);
      // Stored balance must move with the ledger (Taj has a known pre-existing stored ≠ ledger gap: keep it unchanged).
      const gapBefore = before[id].stored - before[id].ledger;
      const gapAfter = after[id].stored - after[id].ledger;
      if (gapAfter !== gapBefore) mismatch.push(`account ${id}: stored − ledger was ₦${gapBefore}, now ₦${gapAfter}`);
    }
    // Every receipt the item posted to: book amount, confirmed field and treasury lines agree.
    if (doApply && posted) {
      for (const rid of new Set(item.ops.map((o) => o.receiptId).filter(Boolean))) {
        const why = confirmedFieldMismatch(rid);
        if (why) mismatch.push(why);
      }
    }
    progress({ event: 'item', item: item.id, outcomes: itemResults.map((r) => `${r.op}:${r.outcome}${r.why ? ` (${r.why})` : ''}`), expectDeltaNgn: item.expectDeltaNgn, itemDelta: delta, concurrent, before, after, mismatch });
    if (mismatch.length) {
      failed = { item: item.id, error: mismatch.join('; ') };
      results.push({ id: item.id, outcome: 'VERIFY FAILED', why: failed.error });
      break;
    }
  }
  progress({ event: failed ? 'stopped' : 'done', failed });
}
for (const group of perItem ? [] : ['A', 'D', 'C', 'B', 'E']) {
  const items = plan.items.filter((i) => i.group === group);
  if (!items.length) continue;
  const groupResults = [];
  try {
    const run = () => {
      for (const item of items) {
        for (const op of item.ops) groupResults.push({ id: item.id, group, record: item.record, field: item.field, op: op.kind, ...runOp(item, op) });
        if (doApply) for (const rid of new Set(item.ops.map((o) => o.receiptId).filter(Boolean))) assertConfirmedFieldAligned(item, rid);
      }
    };
    if (doApply) db.transaction(run)();
    else run();
    results.push(...groupResults);
    // Fixed assets for capex expenses, after the group has committed (the ERP's sync runs DDL).
    if (doApply && pendingCapex.length) {
      const { item } = pendingCapex[0];
      pendingCapex.length = 0;
      results.push({ id: item.id, group, record: capexKeys.join(' + '), field: 'fixed asset', op: 'capexSync', outcome: 'applied', capex: registerCombinedCapexAsset(item) });
    }
  } catch (e) {
    failed = { group, error: String(e.message || e) };
    results.push({ group, outcome: 'ROLLED BACK', why: failed.error });
    break;
  }
}

const stamp = approvedAtISO.replace(/[:.]/g, '-');
const out = path.join(BE, `exports/phase2-apply-${database}-${doApply ? 'applied' : 'check'}-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify({ database, mode: doApply ? 'apply' : 'check', approver, approvedAtISO, plan: path.basename(planPath), failed, results }, null, 1));
const tally = {};
for (const r of results) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
console.log(`${doApply ? 'APPLY' : 'CHECK'} on ${databaseLabel(cfg)} → ${out}`);
console.log(tally);
for (const r of results.filter((x) => x.outcome !== 'applied' && x.outcome !== 'would apply')) console.log(`  ${r.id || r.group} ${r.outcome}: ${r.why || ''}`);
db.close?.();
process.exit(failed ? 1 : 0);
