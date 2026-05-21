/**
 * Diagnose and fix orphan coil_lots.qty_reserved vs production_job_coils (Planned/Running).
 *
 * Usage (repo root, with .env pointing at production MySQL):
 *   node scripts/reconcile-coil-reservation.mjs --search 1975
 *   node scripts/reconcile-coil-reservation.mjs --coil CL-25-1975 --apply
 */
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import {
  expectedCoilReservedKgFromJobs,
  listCoilProductionHolders,
  reconcileCoilReservationFromProductionJobs,
} from '../server/productionTraceability.js';

loadProjectEnv();

const args = process.argv.slice(2);
const search = argValue('--search') || '1975';
const coilFlag = argValue('--coil');
const apply = args.includes('--apply');

function argValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  return String(args[i + 1] || '').trim();
}

const db = createDatabase({ seed: false });

try {
  let coilNos = [];
  if (coilFlag) {
    coilNos = [coilFlag];
  } else {
    const pattern = `%${search}%`;
    const rows = db
      .prepare(
        `SELECT coil_no, qty_remaining, qty_reserved, current_weight_kg, current_status, branch_id
         FROM coil_lots
         WHERE coil_no LIKE ?
         ORDER BY coil_no`
      )
      .all(pattern);
    if (!rows.length) {
      console.log(`[reconcile-coil] No coil_lots matching "${search}".`);
      process.exit(0);
    }
    console.log(`[reconcile-coil] Found ${rows.length} coil(s) matching "${search}":\n`);
    for (const r of rows) {
      console.log(
        `  ${r.coil_no}  rem=${Number(r.qty_remaining).toFixed(2)}  res=${Number(r.qty_reserved).toFixed(2)}  ` +
          `cur=${Number(r.current_weight_kg).toFixed(2)}  status=${r.current_status}  branch=${r.branch_id || '—'}`
      );
    }
    coilNos = rows.map((r) => r.coil_no);
  }

  for (const coilNo of coilNos) {
    const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
    if (!row) {
      console.log(`\n[reconcile-coil] Skip missing coil ${coilNo}`);
      continue;
    }
    const booked = Math.max(0, Number(row.qty_reserved) || 0);
    const expected = expectedCoilReservedKgFromJobs(db, coilNo);
    const orphan = Math.max(0, booked - expected);
    const holders = listCoilProductionHolders(db, coilNo);
    const active = holders.filter((h) => h.jobStatus === 'Planned' || h.jobStatus === 'Running');

    console.log(`\n--- ${coilNo} ---`);
    console.log(`  Booked reserved kg:     ${booked.toFixed(2)}`);
    console.log(`  Expected (Planned/Run): ${expected.toFixed(2)}`);
    console.log(`  Orphan kg:              ${orphan.toFixed(2)}`);
    console.log(`  Free kg (book):         ${Math.max(0, (Number(row.qty_remaining) || 0) - booked).toFixed(2)}`);

    if (holders.length === 0) {
      console.log('  Production holders:     (none)');
    } else {
      console.log(`  Production holders (${holders.length} total, ${active.length} active):`);
      for (const h of holders) {
        console.log(
          `    ${h.jobStatus.padEnd(10)} ${h.cuttingListId || h.jobID}  open=${Number(h.openingWeightKg).toFixed(1)} kg  ` +
            `${h.customer || ''}`.trim()
        );
      }
    }

    if (orphan <= 0.0001) {
      console.log('  => No orphan reservation; nothing to fix.');
      continue;
    }

    if (!apply) {
      console.log('  => Dry run. Re-run with --apply to set qty_reserved from active jobs.');
      continue;
    }

    const r = reconcileCoilReservationFromProductionJobs(db, coilNo, {});
    if (!r.ok) {
      console.error(`  => FAILED: ${r.error}`);
      process.exitCode = 1;
      continue;
    }
    console.log(
      `  => APPLIED: ${Number(r.qtyReservedBefore).toFixed(2)} → ${Number(r.qtyReservedAfter).toFixed(2)} kg ` +
        `(freed ${Number(r.freedKg).toFixed(2)} kg)`
    );
  }
} finally {
  db.close();
}
