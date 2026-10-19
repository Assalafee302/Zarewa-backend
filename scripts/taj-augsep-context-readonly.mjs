#!/usr/bin/env node
/**
 * READ-ONLY (SELECT/SHOW only, READ ONLY session, one connection): facts for the Taj Aug–Sep round (owner 19 Oct 2026).
 *   P1  TM-KD-26-3021 (Taj leg of PREQ-KD-26-0330 / EXP-KD-26-0404): line, legs, journal lines, expense / request figures.
 *   P4  LE-KD-26-1323 Abdullahi Mohammed (customer, TM-KD-26-1888, its bank-recon row).
 *   P5  CUS-KD-26-1165 Yunusa Ahmed, September Taj bank-recon rows of the three ₦49,000 credits.
 *   P2/P3 who bank-confirmed LE-KD-26-1359 / LE-KD-26-1329 and through which call (audit_log).
 *   Taj ledger and stored balance at 31 Aug, 30 Sep and 19 Oct (Lagos day cut), period locks.
 *
 *   node scripts/taj-augsep-context-readonly.mjs  →  exports/phase2-taj-oct/taj-augsep-context-readonly.json
 * Reads the commented ZAREWA_MYSQL_* lines from .env.local in ZAREWA_PHASE2_ENV_ROOT (default: the main checkout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENV_ROOT = process.env.ZAREWA_PHASE2_ENV_ROOT || 'C:/Users/USER/OneDrive/Desktop/Zarewa-backend-main';
for (const line of fs.readFileSync(path.join(ENV_ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
process.env.ZAREWA_MYSQL_PORT ||= '3306';
process.env.ZAREWA_MYSQL_POOL_SIZE = '1';
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';
const { createMysqlDatabase, mysqlConfigFromEnv } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), connectionLimit: 1 }, { reset: false, bootstrap: false });
db.exec('SET SESSION TRANSACTION READ ONLY');
const q = (sql, ...a) => {
  if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) throw new Error(`refused non-SELECT: ${sql.slice(0, 40)}`);
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ error: String(e.message || e) }];
  }
};

const TAJ = 2;
const CUTS = { '2026-08-31': '2026-08-31T23:00:00Z', '2026-09-30': '2026-09-30T23:00:00Z', '2026-10-19': '2026-10-19T23:00:00Z' };
const out = { readAtISO: new Date().toISOString() };
try {
  out.locks = q(`SELECT * FROM accounting_period_locks WHERE period_key IN ('2026-08','2026-09','2026-10')`);
  out.taj = q(`SELECT id, name, balance, opening_balance_ngn FROM treasury_accounts WHERE id = ?`, TAJ);
  out.tajLedgerAt = Object.fromEntries(
    Object.entries(CUTS).map(([d, cut]) => [d, q(`SELECT COALESCE(SUM(amount_ngn),0) AS s, COUNT(*) AS n FROM treasury_movements WHERE treasury_account_id = ? AND posted_at_iso < ?`, TAJ, cut)[0]])
  );
  out.tajAllMovements = q(`SELECT COALESCE(SUM(amount_ngn),0) AS s, COUNT(*) AS n FROM treasury_movements WHERE treasury_account_id = ?`, TAJ)[0];

  // P1
  out.p1Line = q(`SELECT * FROM treasury_movements WHERE id = 'TM-KD-26-3021'`);
  out.p1Reversal = q(`SELECT id, type, amount_ngn, posted_at_iso FROM treasury_movements WHERE reverses_movement_id = 'TM-KD-26-3021'`);
  out.p1Legs = q(`SELECT id, type, treasury_account_id, amount_ngn, posted_at_iso, source_kind, reverses_movement_id FROM treasury_movements WHERE source_id = 'PREQ-KD-26-0330' ORDER BY id`);
  out.p1Journal = q(
    `SELECT je.id, je.source_kind, je.source_id, je.entry_date_iso, je.period_key, a.code, a.id AS account_id, l.debit_ngn, l.credit_ngn
     FROM gl_journal_entries je JOIN gl_journal_lines l ON l.journal_id = je.id JOIN gl_accounts a ON a.id = l.account_id
     WHERE je.source_id = 'TM-KD-26-3021'`
  );
  out.p1Expense = q(`SELECT expense_id, amount_ngn, category, branch_id, date, expense_type FROM expenses WHERE expense_id = 'EXP-KD-26-0404'`);
  out.p1Request = q(`SELECT request_id, expense_id, amount_requested_ngn, paid_amount_ngn, approval_status, paid_at_iso FROM payment_requests WHERE request_id = 'PREQ-KD-26-0330'`);

  // P4
  out.p4Ledger = q(`SELECT id, type, customer_id, customer_name, amount_ngn, quotation_ref, at_iso, payment_method FROM ledger_entries WHERE id = 'LE-KD-26-1323'`);
  out.p4Receipt = q(`SELECT id, customer_id, amount_ngn, bank_received_amount_ngn, status, date_iso, method, ledger_entry_id FROM sales_receipts WHERE id = 'LE-KD-26-1323' OR ledger_entry_id = 'LE-KD-26-1323'`);
  out.p4Line = q(`SELECT id, type, treasury_account_id, amount_ngn, posted_at_iso, source_id FROM treasury_movements WHERE id = 'TM-KD-26-1888'`);
  out.p4Recon = q(`SELECT id, bank_date_iso, description, amount_ngn, system_match, status, matched_system_amount_ngn, variance_ngn FROM bank_reconciliation_lines WHERE system_match LIKE '%TM-KD-26-1888%'`);
  const p4Cust = out.p4Ledger[0]?.customer_id || '-';
  out.p4Customer = q(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = ?`, p4Cust);
  out.p4Advances = q(`SELECT id, amount_ngn, at_iso FROM ledger_entries WHERE type = 'ADVANCE_IN' AND customer_id = ? AND at_iso LIKE '2026-08-02%'`, p4Cust);

  // P5
  out.p5Customer = q(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = 'CUS-KD-26-1165'`);
  out.p5Advances = q(`SELECT id, amount_ngn, at_iso FROM ledger_entries WHERE type = 'ADVANCE_IN' AND customer_id = 'CUS-KD-26-1165' ORDER BY at_iso`);
  out.p5Recon = q(
    `SELECT id, bank_date_iso, description, amount_ngn, system_match, status FROM bank_reconciliation_lines
     WHERE treasury_account_id = ? AND bank_date_iso IN ('2026-09-18','2026-09-19','2026-09-26') AND amount_ngn IN (49000, 120000) ORDER BY bank_date_iso, id`,
    TAJ
  );

  // P2 / P3 — who confirmed, through which call
  for (const id of ['LE-KD-26-1359', 'LE-KD-26-1329']) {
    const sr = q(
      `SELECT id, customer_id, amount_ngn, bank_received_amount_ngn, status, date_iso, method, handled_by, bank_confirmed_at_iso, bank_confirmed_by_user_id,
              finance_reconciliation_saved_at_iso FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`,
      id,
      id
    );
    const uid = sr[0]?.bank_confirmed_by_user_id || '-';
    out[`receipt_${id}`] = {
      receipt: sr,
      confirmedBy: q(`SELECT id, username, display_name, role_key FROM app_users WHERE id = ?`, uid),
      audit: q(
        `SELECT id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json FROM audit_log
         WHERE entity_id IN (?, ?) ORDER BY occurred_at_iso`,
        id,
        sr[0]?.id || id
      ),
    };
  }
} finally {
  db.close?.();
}
const dir = path.join(BE, 'exports/phase2-taj-oct');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'taj-augsep-context-readonly.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}`);
for (const [d, r] of Object.entries(out.tajLedgerAt)) console.log(`Taj ledger at ${d}: ₦${Math.round(Number(out.taj[0]?.opening_balance_ngn || 0) + Number(r.s)).toLocaleString('en-NG')}`);
