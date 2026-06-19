import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { listRefunds } from './readModel.js';
import { approvedRefundsAwaitingPayment } from '../shared/lib/refundsStore.js';
import { setQuotationRefundsBlocked } from './controlOps.js';

describe('blocked quotation refunds are not payable', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('md1', 'md.user', 'MD User', 'hash', 'md', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-PAY', 'Pay Customer', 'BR-KD');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
      VALUES ('QT-PAY-BLOCK', 'CUS-PAY', 'Pay Customer', 50000, 50000, 'Finished', '{}', '2026-04-01', 'BR-KD');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id
      ) VALUES (
        'RF-PAY-BLOCK', 'CUS-PAY', 'Pay Customer', 'QT-PAY-BLOCK', '—', '["Adjustment"]',
        'Approved before block', 5000, 5000, 0, 'Approved', 'Sales', '2026-04-02', '2026-04-03', 'BM', 'BR-KD'
      );
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const mdActor = { id: 'md1', displayName: 'MD User', roleKey: 'md', permissions: [] };

  it('listRefunds includes quotation block flags', () => {
    const rows = listRefunds(db);
    const row = rows.find((r) => r.refundID === 'RF-PAY-BLOCK');
    expect(row).toBeTruthy();
    expect(row.quotationRefundsBlockedAtISO).toBeFalsy();
  });

  it('approved refund drops out of payable queue after quotation block', () => {
    expect(approvedRefundsAwaitingPayment(listRefunds(db)).some((r) => r.refundID === 'RF-PAY-BLOCK')).toBe(true);

    const block = setQuotationRefundsBlocked(
      db,
      'QT-PAY-BLOCK',
      { blocked: true, reason: 'Finance correction — do not pay out' },
      mdActor
    );
    expect(block.ok).toBe(true);

    const payables = approvedRefundsAwaitingPayment(listRefunds(db));
    expect(payables.some((r) => r.refundID === 'RF-PAY-BLOCK')).toBe(false);
  });
});
