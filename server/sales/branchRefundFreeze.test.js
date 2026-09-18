import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { getEligibleRefundQuotations, quotationMeetsRefundEligibility } from '../controlOps.js';
import { setBranchRefundsBlocked } from './branchRefundFreezeOps.js';
import { assertQuotationBranchRefundsNotFrozen } from './branchRefundFreeze.js';

describe('branch refund lock window (admin, quotations + receipts in range)', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    const linesJson = JSON.stringify({
      products: [{ name: 'R', qty: 20, unitPrice: 2500 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('adm1', 'admin.user', 'Admin User', 'hash', 'admin', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-YL-1', 'Yola Customer', 'BR-YL');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-YL-SEP', 'CUS-YL-1', 'Yola Customer', 50000, 50000, 'Finished', '${linesJson.replace(/'/g, "''")}', '2026-09-10', 'BR-YL'),
        ('QT-YL-APR', 'CUS-YL-1', 'Yola Customer', 50000, 50000, 'Finished', '${linesJson.replace(/'/g, "''")}', '2026-04-01', 'BR-YL'),
        ('QT-YL-RCPT', 'CUS-YL-1', 'Yola Customer', 50000, 50000, 'Finished', '${linesJson.replace(/'/g, "''")}', '2026-08-20', 'BR-YL');
      INSERT INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso, branch_id)
      VALUES
        ('JOB-YL-SEP', 'QT-YL-SEP', 0, 'Cancelled', '2026-09-10T10:00:00Z', 'BR-YL'),
        ('JOB-YL-APR', 'QT-YL-APR', 0, 'Cancelled', '2026-04-01T10:00:00Z', 'BR-YL'),
        ('JOB-YL-RCPT', 'QT-YL-RCPT', 0, 'Cancelled', '2026-08-20T10:00:00Z', 'BR-YL');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, branch_id)
      VALUES ('SR-YL-SEP', 'CUS-YL-1', 'Yola Customer', 'QT-YL-RCPT', '2026-09-05', 50000, 'Posted', 'BR-YL');
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const admin = { id: 'adm1', displayName: 'Admin User', roleKey: 'admin', permissions: ['*'] };
  const md = { id: 'md1', displayName: 'MD', roleKey: 'md', permissions: [] };

  it('MD cannot set a branch window; admin can lock 1–16 September', () => {
    expect(
      setBranchRefundsBlocked(
        db,
        'BR-YL',
        { fromISO: '2026-09-01', toISO: '2026-09-16', reason: 'Lock Yola 1–16 Sep catch-up' },
        md
      ).code
    ).toBe('FORBIDDEN');

    const r = setBranchRefundsBlocked(
      db,
      'BR-YL',
      {
        fromISO: '2026-09-01',
        toISO: '2026-09-16',
        reason: 'Yola historical refunds treated as already paid',
      },
      admin
    );
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(true);
    expect(String(r.refundsBlockedFromISO || '')).toMatch(/^2026-09-01/);
    expect(String(r.refundsBlockedToISO || '')).toMatch(/^2026-09-16/);
  });

  it('blocks Yola quotes and receipts in the window; leaves earlier Yola quotes open', () => {
    const inWindow = assertQuotationBranchRefundsNotFrozen(db, 'QT-YL-SEP', 'BR-YL');
    expect(inWindow.ok).toBe(false);
    expect(inWindow.code).toBe('BRANCH_REFUNDS_FROZEN');
    expect(String(inWindow.error || '')).toMatch(/already settled/i);

    const receiptHit = assertQuotationBranchRefundsNotFrozen(db, 'QT-YL-RCPT', 'BR-YL');
    expect(receiptHit.ok).toBe(false);

    const earlier = assertQuotationBranchRefundsNotFrozen(db, 'QT-YL-APR', 'BR-YL');
    expect(earlier.ok).toBe(true);

    expect(quotationMeetsRefundEligibility(db, 'QT-YL-SEP').ok).toBe(false);
    const rows = getEligibleRefundQuotations(db, { branchScope: 'BR-YL' });
    expect(rows.some((r) => r.id === 'QT-YL-SEP')).toBe(false);
    expect(rows.some((r) => r.id === 'QT-YL-RCPT')).toBe(false);
  });

  it('admin can lift the window', () => {
    const r = setBranchRefundsBlocked(db, 'BR-YL', { blocked: false }, admin);
    expect(r.ok).toBe(true);
    expect(assertQuotationBranchRefundsNotFrozen(db, 'QT-YL-SEP', 'BR-YL').ok).toBe(true);
  });
});
