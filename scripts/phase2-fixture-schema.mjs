#!/usr/bin/env node
/**
 * Build a LOCAL test schema (default zarewa_phase2_fixture) holding the records a Phase 2 plan touches, taken from
 * the Kaduna Sep 2026 fixtures (13 Oct 2026 ERP export). Used to test scripts/phase2-apply.mjs before the
 * production backup is restored. Wipes and rebuilds that schema only; refuses production names and remote hosts.
 *
 *   node scripts/phase2-fixture-schema.mjs [--database zarewa_phase2_fixture] --plan exports/<plan>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FE = path.resolve(BE, '../Zarewa-frontend-main');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const args = process.argv.slice(2);
const opt = (n, d = '') => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const database = opt('database', 'zarewa_phase2_fixture');
const plan = JSON.parse(fs.readFileSync(opt('plan'), 'utf8'));

// One connection so the session setting below (no FK checks for this partial copy) holds for every insert.
process.env.ZAREWA_MYSQL_POOL_SIZE = '1';
const { mysqlConfigFromEnv, createMysqlDatabase, databaseLabel } = await imp('server/mysqlDatabase.js');
const { assertNotProductionMysqlDatabase } = await imp('server/mysqlProdGuard.js');
const { normaliseDateISO } = await imp('shared/lib/coilRegisterCore.js');
const cfg = { ...mysqlConfigFromEnv(), database };
assertNotProductionMysqlDatabase(database, 'phase2 fixture schema');
if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(cfg.host) || !/fixture|test/i.test(database)) {
  console.error(`Refused: ${databaseLabel(cfg)}`);
  process.exit(3);
}

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const mat = load(path.join(BE, 'shared/lib/__fixtures__/kd-2026-09/materialRegisterSource.json'));
const sales = load(path.join(FE, 'src/lib/__fixtures__/kd-2026-09/salesReportSource.json'));
const exp = load(path.join(FE, 'src/lib/__fixtures__/kd-2026-09/expensesReportSource.json'));

console.error(`Rebuilding ${databaseLabel(cfg)} (schema DDL)…`);
const db = createMysqlDatabase(cfg, { reset: true, bootstrap: true });
// Partial copy: only the records the plan touches, so parents (customers, quotations…) are absent.
db.exec('SET FOREIGN_KEY_CHECKS = 0');
const insert = (table, row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
};
const nn = (v) => (v === '' || v == null ? null : v);

const ops = plan.items.flatMap((i) => i.ops);
const keysOf = (table) => new Set(ops.filter((o) => o.table === table).map((o) => o.key));
const coilNos = new Set([...keysOf('coil_lots'), ...ops.filter((o) => o.kind === 'grnDate').map((o) => o.coilNo)]);
for (const c of mat.coilLots.filter((x) => coilNos.has(x.coilNo))) {
  insert('coil_lots', {
    coil_no: c.coilNo, product_id: c.productID, weight_kg: nn(c.weightKg), qty_received: nn(c.qtyReceived) ?? 0,
    qty_remaining: 0, qty_reserved: 0, current_weight_kg: nn(c.currentWeightKg) ?? 0, colour: c.colour, gauge_label: c.gaugeLabel,
    material_type_name: c.materialTypeName, current_status: c.currentStatus, po_id: nn(c.poID), supplier_name: nn(c.supplierName),
    received_at_iso: normaliseDateISO(c.receivedAtISO) || null, landed_cost_ngn: nn(c.landedCostNgn), unit_cost_ngn_per_kg: nn(c.unitCostNgnPerKg),
  });
}
for (const m of mat.stockMovements.filter((x) => x.type === 'STORE_GRN' && [...coilNos].some((n) => String(x.detail).startsWith(`${n} `)))) {
  insert('stock_movements', { id: m.id, at_iso: m.atISO, type: m.type, ref: m.ref, product_id: m.productID, qty: m.qty, detail: m.detail, date_iso: m.dateISO });
}
for (const j of sales.productionJobs.filter((x) => keysOf('production_jobs').has(x.jobID))) {
  insert('production_jobs', { job_id: j.jobID, quotation_ref: j.quotationRef, customer_name: j.customerName, status: j.status, completed_at_iso: nn(j.completedAtISO), actual_meters: Number(j.actualMeters) || 0, actual_weight_kg: Number(j.actualWeightKg) || 0 });
}
for (const r of sales.receipts.filter((x) => keysOf('sales_receipts').has(x.id))) {
  insert('sales_receipts', { id: r.id, customer_id: r.customerID, customer_name: r.customer, quotation_ref: r.quotationRef, date_iso: r.dateISO, amount_ngn: Number(r.amountNgn) || 0, method: r.method, status: r.status, ledger_entry_id: r.ledgerEntryId });
}
const tmIds = new Set(ops.filter((o) => o.kind === 'reverseTreasuryLine').map((o) => o.movementId));
const accounts = new Set();
for (const t of sales.treasuryMovements.filter((x) => tmIds.has(x.id))) {
  if (!accounts.has(t.treasuryAccountId)) {
    const a = sales.treasuryAccounts.find((x) => String(x.id) === String(t.treasuryAccountId)) || { name: t.accountName, type: 'Bank' };
    insert('treasury_accounts', { id: t.treasuryAccountId, name: a.name, bank_name: nn(a.bankName), balance: 5_000_000, type: a.type || 'Bank', branch_id: 'BR-KD' });
    accounts.add(t.treasuryAccountId);
  }
  insert('treasury_movements', { id: t.id, posted_at_iso: t.postedAtISO, type: t.type, treasury_account_id: t.treasuryAccountId, amount_ngn: t.amountNgn, reference: nn(t.reference), counterparty_name: nn(t.counterpartyName), source_kind: t.sourceKind, source_id: t.sourceId });
}
for (const e of exp.expenses.filter((x) => keysOf('expenses').has(x.expenseID))) {
  insert('expenses', { expense_id: e.expenseID, expense_type: e.expenseType, amount_ngn: Number(e.amountNgn) || 0, date: e.date, category: e.category, payment_method: nn(e.paymentMethod), reference: nn(e.reference) });
}
const counts = Object.fromEntries(
  ['coil_lots', 'stock_movements', 'production_jobs', 'sales_receipts', 'treasury_movements', 'expenses'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
);
console.log(`Built ${databaseLabel(cfg)}:`, counts);
db.close?.();
process.exit(0);
