import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { saveRefundPayoutBank } from './refundPayoutBankOps.js';

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

describe.skipIf(!mysqlOk)('saveRefundPayoutBank', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const existing = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-BANK-INLINE');
    if (!existing) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status)
         VALUES ('CUS-BANK-INLINE', 'Inline Bank Customer', 'BR-KD', 'Active')`
      ).run();
    }
    const staff = db.prepare(`SELECT id FROM associated_staff WHERE id = ?`).get('AST-BANK-INLINE');
    if (!staff) {
      db.prepare(
        `INSERT INTO associated_staff (id, name, branch_id, status, staff_type)
         VALUES ('AST-BANK-INLINE', 'Inline Driver', 'BR-KD', 'Active', 'Driver')`
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

  it('saves customer bank for refund payout', () => {
    const r = saveRefundPayoutBank(db, {
      kind: 'customer',
      id: 'CUS-BANK-INLINE',
      bankAccountName: 'Inline Payee',
      bankName: 'Zenith Bank',
      bankAccountNo: '1234567890',
      branchId: 'BR-KD',
    });
    expect(r.ok).toBe(true);
    const row = db
      .prepare(`SELECT bank_account_name, bank_name, bank_account_no FROM customers WHERE customer_id = ?`)
      .get('CUS-BANK-INLINE');
    expect(row.bank_name).toBe('Zenith Bank');
    expect(row.bank_account_no).toBe('1234567890');
  });

  it('saves associated staff bank for refund payout', () => {
    const r = saveRefundPayoutBank(db, {
      kind: 'associated_staff',
      id: 'AST-BANK-INLINE',
      bankAccountName: 'Driver Payee',
      bankName: 'GTB',
      bankAccountNo: '0987654321',
    });
    expect(r.ok).toBe(true);
    const row = db
      .prepare(`SELECT bank_account_name, bank_name, bank_account_no FROM associated_staff WHERE id = ?`)
      .get('AST-BANK-INLINE');
    expect(row.bank_name).toBe('GTB');
    expect(row.bank_account_no).toBe('0987654321');
  });
});
