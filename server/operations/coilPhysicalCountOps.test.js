import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { postCoilPhysicalCount } from './coilPhysicalCountOps.js';

describe('coil physical count', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  function seedCoil(bookKg) {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
       VALUES ('COIL-PHY', 'Test coil kg', ?, 'kg', ?)`
    ).run(bookKg, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, branch_id, qty_received, weight_kg, qty_remaining, qty_reserved,
        current_weight_kg, current_status, unit_cost_ngn_per_kg, received_at_iso
      ) VALUES ('CL-PHY-1', 'COIL-PHY', ?, ?, ?, ?, 0, ?, 'Available', 1800, '2026-05-01')`
    ).run(DEFAULT_BRANCH_ID, bookKg, bookKg, bookKg, bookKg);
  }

  it('posts the difference as COIL_COUNT_VARIANCE and updates the coil cache', () => {
    seedCoil(1000);
    const r = postCoilPhysicalCount(
      db,
      { coilNo: 'CL-PHY-1', countedKg: 910, countedBy: 'Nazifi', dateISO: '2026-10-06', note: 'Yard count' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { id: 'u1', displayName: 'Store' } }
    );
    expect(r.ok, r.error).toBe(true);
    expect(r.varianceKg).toBe(-90);
    expect(r.movementType).toBe('COIL_COUNT_VARIANCE');
    const coil = db.prepare(`SELECT qty_remaining, current_weight_kg, current_status FROM coil_lots WHERE coil_no = 'CL-PHY-1'`).get();
    expect(coil.qty_remaining).toBe(910);
    expect(coil.current_weight_kg).toBe(910);
    expect(coil.current_status).toBe('Available');
    const mv = db.prepare(`SELECT type, qty, ref FROM stock_movements WHERE id = ?`).get(r.movementId);
    expect(mv.type).toBe('COIL_COUNT_VARIANCE');
    expect(mv.qty).toBe(-90);
    expect(mv.ref).toBe('CL-PHY-1');
    expect(db.prepare(`SELECT COUNT(*) AS c FROM stock_movements WHERE type = 'COIL_SCRAP'`).get().c).toBe(0);
    expect(db.prepare(`SELECT stock_level FROM products WHERE product_id = 'COIL-PHY'`).get().stock_level).toBe(910);
  });

  it('records a matching count without a stock movement', () => {
    seedCoil(500);
    const r = postCoilPhysicalCount(db, {
      coilNo: 'CL-PHY-1',
      countedKg: 500,
      countedBy: 'Nazifi',
      dateISO: '2026-10-06',
      note: 'Agrees with the book',
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.varianceKg).toBe(0);
    expect(r.movementId).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM stock_movements WHERE type = 'COIL_COUNT_VARIANCE'`).get().c).toBe(0);
  });
});
