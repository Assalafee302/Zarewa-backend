#!/usr/bin/env node
/** READ-ONLY (SELECT only): facts for the Phase 2 round 3 (August bank links, phantom inflows, labels) dry run. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const [database = 'u172282559_ZAREWA', outPath = path.join(BE, 'exports/phase2-aug-read3.json'), idsPath = ''] = process.argv.slice(2);
const { loadLiveMysqlEnv } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2LiveEnv.mjs')).href);
loadLiveMysqlEnv(process.env.ZAREWA_PHASE2_ENV_ROOT || BE, database);
const { mysqlConfigFromEnv, createMysqlDatabase } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database }, { reset: false, bootstrap: false });
const q = (s, ...a) => db.prepare(s).all(...a);
const ph = (a) => a.map(() => '?').join(',') || "''";
const extraIds = idsPath ? JSON.parse(fs.readFileSync(idsPath, 'utf8')) : [];
const out = {};
out.reconAug = q(`SELECT * FROM bank_reconciliation_lines WHERE bank_date_iso >= '2026-08-01' AND bank_date_iso <= '2026-08-31' ORDER BY id`);
out.reconLast = q(`SELECT id FROM bank_reconciliation_lines WHERE id LIKE 'BKR-KD-26-%' ORDER BY id DESC LIMIT 1`);
out.linkedElsewhere = extraIds.length
  ? q(`SELECT id, bank_date_iso, amount_ngn, system_match FROM bank_reconciliation_lines WHERE bank_date_iso NOT LIKE '2026-08%' AND (${extraIds.map(() => 'system_match LIKE ?').join(' OR ')})`, ...extraIds.map((i) => `%${i}%`))
  : [];
out.movements = extraIds.length ? q(`SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, source_kind, source_id, reverses_movement_id FROM treasury_movements WHERE id IN (${ph(extraIds)})`, ...extraIds) : [];
out.chargeTm = q(`SELECT id, treasury_account_id, posted_at_iso, amount_ngn, source_id FROM treasury_movements WHERE source_id IN ('EXP-KD-26-0459','EXP-KD-26-0460','EXP-KD-26-0461')`);
// Phantom candidates: August RECEIPT_IN on Moniepoint / Cash Office whose ledger RECEIPT is ₦0 and is not reversed.
out.phantom = q(
  `SELECT m.id, m.posted_at_iso, m.treasury_account_id, m.amount_ngn, m.source_id, m.reference, m.counterparty_name,
          l.amount_ngn AS ledger_ngn, l.quotation_ref, l.customer_id, l.payment_method,
          (SELECT COUNT(*) FROM treasury_movements r WHERE r.reverses_movement_id = m.id) AS reversals
   FROM treasury_movements m JOIN ledger_entries l ON l.id = m.source_id AND l.type = 'RECEIPT'
   WHERE m.type = 'RECEIPT_IN' AND m.posted_at_iso >= '2026-08-01' AND m.posted_at_iso < '2026-09-01' AND m.amount_ngn > 0 AND l.amount_ngn = 0`);
const phIds = out.phantom.map((p) => p.source_id);
out.phantomSettle = phIds.length ? q(`SELECT entity_id, action, details_json FROM audit_log WHERE action = 'receipt.finance_settlement' AND entity_id IN (${ph(phIds)})`, ...phIds) : [];
out.phantomQuotes = q(`SELECT id, paid_ngn, total_ngn FROM quotations WHERE id IN (${ph(out.phantom.map((p) => p.quotation_ref))})`, ...out.phantom.map((p) => p.quotation_ref));
out.phantomGl = phIds.length ? q(`SELECT j.id, j.entry_date_iso, j.source_kind, j.source_id, l.account_id, l.debit_ngn, l.credit_ngn FROM gl_journal_entries j JOIN gl_journal_lines l ON l.journal_id = j.id WHERE j.source_id IN (${ph(phIds)})`, ...phIds) : [];
// Method vs account: August receipts whose single-account method names another account than the treasury line.
out.labels = q(
  `SELECT r.id, r.method, l.payment_method, l.bank_reference, m.id AS tm, m.treasury_account_id, a.name AS acct_name, a.type AS acct_type
   FROM sales_receipts r JOIN ledger_entries l ON l.id = r.id JOIN treasury_movements m ON m.source_id = r.id AND m.type = 'RECEIPT_IN'
   JOIN treasury_accounts a ON a.id = m.treasury_account_id
   WHERE r.branch_id = 'BR-KD' AND r.date_iso >= '2026-08-01' AND r.date_iso < '2026-09-01' AND r.method NOT LIKE 'Split%'`);
out.accounts = q(`SELECT id, name, type, bank_name FROM treasury_accounts WHERE branch_id = 'BR-KD'`);
out.tm2113 = q(`SELECT id, posted_at_iso, treasury_account_id, amount_ngn, source_id FROM treasury_movements WHERE id = 'TM-KD-26-2113'`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(outPath, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
db.close?.();
