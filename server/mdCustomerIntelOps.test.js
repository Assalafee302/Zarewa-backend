import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildExecCustomerBrief,
  buildMdCustomerIntelPack,
  segmentCustomer,
  segmentLabel,
} from './mdCustomerIntelOps.js';

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

describe.skipIf(!mysqlTestReady)('buildExecCustomerBrief', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status, tier, payment_terms)
       VALUES ('C-1', 'Acme Ltd', 'BR-KD', 'active', 'standard', 'cash')`
    ).run();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, date_label, total_ngn, paid_ngn, status, branch_id)
       VALUES ('Q-1', 'C-1', 'Acme Ltd', '2026-06-01', '2026-06-01', 100000, 40000, 'approved', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO ledger_entries (id, customer_id, type, amount_ngn, at_iso, branch_id)
       VALUES ('L-1', 'C-1', 'RECEIPT', 40000, '2026-06-02T10:00:00.000Z', 'BR-KD')`
    ).run();
  });

  afterEach(() => {
    db?.close();
  });

  it('returns per-customer brief without branch-wide scans', () => {
    const brief = buildExecCustomerBrief(db, 'C-1', 'ALL');
    expect(brief.ok).toBe(true);
    expect(brief.customerId).toBe('C-1');
    expect(brief.outstandingByQuotation).toHaveLength(1);
    expect(brief.outstandingByQuotation[0].amountDueNgn).toBe(60000);
    expect(brief.entries).toHaveLength(1);
  });

  it('404-style payload for missing customer', () => {
    const brief = buildExecCustomerBrief(db, 'missing', 'ALL');
    expect(brief.ok).toBe(false);
    expect(brief.error).toBe('Customer not found');
  });
});
