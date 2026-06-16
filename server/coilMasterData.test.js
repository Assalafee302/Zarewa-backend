import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { patchCoilLotMasterData } from './writeOps.js';

const mysqlOk = isMysqlAvailableForTests();

function seedCoil(db, { coilNo, qtyReceived, weightKg, qtyRemaining, qtyReserved = 0 }) {
  db.prepare(
    `INSERT INTO products (product_id, name, category, stock_level, unit)
     VALUES ('COIL-ALU', 'Alu coil', 'Raw Material', ?, 'kg')
     ON CONFLICT(product_id) DO UPDATE SET stock_level = excluded.stock_level`
  ).run(qtyRemaining);
  db.prepare(
    `INSERT INTO coil_lots (
      coil_no, product_id, branch_id, gauge_label, colour,
      qty_received, weight_kg, qty_remaining, qty_reserved, current_weight_kg, current_status
    ) VALUES (?, 'COIL-ALU', 'BR-KD', '0.45mm', 'IV', ?, ?, ?, ?, ?, 'Available')`
  ).run(coilNo, qtyReceived, weightKg, qtyRemaining, qtyReserved, qtyRemaining);
}

describe.skipIf(!mysqlOk)('patchCoilLotMasterData received kg sync', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('shifts on-hand when GRN display kg (weight_kg) is corrected and matches on-hand', () => {
    seedCoil(db, {
      coilNo: 'CL-T-1',
      qtyReceived: 3500,
      weightKg: 4000,
      qtyRemaining: 4000,
    });
    const r = patchCoilLotMasterData(
      db,
      'CL-T-1',
      { receivedKg: 3200, currentWeightKg: 4000 },
      { workspaceBranchId: 'BR-KD' }
    );
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get('CL-T-1');
    expect(Number(row.weight_kg)).toBeCloseTo(3200, 2);
    expect(Number(row.qty_received)).toBeCloseTo(3200, 2);
    expect(Number(row.qty_remaining)).toBeCloseTo(3200, 2);
    expect(Number(row.current_weight_kg)).toBeCloseTo(3200, 2);
  });

  it('does not shift on-hand when production already consumed below received', () => {
    seedCoil(db, {
      coilNo: 'CL-T-2',
      qtyReceived: 4000,
      weightKg: 4000,
      qtyRemaining: 3500,
    });
    const r = patchCoilLotMasterData(db, 'CL-T-2', { receivedKg: 3700 }, { workspaceBranchId: 'BR-KD' });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get('CL-T-2');
    expect(Number(row.qty_received)).toBeCloseTo(3700, 2);
    expect(Number(row.qty_remaining)).toBeCloseTo(3500, 2);
  });

  it('syncs on-hand when only receivedKg is sent (no currentWeightKg)', () => {
    seedCoil(db, {
      coilNo: 'CL-T-3',
      qtyReceived: 4000,
      weightKg: null,
      qtyRemaining: 4000,
    });
    const r = patchCoilLotMasterData(db, 'CL-T-3', { receivedKg: 3500 }, { workspaceBranchId: 'BR-KD' });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get('CL-T-3');
    expect(Number(row.qty_remaining)).toBeCloseTo(3500, 2);
  });
});
