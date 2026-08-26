/**
 * No customer bank → split payout → partner wallet credit (and cashier withdraw when MySQL tx stack allows).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { creditRefundToPartnerWalletTx, withdrawPartnerWallet } from './finance/partnerWalletOps.js';

const prevWallet = process.env.ZAREWA_PARTNER_WALLET_V1;
const prevAssoc = process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;

const SPLIT_JSON = JSON.stringify([
  {
    recipientKind: 'associated_staff',
    recipientAssociatedStaffID: 'AST-DRV-WALLET',
    amountNgn: 7000,
    note: 'Transport',
    payoutAccount: {
      payeeName: 'Driver Beneficiary',
      payeeBankName: 'Test Bank PLC',
      payeeAccountNo: '0987654321',
      partyKind: 'associated_staff',
      partyId: 'AST-DRV-WALLET',
      partyName: 'Driver Wallet Test',
    },
  },
  {
    recipientKind: 'customer',
    recipientCustomerID: 'CUS-CLAIM-STAFF',
    amountNgn: 13000,
    note: 'Remainder to claiming staff',
    payoutAccount: {
      payeeName: 'Staff Beneficiary',
      payeeBankName: 'Test Bank PLC',
      payeeAccountNo: '0123456789',
      partyKind: 'customer',
      partyId: 'CUS-CLAIM-STAFF',
      partyName: 'Claiming Staff Wallet',
    },
  },
]);

describe('refund partner wallet split (no customer bank)', () => {
  let db;
  let treasuryAccountId;
  let financeActor;

  beforeEach(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '1';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id, status)
      VALUES ('CUS-NOBANK', 'Walk-in No Bank', 'BR-KD', 'Active');
      INSERT INTO customers (
        customer_id, name, branch_id, status, bank_account_name, bank_name, bank_account_no
      ) VALUES (
        'CUS-CLAIM-STAFF', 'Claiming Staff Wallet', 'BR-KD', 'Active',
        'Staff Beneficiary', 'Test Bank PLC', '0123456789'
      );
      INSERT INTO associated_staff (
        id, name, branch_id, status, staff_type, bank_account_name, bank_name, bank_account_no
      ) VALUES (
        'AST-DRV-WALLET', 'Driver Wallet Test', 'BR-KD', 'Active', 'Driver',
        'Driver Beneficiary', 'Test Bank PLC', '0987654321'
      );
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn
      ) VALUES (
        'RF-WALLET-SPLIT-1', 'CUS-NOBANK', 'Walk-in No Bank', 'QT-WALLET-1',
        '["Order cancellation"]', 'Cancel with staff split payout',
        20000, '[]', '${SPLIT_JSON.replace(/'/g, "''")}', 'Approved',
        'Driver Beneficiary', '0987654321', 'Test Bank PLC', 'BR-KD', 'Sales Staff', '2026-03-29T10:00:00.000Z',
        20000
      );
    `);
    treasuryAccountId = db.prepare(`SELECT id FROM treasury_accounts LIMIT 1`).get()?.id;
    financeActor = db
      .prepare(
        `SELECT id, username, role_key AS roleKey, display_name AS displayName FROM app_users WHERE username = 'finance.manager'`
      )
      .get();
    expect(treasuryAccountId).toBeTruthy();
    expect(financeActor?.id).toBeTruthy();
  }, 300_000);

  afterEach(() => {
    db?.close();
    if (prevWallet == null) delete process.env.ZAREWA_PARTNER_WALLET_V1;
    else process.env.ZAREWA_PARTNER_WALLET_V1 = prevWallet;
    if (prevAssoc == null) delete process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;
    else process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = prevAssoc;
  });

  it('credits split recipients from split_distributions_json', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get('RF-WALLET-SPLIT-1');
    const transportNgn = 7_000;
    const remainderNgn = 13_000;

    const walletCredit = creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 20_000,
      actor: { id: financeActor.id, displayName: financeActor.displayName, roleKey: financeActor.roleKey },
    });
    if (!walletCredit.ok) throw new Error(`creditRefundToPartnerWalletTx: ${walletCredit.error}`);

    const credits = db
      .prepare(
        `SELECT party_id, amount_ngn, open_ngn FROM partner_wallet_entries
         WHERE entry_type = 'credit' AND refund_id = ? ORDER BY party_id`
      )
      .all('RF-WALLET-SPLIT-1');
    expect(credits).toHaveLength(2);
    // Staff splits take the company cut (default 20%) — wallet holds net only.
    expect(credits.find((c) => c.party_id === 'AST-DRV-WALLET')?.amount_ngn).toBe(Math.round(transportNgn * 0.8));
    expect(credits.find((c) => c.party_id === 'CUS-CLAIM-STAFF')?.amount_ngn).toBe(Math.round(remainderNgn * 0.8));
    expect(credits.find((c) => c.party_id === 'AST-DRV-WALLET')?.open_ngn).toBe(Math.round(transportNgn * 0.8));
    expect(credits.find((c) => c.party_id === 'CUS-CLAIM-STAFF')?.open_ngn).toBe(Math.round(remainderNgn * 0.8));
    expect(walletCredit.companyRetentionNgn).toBe(Math.round((transportNgn + remainderNgn) * 0.2));
  });

  it('cashier withdraws staff wallet slice after split credit', () => {
    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get('RF-WALLET-SPLIT-1');
    creditRefundToPartnerWalletTx(db, refundRow, {
      approvedAmountNgn: 20_000,
      actor: { id: financeActor.id, displayName: financeActor.displayName, roleKey: financeActor.roleKey },
    });
    const withdraw = withdrawPartnerWallet(db, {
      partyKind: 'associated_staff',
      partyId: 'AST-DRV-WALLET',
      amountNgn: Math.round(7_000 * 0.8),
      treasuryAccountId,
      reference: 'PWV-SPLIT-TEST',
      dateISO: '2026-03-29',
      actor: { ...financeActor, permissions: [] },
      workspaceBranchId: 'BR-KD',
    });
    expect(withdraw.ok).toBe(true);
  });
});
