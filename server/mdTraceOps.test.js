import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildMdTracePack } from './mdTraceOps.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe('mdTraceOps (pure)', () => {
  it('buildMdTracePack handles null db gracefully', () => {
    const pack = buildMdTracePack(null, { branchScope: 'ALL', dateISO: '2026-06-01' });
    expect(pack.ok).toBe(true);
    expect(pack.sampleCount).toBe(0);
  });
});

describe.skipIf(!mysqlTestReady)('mdTraceOps (integration)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('buildMdTracePack returns ok with empty database', () => {
    const pack = buildMdTracePack(db, { branchScope: 'ALL', dateISO: '2026-06-01' });
    expect(pack.ok).toBe(true);
    expect(pack.dateISO).toBe('2026-06-01');
    expect(pack.sampleCount).toBe(0);
    expect(pack.samples).toEqual([]);
    expect(pack.seedLabel).toBe('daily');
  });

  it('daily seed is stable for the same date and branch', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_name, total_ngn, paid_ngn, date_iso, branch_id, status)
      VALUES ('Q-TRACE-1', 'Acme Ltd', 500000, 250000, '2026-06-01', 'BR-KD', 'Approved');
      INSERT INTO sales_receipts (id, receipt_id, quotation_ref, amount_ngn, date_iso, branch_id)
      VALUES ('SR-1', 'RCP-TRACE-1', 'Q-TRACE-1', 250000, '2026-06-01', 'BR-KD');
    `);
    const a = buildMdTracePack(db, { branchScope: 'ALL', dateISO: '2026-06-15' });
    const b = buildMdTracePack(db, { branchScope: 'ALL', dateISO: '2026-06-15' });
    expect(a.samples.length).toBeGreaterThan(0);
    expect(a.samples[0]?.entityRef).toBe(b.samples[0]?.entityRef);
  });

  it('shuffle nonce changes seed label', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_name, total_ngn, paid_ngn, date_iso, branch_id, status)
      VALUES ('Q-A', 'Alpha', 100000, 50000, '2026-06-01', 'BR-KD', 'Approved'),
             ('Q-B', 'Beta', 200000, 100000, '2026-06-02', 'BR-KD', 'Approved');
    `);
    const daily = buildMdTracePack(db, { branchScope: 'ALL', dateISO: '2026-06-20' });
    const shuffled = buildMdTracePack(db, {
      branchScope: 'ALL',
      dateISO: '2026-06-20',
      shuffleNonce: 'nonce-1',
    });
    expect(daily.seedLabel).toBe('daily');
    expect(shuffled.seedLabel).toBe('shuffled');
    expect(daily.samples.some((s) => s.domain === 'sales')).toBe(true);
    expect(shuffled.samples.some((s) => s.domain === 'sales')).toBe(true);
  });
});
