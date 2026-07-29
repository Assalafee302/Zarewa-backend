import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildMaintenanceInsightsPack,
  buildMaintenanceMachineInsights,
  buildMaintenanceVendorCostComparison,
} from './maintenanceInsightsOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('maintenanceInsightsOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close?.();
  });

  it('flags watch from lifetime cost vs asset purchase cost', () => {
    db.prepare(
      `INSERT INTO machines (id, reference_no, machine_code, name, branch_id, status, created_at_iso, updated_at_iso)
       VALUES ('m1','MACH-1','MC-1','Press','kaduna','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO fixed_assets (
         id, name, category, branch_id, cost_ngn, salvage_ngn, useful_life_months, depreciation_method,
         acquisition_date_iso, status, created_at_iso, updated_at_iso
       ) VALUES (
         'a1','Press asset','machinery','kaduna',10000000,0,120,'straight_line',
         '2024-01-01','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT INTO machine_asset_links (machine_id, asset_id, relation_kind)
       VALUES ('m1','a1','primary')`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_work_orders (
         id, reference_no, branch_id, machine_id, status, priority, kind, summary, opened_at_iso
       ) VALUES (
         'wo1','WO-1','kaduna','m1','closed','normal','corrective','Repair','2026-01-01T00:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_cost_lines (
         id, work_order_id, cost_kind, amount_ngn, posted_at_iso, source_kind, source_id
       ) VALUES (
         'cl1','wo1','parts',4000000,'2026-06-01T00:00:00.000Z','payment_request','PR1'
       )`
    ).run();

    const rows = buildMaintenanceMachineInsights(db, { branchId: 'kaduna', viewAll: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].lifetimeMaintenanceNgn).toBe(4_000_000);
    expect(rows[0].flag).toBe('watch');
    expect(rows[0].signal).toBe('watch');
  });

  it('ignores cost lines without payment/expense source', () => {
    db.prepare(
      `INSERT INTO machines (id, reference_no, machine_code, name, branch_id, status, created_at_iso, updated_at_iso)
       VALUES ('m1','MACH-1','MC-1','Press','kaduna','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_work_orders (
         id, reference_no, branch_id, machine_id, status, priority, kind, summary, opened_at_iso
       ) VALUES (
         'wo1','WO-1','kaduna','m1','open','normal','corrective','Fault','2026-01-01T00:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_cost_lines (
         id, work_order_id, cost_kind, amount_ngn, posted_at_iso, source_kind, source_id
       ) VALUES (
         'cl1','wo1','parts',999999,'2026-06-01T00:00:00.000Z','manual',''
       )`
    ).run();

    const rows = buildMaintenanceMachineInsights(db, { viewAll: true });
    expect(rows[0].lifetimeMaintenanceNgn).toBe(0);
    expect(rows[0].flag).toBe('ok');
  });

  it('rolls up attributed spend by vendor', () => {
    db.prepare(
      `INSERT INTO maintenance_vendors (
         id, name, specialty, phone, status, created_at_iso, updated_at_iso
       ) VALUES (
         'v1','Acme Fix','electrical','0800','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT INTO machines (id, reference_no, machine_code, name, branch_id, status, created_at_iso, updated_at_iso)
       VALUES ('m1','MACH-1','MC-1','Press','kaduna','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_work_orders (
         id, reference_no, branch_id, machine_id, status, priority, kind, summary,
         opened_at_iso, vendor_id, vendor_name
       ) VALUES (
         'wo1','WO-1','kaduna','m1','closed','normal','corrective','Repair',
         '2026-06-01T00:00:00.000Z','v1','Acme Fix'
       )`
    ).run();
    db.prepare(
      `INSERT INTO maintenance_cost_lines (
         id, work_order_id, cost_kind, amount_ngn, posted_at_iso, source_kind, source_id
       ) VALUES (
         'cl1','wo1','labour',250000,'2026-07-01T00:00:00.000Z','expense','EX1'
       )`
    ).run();

    const vendors = buildMaintenanceVendorCostComparison(db, { viewAll: true });
    expect(vendors).toHaveLength(1);
    expect(vendors[0].totalNgn).toBe(250_000);
    expect(vendors[0].jobCount).toBe(1);
    expect(vendors[0].avgCostPerJobNgn).toBe(250_000);
    expect(vendors[0].specialty).toBe('electrical');
    expect(vendors[0].name).toBe('Acme Fix');
  });

  it('returns ok pack with machines and vendors arrays', () => {
    const pack = buildMaintenanceInsightsPack(db, { viewAll: true });
    expect(pack.ok).toBe(true);
    expect(Array.isArray(pack.machines)).toBe(true);
    expect(Array.isArray(pack.vendors)).toBe(true);
    expect(pack.summary).toBeTruthy();
  });
});
