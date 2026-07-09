import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import {
  summarizeCoilProductionHoldersBook,
  syncProductionJobCoilConsumedWeightsForCoil,
} from './productionTraceability.js';

const mysqlOk = isMysqlAvailableForTests();

function seedConsumedCoilScenario(db) {
  db.prepare(
    `INSERT INTO products (product_id, name, category, stock_level, unit)
     VALUES ('COIL-ALU', 'Alu coil', 'Raw Material', 0, 'kg')
     ON CONFLICT(product_id) DO UPDATE SET stock_level = excluded.stock_level`
  ).run();
  db.prepare(
    `INSERT INTO coil_lots (
      coil_no, product_id, branch_id, gauge_label, colour,
      qty_received, weight_kg, qty_remaining, qty_reserved, current_weight_kg, current_status
    ) VALUES ('CL-26-2040', 'COIL-ALU', 'BR-KD', '0.24mm', 'Gray', 3540, 3540, 0, 0, 0, 'Consumed')`
  ).run();
  db.prepare(
    `INSERT INTO production_jobs (job_id, status, branch_id, product_id)
     VALUES ('PRO-KD-26-0508', 'Completed', 'BR-KD', 'COIL-ALU')`
  ).run();
  db.prepare(
    `INSERT INTO production_job_coils (
      id, job_id, sequence_no, coil_no, product_id, opening_weight_kg, closing_weight_kg,
      consumed_weight_kg, meters_produced, allocation_status
    ) VALUES ('PJC-1', 'PRO-KD-26-0508', 1, 'CL-26-2040', 'COIL-ALU', 3540, 72, 500, 114, 'Completed')`
  ).run();
  db.prepare(
    `INSERT INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, branch_id)
     VALUES ('SM-1', '2026-07-09T12:00:00', 'COIL_CONSUMPTION', 'PRO-KD-26-0695', 'COIL-ALU', -72,
       'CL-26-2040 roll finished — tail 72.00 kg removed from yard stock (PRO-KD-26-0695)', 'BR-KD')`
  ).run();
}

describe.skipIf(!mysqlOk)('coil production book reconciliation', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: true });
    seedConsumedCoilScenario(db);
  });

  it('syncs drifted consumed_weight_kg from opening − closing', () => {
    const sync = syncProductionJobCoilConsumedWeightsForCoil(db, 'CL-26-2040');
    expect(sync.updatedLineCount).toBe(1);
    const row = db.prepare(`SELECT consumed_weight_kg FROM production_job_coils WHERE id = ?`).get('PJC-1');
    expect(Number(row.consumed_weight_kg)).toBeCloseTo(3468, 2);
  });

  it('does not flag finish-roll tail as a job vs book gap', () => {
    syncProductionJobCoilConsumedWeightsForCoil(db, 'CL-26-2040');
    const summary = summarizeCoilProductionHoldersBook(db, 'CL-26-2040');
    expect(summary.bookUsedKg).toBeCloseTo(3540, 2);
    expect(summary.jobsConsumedKgSum).toBeCloseTo(3468, 2);
    expect(summary.ancillaryNetKg).toBeCloseTo(-72, 2);
    expect(summary.bookUsedFromJobsKg).toBeCloseTo(3468, 2);
    expect(Math.abs(summary.reconciliationGapKg)).toBeLessThan(0.06);
  });
});
