import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  recalculateAllCoilProductionJobStock,
  recalculateProductionJobCoilStock,
  saveProductionJobAllocations,
} from './productionTraceability.js';

describe('recalculateProductionJobCoilStock', () => {
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

  it('rebalances reserved kg after allocation save leaves orphan reservation', () => {
    saveProductionJobAllocations(db, 'JOB-T1', [{ coilNo: 'CL-T-1975', openingWeightKg: 800 }]);
    db.prepare(`UPDATE coil_lots SET qty_reserved = 4200 WHERE coil_no = 'CL-T-1975'`).run();

    const r = recalculateProductionJobCoilStock(db, 'JOB-T1', { workspaceBranchId: 'BR1' });
    expect(r.ok).toBe(true);
    expect(r.recalculatedCount).toBe(1);

    const after = db.prepare(`SELECT qty_reserved FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(after.qty_reserved).toBe(800);
  });
});

describe('recalculateAllCoilProductionJobStock', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, qty_received, weight_kg, qty_remaining, qty_reserved,
        current_weight_kg, current_status, branch_id, received_at_iso
      ) VALUES ('CL-RECON', 'COIL-ALU', 1922, 1922, 1657, 0, 1657, 'Available', 'BR1', '2026-04-30')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, branch_id) VALUES ('COIL-ALU', 'Aluzinc', 1657, 'BR1')`
    ).run();
    const jobs = [
      ['JOB-1', 33, 1922, 1889, 17.2],
      ['JOB-2', 167, 1889, 1722, 89],
      ['JOB-3', 89, 1722, 1633, 45],
      ['JOB-4', 15, 1633, 1618, 7.5],
    ];
    for (const [jobId, consumed, opening, closing, meters] of jobs) {
      db.prepare(
        `INSERT INTO production_jobs (job_id, cutting_list_id, status, branch_id, created_at_iso, actual_weight_kg)
         VALUES (?, ?, 'Completed', 'BR1', '2026-05-12', ?)`
      ).run(jobId, `CL-${jobId}`, consumed);
      db.prepare(
        `INSERT INTO production_job_coils (
          id, job_id, sequence_no, coil_no, product_id, opening_weight_kg, closing_weight_kg,
          consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso
        ) VALUES (?, ?, 1, 'CL-RECON', 'COIL-ALU', ?, ?, ?, ?, 'Completed', '2026-05-12')`
      ).run(`PJC-${jobId}`, jobId, opening, closing, consumed, meters);
    }
  });

  afterEach(() => {
    db?.close();
  });

  it('realigns on-hand kg and book used with summed job consumption', () => {
    const r = recalculateAllCoilProductionJobStock(db, 'CL-RECON', { workspaceBranchId: 'BR1' });
    expect(r.ok).toBe(true);
    expect(r.bookReconcile.unchanged).toBe(false);
    expect(r.bookReconcile.afterOnHandKg).toBeCloseTo(1618, 1);
    expect(r.bookReconcile.bookUsedKgAfter).toBeCloseTo(304, 1);
    expect(r.summary.reconciliationGapKg).toBeCloseTo(0, 1);

    const lot = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = 'CL-RECON'`).get();
    expect(lot.qty_remaining).toBeCloseTo(1618, 1);
  });
});
