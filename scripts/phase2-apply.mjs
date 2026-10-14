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

const { mysqlConfigFromEnv, createMysqlDatabase, databaseLabel } = await imp('server/mysqlDatabase.js');
const cfg = { ...mysqlConfigFromEnv(), database };
const localHost = /^(localhost|127\.0\.0\.1|::1)$/i.test(cfg.host);
const rehearsalName = /rehearsal|fixture|test/i.test(database);
if (!live && (!localHost || !rehearsalName)) {
  console.error(`Refused: ${databaseLabel(cfg)} — only a local rehearsal/fixture/test schema without --live.`);
  process.exit(3);
}
if (live && process.env.ZAREWA_PHASE2_LIVE_CONFIRM !== database) {
  console.error(`Refused: --live needs ZAREWA_PHASE2_LIVE_CONFIRM=${database}.`);
  process.exit(3);
}

const { appendAuditLog } = await imp('server/controlOps.js');
const { insertTreasuryMovementTx } = await imp('server/writeOps.js');
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

function runOp(item, op) {
  if (op.kind === 'update') {
    const t = ALLOWED[op.table];
    if (!t || t.key !== op.keyCol || !t.cols.includes(op.col)) throw new Error(`${item.id}: ${op.table}.${op.col} not allowed`);
    const row = db.prepare(`SELECT ${op.col} AS v FROM ${op.table} WHERE ${op.keyCol} = ?`).get(op.key);
    if (!row) return { outcome: 'skipped', why: 'record not found' };
    if (same(row.v, op.after, op.compare)) return { outcome: 'skipped', why: 'already at the planned value' };
    if (!same(row.v, op.before, op.compare)) return { outcome: 'skipped', why: `current value ${JSON.stringify(row.v)} ≠ planned before ${JSON.stringify(op.before)}` };
    if (!doApply) return { outcome: 'would apply' };
    let after = op.after;
    if (op.compare === 'day') after = `${op.after}${String(row.v || '').slice(10)}`;
    db.prepare(`UPDATE ${op.table} SET ${op.col} = ? WHERE ${op.keyCol} = ?`).run(after, op.key);
    audit(item, op, { table: op.table, key: op.key, column: op.col, before: row.v, after });
    if (op.afterHook === 'capexSync') {
      const r = syncFixedAssetFromCapexExpense(db, op.key, { actor });
      return { outcome: 'applied', capex: r?.skipped ? `fixed asset not created (${r.reason})` : r?.ok ? 'fixed asset registered' : `fixed asset: ${r?.error}` };
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
