import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { createFixedAsset } from './accountingPhase2Ops.js';
import { disposeFixedAsset } from './fixedAssetDisposalOps.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';

describe('fixedAssetDisposalOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('records sale proceeds, treasury receipt, and GL on disposal', () => {
    const { asset } = createFixedAsset(
      db,
      {
        name: 'Forklift',
        category: 'plant',
        branchId: 'BR-KD',
        acquisitionDateIso: '2024-06-01',
        costNgn: 3_000_000,
        usefulLifeMonths: 60,
      },
      { id: 'u1' }
    );

    const r = disposeFixedAsset(
      db,
      asset.id,
      {
        disposalDateIso: '2026-06-15',
        saleProceedsNgn: 1_800_000,
        treasuryAccountId: 1,
        reference: 'FA-SALE-01',
        workspaceBranchId: 'BR-KD',
      },
      { id: 'u1', displayName: 'Finance' }
    );
    expect(r.ok).toBe(true);
    expect(r.asset.status).toBe('disposed');
    expect(r.asset.disposalProceedsNgn).toBe(1_800_000);
    expect(r.saleProceedsNgn).toBe(1_800_000);

    const tm = db
      .prepare(
        `SELECT amount_ngn FROM treasury_movements WHERE source_kind = 'FIXED_ASSET' AND source_id = ?`
      )
      .get(asset.id);
    expect(Number(tm?.amount_ngn)).toBe(1_800_000);

    const je = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'FIXED_ASSET_DISPOSE' AND source_id = ?`)
      .get(asset.id);
    expect(je?.id).toBeTruthy();
  });

  it('posts loss on disposal when sold below NBV', () => {
    const { asset } = createFixedAsset(
      db,
      {
        name: 'Old laptop',
        category: 'it',
        branchId: 'BR-KD',
        acquisitionDateIso: '2025-01-01',
        costNgn: 1_000_000,
        usefulLifeMonths: 24,
      },
      { id: 'u1' }
    );

    const r = disposeFixedAsset(
      db,
      asset.id,
      {
        disposalDateIso: '2026-06-15',
        saleProceedsNgn: 100_000,
        treasuryAccountId: 1,
        workspaceBranchId: 'BR-KD',
      },
      { id: 'u1' }
    );
    expect(r.ok).toBe(true);
    expect(r.gainLossNgn).toBeLessThan(0);
  });

  it('allows scrap disposal without treasury proceeds', () => {
    const { asset } = createFixedAsset(
      db,
      {
        name: 'Scrapped press',
        category: 'plant',
        branchId: 'BR-KD',
        acquisitionDateIso: '2023-01-01',
        costNgn: 2_000_000,
        usefulLifeMonths: 48,
      },
      { id: 'u1' }
    );

    const r = disposeFixedAsset(
      db,
      asset.id,
      { disposalDateIso: '2026-06-15', saleProceedsNgn: 0, workspaceBranchId: 'BR-KD' },
      { id: 'u1' }
    );
    expect(r.ok).toBe(true);
    expect(r.treasuryMovementId).toBeNull();

    const tmCount = db
      .prepare(`SELECT COUNT(*) AS c FROM treasury_movements WHERE source_id = ?`)
      .get(asset.id);
    expect(Number(tmCount?.c)).toBe(0);
  });
});
