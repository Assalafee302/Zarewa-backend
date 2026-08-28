/**
 * Company cut must settle on approval even when partner-wallet credits are off,
 * so cashier outstanding is net (not gross).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { creditRefundToPartnerWalletTx } from './partnerWalletCredit.js';

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

describe.skipIf(!mysqlOk)('company cut settles without partner wallet', () => {
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
        'AST-CUT-1', 'Driver Cut', 'BR-KD', 'Active', 'Driver',
        'Driver Payee', 'Test Bank', '1111222233'
      );
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (
        'RF-CUT-WALLET-OFF', 'CUS-QUOTE', 'Quote Customer', 'QT-CUT-1',
        '["Transport issue"]', 'Staff cut test',
        10000, '[]',
        '[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"AST-CUT-1","amountNgn":10000,"note":"Transport"}]',
        'Approved',
        'Driver Payee', '1111222233', 'Test Bank', 'BR-KD', 'Sales', '2026-03-29T10:00:00.000Z',
        10000, 0
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

  it('reduces paid_amount by 20% company cut and skips wallet rows', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get('RF-CUT-WALLET-OFF');
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 10_000,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(r.skippedWallet).toBe(true);
    expect(r.companyRetentionNgn).toBe(2_000);
    expect(r.settledAtApprovalNgn).toBe(2_000);
    expect(r.credits || []).toHaveLength(0);

    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note, status FROM customer_refunds WHERE refund_id = ?`).get(
      'RF-CUT-WALLET-OFF'
    );
    expect(Number(updated.paid_amount_ngn)).toBe(2_000);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    // Outstanding for cashier = 10000 - 2000 = 8000 (net)
    expect(10_000 - Number(updated.paid_amount_ngn)).toBe(8_000);

    const walletRows = db
      .prepare(`SELECT COUNT(*) AS c FROM partner_wallet_entries WHERE refund_id = ?`)
      .get('RF-CUT-WALLET-OFF');
    expect(Number(walletRows?.c || 0)).toBe(0);
  });

  it('backfills paid_amount when wallet credits exist but company cut was not settled', () => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '1';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    const refundId = 'RF-CUT-WALLET-BACKFILL';
    db.exec(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (
        '${refundId}', 'CUS-QUOTE', 'Quote Customer', 'QT-CUT-2',
        '["Transport issue"]', 'Staff cut backfill',
        10000, '[]',
        '[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"AST-CUT-1","amountNgn":10000,"note":"Transport"}]',
        'Approved',
        'Driver Payee', '1111222233', 'Test Bank', 'BR-KD', 'Sales', '2026-03-29T10:00:00.000Z',
        10000, 0
      );
      INSERT INTO partner_wallet_entries (
        id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
        source_kind, source_id, refund_id, branch_id,
        payee_name, payee_bank_name, payee_account_no, note, created_at_iso
      ) VALUES (
        'PWL-BF-1', 'associated_staff', 'AST-CUT-1', 'Driver Cut', 'credit', 8000, 8000,
        'REFUND', '${refundId}', '${refundId}', 'BR-KD',
        'Driver Payee', 'Test Bank', '1111222233', 'net after 20% company cut', '2026-03-29T11:00:00.000Z'
      );
    `);
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 10_000,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(r.backfilledSettlement).toBe(true);
    expect(r.companyRetentionNgn).toBe(2_000);

    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = ?`).get(
      refundId
    );
    expect(Number(updated.paid_amount_ngn)).toBe(2_000);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    expect(10_000 - Number(updated.paid_amount_ngn)).toBe(8_000);
  });
});
