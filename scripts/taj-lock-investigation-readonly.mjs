#!/usr/bin/env node
/**
 * READ-ONLY (SELECT only, READ ONLY session, one connection) — owner 19 Oct 2026, after the Aug–Sep plan stopped on
 * "2026-08 is not locked". Not committed.
 *   1. Period locks now + every lock / unlock in the audit log (who, when, note), and phase2 rows that name TA-*.
 *   2. Rows dated in August: the newest by id per table (new ids stand out), GL journals dated August created since
 *      15 Oct, and every audit row written while August was open (windows from the lock/unlock rows).
 *   3. Taj movements created since round 1 (newest ids on account 2), Yunusa Ahmed rows anywhere, with their audit rows.
 *
 *   node scripts/taj-lock-investigation-readonly.mjs  →  exports/phase2-taj-oct/taj-lock-investigation-readonly.json
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
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`refused non-SELECT: ${sql.slice(0, 40)}`);
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ error: String(e.message || e) }];
  }
};
const NUM = (col) => `CAST(SUBSTRING_INDEX(${col}, '-', -1) AS UNSIGNED)`;
const AUD = `id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json`;
const out = { readAtISO: new Date().toISOString() };
try {
  // 1. Locks
  out.locksNow = q(`SELECT * FROM accounting_period_locks ORDER BY period_key`);
  out.lockAudit = q(
    `SELECT ${AUD} FROM audit_log WHERE action IN ('period.lock','period.unlock') OR entity_kind = 'accounting_period' ORDER BY occurred_at_iso`
  );
  out.phase2Since19Oct = q(
    `SELECT ${AUD} FROM audit_log WHERE action = 'phase2.correction' AND occurred_at_iso >= '2026-10-19T00:00:00Z' ORDER BY occurred_at_iso`
  );

  // Windows when 2026-08 was open (unlock → next lock, or still open)
  const windows = [];
  let openAt = null;
  for (const r of out.lockAudit.filter((x) => x.entity_id === '2026-08')) {
    if (r.action === 'period.unlock') openAt = r.occurred_at_iso;
    if (r.action === 'period.lock' && openAt) {
      windows.push({ from: openAt, to: r.occurred_at_iso });
      openAt = null;
    }
  }
  if (openAt || !out.locksNow.some((l) => l.period_key === '2026-08')) windows.push({ from: openAt || '(no unlock row — August lock missing)', to: 'still open' });
  out.augustOpenWindows = windows;
  out.auditWhileAugustOpen = windows
    .filter((w) => /^\d{4}-/.test(w.from))
    .map((w) => ({
      window: w,
      rows: q(`SELECT ${AUD} FROM audit_log WHERE occurred_at_iso >= ? AND occurred_at_iso <= ? ORDER BY occurred_at_iso`, w.from, w.to === 'still open' ? '9999' : w.to),
    }));

  // 2. Rows dated in August — newest ids per table (rows created recently have the highest numbers)
  out.augNewest = {
    treasury: q(
      `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, source_kind, source_id, counterparty_name, created_by, reverses_movement_id, note
       FROM treasury_movements WHERE posted_at_iso >= '2026-07-31T23:00:00Z' AND posted_at_iso < '2026-08-31T23:00:00Z' ORDER BY ${NUM('id')} DESC LIMIT 40`
    ),
    ledger: q(
      `SELECT id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref, payment_method, created_by_name, note
       FROM ledger_entries WHERE at_iso >= '2026-08-01' AND at_iso < '2026-09-01' ORDER BY ${NUM('id')} DESC LIMIT 40`
    ),
    expenses: q(`SELECT expense_id, date, amount_ngn, category, expense_type, payment_method FROM expenses WHERE date >= '2026-08-01' AND date < '2026-09-01' ORDER BY ${NUM('expense_id')} DESC LIMIT 25`),
    receipts: q(`SELECT id, date_iso, customer_id, amount_ngn, status, method, bank_confirmed_at_iso FROM sales_receipts WHERE date_iso >= '2026-08-01' AND date_iso < '2026-09-01' ORDER BY ${NUM('id')} DESC LIMIT 25`),
    glCreatedSince15Oct: q(
      `SELECT id, entry_date_iso, period_key, source_kind, source_id, memo, created_at_iso, created_by_user_id FROM gl_journal_entries
       WHERE entry_date_iso >= '2026-08-01' AND entry_date_iso < '2026-09-01' AND created_at_iso >= '2026-10-15' ORDER BY created_at_iso`
    ),
    glCreatedSince15OctSeptember: q(
      `SELECT id, entry_date_iso, source_kind, source_id, created_at_iso FROM gl_journal_entries
       WHERE entry_date_iso >= '2026-09-01' AND entry_date_iso < '2026-10-01' AND created_at_iso >= '2026-10-19' ORDER BY created_at_iso`
    ),
  };

  // 3. Taj since round 1, Yunusa Ahmed
  out.tajLedgerNow = q(
    `SELECT a.opening_balance_ngn AS opening, a.balance AS stored, (SELECT COALESCE(SUM(amount_ngn),0) FROM treasury_movements WHERE treasury_account_id = 2) AS movements,
            (SELECT COALESCE(SUM(amount_ngn),0) FROM treasury_movements WHERE treasury_account_id = 2 AND posted_at_iso < '2026-10-19T23:00:00Z') AS movementsTo19Oct
     FROM treasury_accounts a WHERE a.id = 2`
  );
  out.tajNewest = q(
    `SELECT id, posted_at_iso, type, amount_ngn, source_kind, source_id, counterparty_id, counterparty_name, created_by, reverses_movement_id, reference, note
     FROM treasury_movements WHERE treasury_account_id = 2 ORDER BY ${NUM('id')} DESC LIMIT 60`
  );
  out.yunusaLedger = q(
    `SELECT id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref, payment_method, bank_reference, created_by_name, note
     FROM ledger_entries WHERE customer_id = 'CUS-KD-26-1165' OR LOWER(customer_name) LIKE '%yunusa%' OR LOWER(bank_reference) LIKE '%yunusa%' ORDER BY at_iso, id`
  );
  out.yunusaCustomers = q(`SELECT customer_id, name, branch_id FROM customers WHERE LOWER(name) LIKE '%yunusa%'`);
  out.yunusaTreasury = q(
    `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, source_id, counterparty_id, counterparty_name, created_by, note FROM treasury_movements
     WHERE counterparty_id = 'CUS-KD-26-1165' OR LOWER(counterparty_name) LIKE '%yunusa%' OR LOWER(note) LIKE '%yunusa%' OR LOWER(reference) LIKE '%yunusa%' ORDER BY posted_at_iso, id`
  );
  out.yunusaRecon = q(
    `SELECT id, bank_date_iso, description, amount_ngn, system_match, status, treasury_account_id FROM bank_reconciliation_lines
     WHERE treasury_account_id = 2 AND LOWER(description) LIKE '%yunusa%' ORDER BY bank_date_iso, id`
  );
  const ids = [...new Set([...out.yunusaLedger, ...out.yunusaTreasury].map((r) => r.id).filter(Boolean))];
  out.yunusaAudit = ids.length
    ? q(`SELECT ${AUD} FROM audit_log WHERE entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY occurred_at_iso`, ...ids)
    : [];
  out.auditSinceRound1 = q(
    `SELECT ${AUD} FROM audit_log WHERE occurred_at_iso >= '2026-10-19T12:44:00Z' AND (details_json LIKE '%"treasuryAccountId":2%' OR note LIKE '%Taj%' OR action LIKE 'ledger.%' OR action LIKE 'period.%') ORDER BY occurred_at_iso`
  );
} finally {
  db.close?.();
}
const dir = path.join(BE, 'exports/phase2-taj-oct');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'taj-lock-investigation-readonly.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}`);
console.log('locks now:', out.locksNow.map((l) => `${l.period_key} "${l.reason}" by ${l.locked_by_name} at ${l.locked_at_iso}`));
for (const r of out.lockAudit.filter((x) => /^2026-0[89]$/.test(x.entity_id))) console.log(`${r.occurred_at_iso} ${r.action} ${r.entity_id} by ${r.actor_name} — ${r.note}`);
console.log('August open windows:', out.augustOpenWindows);
const t = out.tajLedgerNow[0] || {};
console.log(`Taj ledger to 19 Oct: ₦${(Number(t.opening) + Number(t.movementsTo19Oct)).toLocaleString('en-NG')}; all: ₦${(Number(t.opening) + Number(t.movements)).toLocaleString('en-NG')}; stored ₦${Number(t.stored).toLocaleString('en-NG')}`);
console.log(`Yunusa: ${out.yunusaLedger.length} ledger rows, ${out.yunusaTreasury.length} treasury rows, customers ${out.yunusaCustomers.map((c) => c.customer_id).join(', ')}`);
