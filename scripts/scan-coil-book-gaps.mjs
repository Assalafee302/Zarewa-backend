/**
 * List coils where job consumed kg ≠ coil book used (and orphan reserved kg).
 *
 * Usage (repo root, with .env pointing at your database):
 *   node scripts/scan-coil-book-gaps.mjs
 *   node scripts/scan-coil-book-gaps.mjs --branch BR1
 *   node scripts/scan-coil-book-gaps.mjs --search APR
 *   node scripts/scan-coil-book-gaps.mjs --min-gap 1
 *   node scripts/scan-coil-book-gaps.mjs --apply
 *   node scripts/scan-coil-book-gaps.mjs --apply --coil CL-KD-APR-1969
 */
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import {
  listCoilProductionBookReconciliationIssues,
  recalculateAllCoilProductionJobStock,
} from '../server/productionTraceability.js';

loadProjectEnv();

const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  return String(args[i + 1] || '').trim();
}

const branch = argValue('--branch');
const search = argValue('--search');
const coilOnly = argValue('--coil');
const minGap = Number(argValue('--min-gap') || '0.05');
const apply = args.includes('--apply');
const gapsOnly = args.includes('--gaps-only');

const db = createDatabase({ seed: false });

try {
  const issues = listCoilProductionBookReconciliationIssues(db, {
    branchId: branch || undefined,
    workspaceBranchId: branch || undefined,
    coilNoLike: coilOnly || search || undefined,
    minGapKg: Number.isFinite(minGap) ? minGap : 0.05,
    includeOrphanReservation: !gapsOnly,
  });

  if (!issues.length) {
    console.log('[scan-coil-book-gaps] No coils with job vs book gaps or orphan reservations found.');
    process.exit(0);
  }

  console.log(`[scan-coil-book-gaps] Found ${issues.length} coil(s) with issues (min gap ${minGap} kg):\n`);
  console.log(
    'coil_no'.padEnd(22) +
      'gap_kg'.padStart(8) +
      'jobs_kg'.padStart(9) +
      'book_kg'.padStart(9) +
      'on_hand'.padStart(9) +
      'orph_res'.padStart(9) +
      '  jobs'
  );
  console.log('-'.repeat(80));

  for (const row of issues) {
    const gap = Number(row.reconciliationGapKg) || 0;
    const orphan = Number(row.orphanReservedKg) || 0;
    console.log(
      String(row.coilNo).padEnd(22) +
        gap.toFixed(1).padStart(8) +
        Number(row.jobsConsumedKgSum).toFixed(1).padStart(9) +
        Number(row.bookUsedKg).toFixed(1).padStart(9) +
        Number(row.onHandKg).toFixed(1).padStart(9) +
        orphan.toFixed(1).padStart(9) +
        `  ${row.jobLinkCount}`
    );
    if (Math.abs(gap) > minGap) {
      const dir = gap > 0 ? 'jobs > book' : 'book > jobs';
      console.log(`  consumption: ${dir} by ${Math.abs(gap).toFixed(2)} kg`);
    }
    if (orphan > minGap) {
      console.log(
        `  reservation: booked ${Number(row.bookedReservedKg).toFixed(1)} kg, jobs hold ${Number(row.expectedReservedKg).toFixed(1)} kg`
      );
    }
  }

  if (!apply) {
    console.log('\n=> Dry run. Re-run with --apply to recalc production stock on each listed coil.');
    process.exit(0);
  }

  console.log('\n[scan-coil-book-gaps] Applying recalculate-production-stock…\n');
  for (const row of issues) {
    const cn = row.coilNo;
    const r = recalculateAllCoilProductionJobStock(db, cn, {
      workspaceBranchId: branch || row.branchId || undefined,
    });
    if (!r.ok) {
      console.error(`  ${cn}: FAILED — ${r.error}`);
      process.exitCode = 1;
      continue;
    }
    const afterGap = Number(r.summary?.reconciliationGapKg) || 0;
    const delta = Number(r.bookReconcile?.onHandDeltaKg) || 0;
    console.log(
      `  ${cn}: on-hand ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} kg, gap after ${afterGap.toFixed(2)} kg`
    );
  }
} finally {
  db.close();
}
