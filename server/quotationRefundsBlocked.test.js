import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import {
  getEligibleRefundQuotations,
  insertRefundRequest,
  quotationMeetsRefundEligibility,
  setQuotationRefundsBlocked,
} from './controlOps.js';

describe('quotation refunds blocked (MD/admin permanent block)', () => {
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
      VALUES ('md1', 'md.user', 'MD User', 'hash', 'md', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-001', 'Test Customer', 'BR-KD');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
      VALUES ('QT-BLOCK-259', 'CUS-001', 'Test Customer', 50000, 50000, 'Finished', '${linesJson.replace(/'/g, "''")}', '2026-04-01', 'BR-KD');
      INSERT INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso, branch_id)
      VALUES ('JOB-BLOCK-259', 'QT-BLOCK-259', 0, 'Cancelled', '2026-04-01T10:00:00Z', 'BR-KD');
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const mdActor = { id: 'md1', displayName: 'MD User', roleKey: 'md', permissions: [] };
  const salesActor = { id: 's1', displayName: 'Sales', roleKey: 'sales_staff', permissions: ['refunds.request'] };

  it('eligible list includes quote before block', () => {
    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-BLOCK-259')).toBe(true);
  });

  it('branch manager cannot block refunds', () => {
    const bm = { id: 'bm1', displayName: 'BM', roleKey: 'sales_manager' };
    const r = setQuotationRefundsBlocked(db, 'QT-BLOCK-259', { blocked: true, reason: 'Mistaken posting — not refundable' }, bm);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });

  it('MD blocks refunds with reason and removes quote from eligible list', () => {
    const r = setQuotationRefundsBlocked(
      db,
      'QT-BLOCK-259',
      { blocked: true, reason: 'Mistaken overpayment on quotation 259 — finance corrected' },
      mdActor
    );
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(true);

    const row = db
      .prepare(`SELECT refunds_blocked_at_iso, refunds_blocked_reason FROM quotations WHERE id = ?`)
      .get('QT-BLOCK-259');
    expect(row.refunds_blocked_at_iso).toBeTruthy();
    expect(row.refunds_blocked_reason).toMatch(/Mistaken overpayment/i);

    const meets = quotationMeetsRefundEligibility(db, 'QT-BLOCK-259');
    expect(meets.ok).toBe(false);
    expect(meets.refundsBlocked).toBe(true);

    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-BLOCK-259')).toBe(false);
  });

  it('insertRefundRequest is rejected while blocked', () => {
    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-001',
        customer: 'Test Customer',
        quotationRef: 'QT-BLOCK-259',
        reasonCategory: 'Adjustment',
        reason: 'Should not go through',
        amountNgn: 5000,
        calculationLines: [{ label: 'X', amountNgn: 5000 }],
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/permanently blocked/i);
  });

  it('MD can unblock refunds', () => {
    const r = setQuotationRefundsBlocked(db, 'QT-BLOCK-259', { blocked: false }, mdActor);
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(false);
    const meets = quotationMeetsRefundEligibility(db, 'QT-BLOCK-259');
    expect(meets.ok).toBe(true);
  });
});
