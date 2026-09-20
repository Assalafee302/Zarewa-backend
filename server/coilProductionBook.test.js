import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import {
  listOrphanCoilProductionHolders,
  reconcileCoilBookFromProductionHolders,
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

function seedOrphanJobConsumptionScenario(db) {
  db.prepare(
    `INSERT INTO products (product_id, name, category, stock_level, unit)
     VALUES ('PRD-102', 'Aluzinc coil', 'Raw Material', 0, 'kg')
     ON CONFLICT(product_id) DO UPDATE SET stock_level = excluded.stock_level`
  ).run();
  db.prepare(
    `INSERT INTO coil_lots (
      coil_no, product_id, branch_id, gauge_label, colour,
      qty_received, weight_kg, qty_remaining, qty_reserved, current_weight_kg, current_status
    ) VALUES ('CL-T-8405', 'PRD-102', 'BR-YL', '0.24mm', 'Pale Green', 2410, 2410, 1910, 0, 1910, 'Available')`
  ).run();
  db.prepare(
    `INSERT INTO production_jobs (job_id, status, branch_id, product_id, cutting_list_id)
     VALUES ('PRO-T-0110', 'Completed', 'BR-YL', 'PRD-102', 'CL-T-0105')`
  ).run();
  db.prepare(
    `INSERT INTO production_jobs (job_id, status, branch_id, product_id, cutting_list_id)
     VALUES ('PRO-T-0071', 'Completed', 'BR-YL', 'PRD-102', 'CL-T-0051')`
  ).run();
  db.prepare(
    `INSERT INTO production_job_coils (
      id, job_id, sequence_no, coil_no, product_id, opening_weight_kg, closing_weight_kg,
      consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso
    ) VALUES ('PJC-T-0110', 'PRO-T-0110', 1, 'CL-T-8405', 'PRD-102', 2392, 1892, 500, 226.4, 'Completed',
      '2026-09-18T12:00:00')`
  ).run();
  db.prepare(
    `INSERT INTO production_conversion_checks (
      id, job_id, coil_no, actual_conversion_kg_per_m, standard_conversion_kg_per_m,
      alert_state, manager_review_required, checked_at_iso
    ) VALUES ('PCC-T-0071', 'PRO-T-0071', 'CL-T-8405', 1.89, 2.26, 'Low', 0, '2026-09-15T12:00:00')`
  ).run();
  const moves = [
    [
      'SM-T-0071',
      '2026-09-15T12:00:00',
      'PRO-T-0071',
      -18,
      'CL-T-8405 consumed for 9.50 m on PRO-T-0071',
    ],
    [
      'SM-T-0110a',
      '2026-09-18T12:00:00',
      'PRO-T-0110',
      -500,
      'CL-T-8405 consumed for 226.40 m on PRO-T-0110',
    ],
    [
      'SM-T-0110b',
      '2026-09-18T17:22:00',
      'PRO-T-0110',
      500,
      'Completion coil correction — restore 500.00 kg to CL-T-8405 (PRO-T-0110)',
    ],
    [
      'SM-T-0110c',
      '2026-09-18T17:22:00',
      'PRO-T-0110',
      -500,
      'CL-T-8405 consumed for 226.40 m on PRO-T-0110 (completion correction)',
    ],
  ];
  const insMove = db.prepare(
    `INSERT INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, branch_id)
     VALUES (?, ?, 'COIL_CONSUMPTION', ?, 'PRD-102', ?, ?, 'BR-YL')`
  );
  for (const [id, at, ref, qty, detail] of moves) insMove.run(id, at, ref, qty, detail);
  db.prepare(
    `INSERT INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, branch_id)
     VALUES ('SM-T-rec', '2026-09-18T11:48:00', 'COIL_RETURN', 'CL-T-8405', 'PRD-102', 18,
       'Production book reconcile: 1892.00 kg → 1910.00 kg (received 2410.00 − jobs 500.00 − split 0.00 + ancillary 0.00)',
       'BR-YL')`
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

describe.skipIf(!mysqlOk)('coil book keeps orphan job consumption', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: true });
    seedOrphanJobConsumptionScenario(db);
  });

  it('does not treat a deleted allocation as unused steel (coil 8405 pattern)', () => {
    const summary = summarizeCoilProductionHoldersBook(db, 'CL-T-8405');
    expect(summary.holderJobsConsumedKgSum).toBeCloseTo(500, 2);
    expect(summary.movementJobsConsumedKgSum).toBeCloseTo(518, 2);
    expect(summary.jobsConsumedKgSum).toBeCloseTo(518, 2);
    expect(summary.bookUsedKg).toBeCloseTo(500, 2);
    expect(summary.reconciliationGapKg).toBeCloseTo(18, 2);

    const orphans = listOrphanCoilProductionHolders(db, 'CL-T-8405', [{ jobID: 'PRO-T-0110' }]);
    expect(orphans.map((h) => h.jobID)).toEqual(['PRO-T-0071']);
    expect(orphans[0].consumedWeightKg).toBeCloseTo(18, 2);
    expect(orphans[0].metersProduced).toBeCloseTo(9.5, 2);

    const rec = reconcileCoilBookFromProductionHolders(db, 'CL-T-8405', {
      workspaceBranchId: 'BR-YL',
      dateISO: '2026-09-18',
    });
    expect(rec.ok).toBe(true);
    expect(rec.afterOnHandKg).toBeCloseTo(1892, 2);
    expect(rec.jobsConsumedKgSum).toBeCloseTo(518, 2);
    const after = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = ?`).get('CL-T-8405');
    expect(Number(after.qty_remaining)).toBeCloseTo(1892, 2);
  });

  it('does not silently put kg back when book used is higher than jobs', () => {
    db.prepare(
      `UPDATE coil_lots SET qty_remaining = 1700, current_weight_kg = 1700 WHERE coil_no = ?`
    ).run('CL-T-8405');
    const rec = reconcileCoilBookFromProductionHolders(db, 'CL-T-8405', {
      workspaceBranchId: 'BR-YL',
      dateISO: '2026-09-18',
    });
    expect(rec.ok).toBe(true);
    expect(rec.restoreBlocked).toBe(true);
    expect(rec.afterOnHandKg).toBeCloseTo(1700, 2);
    const after = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = ?`).get('CL-T-8405');
    expect(Number(after.qty_remaining)).toBeCloseTo(1700, 2);
  });
});
