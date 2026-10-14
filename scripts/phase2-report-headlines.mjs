#!/usr/bin/env node
/**
 * Headline figures of the four Kaduna Sep 2026 reports read from a LOCAL database schema (SELECT only), with the
 * same loaders the report endpoints use. Run before and after scripts/phase2-apply.mjs on the rehearsal copy.
 *
 *   node scripts/phase2-report-headlines.mjs --database zarewa_phase2_rehearsal [--out file.json] [--compare before.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const args = process.argv.slice(2);
const opt = (n, d = '') => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const database = opt('database');
if (!database) {
  console.error('Usage: node scripts/phase2-report-headlines.mjs --database <local schema> [--out f.json] [--compare before.json]');
  process.exit(2);
}

const { mysqlConfigFromEnv, createMysqlDatabase, databaseLabel } = await imp('server/mysqlDatabase.js');
const cfg = { ...mysqlConfigFromEnv(), database };
if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(cfg.host)) {
  console.error(`Refused: ${databaseLabel(cfg)} is not local.`);
  process.exit(3);
}
const rm = await imp('server/readModel.js');
const lq = await imp('server/listQueryOpts.js');
const { loadPurchaseRegisterSource } = await imp('server/procurement/purchaseRegisterSourceOps.js');
const { loadReportPeriodSource } = await imp('server/finance/reportPeriodSourceOps.js');
const { headlines } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2Headlines.mjs')).href);

const B = 'BR-KD';
const startDate = '2026-09-01';
const endDate = '2026-09-30';
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const t0 = Date.now();
const purchase = loadPurchaseRegisterSource(db, { branchScope: B, startDate, endDate });
const period = loadReportPeriodSource(db, { branchScope: B, startDate, endDate });
if (!period.ok) throw new Error(period.error);
const material = {
  coilLots: rm.listCoilLots(db, B),
  stockMovements: rm.listStockMovementsForBranchThrough(db, B, '9999-12-31'),
  purchaseOrders: rm.listPurchaseOrders(db, B, lq.reportPurchaseOrderListOpts()),
  productionJobs: period.productionJobs,
  quotations: period.quotations,
  startDate,
  endDate,
};
const sales = {
  receipts: period.receipts,
  productionJobs: period.productionJobs,
  quotations: period.quotations,
  quotationLines: period.quotationLines,
  ledgerEntries: period.ledgerEntries,
  treasuryMovements: period.treasuryMovements,
  accrualTreasuryMovements: period.accrualTreasuryMovements,
  refunds: period.refunds,
  bankRecon: period.bankReconciliation,
  startDate,
  endDate,
};
const expenses = {
  expenses: period.expenses,
  paymentRequests: period.paymentRequests,
  treasuryMovements: period.treasuryMovements,
  startDate,
  endDate,
};
const h = headlines({ purchase, material, sales, expenses });
console.error(`Loaded and computed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const out = opt('out');
if (out) fs.writeFileSync(out, JSON.stringify({ database, computedAtISO: new Date().toISOString(), headlines: h }, null, 1));

const cmp = opt('compare');
const before = cmp ? JSON.parse(fs.readFileSync(cmp, 'utf8')).headlines : null;
const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-NG') : String(v ?? '—'));
for (const k of Object.keys({ ...(before || {}), ...h })) {
  const a = before ? before[k] : undefined;
  const b = h[k];
  if (before && a === b) continue;
  console.log(before ? `${k}: ${fmt(a)} → ${fmt(b)}` : `${k}: ${fmt(b)}`);
}
db.close?.();
process.exit(0);
