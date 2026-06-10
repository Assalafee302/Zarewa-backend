import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';
import { createCoilDamageMaterialIncident, approveMaterialIncident } from './materialIncidentOps.js';

function seedCoil(db, coilNo, kg = 5000) {
  db.prepare(
    `INSERT INTO products (product_id, name, category, stock_level, unit)
     VALUES ('COIL-ALU', 'Alu coil', 'Raw Material', ?, 'kg')
     ON CONFLICT(product_id) DO UPDATE SET stock_level = excluded.stock_level`
  ).run(kg);
  db.prepare(
    `INSERT INTO coil_lots (
      coil_no, product_id, branch_id, gauge_label, colour, qty_received, qty_remaining,
      current_weight_kg, supplier_conversion_kg_per_m, current_status
    ) VALUES (?, 'COIL-ALU', 'BR-001', '0.45mm', 'Traffic Black', ?, ?, ?, 2.65, 'available')`
  ).run(coilNo, kg, kg, kg, 2.65);
}

describe('createCoilDamageMaterialIncident', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    seedCoil(db, 'C-DMG-1', 5000);
  });

  it('creates coil_stain draft with before/after kg and metre line', () => {
    const r = createCoilDamageMaterialIncident(
      db,
      {
        coilNo: 'C-DMG-1',
        beforeKg: 4800,
        afterKg: 4400,
        meters: 150,
        note: 'Mid-roll rust band cut out',
        submit: false,
      },
      { workspaceBranchId: 'BR-001', actor: { userId: 'u1', displayName: 'Store' } }
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe('draft');
    expect(r.id).toMatch(/^MEX-/);
    const row = db.prepare(`SELECT * FROM material_incidents WHERE id = ?`).get(r.id);
    expect(row.incident_type).toBe('coil_stain');
    expect(row.before_kg).toBeCloseTo(4800, 2);
    expect(row.after_kg).toBeCloseTo(4400, 2);
    expect(row.kg_deducted).toBeCloseTo(400, 2);
    expect(row.total_meters).toBeCloseTo(150, 2);
    expect(row.return_disposition).toBe('offcut_pool');
  });

  it('uses production_error when production job is linked', () => {
    const r = createCoilDamageMaterialIncident(
      db,
      {
        coilNo: 'C-DMG-1',
        beforeKg: 3000,
        afterKg: 2900,
        meters: 120,
        productionJobId: 'JOB-99',
        note: 'Trim error during production run',
        submit: false,
      },
      { workspaceBranchId: 'BR-001', actor: { userId: 'u1' } }
    );
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT incident_type, production_job_id FROM material_incidents WHERE id = ?`).get(r.id);
    expect(row.incident_type).toBe('production_error');
    expect(row.production_job_id).toBe('JOB-99');
  });

  it('rejects kg removal above unreserved balance', () => {
    const r = createCoilDamageMaterialIncident(
      db,
      {
        coilNo: 'C-DMG-1',
        beforeKg: 5000,
        afterKg: 0,
        meters: 1800,
        note: 'Attempt to remove entire coil as damage',
        submit: false,
      },
      { workspaceBranchId: 'BR-001', actor: { userId: 'u1' } }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/unreserved/i);
  });

  it('posts scrap disposition to SCRAP-COIL not offcut pool on approve', () => {
    db.prepare(
      `INSERT INTO products (product_id, name, category, stock_level, unit)
       VALUES ('SCRAP-COIL', 'Scrap coil', 'Raw Material', 0, 'kg')`
    ).run();
    const created = createCoilDamageMaterialIncident(
      db,
      {
        coilNo: 'C-DMG-1',
        beforeKg: 2000,
        afterKg: 1865,
        meters: 50,
        returnDisposition: 'scrap',
        note: 'Unusable damaged section scrapped',
        submit: true,
      },
      { workspaceBranchId: 'BR-001', actor: { userId: 'u1', displayName: 'Store', roleKey: 'storekeeper' } }
    );
    expect(created.ok).toBe(true);
    expect(created.status).toBe('submitted');

    const approved = approveMaterialIncident(
      db,
      created.id,
      { managerRemark: 'Approved scrap' },
      { workspaceBranchId: 'BR-001', actor: { userId: 'mgr', displayName: 'Manager', roleKey: 'sales_manager' } }
    );
    expect(approved.ok).toBe(true);
    expect(approved.incident.metersAvailable).toBe(0);

    const scrap = db.prepare(`SELECT stock_level FROM products WHERE product_id = 'SCRAP-COIL'`).get();
    expect(Number(scrap.stock_level)).toBeCloseTo(135, 2);

    const coil = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = ?`).get('C-DMG-1');
    expect(Number(coil.qty_remaining)).toBeCloseTo(4865, 2);
  });
});
