import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { resolveSetupPriceListUnitNgn } from './pricingResolve.js';

describe('pricingResolve', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('resolveSetupPriceListUnitNgn matches specific setup row', () => {
    const r = resolveSetupPriceListUnitNgn(db, {
      quoteItemId: 'SQI-001',
      gaugeId: 'GAU-003',
      colourId: 'COL-001',
      materialTypeId: 'MAT-001',
      profileId: 'PROF-001',
    });
    expect(r).not.toBeNull();
    expect(r?.unitPriceNgn).toBeGreaterThan(0);
    expect(r?.source).toBe('setup_price_lists');
  });
});
