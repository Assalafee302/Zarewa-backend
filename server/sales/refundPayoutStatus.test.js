/**
 * Refund Paid status requires treasury or wallet payout — not approval settlement alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe.skipIf(!mysqlOk)('refund payout status', () => {
  let db;

  beforeEach(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id, status)
      VALUES ('CUS-QUOTE', 'Quote Customer', 'BR-KD', 'Active');
      INSERT INTO associated_staff (
        id, name, branch_id, status, staff_type, bank_account_name, bank_name, bank_account_no
      ) VALUES (
        'AST-9553', 'Muhammad Ibrahim Bakari', 'BR-KD', 'Active', 'Agent',
        'Muhammad Ibrahim Bakari', 'First Bank', '3064987728'
      );
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (
        '${REFUND_ID}', 'CUS-QUOTE', 'Bashir Shehu', 'QT-KD-26-1342',
        '["Overpayment"]', 'Overpayment',
        61200, '[]',
        '[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"AST-9553","amountNgn":61200,"companyDeductionNgn":12240,"netPayoutNgn":48960,"note":"Overpayment · quote customer"}]',
        'Approved',
        'Muhammad Ibrahim Bakari', '3064987728', 'First Bank', 'BR-KD', 'Sales', '2026-08-28T10:00:00.000Z',
        61200, 0
      );
    `);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
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

  it('repairs wrongly Paid refunds with no treasury trace', () => {
    db.prepare(
      `UPDATE customer_refunds SET status = 'Paid', paid_amount_ngn = 61200, payment_note = ? WHERE refund_id = ?`
    ).run(
      'Settled at approval: company cut ₦12,240 → retention ledger; uncleared receipts offset ₦48,960.',
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
      'TM-RF-PARTIAL-1',
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
      'TM-RF-FULL-1',
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
