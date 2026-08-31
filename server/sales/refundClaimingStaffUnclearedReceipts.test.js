import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { payRefundEntry } from '../writeOps.js';
import {
  unclearedReceiptFloatBySalesCustomerIds,
  unclearedReceiptFloatForSalesCustomer,
} from './refundClaimingStaffUnclearedReceipts.js';
import { refundHeldNetCashDueNgn } from '../finance/partnerWalletCredit.js';

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
const CUSTOMER_ID = 'CUS-UNCLR-PAYEE';
const REFUND_ID = 'RF-UNCLR-PAYEE-1';

const prevWallet = process.env.ZAREWA_PARTNER_WALLET_V1;
const prevAssoc = process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;

describe.skipIf(!mysqlOk)('uncleared receipts on refund payees', () => {
  /** @type {ReturnType<typeof createDatabase> | null} */
  let db = null;
  let treasuryAccountId = 0;

  beforeAll(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status, bank_account_name, bank_name, bank_account_no)
       VALUES (?, 'Payee Customer', 'BR-KD', 'Active', 'Payee', 'Test Bank PLC', '0123456789')`
    ).run(CUSTOMER_ID);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES (?, ?, 'Payee Customer', 'QT-OTHER', 25_000, 'Pending clearance', '2026-05-20')`
    ).run('RC-UNCLR-PAYEE', CUSTOMER_ID);
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, payee_name, payee_account_no, payee_bank_name, branch_id,
        requested_by, requested_at_iso, approved_amount_ngn, paid_amount_ngn, payment_note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      REFUND_ID,
      CUSTOMER_ID,
      'Payee Customer',
      '',
      '["Adjustment"]',
      'Customer payout hold',
      10_000,
      'Approved',
      'Payee',
      '0123456789',
      'Test Bank PLC',
      'BR-KD',
      'Sales',
      '2026-05-21T10:00:00.000Z',
      10_000,
      0,
      'Settled at approval: company cut ₦0 → retention ledger.'
    );
    treasuryAccountId = Number(db.prepare(`SELECT id FROM treasury_accounts LIMIT 1`).get()?.id || 0);
  }, 180_000);

  beforeEach((ctx) => {
    if (!db) ctx.skip();
    db.prepare(
      `UPDATE sales_receipts
       SET status = 'Pending clearance', finance_reconciliation_saved_at_iso = NULL
       WHERE id = ?`
    ).run('RC-UNCLR-PAYEE');
    db.prepare(
      `UPDATE customer_refunds
       SET status = 'Approved', paid_amount_ngn = 0, paid_at_iso = NULL, paid_by = NULL, paid_by_user_id = NULL,
           payment_note = 'Settled at approval: company cut ₦0 → retention ledger.'
       WHERE refund_id = ?`
    ).run(REFUND_ID);
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
    if (prevWallet == null) delete process.env.ZAREWA_PARTNER_WALLET_V1;
    else process.env.ZAREWA_PARTNER_WALLET_V1 = prevWallet;
    if (prevAssoc == null) delete process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;
    else process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = prevAssoc;
  });

  it('counts pending receipts on the customer account', () => {
    const info = unclearedReceiptFloatForSalesCustomer(db, CUSTOMER_ID);
    expect(info.totalNgn).toBe(25_000);
    expect(info.receiptCount).toBe(1);
    expect(info.receiptIds).toContain('RC-UNCLR-PAYEE');
  });

  it('holds the full customer till payout while receipts are unconfirmed', () => {
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(refundHeldNetCashDueNgn(db, row, 10_000)).toBe(10_000);
  });

  it('blocks cashier payout while the payee has unconfirmed receipts', () => {
    const r = payRefundEntry(db, REFUND_ID, {
      treasuryAccountId,
      actor: { id: 'USR-CASH', displayName: 'Cashier', roleKey: 'cashier', permissions: ['finance.pay'] },
      paidBy: 'Cashier',
      dateISO: '2026-05-22',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_PAYOUT_HELD_UNCLEARED');
  });

  it('lets admin pay out as an exemption while receipts are still unconfirmed', () => {
    const r = payRefundEntry(db, REFUND_ID, {
      treasuryAccountId,
      actor: { id: 'USR-ADMIN', displayName: 'Admin', roleKey: 'admin', permissions: ['*'] },
      paidBy: 'Admin',
      dateISO: '2026-05-22',
    });
    expect(r.ok).toBe(true);
    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = ?`).get(
      REFUND_ID
    );
    expect(Number(updated.paid_amount_ngn)).toBe(10_000);
    expect(String(updated.payment_note || '')).toMatch(/Admin exemption/i);
  });

  it('clears the hold after finance confirms the receipt', () => {
    db.prepare(
      `UPDATE sales_receipts
       SET status = 'Cleared', finance_reconciliation_saved_at_iso = '2026-05-21T12:00:00.000Z'
       WHERE id = ?`
    ).run('RC-UNCLR-PAYEE');
    const map = unclearedReceiptFloatBySalesCustomerIds(db, [CUSTOMER_ID]);
    expect(map.get(CUSTOMER_ID)?.totalNgn || 0).toBe(0);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(refundHeldNetCashDueNgn(db, row, 10_000)).toBe(0);
  });
});
