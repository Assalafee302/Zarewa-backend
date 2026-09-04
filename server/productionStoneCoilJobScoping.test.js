import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { completeProductionJob } from './productionTraceability.js';

/**
 * Regression coverage for the production register bug: a stone-coated quotation with both a
 * "Roofing Sheet" line (stone-metre stock) and a "Flat sheet" line (coil-backed) produces two
 * separate production jobs — one per cutting-list product. Before the fix, `jobExpectsCoilAllocation`
 * / `quotationRequiresStoneMetreConsumption` read the WHOLE quotation's product lines, so:
 *  - the Roofing Sheet job was wrongly treated as expecting coil allocation (routed away from the
 *    pure stone-metre completion path — "the stone roof does not get detected"), and
 *  - the Flat sheet job was wrongly forced to demand a non-zero "stone metres consumed" value.
 * These tests complete each job with an empty payload and assert each only gets gated by the
 * validation appropriate to its OWN product.
 */
describe('production job completion is scoped to its own cutting-list product on a hybrid stone quote', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-HY-1', 'Hybrid Test Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES ('QT-HYBRID-1', 'CUS-HY-1', 'Hybrid Test Customer', 500000, 0, 'Unpaid', 'Approved', ?, '2026-05-01', ?)`
    ).run(
      JSON.stringify({
        materialTypeId: 'MAT-005',
        stoneMeterQuote: true,
        products: [
          { name: 'Roofing Sheet', qty: '100' },
          { name: 'Flat sheet', qty: '30' },
        ],
        accessories: [{ name: 'Stone nail', qty: '5' }],
      }),
      DEFAULT_BRANCH_ID
    );
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, quotation_ref, customer_id, customer_name, product_id, product_name,
        status, planned_meters, actual_meters, branch_id, created_at_iso
      ) VALUES ('JOB-ROOF-1', 'QT-HYBRID-1', 'CUS-HY-1', 'Hybrid Test Customer', 'PROD-ROOF', 'Roofing Sheet',
        'Running', 100, 0, ?, '2026-05-01T10:00:00.000Z')`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, quotation_ref, customer_id, customer_name, product_id, product_name,
        status, planned_meters, actual_meters, branch_id, created_at_iso
      ) VALUES ('JOB-FLAT-1', 'QT-HYBRID-1', 'CUS-HY-1', 'Hybrid Test Customer', 'PROD-FLAT', 'Flat sheet',
        'Running', 30, 0, ?, '2026-05-01T10:00:00.000Z')`
    ).run(DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    db?.close();
  });

  it('the Roofing Sheet job is detected as pure stone-metre and demands stone metres — not coil allocations', () => {
    const r = completeProductionJob(db, 'JOB-ROOF-1', {});
    expect(r.ok).toBe(false);
    // Routed to the pure stone-metre completion path (not the generic coil/offcut path, which
    // would instead complain about missing coil allocations).
    expect(r.error).toMatch(/stone metres consumed/i);
    expect(r.error).not.toMatch(/coil allocation/i);
  });

  it('the Flat sheet job is NOT forced to enter stone metres consumed — it is routed to the coil/offcut path', () => {
    const r = completeProductionJob(db, 'JOB-FLAT-1', {});
    expect(r.ok).toBe(false);
    // Must not be gated by the stone-metre requirement that belongs to the sibling Roofing Sheet line.
    expect(r.error).not.toMatch(/stone metres consumed/i);
    // Instead it hits the ordinary coil/offcut completion gate (no coil allocations linked yet).
    expect(r.error).toMatch(/coil allocation/i);
  });
});
