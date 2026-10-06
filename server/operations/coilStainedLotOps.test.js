import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { markCoilStainedDamaged } from './coilStainedLotOps.js';
import { postCoilScrap } from '../writeOps.js';
import { completeProductionJob, startProductionJob } from '../productionTraceability.js';

describe('stained coil lots', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  function seed() {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
       VALUES ('COIL-PHY', 'Test coil kg', 1000, 'kg', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, branch_id, colour, gauge_label, qty_received, weight_kg, qty_remaining, qty_reserved,
        current_weight_kg, current_status, unit_cost_ngn_per_kg, landed_cost_ngn, received_at_iso
      ) VALUES ('CL-STAIN-1', 'COIL-PHY', ?, 'Traffic Black', '0.28mm', 1000, 1000, 1000, 0, 1000, 'Available', 1800, 1800000, '2026-05-01')`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_jobs (job_id, status, planned_meters, created_at_iso, branch_id)
       VALUES ('PRO-STAIN-1', 'Planned', 10, '2026-10-01T00:00:00.000Z', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_jobs (job_id, status, planned_meters, created_at_iso, branch_id)
       VALUES ('PRO-OFF-1', 'Running', 4, '2026-10-01T00:00:00.000Z', ?)`
    ).run(DEFAULT_BRANCH_ID);
  }

  it('moves kg into a stained lot and keeps catalogue stock', () => {
    seed();
    const marked = markCoilStainedDamaged(
      db,
      { coilNo: 'CL-STAIN-1', kg: 100, reason: 'Water stain along the edge', by: 'Store', dateISO: '2026-10-06' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { displayName: 'Store' } }
    );
    expect(marked.ok, marked.error).toBe(true);
    const coil = db.prepare(`SELECT qty_remaining, landed_cost_ngn, current_status FROM coil_lots WHERE coil_no = 'CL-STAIN-1'`).get();
    expect(Number(coil.qty_remaining)).toBe(900);
    expect(Number(coil.landed_cost_ngn)).toBe(1620000);
    expect(coil.current_status).toBe('Available');
    const lot = db.prepare(`SELECT * FROM stained_lots WHERE coil_no = 'CL-STAIN-1'`).get();
    expect(Number(lot.qty_kg)).toBe(100);
    expect(lot.colour).toBe('Traffic Black');
    expect(lot.gauge_label).toBe('0.28mm');
    expect(Number(lot.unit_cost_ngn_per_kg)).toBe(1800);
    expect(Number(lot.cost_ngn)).toBe(180000);
    const stock = db.prepare(`SELECT stock_level FROM products WHERE product_id = 'COIL-PHY'`).get();
    expect(Number(stock.stock_level)).toBe(1000);
    const moves = db.prepare(`SELECT type, ref, qty FROM stock_movements WHERE type = 'COIL_TO_STAINED' ORDER BY qty`).all();
    expect(moves.map((m) => ({ type: m.type, ref: m.ref, qty: Number(m.qty) }))).toEqual([
      { type: 'COIL_TO_STAINED', ref: 'CL-STAIN-1', qty: -100 },
      { type: 'COIL_TO_STAINED', ref: 'STAINED:CL-STAIN-1', qty: 100 },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM stock_movements WHERE type = 'COIL_SCRAP'`).get().c).toBe(0);

    const scrap = postCoilScrap(
      db,
      { coilNo: 'CL-STAIN-1', kg: 10, reason: 'edge stain', dateISO: '2026-10-06' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { displayName: 'Store' } }
    );
    expect(scrap.ok).toBe(false);
    expect(scrap.code).toBe('STAINED_LOT_REQUIRED');
  });

  it('completes production from the stained lot and leaves the prime coil', () => {
    seed();
    const marked = markCoilStainedDamaged(
      db,
      { coilNo: 'CL-STAIN-1', kg: 100, reason: 'Damaged outer wraps', by: 'Store', dateISO: '2026-10-06' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { displayName: 'Store' } }
    );
    expect(marked.ok, marked.error).toBe(true);
    const started = startProductionJob(
      db,
      'PRO-STAIN-1',
      { startMode: 'stained', startedAtISO: '2026-10-06T12:00:00.000Z' },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { displayName: 'Store' } }
    );
    expect(started.ok, started.error).toBe(true);
    const done = completeProductionJob(
      db,
      'PRO-STAIN-1',
      {
        completeMode: 'stained',
        coilNo: 'CL-STAIN-1',
        metersProduced: 10,
        kg: 26,
        completedAtISO: '2026-10-06T12:00:00.000Z',
      },
      { workspaceBranchId: DEFAULT_BRANCH_ID, actor: { displayName: 'Store' } }
    );
    expect(done.ok, done.error).toBe(true);
    expect(done.actualMeters).toBe(10);
    expect(done.actualWeightKg).toBe(26);
    const coil = db.prepare(`SELECT qty_remaining FROM coil_lots WHERE coil_no = 'CL-STAIN-1'`).get();
    expect(Number(coil.qty_remaining)).toBe(900);
    const lot = db.prepare(`SELECT qty_kg, cost_ngn FROM stained_lots WHERE coil_no = 'CL-STAIN-1'`).get();
    expect(Number(lot.qty_kg)).toBe(74);
    expect(Number(lot.cost_ngn)).toBe(180000 - 26 * 1800);
    const stock = db.prepare(`SELECT stock_level FROM products WHERE product_id = 'COIL-PHY'`).get();
    expect(Number(stock.stock_level)).toBe(974);
    const consumed = db.prepare(`SELECT type, ref, qty, detail FROM stock_movements WHERE type = 'COIL_CONSUMPTION'`).get();
    expect(consumed.ref).toBe('PRO-STAIN-1');
    expect(Number(consumed.qty)).toBe(-26);
    expect(String(consumed.detail)).toMatch(/^Stained lot CL-STAIN-1/);
    const offcut = completeProductionJob(
      db,
      'PRO-OFF-1',
      { completeMode: 'offcut', offcutInventoryMeters: 4 },
      { workspaceBranchId: DEFAULT_BRANCH_ID }
    );
    expect(offcut.ok).toBe(false);
    expect(offcut.code).toBe('OFFCUT_POOL_DRAW_REQUIRED');
  });
});
