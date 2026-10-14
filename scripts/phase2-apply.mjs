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
    if (!doApply) return { outcome: 'would apply', account: `${account.name} (${account.bank_name})` };
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
    return { outcome: 'applied', expenseID, treasuryMovementId: movement.id };
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
