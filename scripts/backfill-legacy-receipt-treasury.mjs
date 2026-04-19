#!/usr/bin/env node
/**
 * Finance → Treasury tab sums "Cash inflows" from treasury_movements (RECEIPT_IN), not from ledger alone.
 * The Access import wrote ledger RECEIPT + sales_receipts but did NOT post treasury lines — so Finance looks empty.
 *
 * This script creates matching RECEIPT_IN movements (source_kind LEDGER_RECEIPT) for each legacy receipt
 * ledger row, using ONE treasury account you choose (e.g. main cash/bank). Idempotent: skips if a movement
 * already exists for that ledger entry id.
 *
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1 --dry-run
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1 --post-gl
 *
 * List accounts: open Finance → Treasury, or query: SELECT id, name FROM treasury_accounts;
 *
 * --post-gl: also run tryPostCustomerReceiptGl (Dr cash / Cr AR) where missing — idempotent on ledger id.
 *
 * Stop the API if SQLITE_BUSY. Set ZAREWA_DB if not using default data/zarewa.sqlite.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from '../server/schemaSql.js';
import { runMigrations } from '../server/migrate.js';
import { defaultDbPath } from '../server/db.js';
import { recordCustomerReceiptCash } from '../server/writeOps.js';
import { tryPostCustomerReceiptGl } from '../server/glOps.js';

function parseArgs() {
  let dbPath = process.env.ZAREWA_DB ? path.resolve(process.env.ZAREWA_DB) : defaultDbPath();
  let treasuryAccountId = 0;
  let dryRun = false;
  let postGl = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--db' && process.argv[i + 1]) dbPath = path.resolve(process.argv[++i]);
    else if (a === '--treasury-account-id' && process.argv[i + 1]) treasuryAccountId = parseInt(process.argv[++i], 10);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--post-gl') postGl = true;
  }
  return { dbPath, treasuryAccountId, dryRun, postGl };
}

const { dbPath, treasuryAccountId, dryRun, postGl } = parseArgs();

if (!treasuryAccountId || treasuryAccountId <= 0) {
  console.error('Required: --treasury-account-id <number> (see treasury_accounts.id)');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error('Database not found:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
runMigrations(db);

const acc = db.prepare(`SELECT id, name FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId);
if (!acc) {
  console.error('No treasury_accounts row with id =', treasuryAccountId);
  db.close();
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT id, at_iso, customer_id, customer_name, amount_ngn, quotation_ref, payment_method, branch_id
     FROM ledger_entries
     WHERE type = 'RECEIPT' AND id LIKE 'LE-LEGACY-R%'`
  )
  .all();

let created = 0;
let skipped = 0;
let glPosted = 0;
let glSkipped = 0;

for (const row of rows) {
  const hasTm = db
    .prepare(`SELECT 1 FROM treasury_movements WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ?`)
    .get(row.id);
  if (hasTm) {
    skipped += 1;
    continue;
  }

  const amt = Math.round(Number(row.amount_ngn) || 0);
  if (amt <= 0) continue;

  const dateISO = String(row.at_iso || '').slice(0, 10);
  if (dryRun) {
    created += 1;
    continue;
  }

  db.transaction(() => {
    recordCustomerReceiptCash(db, {
      sourceId: row.id,
      customerID: row.customer_id,
      customerName: row.customer_name || '',
      dateISO,
      reference: String(row.quotation_ref || '').trim() || row.id,
      note: `Legacy import receipt · ${String(row.payment_method || '').trim() || '—'}`,
      paymentLines: [{ treasuryAccountId, amountNgn: amt, reference: row.id }],
      createdBy: 'backfill-legacy-receipt-treasury',
    });
  })();
  created += 1;

  if (postGl) {
    const glR = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: row.id,
      amountNgn: amt,
      entryDateISO: dateISO,
      branchId: row.branch_id || null,
      createdByUserId: null,
    });
    if (glR.duplicate || glR.skipped) glSkipped += 1;
    else if (glR.ok) glPosted += 1;
  }
}

db.close();

console.log('Legacy receipt treasury backfill');
console.log('  DB:', dbPath);
console.log('  Treasury account:', acc.id, acc.name);
console.log('  Ledger rows (LE-LEGACY-R* RECEIPT):', rows.length);
console.log('  Treasury movements created:', dryRun ? `(dry-run) ${created}` : created);
console.log('  Skipped (already had LEDGER_RECEIPT movement):', skipped);
if (postGl) {
  console.log('  GL journals posted:', glPosted);
  console.log('  GL skipped / duplicate:', glSkipped);
}
if (dryRun) console.log('\nRe-run without --dry-run to apply.');
