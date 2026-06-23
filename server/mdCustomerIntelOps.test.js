import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildMdCustomerIntelPack, segmentCustomer, segmentLabel } from './mdCustomerIntelOps.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe('mdCustomerIntelOps segments', () => {
  it('segmentLabel maps known segments', () => {
    expect(segmentLabel('champion')).toBe('Champion');
    expect(segmentLabel('risk')).toBe('At risk');
  });

  it('segmentCustomer flags aged debt as risk', () => {
    const risk = segmentCustomer(
      { debtNgn: 500_000, netCollectedNgn: 0, primaryAgingBand: '90+', refundCount: 0 },
      1_000_000
    );
    expect(risk).toBe('risk');
  });

  it('segmentCustomer picks champion when paid high with low debt', () => {
    const champion = segmentCustomer(
      { debtNgn: 50_000, netCollectedNgn: 2_000_000, primaryAgingBand: '0-30', refundCount: 0 },
      1_000_000
    );
    expect(champion).toBe('champion');
  });
});

describe.skipIf(!mysqlTestReady)('mdCustomerIntelOps pack', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('buildMdCustomerIntelPack returns empty pack on fresh database', () => {
    const pack = buildMdCustomerIntelPack(db, {
      branchScope: 'ALL',
      startISO: '2026-06-01',
      endISO: '2026-06-30',
    });
    expect(pack.ok).toBe(true);
    expect(pack.customers).toEqual([]);
    expect(pack.summary.total).toBe(0);
    expect(pack.champion).toBeNull();
  });
});
