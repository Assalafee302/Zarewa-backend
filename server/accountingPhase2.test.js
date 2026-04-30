import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  createFixedAsset,
  disposeFixedAsset,
  getCostingSnapshot,
  listFixedAssets,
  updateFixedAsset,
  upsertProductStandardCost,
} from './accountingPhase2Ops.js';

describe('accountingPhase2Ops', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('creates and lists fixed assets scoped by branch', () => {
    const r = createFixedAsset(
      db,
      {
        name: 'CNC line 1',
        category: 'plant',
        branchId: 'BR-KD',
        acquisitionDateIso: '2024-01-15',
        costNgn: 12_000_000,
        salvageNgn: 480_000,
        usefulLifeMonths: 48,
      },
      { id: 'u1' }
    );
    expect(r.ok).toBe(true);
    expect(r.asset.monthlyDepreciationNgn).toBe(240_000);

    const kad = listFixedAssets(db, 'BR-KD');
    expect(kad.assets).toHaveLength(1);
    expect(kad.assets[0].accumulatedDepreciationNgn).toBeGreaterThanOrEqual(0);

    const yol = listFixedAssets(db, 'BR-YL');
    expect(yol.assets).toHaveLength(0);

    const all = listFixedAssets(db, 'ALL');
    expect(all.assets.length).toBeGreaterThanOrEqual(1);
  });

  it('updates and disposes a fixed asset', () => {
    const { asset } = createFixedAsset(
      db,
      {
        name: 'Laptop pack',
        category: 'it',
        branchId: 'BR-KD',
        acquisitionDateIso: '2025-01-01',
        costNgn: 2_000_000,
        usefulLifeMonths: 24,
      },
      { id: 'u1' }
    );
    const u = updateFixedAsset(db, asset.id, { costNgn: 2_100_000 }, { id: 'u1' });
    expect(u.ok).toBe(true);
    expect(u.asset.costNgn).toBe(2_100_000);

    const d = disposeFixedAsset(db, asset.id, '2026-03-01', { id: 'u1' });
    expect(d.ok).toBe(true);
    expect(d.asset.status).toBe('disposed');

    const bad = updateFixedAsset(db, asset.id, { name: 'x' }, { id: 'u1' });
    expect(bad.ok).toBe(false);
  });

  it('blocks fixed asset and standard cost when accounting period is locked', () => {
    db.prepare(
      `INSERT INTO accounting_period_locks (period_key, locked_from_iso, locked_at_iso, locked_by_user_id, locked_by_name, reason)
       VALUES (?,?,?,?,?,?)`
    ).run('2025-06', '2025-06-01', new Date().toISOString(), 'USR-ADMIN', 'Test', 'close');

    const blocked = createFixedAsset(
      db,
      {
        name: 'Locked month asset',
        category: 'it',
        branchId: 'BR-KD',
        acquisitionDateIso: '2025-06-15',
        costNgn: 100_000,
      },
      { id: 'u1' }
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/locked period/i);

    const prod = db.prepare(`SELECT product_id FROM products LIMIT 1`).get();
    const sc = upsertProductStandardCost(
      db,
      prod.product_id,
      { standardMaterialCostNgnPerKg: 100, effectiveFromIso: '2025-06-01' },
      { id: 'u1' }
    );
    expect(sc.ok).toBe(false);
    expect(sc.error).toMatch(/locked period/i);
  });

  it('upserts standard cost and returns costing snapshot rows', () => {
    const prod = db.prepare(`SELECT product_id FROM products LIMIT 1`).get();
    expect(prod?.product_id).toBeTruthy();
    const pid = prod.product_id;

    const up = upsertProductStandardCost(
      db,
      pid,
      {
        standardMaterialCostNgnPerKg: 950,
        standardOverheadNgnPerM: 120,
        effectiveFromIso: '2025-01-01',
      },
      { id: 'u1' }
    );
    expect(up.ok).toBe(true);

    const snap = getCostingSnapshot(db, 'ALL');
    expect(snap.ok).toBe(true);
    const row = snap.rows.find((r) => r.productId === pid);
    expect(row).toBeTruthy();
    expect(row.standardMaterialCostNgnPerKg).toBe(950);
    expect(row.standardOverheadNgnPerM).toBe(120);
  });
});
