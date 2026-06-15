import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildAp3CostingReadinessReport } from './ap3CostingReadinessOps.js';
import { classifyExpenseForCosting } from './ap3CostingClassification.js';

function seedCostingFixture(db) {
  db.exec(`
    INSERT INTO production_jobs (
      job_id, quotation_ref, product_id, product_name, status, actual_meters,
      completed_at_iso, created_at_iso, branch_id
    ) VALUES
      ('PJ-OK', 'QT-1', 'P1', 'Sheet A', 'Completed', 100,
       '2026-06-15T10:00:00.000Z', '2026-06-01T10:00:00.000Z', 'BR-KD'),
      ('PJ-NOM', 'QT-2', 'P1', 'Sheet A', 'Completed', 0,
       '2026-06-16T10:00:00.000Z', '2026-06-01T10:00:00.000Z', 'BR-KD'),
      ('PJ-NOCOIL', 'QT-3', 'P1', 'Sheet A', 'Completed', 50,
       '2026-06-17T10:00:00.000Z', '2026-06-01T10:00:00.000Z', 'BR-YL');
    INSERT INTO coil_lots (
      coil_no, product_id, qty_received, weight_kg, qty_remaining, current_weight_kg,
      current_status, branch_id, received_at_iso, unit_cost_ngn_per_kg, landed_cost_ngn
    ) VALUES
      ('CL-COST', 'P1', 1000, 1000, 500, 500, 'Available', 'BR-KD', '2026-06-01', 800, NULL),
      ('CL-NOCOST', 'P1', 1000, 1000, 500, 500, 'Available', 'BR-KD', '2026-06-01', NULL, NULL);
    INSERT INTO production_job_coils (
      id, job_id, coil_no, sequence_no, consumed_weight_kg, meters_produced, opening_weight_kg, closing_weight_kg, allocated_at_iso
    ) VALUES
      ('PJC-1', 'PJ-OK', 'CL-COST', 1, 200, 100, 400, 200, '2026-06-15T10:00:00.000Z'),
      ('PJC-2', 'PJ-OK', 'CL-NOCOST', 2, 50, 0, 100, 50, '2026-06-15T10:00:00.000Z');
    INSERT INTO expenses (expense_id, amount_ngn, date, category, branch_id)
    VALUES
      ('EX-W', 50000, '2026-06-10', 'Wages', 'BR-KD'),
      ('EX-F', 30000, '2026-06-11', 'Fuel & lubricant', 'BR-KD'),
      ('EX-U', 10000, '2026-06-12', 'Weird legacy cat', 'BR-KD');
  `);
}

describe('ap3CostingClassification', () => {
  it('classifies diesel/fuel category', () => {
    expect(classifyExpenseForCosting('Fuel & lubricant').bucket).toBe('diesel_fuel');
  });

  it('classifies wages as production labour', () => {
    expect(classifyExpenseForCosting('Wages').bucket).toBe('production_labour');
  });

  it('maps unknown legacy text to bucket or unclassified', () => {
    const c = classifyExpenseForCosting('Weird legacy cat');
    expect(['unclassified', 'admin_office', 'factory_consumables']).toContain(c.bucket);
  });
});

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('ap3CostingReadinessOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    seedCostingFixture(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('counts completed jobs and produced metres', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.status).toBe('readiness_only');
    expect(r.summary.completedJobs).toBe(3);
    expect(r.summary.producedMetres).toBe(150);
  });

  it('calculates material cost per metre when coil cost exists', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06', branchId: 'BR-KD' });
    expect(r.summary.materialCostNgn).toBeGreaterThan(0);
    expect(r.summary.materialCostPerMetreNgn).toBeGreaterThan(0);
  });

  it('detects missing coil cost', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.summary.missingCoilCostCount).toBeGreaterThan(0);
  });

  it('detects missing metres', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.summary.jobsMissingMetres).toBeGreaterThanOrEqual(1);
  });

  it('detects job with no coil consumption', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.summary.jobsMissingCoilConsumption).toBeGreaterThanOrEqual(1);
  });

  it('expense category classification aggregates labour and diesel', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.summary.labourExpenseNgn).toBe(50000);
    expect(r.summary.dieselExpenseNgn).toBe(30000);
    const diesel = r.expenseClassification.find((x) => x.bucket === 'diesel_fuel');
    expect(diesel?.count).toBe(1);
  });

  it('labour/payroll readiness handles missing HR safely', () => {
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.labourReadiness).toBeDefined();
    expect(typeof r.labourReadiness.ready).toBe('boolean');
    expect(Array.isArray(r.labourReadiness.notes)).toBe(true);
  });

  it('branch filtering works', () => {
    const kd = buildAp3CostingReadinessReport(db, { period: '2026-06', branchId: 'BR-KD' });
    const yl = buildAp3CostingReadinessReport(db, { period: '2026-06', branchId: 'BR-YL' });
    expect(kd.summary.completedJobs).toBe(2);
    expect(yl.summary.completedJobs).toBe(1);
  });

  it('returns proposed costing policy and is read-only', () => {
    const beforeGl = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get()?.c ?? 0;
    const r = buildAp3CostingReadinessReport(db, { period: '2026-06' });
    expect(r.proposedCostingPolicy.materialCostBasis).toBe('actual_coil_consumption');
    expect(r.disclaimer).toMatch(/read-only/i);
    const afterGl = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get()?.c ?? 0;
    expect(afterGl).toBe(beforeGl);
  });

  it('does not change coil unit cost', () => {
    const before = db.prepare(`SELECT unit_cost_ngn_per_kg FROM coil_lots WHERE coil_no = 'CL-COST'`).get();
    buildAp3CostingReadinessReport(db, { period: '2026-06' });
    const after = db.prepare(`SELECT unit_cost_ngn_per_kg FROM coil_lots WHERE coil_no = 'CL-COST'`).get();
    expect(after.unit_cost_ngn_per_kg).toBe(before.unit_cost_ngn_per_kg);
  });
});
