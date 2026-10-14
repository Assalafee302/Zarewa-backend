#!/usr/bin/env node
/** READ-ONLY (SELECT only): live facts for the Chairman withdrawal / TM-KD-26-1969 dry run. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENV_ROOT = process.env.ZAREWA_PHASE2_ENV_ROOT || BE;
const database = process.argv[2] || 'u172282559_ZAREWA';
const { loadLiveMysqlEnv } = await import(pathToFileURL(path.join(BE, 'scripts/lib/phase2LiveEnv.mjs')).href);
loadLiveMysqlEnv(ENV_ROOT, database);
const { mysqlConfigFromEnv, createMysqlDatabase } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database }, { reset: false, bootstrap: false });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const out = {};
out.accounts = q(`SELECT id, name, bank_name, type, branch_id, balance FROM treasury_accounts ORDER BY id`);
out.locks = q(`SELECT period_key FROM accounting_period_locks ORDER BY period_key`).map((r) => r.period_key);
out.chairmanExpenses = q(
  `SELECT expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id
   FROM expenses WHERE category = 'Chairman withdrawal' ORDER BY date DESC, expense_id DESC LIMIT 8`
);
out.chairmanTm = q(
  `SELECT m.id, m.posted_at_iso, m.type, m.treasury_account_id, m.amount_ngn, m.reference, m.counterparty_kind, m.counterparty_name, m.source_kind, m.source_id, m.note, m.created_by
   FROM treasury_movements m JOIN expenses e ON e.expense_id = m.source_id
   WHERE e.category = 'Chairman withdrawal' ORDER BY m.posted_at_iso DESC LIMIT 4`
);
out.possibleDuplicates = q(
  `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, reference, source_kind, source_id, note
   FROM treasury_movements
   WHERE posted_at_iso >= '2026-08-01' AND posted_at_iso < '2026-08-16'
     AND ABS(amount_ngn) IN (1160000, 300000, 50000, 20000)`
);
out.dupExpenses = q(
  `SELECT expense_id, expense_type, amount_ngn, date, category, reference FROM expenses
   WHERE date >= '2026-08-01' AND date <= '2026-08-15' AND amount_ngn IN (1160000, 300000, 50000, 20000)`
);
out.tm1969 = q(`SELECT * FROM treasury_movements WHERE id = 'TM-KD-26-1969'`);
const t = out.tm1969[0];
if (t) {
  out.tm1969Reversals = q(`SELECT id, posted_at_iso, type, amount_ngn FROM treasury_movements WHERE reverses_movement_id = ?`, t.id);
  out.tm1969Siblings = q(
    `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn FROM treasury_movements WHERE source_id = ? AND id <> ?`,
    t.source_id || '-', t.id
  );
  out.tm1969Ledger = q(`SELECT id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref FROM ledger_entries WHERE id = ?`, t.source_id || '-');
  out.tm1969Receipt = q(`SELECT id, date_iso, amount_ngn, status, quotation_ref FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`, t.source_id || '-', t.source_id || '-');
  out.tm1969Gl = q(`SELECT id, entry_date_iso, source_kind, source_id, memo FROM gl_journal_entries WHERE source_id IN (?, ?)`, t.id, t.source_id || '-');
}
out.expenseCols = q(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'expenses'`).map((r) => r.c ?? r.C ?? r.COLUMN_NAME);
console.log(JSON.stringify(out, null, 1));
db.close?.();
