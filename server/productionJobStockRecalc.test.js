import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  recalculateAllCoilProductionJobStock,
  recalculateProductionJobCoilStock,
  recalculateWorkspaceCoilProductionStock,
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

    const after = db.prepare(`SELECT qty_reserved, qty_remaining FROM coil_lots WHERE coil_no = 'CL-T-1975'`).get();
    expect(after.qty_reserved).toBe(800);
    /** Planned jobs reserve kg; they must not reduce on-hand as if the coil was consumed. */
    expect(after.qty_remaining).toBeCloseTo(5000, 1);
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

describe('recalculateWorkspaceCoilProductionStock', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, branch_id) VALUES ('COIL-ALU', 'Aluzinc', 0, 'BR1')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, qty_received, weight_kg, qty_remaining, qty_reserved,
        current_weight_kg, current_status, branch_id, received_at_iso
      ) VALUES
        ('CL-GAP', 'COIL-ALU', 1000, 1000, 800, 0, 800, 'Available', 'BR1', '2026-08-01'),
        ('CL-OK', 'COIL-ALU', 500, 500, 400, 0, 400, 'Available', 'BR1', '2026-08-01'),
        ('CL-OTHER', 'COIL-ALU', 900, 900, 100, 0, 100, 'Available', 'BR2', '2026-08-01')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, status, branch_id, created_at_iso)
       VALUES ('JOB-GAP', 'Completed', 'BR1', '2026-08-02'),
              ('JOB-OK', 'Completed', 'BR1', '2026-08-02'),
              ('JOB-OTHER', 'Completed', 'BR2', '2026-08-02')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (
        id, job_id, sequence_no, coil_no, product_id, opening_weight_kg, closing_weight_kg,
        consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso
      ) VALUES
        ('PJC-GAP', 'JOB-GAP', 1, 'CL-GAP', 'COIL-ALU', 1000, 700, 300, 100, 'Completed', '2026-08-02'),
        ('PJC-OK', 'JOB-OK', 1, 'CL-OK', 'COIL-ALU', 500, 400, 100, 40, 'Completed', '2026-08-02'),
        ('PJC-OTHER', 'JOB-OTHER', 1, 'CL-OTHER', 'COIL-ALU', 900, 200, 700, 200, 'Completed', '2026-08-02')`
    ).run();
  });

  afterEach(() => {
    db?.close();
  });

  it('rebuilds on-hand for this branch only and leaves a balanced coil unchanged', () => {
    const r = recalculateWorkspaceCoilProductionStock(db, { workspaceBranchId: 'BR1' });
    expect(r.ok).toBe(true);
    expect(r.coilCount).toBe(2);
    expect(r.adjusted).toBe(1);
    expect(r.unchanged).toBe(1);

    const gap = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = 'CL-GAP'`).get();
    const ok = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = 'CL-OK'`).get();
    const other = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = 'CL-OTHER'`).get();
    expect(Number(gap.qty_remaining)).toBeCloseTo(700, 1);
    expect(Number(ok.qty_remaining)).toBeCloseTo(400, 1);
    expect(Number(other.qty_remaining)).toBeCloseTo(100, 1);
  });
});
