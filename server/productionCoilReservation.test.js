import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  expectedCoilReservedKgFromJobs,
  listCoilProductionHolders,
  reconcileCoilReservationFromProductionJobs,
  saveProductionJobAllocations,
} from './productionTraceability.js';

describe('production coil reservation reconcile', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, qty_received, weight_kg, qty_remaining, qty_reserved,
        current_weight_kg, current_status, branch_id, received_at_iso
      ) VALUES ('CL-T-1975', 'COIL-ALU', 5000, 5000, 5000, 4200, 5000, 'Reserved', 'BR1', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, cutting_list_id, status, branch_id, created_at_iso)
       VALUES ('JOB-T1', 'CL-1', 'Planned', 'BR1', '2026-01-01')`
    ).run();
  });

  afterEach(() => {
    db?.close();
  });

  it('reconcile clears orphan qty_reserved when no production_job_coils rows exist', () => {
    const before = db.prepare(`SELECT qty_reserved FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(before.qty_reserved).toBe(4200);

    const r = reconcileCoilReservationFromProductionJobs(db, 'CL-T-1975', {});
    expect(r.ok).toBe(true);
    expect(r.freedKg).toBe(4200);
    expect(r.qtyReservedAfter).toBe(0);

    const after = db.prepare(`SELECT qty_reserved, current_status FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(after.qty_reserved).toBe(0);
    expect(after.current_status).toBe('Available');
  });

  it('reconcile keeps reserved kg matching planned job allocation', () => {
    saveProductionJobAllocations(db, 'JOB-T1', [{ coilNo: 'CL-T-1975', openingWeightKg: 800 }]);
    db.prepare(`UPDATE coil_lots SET qty_reserved = 4200 WHERE coil_no = 'CL-T-1975'`).run();

    const r = reconcileCoilReservationFromProductionJobs(db, 'CL-T-1975', {});
    expect(r.ok).toBe(true);
    expect(r.qtyReservedAfter).toBe(800);
    expect(r.freedKg).toBe(3400);

    expect(expectedCoilReservedKgFromJobs(db, 'CL-T-1975')).toBe(800);
    const holders = listCoilProductionHolders(db, 'CL-T-1975');
    expect(holders).toHaveLength(1);
    expect(holders[0].openingWeightKg).toBe(800);
  });

  it('refuses to reconcile a reservation that exceeds the coil remaining balance instead of silently clamping it', () => {
    // Allocate 800kg while the coil has plenty of remaining weight (5000kg from the fixture),
    // then simulate a later event dropping the coil's remaining weight below that open
    // allocation (e.g. a correction applied without re-checking outstanding reservations).
    // Reconciling must surface the coil is now over-committed, not quietly write a reservation
    // the derived-state clamp would then truncate back down to a different, inconsistent value.
    saveProductionJobAllocations(db, 'JOB-T1', [{ coilNo: 'CL-T-1975', openingWeightKg: 800 }]);
    db.prepare(`UPDATE coil_lots SET qty_remaining = 500, current_weight_kg = 500 WHERE coil_no = 'CL-T-1975'`).run();

    // Only the one 800kg job allocation counts toward expectedReserved; the fixture's other
    // 4200kg was already folded into qty_reserved by the allocation save above (4200 + 800 =
    // 5000), independent of any actual open job.
    const beforeReconcile = db.prepare(`SELECT qty_reserved FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(beforeReconcile.qty_reserved).toBe(5000);

    const r = reconcileCoilReservationFromProductionJobs(db, 'CL-T-1975', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('COIL_OVER_RESERVED');

    const after = db.prepare(`SELECT qty_reserved FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(after.qty_reserved).toBe(beforeReconcile.qty_reserved);
  });
});
