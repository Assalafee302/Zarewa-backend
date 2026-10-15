#!/usr/bin/env node
/**
 * Seed the August 2026 bank statement balances (owner, 15 Oct 2026) into bank_statement_balances.
 * DRY RUN by default: prints what it would save. Writes only with --apply, through upsertStatementBalance
 * (audit log entry, entered by = --by). Run after the round-2 deploy, outside the 7am window.
 *
 *   node scripts/seed-statement-balances-2026-08.mjs [--apply] [--by "Name"]
 */
import { createDatabase } from '../server/db.js';
import { createMysqlDatabase, mysqlConfigFromEnv } from '../server/mysqlDatabase.js';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { upsertStatementBalance } from '../server/finance/bankStatementBalanceOps.js';

const SEED = [
  { accNo: '0006047389', label: 'Taj', openingNgn: 12_924_292.56, closingNgn: 132_311.01 },
  { accNo: '6432680767', label: 'Moniepoint', openingNgn: 154_841.65, closingNgn: 8_297_144.24 },
];
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : 'Owner (seed 15 Oct 2026)';

loadProjectEnv();
// Dry run opens the schema without DDL or migrations and only reads; --apply opens it the way the app does.
const db = apply ? createDatabase({ seed: false }) : createMysqlDatabase(mysqlConfigFromEnv(), { bootstrap: false });
try {
  for (const s of SEED) {
    const acc = db.prepare(`SELECT id, name, acc_no, branch_id FROM treasury_accounts WHERE REPLACE(acc_no, ' ', '') = ?`).get(s.accNo);
    if (!acc) {
      console.log(`SKIP ${s.label} ${s.accNo}: no treasury account with this number`);
      continue;
    }
    const body = { treasuryAccountId: acc.id, periodKey: '2026-08', openingNgn: s.openingNgn, closingNgn: s.closingNgn, note: 'Seeded from the owner’s August statement figures' };
    if (!apply) {
      console.log('DRY RUN would save', { account: `${acc.id} ${acc.name}`, ...body });
      continue;
    }
    console.log(upsertStatementBalance(db, body, { id: 'seed', displayName: by }, { workspaceViewAll: true }));
  }
} finally {
  db.close();
}
