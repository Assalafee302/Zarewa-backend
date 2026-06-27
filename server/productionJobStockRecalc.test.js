import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
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
