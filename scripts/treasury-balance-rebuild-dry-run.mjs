#!/usr/bin/env node
/**
 * Print stored vs computed treasury balances. Writes nothing.
 * Usage: node scripts/treasury-balance-rebuild-dry-run.mjs [branchId]
 */
import { createDatabase } from '../server/db.js';
import { previewTreasuryBalanceRebuild } from '../server/finance/treasuryBalanceIntegrityOps.js';

const branchId = String(process.argv[2] || 'BR-KD').trim() || 'BR-KD';
const db = createDatabase();
try {
  const report = previewTreasuryBalanceRebuild(db, branchId);
  const rows = (report.accounts || []).map((a) => ({
    id: a.treasuryAccountId,
    name: a.accountName,
    opening: a.openingBalanceNgn,
    movementSum: a.movementSumNgn,
    computed: a.computedBalanceNgn,
    stored: a.storedBalanceNgn,
    difference: a.differenceNgn,
    wouldBecome: a.wouldBecomeNgn,
    rebuildDelta: a.rebuildDeltaNgn,
  }));
  console.log(`Treasury balance dry-run  branch=${report.branchId}  wroteRows=${report.wroteRows}`);
  console.table(rows);
  console.log(report.message);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
process.exit(0);
