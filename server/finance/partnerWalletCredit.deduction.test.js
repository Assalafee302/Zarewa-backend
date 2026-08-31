/**
 * Company cut must settle on approval even when partner-wallet credits are off,
 * so cashier outstanding is net (not gross).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { creditRefundToPartnerWalletTx, backfillMissingRefundCompanyRetentionCredits } from './partnerWalletCredit.js';

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
const CUSTOMER_ID = 'CUS-RF-CUT-WALLET';
const STAFF_ID = 'AST-RF-CUT-1';
const REFUND_WALLET_OFF = 'RF-CUT-WALLET-OFF';
const REFUND_BACKFILL = 'RF-CUT-WALLET-BACKFILL';
const REFUND_NOTE_BF = 'RF-CUT-NOTE-BF';
const FIXTURE_REFUND_IDS = [REFUND_WALLET_OFF, REFUND_BACKFILL, REFUND_NOTE_BF];

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
      ) VALUES (?, 'Driver Cut', 'BR-KD', 'Active', 'Driver', ?, 'Test Bank', '1111222233')`
    ).run(STAFF_ID, 'Driver Payee');
  }
}

function seedBaseRefund(db) {
  ensureCustomerStaff(db);
  db.prepare(
    `INSERT INTO customer_refunds (
      refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
      amount_ngn, calculation_lines_json, split_distributions_json, status,
      payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
      approved_amount_ngn, paid_amount_ngn
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    REFUND_WALLET_OFF,
    CUSTOMER_ID,
    'Quote Customer',
    'QT-CUT-1',
    '["Transport issue"]',
    'Staff cut test',
    10_000,
    '[]',
    `[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"${STAFF_ID}","amountNgn":10000,"note":"Transport"}]`,
    'Approved',
    'Driver Payee',
    '1111222233',
    'Test Bank',
    'BR-KD',
    'Sales',
    '2026-03-29T10:00:00.000Z',
    10_000,
    0
  );
}

function resetCutWalletState(db) {
  db.prepare(`DELETE FROM partner_wallet_entries WHERE id LIKE 'PWL-BF-%'`).run();
  for (const refundId of FIXTURE_REFUND_IDS) {
    db.prepare(`DELETE FROM partner_wallet_entries WHERE refund_id = ?`).run(refundId);
    db.prepare(`DELETE FROM refund_company_retention_entries WHERE refund_id = ?`).run(refundId);
    db.prepare(`DELETE FROM customer_refunds WHERE refund_id = ?`).run(refundId);
  }
  seedBaseRefund(db);
}

describe.skipIf(!mysqlOk)('company cut settles without partner wallet', () => {
  /** @type {ReturnType<typeof createDatabase> | null} */
  let db = null;

  beforeAll(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    db = createDatabase(':memory:');
  }, 300_000);

  beforeEach((ctx) => {
    if (!db) ctx.skip();
    process.env.ZAREWA_PARTNER_WALLET_V1 = '0';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '0';
    resetCutWalletState(db);
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

  it('reduces paid_amount by 20% company cut and skips wallet rows', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_WALLET_OFF);
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
      REFUND_WALLET_OFF
    );
    expect(Number(updated.paid_amount_ngn)).toBe(2_000);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    expect(String(updated.status || '')).toBe('Approved');
    // Outstanding for cashier = 10000 - 2000 = 8000 (net)
    expect(10_000 - Number(updated.paid_amount_ngn)).toBe(8_000);

    const walletRows = db
      .prepare(`SELECT COUNT(*) AS c FROM partner_wallet_entries WHERE refund_id = ?`)
      .get(REFUND_WALLET_OFF);
    expect(Number(walletRows?.c || 0)).toBe(0);

    const retention = db
      .prepare(
        `SELECT amount_ngn, open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`
      )
      .get(REFUND_WALLET_OFF);
    expect(Number(retention?.amount_ngn)).toBe(2_000);
    expect(Number(retention?.open_ngn)).toBe(2_000);
  });

  it('backfills paid_amount when wallet credits exist but company cut was not settled', () => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '1';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      REFUND_BACKFILL,
      CUSTOMER_ID,
      'Quote Customer',
      'QT-CUT-2',
      '["Transport issue"]',
      'Staff cut backfill',
      10_000,
      '[]',
      `[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"${STAFF_ID}","amountNgn":10000,"note":"Transport"}]`,
      'Approved',
      'Driver Payee',
      '1111222233',
      'Test Bank',
      'BR-KD',
      'Sales',
      '2026-03-29T10:00:00.000Z',
      10_000,
      0
    );
    db.prepare(
      `INSERT INTO partner_wallet_entries (
        id, party_kind, party_id, party_name, entry_type, amount_ngn, open_ngn,
        source_kind, source_id, refund_id, branch_id,
        payee_name, payee_bank_name, payee_account_no, note, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'PWL-BF-1',
      'associated_staff',
      STAFF_ID,
      'Driver Cut',
      'credit',
      8000,
      8000,
      'REFUND',
      REFUND_BACKFILL,
      REFUND_BACKFILL,
      'BR-KD',
      'Driver Payee',
      'Test Bank',
      '1111222233',
      'net after 20% company cut',
      '2026-03-29T11:00:00.000Z'
    );
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_BACKFILL);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 10_000,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(r.backfilledSettlement).toBe(true);
    expect(r.companyRetentionNgn).toBe(2_000);

    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = ?`).get(
      REFUND_BACKFILL
    );
    expect(Number(updated.paid_amount_ngn)).toBe(2_000);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    expect(10_000 - Number(updated.paid_amount_ngn)).toBe(8_000);

    const retention = db
      .prepare(
        `SELECT amount_ngn, open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`
      )
      .get(REFUND_BACKFILL);
    expect(Number(retention?.amount_ngn)).toBe(2_000);
  });

  it('backfills retention from payment note when ledger row was missing at approval', () => {
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn, payment_note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      REFUND_NOTE_BF,
      CUSTOMER_ID,
      'Quote Customer',
      'QT-CUT-3',
      '["Overpayment"]',
      'Note-only backfill',
      89_300,
      '[]',
      '[]',
      'Approved',
      'Payee',
      '1111222233',
      'Test Bank',
      'BR-KD',
      'Sales',
      '2026-03-29T10:00:00.000Z',
      89_300,
      14_300,
      'Settled at approval: company cut ₦2,860 → retention ledger; uncleared receipts offset ₦11,440.'
    );
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const bf = backfillMissingRefundCompanyRetentionCredits(db, 'ALL', {
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(bf.backfilled).toBeGreaterThanOrEqual(1);
    const retention = db
      .prepare(
        `SELECT amount_ngn, open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`
      )
      .get(REFUND_NOTE_BF);
    expect(Number(retention?.amount_ngn)).toBe(2_860);
    expect(Number(retention?.open_ngn)).toBe(2_860);
  });
});
