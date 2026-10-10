import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { insertRefundRequest } from '../controlOps.js';
import { customerOpenCreditNgn } from './refundPayeeControl.js';
import { saveRefundPayoutBank } from './refundPayoutBankOps.js';
import { REFUND_TEST_PAYEE, ensureRefundTestCustomerBanks } from '../refundTestPayee.js';

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

  it('allows overpayment refund when cash excess exists but OVERPAY_ADVANCE ledger is missing', () => {
    // QT-KD-26-1750 shape: full till RECEIPT, cleared, no OVERPAY_ADVANCE sibling → ledger open credit 0.
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 1, unitPrice: 716950 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO customers (customer_id, name, branch_id, status)
       VALUES ('CUS-OP-RES', 'Overpay Residual Customer', 'BR-KD', 'Active')`
    ).run();
    ensureRefundTestCustomerBanks(db, ['CUS-OP-RES']);
    db.prepare(
      `INSERT OR REPLACE INTO quotations (
         id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id, date_iso
       ) VALUES (
         'QT-OP-RES', 'CUS-OP-RES', 'Overpay Residual Customer', 716950, 1200000, 'Paid', 'Finished', ?, 'BR-KD', '2026-10-07'
       )`
    ).run(lines);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (
         id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso,
         ledger_entry_id, branch_id, bank_received_amount_ngn, finance_reconciliation_saved_at_iso
       ) VALUES (
         'LE-OP-RES', 'CUS-OP-RES', 'Overpay Residual Customer', 'QT-OP-RES', 1200000, '₦1,200,000', 'Cleared',
         '2026-10-07', 'LE-OP-RES', 'BR-KD', 1200000, '2026-10-07T12:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO ledger_entries (
         id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id
       ) VALUES (
         'LE-OP-RES', 'RECEIPT', 'CUS-OP-RES', 'Overpay Residual Customer', 'QT-OP-RES', 1200000,
         '2026-10-07T12:00:00.000Z', 'BR-KD'
       )`
    ).run();

    expect(customerOpenCreditNgn(db, 'CUS-OP-RES', 'BR-KD')).toBe(0);

    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-OP-RES',
        quotationRef: 'QT-OP-RES',
        reasonCategory: 'Overpayment',
        reason: 'Cash above quote',
        amountNgn: 483_050,
        calculationLines: [
          { label: 'Overpayment', amountNgn: 483_050, category: 'Overpayment', include: true },
        ],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(true);
    expect(r.code).not.toBe('REFUND_EXCEEDS_OPEN_CREDIT');
  });

  it('allows overpay + unproduced above open credit without MD (BM screens; cash hard-cap holds)', () => {
    // Abdullahi / QT-KD-26-1753 shape: cash 147k, quote 127.75k → open credit 19.25k; refund 37.5k.
    const lines = JSON.stringify({
      products: [{ name: 'Flat sheet', qty: 35, unitPrice: 3650 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO customers (customer_id, name, branch_id, status)
       VALUES ('CUS-OP-UNPR', 'Abdullahi Shape', 'BR-KD', 'Active')`
    ).run();
    ensureRefundTestCustomerBanks(db, ['CUS-OP-UNPR']);
    db.prepare(
      `INSERT OR REPLACE INTO quotations (
         id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id, date_iso
       ) VALUES (
         'QT-OP-UNPR', 'CUS-OP-UNPR', 'Abdullahi Shape', 127750, 147000, 'Paid', 'Finished', ?, 'BR-KD', '2026-10-07'
       )`
    ).run(lines);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (
         id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso,
         ledger_entry_id, branch_id, bank_received_amount_ngn, finance_reconciliation_saved_at_iso
       ) VALUES (
         'LE-OP-UNPR', 'CUS-OP-UNPR', 'Abdullahi Shape', 'QT-OP-UNPR', 147000, '₦147,000', 'Cleared',
         '2026-10-07', 'LE-OP-UNPR', 'BR-KD', 147000, '2026-10-07T12:00:00.000Z'
       )`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO ledger_entries (
         id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id
       ) VALUES (
         'LE-OP-UNPR', 'RECEIPT', 'CUS-OP-UNPR', 'Abdullahi Shape', 'QT-OP-UNPR', 147000,
         '2026-10-07T12:00:00.000Z', 'BR-KD'
       )`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (
         job_id, quotation_ref, customer_id, customer_name, planned_meters, actual_meters, status,
         completed_at_iso, branch_id, production_date_iso
       ) VALUES (
         'PRO-OP-UNPR', 'QT-OP-UNPR', 'CUS-OP-UNPR', 'Abdullahi Shape', 30, 30, 'Completed',
         '2026-10-07T12:00:00.000Z', 'BR-KD', '2026-10-07'
       )`
    ).run();

    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-OP-UNPR',
        quotationRef: 'QT-OP-UNPR',
        reasonCategory: ['Overpayment', 'Unproduced meterage'],
        reason: 'Overpay + unproduced metres',
        amountNgn: 37_500,
        calculationLines: [
          { label: 'Overpayment', amountNgn: 19_250, category: 'Overpayment', include: true },
          {
            label: 'Unproduced metres (5.00m @ ₦3,650)',
            amountNgn: 18_250,
            category: 'Unproduced meterage',
            include: true,
          },
        ],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.code).not.toBe('REFUND_EXCEEDS_OPEN_CREDIT');
    expect(r.ok).toBe(true);
  });
});
