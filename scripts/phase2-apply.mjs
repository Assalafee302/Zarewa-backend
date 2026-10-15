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
const { postBalancedJournalTx } = await imp('server/glOps.js');
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

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const actor = {
  id: null,
  displayName: approver,
  name: approver,
  jobTitle: 'Operations Manager',
  permissions: ['investigation.manage'],
};
const approvedAtISO = new Date().toISOString();
const ALLOWED = {
  coil_lots: { key: 'coil_no', cols: ['unit_cost_ngn_per_kg', 'received_at_iso', 'gauge_label'] },
  production_jobs: { key: 'job_id', cols: ['status'] },
  sales_receipts: { key: 'id', cols: ['method', 'status'] },
  expenses: { key: 'expense_id', cols: ['category', 'expense_type'] },
};

const same = (current, expected, compare) => {
  if (expected == null || expected === '' || expected === '(none)') return current == null || current === '' || Number(current) === 0;
  if (compare === 'day') return String(current || '').slice(0, 10) === String(expected).slice(0, 10);
  if (typeof expected === 'number' || (/^-?\d+(\.\d+)?$/.test(String(expected)) && /^-?\d+(\.\d+)?$/.test(String(current ?? '')))) {
    return Number(current) === Number(expected);
  }
  return String(current ?? '').trim() === String(expected).trim();
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
      postedAtISO: `${op.date}T12:00:00.000Z`,
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
    });
    if (!gl.ok && !gl.skipped && !gl.duplicate) throw new Error(`${item.id}: GL — ${gl.error}`);
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
    let cust = db.prepare(`SELECT customer_id, name FROM customers WHERE LOWER(name) = LOWER(?) AND branch_id = ?`).get(op.customerName, op.branchId);
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
  throw new Error(`${item.id}: unknown operation ${op.kind}`);
}

// DDL (CREATE TABLE IF NOT EXISTS) outside the transactions: MySQL commits implicitly on DDL.
ensureInvestigationSchema(db);
ensureAccountingPhase2Schema(db);

const results = [];
let failed = null;
for (const group of ['A', 'D', 'C', 'B']) {
  const items = plan.items.filter((i) => i.group === group);
  if (!items.length) continue;
  const groupResults = [];
  try {
    const run = () => {
      for (const item of items) {
        for (const op of item.ops) groupResults.push({ id: item.id, group, record: item.record, field: item.field, op: op.kind, ...runOp(item, op) });
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
