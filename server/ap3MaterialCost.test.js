import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildAp3MaterialCostReport } from './ap3MaterialCostOps.js';
import { materialCostTrust, computeJobMaterialCost } from './ap3MaterialCostShared.js';

describe('ap3MaterialCostShared', () => {
  it('trust levels classify jobs correctly', () => {
    expect(
      materialCostTrust({
        metres: 100,
        consumedKg: 200,
        materialCostNgn: 160000,
        missingCostCount: 0,
        coilRowCount: 1,
        confidence: 'high',
      })
    ).toBe('trusted');

    expect(
      materialCostTrust({
        metres: 100,
        consumedKg: 200,
        materialCostNgn: 80000,
        missingCostCount: 1,
        coilRowCount: 2,
        confidence: 'medium',
      })
    ).toBe('partial');

    expect(
      materialCostTrust({
        metres: 0,
        consumedKg: 0,
        materialCostNgn: 0,
        missingCostCount: 0,
        coilRowCount: 0,
        confidence: 'low',
      })
    ).toBe('excluded');
  });
});

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('ap3MaterialCostOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO production_jobs (
        job_id, quotation_ref, product_id, product_name, status, actual_meters,
        completed_at_iso, created_at_iso, branch_id
      ) VALUES
        ('PJ-TRUST', 'QT-1', 'P1', 'Sheet A', 'Completed', 100,
         '2026-06-15T10:00:00.000Z', '2026-06-01T10:00:00.000Z', 'BR-KD'),
        ('PJ-PART', 'QT-2', 'P1', 'Sheet A', 'Completed', 50,
         '2026-06-16T10:00:00.000Z', '2026-06-01T10:00:00.000Z', 'BR-KD');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, date_iso)
      VALUES ('QT-1', 'C1', 'Customer', 500000, '2026-06-01');
      INSERT INTO coil_lots (
        coil_no, product_id, qty_received, weight_kg, qty_remaining, current_weight_kg,
        current_status, branch_id, received_at_iso, unit_cost_ngn_per_kg
      ) VALUES
        ('CL-OK', 'P1', 1000, 1000, 500, 500, 'Available', 'BR-KD', '2026-06-01', 800),
        ('CL-BAD', 'P1', 1000, 1000, 500, 500, 'Available', 'BR-KD', '2026-06-01', NULL);
      INSERT INTO production_job_coils (
        id, job_id, coil_no, sequence_no, consumed_weight_kg, meters_produced, opening_weight_kg, closing_weight_kg, allocated_at_iso
      ) VALUES
        ('PJC-T1', 'PJ-TRUST', 'CL-OK', 1, 200, 100, 400, 200, '2026-06-15T10:00:00.000Z'),
        ('PJC-P1', 'PJ-PART', 'CL-OK', 1, 100, 50, 200, 100, '2026-06-16T10:00:00.000Z'),
        ('PJC-P2', 'PJ-PART', 'CL-BAD', 2, 50, 0, 100, 50, '2026-06-16T10:00:00.000Z');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('trusted material cost per metre from coil consumption', () => {
    const r = buildAp3MaterialCostReport(db, { period: '2026-06' });
    expect(r.status).toBe('material_cost_only');
    expect(r.summary.trustedJobCount).toBe(1);
    expect(r.summary.partialJobCount).toBe(1);
    expect(r.summary.trustedMaterialCostPerMetreNgn).toBe(1600);
  });

  it('by branch and product family aggregates trusted metres', () => {
    const r = buildAp3MaterialCostReport(db, { period: '2026-06', branchId: 'BR-KD' });
    expect(r.byBranch[0].trustedJobCount).toBe(1);
    expect(r.byProductFamily[0].trustedMetres).toBe(100);
  });

  it('job row includes margin warning when selling below material', () => {
    const job = db
      .prepare(`SELECT * FROM production_jobs WHERE job_id = 'PJ-TRUST'`)
      .get();
    const mapped = {
      jobID: job.job_id,
      quotationRef: job.quotation_ref,
      productID: job.product_id,
      productName: job.product_name,
      status: job.status,
      actualMeters: job.actual_meters,
      effectiveOutputMeters: job.actual_meters,
      branchId: job.branch_id,
    };
    const row = computeJobMaterialCost(db, mapped);
    expect(row.trust).toBe('trusted');
    expect(row.belowMaterialCostWarning).toBe(true);
    expect(row.materialMarginPerMetreNgn).toBeDefined();
  });

  it('report is read-only — no GL rows added', () => {
    const before = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get()?.c ?? 0;
    buildAp3MaterialCostReport(db, { period: '2026-06' });
    const after = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get()?.c ?? 0;
    expect(after).toBe(before);
  });
});
