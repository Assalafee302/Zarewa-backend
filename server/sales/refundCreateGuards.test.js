import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { insertRefundRequest } from '../controlOps.js';
import { saveRefundPayoutBank } from './refundPayoutBankOps.js';
import { REFUND_TEST_PAYEE } from '../refundTestPayee.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

const salesActor = { id: 'U-SALES', displayName: 'Sales', roleKey: 'sales_staff' };

describe.skipIf(!mysqlOk)('refund create / payout-bank guards', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT OR REPLACE INTO customers (customer_id, name, branch_id, status)
       VALUES ('CUS-GUARD-A', 'Quote Customer', 'BR-KD', 'Active')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, branch_id)
       VALUES ('QT-GUARD-001', 'CUS-GUARD-A', 'Quote Customer', 10000, 10000, 'Paid', 'Finished', 'BR-KD')`
    ).run();
    const staff = db.prepare(`SELECT id FROM associated_staff WHERE id = ?`).get('AST-YL-BANK');
    if (!staff) {
      db.prepare(
        `INSERT INTO associated_staff (id, name, branch_id, status, staff_type)
         VALUES ('AST-YL-BANK', 'Yola Driver', 'BR-YL', 'Active', 'Driver')`
      ).run();
    }
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('rejects a refund with no quotation', () => {
    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-GUARD-A',
        reasonCategory: 'Overpayment',
        reason: 'No quote',
        amountNgn: 5000,
        calculationLines: [{ label: 'Overpayment', amountNgn: 5000, category: 'Overpayment' }],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_QUOTATION_REQUIRED');
  });

  it('rejects a refund customer that is not the quotation customer', () => {
    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-OTHER',
        quotationRef: 'QT-GUARD-001',
        reasonCategory: 'Overpayment',
        reason: 'Wrong customer',
        amountNgn: 5000,
        calculationLines: [{ label: 'Overpayment', amountNgn: 5000, category: 'Overpayment' }],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_CUSTOMER_MISMATCH');
  });

  it('refuses to overwrite an associated-staff bank from another branch', () => {
    const r = saveRefundPayoutBank(db, {
      kind: 'associated_staff',
      id: 'AST-YL-BANK',
      bankAccountName: 'Diverted',
      bankName: 'GTB',
      bankAccountNo: '0987654321',
      branchId: 'BR-KD',
    });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/branch/i);
  });
});
