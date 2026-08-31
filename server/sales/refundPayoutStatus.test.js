/**
 * Refund Paid status requires treasury or wallet payout — not approval settlement alone.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { creditRefundToPartnerWalletTx } from '../finance/partnerWalletCredit.js';
import {
  repairRefundPayoutStateTx,
  resolveRefundStatus,
  refundCashOutstandingNgn,
} from './refundPayoutStatus.js';

const prevWallet = process.env.ZAREWA_PARTNER_WALLET_V1;
const prevAssoc = process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;

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
const REFUND_ID = 'RF-STATUS-STAFF-1';
const CUSTOMER_ID = 'CUS-RF-PAYOUT-STATUS';
const STAFF_ID = 'AST-RF-PAYOUT-9553';

function ensureCustomerStaff(db) {
  const customer = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get(CUSTOMER_ID);
  if (!customer) {
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status)
       VALUES (?, 'Quote Customer', 'BR-KD', 'Active')`
    ).run(CUSTOMER_ID);
  }
  const staff = db.prepare(`SELECT id FROM associated_staff WHERE id = ?`).get(STAFF_ID);
  if (!staff) {
    db.prepare(
      `INSERT INTO associated_staff (
        id, name, branch_id, status, staff_type, bank_account_name, bank_name, bank_account_no
      ) VALUES (?, 'Muhammad Ibrahim Bakari', 'BR-KD', 'Active', 'Agent', ?, 'First Bank', '3064987728')`
    ).run(STAFF_ID, 'Muhammad Ibrahim Bakari');
  }
}

function seedRefundPayoutFixture(db) {
  ensureCustomerStaff(db);
  db.prepare(
    `INSERT INTO customer_refunds (
      refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
      amount_ngn, calculation_lines_json, split_distributions_json, status,
      payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
      approved_amount_ngn, paid_amount_ngn
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    REFUND_ID,
    CUSTOMER_ID,
    'Bashir Shehu',
    'QT-KD-26-1342',
    '["Overpayment"]',
    'Overpayment',
    61_200,
    '[]',
    '[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"AST-RF-PAYOUT-9553","amountNgn":61200,"companyDeductionNgn":12240,"netPayoutNgn":48960,"note":"Overpayment · quote customer"}]',
    'Approved',
    'Muhammad Ibrahim Bakari',
    '3064987728',
    'First Bank',
    'BR-KD',
    'Sales',
    '2026-08-28T10:00:00.000Z',
    61_200,
    0
  );
}

function resetRefundPayoutState(db) {
  db.prepare(
    `DELETE FROM treasury_movements WHERE source_id = ? OR id LIKE 'TM-RF-STATUS-%'`
  ).run(REFUND_ID);
  db.prepare(`DELETE FROM refund_company_retention_entries WHERE refund_id = ?`).run(REFUND_ID);
  db.prepare(`DELETE FROM partner_wallet_entries WHERE refund_id = ?`).run(REFUND_ID);
  db.prepare(`DELETE FROM customer_refunds WHERE refund_id = ?`).run(REFUND_ID);
  seedRefundPayoutFixture(db);
}

describe.skipIf(!mysqlOk)('refund payout status', () => {
  /** @type {ReturnType<typeof createDatabase> | null} */
  let db = null;

  beforeAll(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    db = createDatabase(':memory:');
  }, 300_000);

  beforeEach((ctx) => {
    if (!db) ctx.skip();
    resetRefundPayoutState(db);
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

  it('does not mark Paid at approval when staff net cash is still due', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 61_200,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(r.settledAtApprovalNgn).toBe(12_240);

    const updated = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(Number(updated.paid_amount_ngn)).toBe(12_240);
    expect(String(updated.status)).toBe('Approved');
    expect(resolveRefundStatus(db, updated)).toBe('Approved');
    expect(refundCashOutstandingNgn(db, updated)).toBe(48_960);
  });

  it('repairs wrongly Paid refunds with legacy uncleared offset in payment note', () => {
    db.prepare(
      `UPDATE customer_refunds SET status = 'Paid', paid_amount_ngn = 61200, payment_note = ?, split_distributions_json = ? WHERE refund_id = ?`
    ).run(
      'Settled at approval: company cut ₦12,240 → retention ledger; uncleared receipts offset ₦48,960.',
      '[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"AST-RF-PAYOUT-9553","amountNgn":61200,"companyDeductionNgn":12240,"netPayoutNgn":0,"unclearedReceiptHoldNgn":48960,"unclearedReceiptOffsetNgn":48960,"payoutHeldForUnclearedReceipts":true}]',
      REFUND_ID
    );
    const before = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(String(before.status)).toBe('Paid');

    const repair = repairRefundPayoutStateTx(db, REFUND_ID);
    expect(repair.ok).toBe(true);
    expect(repair.changed).toBe(true);
    expect(repair.toStatus).toBe('Approved');
    expect(repair.toPaidAmountNgn).toBe(12_240);

    const after = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, after)).toBe('Approved');
    expect(refundCashOutstandingNgn(db, after)).toBe(48_960);
  });

  it('marks Partially paid when treasury paid some but not all net cash due', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 61_200,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    const acct = db.prepare(`SELECT id FROM treasury_accounts LIMIT 1`).get();
    expect(acct?.id).toBeTruthy();
    db.prepare(
      `INSERT INTO treasury_movements (
        id, posted_at_iso, type, treasury_account_id, amount_ngn,
        source_kind, source_id, note, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      'TM-RF-STATUS-PARTIAL-1',
      '2026-08-29T12:00:00.000Z',
      'REFUND_PAYOUT',
      acct.id,
      20_000,
      'REFUND',
      REFUND_ID,
      'Partial staff payout',
      'Finance'
    );
    db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = 32240 WHERE refund_id = ?`).run(REFUND_ID);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, row)).toBe('Partially paid');
    expect(refundCashOutstandingNgn(db, row)).toBe(28_960);
  });

  it('marks Paid when treasury covers full net cash due without wallet', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 61_200,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    const acct = db.prepare(`SELECT id FROM treasury_accounts LIMIT 1`).get();
    db.prepare(
      `INSERT INTO treasury_movements (
        id, posted_at_iso, type, treasury_account_id, amount_ngn,
        source_kind, source_id, note, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      'TM-RF-STATUS-FULL-1',
      '2026-08-29T12:00:00.000Z',
      'REFUND_PAYOUT',
      acct.id,
      48_960,
      'REFUND',
      REFUND_ID,
      'Full staff payout',
      'Finance'
    );
    db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = 61200 WHERE refund_id = ?`).run(REFUND_ID);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, row)).toBe('Paid');
    expect(refundCashOutstandingNgn(db, row)).toBe(0);
  });
});
