#!/usr/bin/env node
/** READ-ONLY (SELECT only): live facts for the Phase 2 round 2 (August 2026, Kaduna) dry run. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENV_ROOT = process.env.ZAREWA_PHASE2_ENV_ROOT || BE;
const database = process.argv[2] || 'u172282559_ZAREWA';
const outPath = process.argv[3] || path.join(BE, 'exports/phase2-aug-read.json');
const { loadLiveMysqlEnv } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2LiveEnv.mjs')).href);
loadLiveMysqlEnv(ENV_ROOT, database);
const { mysqlConfigFromEnv, createMysqlDatabase } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database }, { reset: false, bootstrap: false });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const out = {};
const cols = (t) => q(`SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, t)
  .map((r) => `${r.c ?? r.COLUMN_NAME}:${r.t ?? r.DATA_TYPE}`);
out.columns = {};
for (const t of ['treasury_accounts', 'treasury_movements', 'sales_receipts', 'customer_refunds', 'fixed_assets', 'expenses', 'quotations', 'payment_requests', 'bank_reconciliation_lines']) out.columns[t] = cols(t);
out.accounts = q(`SELECT * FROM treasury_accounts ORDER BY id`);
out.locks = q(`SELECT period_key FROM accounting_period_locks ORDER BY period_key`).map((r) => r.period_key);
const kd = out.accounts.filter((a) => a.branch_id === 'BR-KD').map((a) => a.id);
out.movements = q(
  `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, reference, counterparty_kind, counterparty_id, counterparty_name,
          source_kind, source_id, note, reverses_movement_id
   FROM treasury_movements WHERE treasury_account_id IN (${kd.map(() => '?').join(',')}) AND posted_at_iso < '2026-10-01'
   ORDER BY posted_at_iso, id`, ...kd);
out.expenses = q(`SELECT * FROM expenses WHERE branch_id = 'BR-KD' AND date >= '2026-07-25' AND date <= '2026-09-30' ORDER BY date, expense_id`);
out.namedExpenses = q(`SELECT * FROM expenses WHERE expense_id IN ('EXP-KD-26-0241','EXP-KD-26-0362','EXP-KD-26-0397','EXP-KD-26-0404')`);
out.categories = q(`SELECT category, COUNT(*) AS n FROM expenses GROUP BY category ORDER BY n DESC`);
out.fixedAssets = q(`SELECT * FROM fixed_assets`);
out.refund9250 = q(`SELECT * FROM customer_refunds WHERE refund_id = 'RF-KD-26-9250'`);
out.refundsAug = q(`SELECT refund_id, customer_id, customer_name, quotation_ref, reason_category, amount_ngn, approved_amount_ngn, paid_amount_ngn, paid_at_iso, payee_name, status
                    FROM customer_refunds WHERE branch_id = 'BR-KD' AND (paid_at_iso >= '2026-07-01' OR requested_at_iso >= '2026-07-01') ORDER BY paid_at_iso`);
out.receiptsAug = q(`SELECT * FROM sales_receipts WHERE date_iso >= '2026-07-28' AND date_iso <= '2026-08-12' AND amount_ngn IN (2387900, 219200, 599400, 447680, 1062080)`);
out.payReqAug = q(`SELECT * FROM payment_requests WHERE (request_date >= '2026-08-01' AND request_date <= '2026-09-05') LIMIT 400`);
out.mamia = q(`SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, counterparty_name, source_kind, source_id, note FROM treasury_movements WHERE (note LIKE '%amia%' OR counterparty_name LIKE '%amia%' OR reference LIKE '%amia%')`);
out.mamiaExp = q(`SELECT * FROM expenses WHERE expense_type LIKE '%amia%' OR reference LIKE '%amia%'`);
out.reconAug = q(`SELECT * FROM bank_reconciliation_lines WHERE bank_date_iso >= '2026-08-01' AND bank_date_iso <= '2026-08-31'`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(outPath, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length])));
db.close?.();
