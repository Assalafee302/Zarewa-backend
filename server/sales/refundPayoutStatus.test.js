/**
 * Refund Paid status requires treasury or wallet payout — not approval settlement alone.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { creditRefundToPartnerWalletTx } from '../finance/partnerWalletCredit.js';
import { payRefundEntry } from '../writeOps.js';
import {
  repairRefundPayoutStateTx,
  resolveRefundStatus,
  refundCashOutstandingNgn,
  refundMoneyOutWithinApproved,
  buildRefundSettlementSummary,
  refundHasPayeeMoneyOut,
} from './refundPayoutStatus.js';
import { cancelApprovedRefundBeforePay } from '../controlOps.js';

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
    expect(r.settledAtApprovalNgn).toBe(1_836);

    const updated = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    // Company cut must not inflate paid_amount — retention ledger only.
    expect(Number(updated.paid_amount_ngn)).toBe(0);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    expect(String(updated.status)).toBe('Approved');
    expect(resolveRefundStatus(db, updated)).toBe('Approved');
    expect(refundCashOutstandingNgn(db, updated)).toBe(59_364);
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
    // paid_amount strips company cut — nothing left to payees yet.
    expect(repair.toPaidAmountNgn).toBe(0);

    const after = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, after)).toBe('Approved');
    expect(refundCashOutstandingNgn(db, after)).toBe(59_364);
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
    // Payee-only paid_amount (treasury). Company cut stays off paid_amount.
    db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = 20000 WHERE refund_id = ?`).run(REFUND_ID);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, row)).toBe('Partially paid');
    expect(refundCashOutstandingNgn(db, row)).toBe(39_364);
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
      59_364,
      'REFUND',
      REFUND_ID,
      'Full staff payout',
      'Finance'
    );
    db.prepare(`UPDATE customer_refunds SET paid_amount_ngn = 59364 WHERE refund_id = ?`).run(REFUND_ID);
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(resolveRefundStatus(db, row)).toBe('Paid');
    expect(refundCashOutstandingNgn(db, row)).toBe(0);
  });

  it('refuses a second till slice larger than remaining approved net', () => {
    const OVERPAY_ID = 'RF-MONEY-OUT-1';
    db.prepare(`DELETE FROM treasury_movements WHERE source_id = ?`).run(OVERPAY_ID);
    db.prepare(`DELETE FROM customer_refunds WHERE refund_id = ?`).run(OVERPAY_ID);
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      OVERPAY_ID,
      CUSTOMER_ID,
      'Quote Customer',
      '',
      '["Order cancellation"]',
      'Customer till overpay guard',
      10_000,
      '[]',
      `[{"recipientKind":"customer","recipientCustomerID":"${CUSTOMER_ID}","amountNgn":10000,"note":"To customer"}]`,
      'Approved',
      'Quote Customer',
      '1111222233',
      'Test Bank',
      'BR-KD',
      'Sales',
      '2026-03-29T10:00:00.000Z',
      10_000,
      0
    );
    const acct = db.prepare(`SELECT id FROM treasury_accounts LIMIT 1`).get();
    const cashier = db
      .prepare(
        `SELECT id, username, role_key AS roleKey, display_name AS displayName
         FROM app_users WHERE username = 'cashier' LIMIT 1`
      )
      .get();
    expect(acct?.id).toBeTruthy();
    expect(cashier?.id).toBeTruthy();
    const actor = {
      id: cashier.id,
      displayName: cashier.displayName,
      roleKey: 'cashier',
    };
    const first = payRefundEntry(db, OVERPAY_ID, {
      paymentLines: [{ treasuryAccountId: acct.id, amountNgn: 6_000, dateISO: '2026-03-29' }],
      actor,
      paidBy: 'Cashier',
      dateISO: '2026-03-29',
    });
    expect(first.ok).toBe(true);
    const afterFirst = db.prepare(`SELECT paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(OVERPAY_ID);
    expect(Number(afterFirst.paid_amount_ngn)).toBe(6_000);

    const second = payRefundEntry(db, OVERPAY_ID, {
      paymentLines: [{ treasuryAccountId: acct.id, amountNgn: 5_000, dateISO: '2026-03-29' }],
      actor,
      paidBy: 'Cashier',
      dateISO: '2026-03-29',
    });
    expect(second.ok).toBe(false);
    expect(String(second.error || '')).toMatch(/exceeds the approved refund balance|money out exceeds/i);
    const afterSecond = db.prepare(`SELECT paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(OVERPAY_ID);
    expect(Number(afterSecond.paid_amount_ngn)).toBe(6_000);
  });

  it('allows cancel after company cut when no payee money has left', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    const actor = db.prepare(`SELECT id, display_name AS displayName, role_key AS roleKey FROM app_users LIMIT 1`).get();
    const credit = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 61_200,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(credit.ok).toBe(true);
    expect(credit.companyRetentionNgn).toBe(1_836);

    const afterCut = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(Number(afterCut.paid_amount_ngn)).toBe(0);
    expect(refundHasPayeeMoneyOut(db, afterCut)).toBe(false);

    const summary = buildRefundSettlementSummary(db, afterCut);
    expect(summary.companyCutNgn).toBe(1_836);
    expect(summary.cashOutstandingNgn).toBe(59_364);
    expect(summary.canCancelBeforePay).toBe(true);
    expect(summary.publicLabel).toMatch(/Ready|Approved/i);

    const cancelled = cancelApprovedRefundBeforePay(
      db,
      REFUND_ID,
      { note: 'Wrong payee — cancel before cash out' },
      { id: actor?.id, displayName: actor?.displayName, roleKey: actor?.roleKey }
    );
    expect(cancelled.ok).toBe(true);
    const row = db.prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
    expect(String(row.status)).toBe('Cancelled');
    expect(Number(row.paid_amount_ngn)).toBe(0);
    const retention = db
      .prepare(`SELECT open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`)
      .get(REFUND_ID);
    expect(Number(retention?.open_ngn ?? 0)).toBe(0);
  });
});

describe('refundMoneyOutWithinApproved', () => {
  it('allows till + company cut + credit up to approved', () => {
    expect(
      refundMoneyOutWithinApproved({
        approvedNgn: 10_000,
        treasuryPaidNgn: 8_000,
        companyCutSettledNgn: 2_000,
      })
    ).toBe(true);
  });

  it('rejects a second till slice that exceeds approved plus ₦1', () => {
    expect(
      refundMoneyOutWithinApproved({
        approvedNgn: 10_000,
        treasuryPaidNgn: 8_002,
        companyCutSettledNgn: 2_000,
      })
    ).toBe(false);
  });

  it('allows ₦1 rounding tolerance', () => {
    expect(
      refundMoneyOutWithinApproved({
        approvedNgn: 10_000,
        treasuryPaidNgn: 8_001,
        companyCutSettledNgn: 2_000,
      })
    ).toBe(true);
  });
});
