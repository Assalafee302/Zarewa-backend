/**
 * Company cut must settle on approval even when partner-wallet credits are off,
 * so cashier outstanding is net (not gross).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { decideRefundRequest } from '../controlOps.js';
import { creditRefundToPartnerWalletTx, backfillMissingRefundCompanyRetentionCredits, assertCompanyRetentionPostedForCut } from './partnerWalletCredit.js';

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
const REFUND_DECIDE_FAIL = 'RF-CUT-DECIDE-FAIL';
const REFUND_CUSTOMER_ONLY = 'RF-CUT-CUSTOMER-ONLY';
const FIXTURE_REFUND_IDS = [
  REFUND_WALLET_OFF,
  REFUND_BACKFILL,
  REFUND_NOTE_BF,
  REFUND_DECIDE_FAIL,
  REFUND_CUSTOMER_ONLY,
];

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

  it('settles company cut on retention ledger without inflating paid_amount', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_WALLET_OFF);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 10_000,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(r.skippedWallet).toBe(true);
    expect(r.companyRetentionNgn).toBe(300);
    expect(r.settledAtApprovalNgn).toBe(300);
    expect(r.credits || []).toHaveLength(0);

    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note, status FROM customer_refunds WHERE refund_id = ?`).get(
      REFUND_WALLET_OFF
    );
    expect(Number(updated.paid_amount_ngn)).toBe(0);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);
    expect(String(updated.status || '')).toBe('Approved');

    const walletRows = db
      .prepare(`SELECT COUNT(*) AS c FROM partner_wallet_entries WHERE refund_id = ?`)
      .get(REFUND_WALLET_OFF);
    expect(Number(walletRows?.c || 0)).toBe(0);

    const retention = db
      .prepare(
        `SELECT amount_ngn, open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`
      )
      .get(REFUND_WALLET_OFF);
    expect(Number(retention?.amount_ngn)).toBe(300);
    expect(Number(retention?.open_ngn)).toBe(300);
  });

  it('backfills company cut note when wallet credits exist but retention was not settled', () => {
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
      'net after 3% company cut',
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
    expect(r.companyRetentionNgn).toBe(300);

    const updated = db.prepare(`SELECT paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = ?`).get(
      REFUND_BACKFILL
    );
    expect(Number(updated.paid_amount_ngn)).toBe(0);
    expect(String(updated.payment_note || '')).toMatch(/Settled at approval/i);

    const retention = db
      .prepare(
        `SELECT amount_ngn, open_ngn FROM refund_company_retention_entries WHERE refund_id = ?`
      )
      .get(REFUND_BACKFILL);
    expect(Number(retention?.amount_ngn)).toBe(300);
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

  it('fails closed when retention tables are missing and does not bump paid_amount', () => {
    expect(assertCompanyRetentionPostedForCut({ ok: true, skipped: true, reason: 'tables_missing' }, 2_000).ok).toBe(
      false
    );
    expect(assertCompanyRetentionPostedForCut({ ok: true, skipped: true, reason: 'already_credited' }, 2_000).ok).toBe(
      true
    );
    expect(assertCompanyRetentionPostedForCut({ ok: true }, 0).ok).toBe(true);

    db.prepare(`RENAME TABLE refund_company_retention_entries TO refund_company_retention_entries_p0bak`).run();
    try {
      const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_WALLET_OFF);
      const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
      const r = creditRefundToPartnerWalletTx(db, refundRow, {
        approvedAmountNgn: 10_000,
        actor: { id: actor?.id, displayName: actor?.displayName },
      });
      expect(r.ok).toBe(false);
      expect(String(r.error || '')).toMatch(/retention ledger is not ready/i);
      const updated = db
        .prepare(`SELECT paid_amount_ngn, status FROM customer_refunds WHERE refund_id = ?`)
        .get(REFUND_WALLET_OFF);
      expect(Number(updated.paid_amount_ngn)).toBe(0);
      expect(String(updated.status || '')).toBe('Approved');
    } finally {
      db.prepare(`RENAME TABLE refund_company_retention_entries_p0bak TO refund_company_retention_entries`).run();
    }
  });

  it('customer-only splits succeed with no retention row', () => {
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn, paid_amount_ngn
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      REFUND_CUSTOMER_ONLY,
      CUSTOMER_ID,
      'Quote Customer',
      'QT-CUT-CUS',
      '["Order cancellation"]',
      'Customer-only payout',
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
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_CUSTOMER_ONLY);
    const actor = db.prepare(`SELECT id, display_name AS displayName FROM app_users LIMIT 1`).get();
    const r = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 10_000,
      actor: { id: actor?.id, displayName: actor?.displayName },
    });
    expect(r.ok).toBe(true);
    expect(Number(r.companyRetentionNgn || 0)).toBe(0);
    const retention = db
      .prepare(`SELECT COUNT(*) AS c FROM refund_company_retention_entries WHERE refund_id = ?`)
      .get(REFUND_CUSTOMER_ONLY);
    expect(Number(retention?.c || 0)).toBe(0);
    const updated = db
      .prepare(`SELECT paid_amount_ngn, status FROM customer_refunds WHERE refund_id = ?`)
      .get(REFUND_CUSTOMER_ONLY);
    expect(Number(updated.paid_amount_ngn)).toBe(0);
    expect(String(updated.status || '')).toBe('Approved');
  });

  it('rolls decideRefundRequest back to Pending when retention cannot post', () => {
    const sales = db
      .prepare(
        `SELECT id FROM app_users WHERE username = 'sales.staff' LIMIT 1`
      )
      .get();
    const finance = db
      .prepare(
        `SELECT id, username, role_key AS roleKey, display_name AS displayName
         FROM app_users WHERE username = 'finance.manager' LIMIT 1`
      )
      .get();
    expect(finance?.id).toBeTruthy();
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id,
        requested_by, requested_by_user_id, requested_at_iso, paid_amount_ngn
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      REFUND_DECIDE_FAIL,
      CUSTOMER_ID,
      'Quote Customer',
      '',
      '["Transport issue"]',
      'Staff cut decide fail-closed',
      10_000,
      JSON.stringify([{ label: 'Transport', amountNgn: 10_000, category: 'Transport issue' }]),
      `[{"recipientKind":"associated_staff","recipientAssociatedStaffID":"${STAFF_ID}","amountNgn":10000,"note":"Transport"}]`,
      'Pending',
      'Driver Payee',
      '1111222233',
      'Test Bank',
      'BR-KD',
      'Sales',
      sales?.id || 'USR-SALES-CUT',
      '2026-03-29T10:00:00.000Z',
      0
    );

    db.prepare(`RENAME TABLE refund_company_retention_entries TO refund_company_retention_entries_p0decide`).run();
    try {
      const decided = decideRefundRequest(
        db,
        REFUND_DECIDE_FAIL,
        {
          status: 'Approved',
          approvedAmountNgn: 10_000,
          approvalDate: '2026-03-29',
          calculationLines: [{ label: 'Transport', amountNgn: 10_000, category: 'Transport issue' }],
        },
        {
          id: finance.id,
          displayName: finance.displayName,
          roleKey: finance.roleKey,
        }
      );
      expect(decided.ok).toBe(false);
      expect(String(decided.error || '')).toMatch(/retention ledger is not ready|Partner wallet credit failed/i);
      const row = db
        .prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`)
        .get(REFUND_DECIDE_FAIL);
      expect(String(row.status || '')).toBe('Pending');
      expect(Number(row.paid_amount_ngn)).toBe(0);
    } finally {
      db.prepare(
        `RENAME TABLE refund_company_retention_entries_p0decide TO refund_company_retention_entries`
      ).run();
    }
  });
});
