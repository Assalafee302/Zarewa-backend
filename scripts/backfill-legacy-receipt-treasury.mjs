#!/usr/bin/env node
/**
 * Finance → Treasury tab sums "Cash inflows" from treasury_movements (RECEIPT_IN), not from ledger alone.
 * The Access import wrote ledger RECEIPT + sales_receipts but did NOT post treasury lines — so Finance looks empty.
 *
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1 --dry-run
 *   node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id 1 --post-gl
 *
 * Stop the API if you need an exclusive connection to the same MySQL database.
 */
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from '../server/mysqlDatabase.js';
import { runMigrations } from '../server/migrate.js';
import { recordCustomerReceiptCash } from '../server/writeOps.js';
import { tryPostCustomerReceiptGl } from '../server/glOps.js';

function parseArgs() {
  let dbOverride = '';
  let treasuryAccountId = 0;
  let dryRun = false;
  let postGl = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--db' && process.argv[i + 1]) dbOverride = String(process.argv[++i]).trim();
    else if (a === '--treasury-account-id' && process.argv[i + 1])
      treasuryAccountId = parseInt(process.argv[++i], 10);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--post-gl') postGl = true;
  }
  return { dbOverride, treasuryAccountId, dryRun, postGl };
}

const { dbOverride, treasuryAccountId, dryRun, postGl } = parseArgs();

if (!treasuryAccountId || treasuryAccountId <= 0) {
  console.error('Required: --treasury-account-id <number> (see treasury_accounts.id)');
  process.exit(1);
}

const cfg = mysqlConfigFromEnv();
if (dbOverride) cfg.database = dbOverride;
const db = createMysqlDatabase(cfg, { reset: false });
db.pragma('foreign_keys = ON');
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
console.log('  DB:', databaseLabel(cfg));
console.log('  Treasury account:', acc.id, acc.name);
console.log('  Ledger rows (LE-LEGACY-R* RECEIPT):', rows.length);
console.log('  Treasury movements created:', dryRun ? `(dry-run) ${created}` : created);
console.log('  Skipped (already had LEDGER_RECEIPT movement):', skipped);
if (postGl) {
  console.log('  GL journals posted:', glPosted);
  console.log('  GL skipped / duplicate:', glSkipped);
}
if (dryRun) console.log('\nRe-run without --dry-run to apply.');
