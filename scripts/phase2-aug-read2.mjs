#!/usr/bin/env node
/** READ-ONLY (SELECT only): overpaid quotations, customer names, recon statuses and GL links for the Phase 2 round 2 dry run. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const database = process.argv[2] || 'u172282559_ZAREWA';
const outPath = process.argv[3] || path.join(BE, 'exports/phase2-aug-read2.json');
const { loadLiveMysqlEnv } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2LiveEnv.mjs')).href);
loadLiveMysqlEnv(process.env.ZAREWA_PHASE2_ENV_ROOT || BE, database);
const { mysqlConfigFromEnv, createMysqlDatabase } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database }, { reset: false, bootstrap: false });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const out = {};
out.reconStatuses = q(`SELECT status, COUNT(*) AS n FROM bank_reconciliation_lines GROUP BY status`);
out.reconSample = q(`SELECT * FROM bank_reconciliation_lines ORDER BY bank_date_iso DESC LIMIT 3`);
out.overpaid = q(
  `SELECT q.id, q.customer_id, q.customer_name, q.date_iso, q.total_ngn, q.paid_ngn, q.status, q.payment_status,
          COALESCE((SELECT SUM(COALESCE(r.approved_amount_ngn, r.amount_ngn)) FROM customer_refunds r
                    WHERE r.quotation_ref = q.id AND LOWER(COALESCE(r.status,'')) NOT IN ('rejected','cancelled')), 0) AS refunds_ngn
   FROM quotations q WHERE q.branch_id = 'BR-KD' AND q.paid_ngn > q.total_ngn`);
out.customers = q(
  `SELECT customer_id, name FROM customers WHERE name LIKE '%Baita%' OR name LIKE '%Babangida%' OR name LIKE '%Solomon%' OR name LIKE '%Abubakar Abdullahi%'
     OR name LIKE '%Sali Usman%' OR name LIKE '%Muhammad Abubakar%' OR name LIKE '%Mohammed Abubakar%' OR name LIKE '%Aleke%' OR name LIKE '%Simeon%'
     OR name LIKE '%Kayode%' OR name LIKE '%Ayeni%' OR name LIKE '%Nuhu%'`);
out.gl = q(`SELECT id, entry_date_iso, source_kind, source_id, memo FROM gl_journal_entries WHERE source_id LIKE '%TM-KD-26-1427%' OR source_id LIKE '%RF-KD-26-9250%'
            OR source_id IN ('TM-KD-26-2142','TM-KD-26-2326','TM-KD-26-2327','TM-KD-26-2162','TM-KD-26-1904','TM-KD-26-1942','PREQ-KD-26-0170','PREQ-KD-26-0210','PREQ-KD-26-0205','RF-KD-26-9500')`);
out.glLines = out.gl.length ? q(`SELECT * FROM gl_journal_lines WHERE journal_id IN (${out.gl.map(() => '?').join(',')})`, ...out.gl.map((g) => g.id)) : [];
out.cashGl = q(`SELECT * FROM gl_accounts WHERE code LIKE '10%' OR code LIKE '11%' LIMIT 40`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(outPath, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
db.close?.();
