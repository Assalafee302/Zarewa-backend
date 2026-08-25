/**
 * Staff-linked customers resolve refund payee from HR bank (not customers.bank_*).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { encryptBankAccount } from '../hrBankCrypto.js';
import {
  claimingStaffPayeeForUserId,
  defaultRefundPayeeForQuotation,
  listClaimingStaffForRefunds,
  savedCustomerPayoutAccount,
} from './customerPayoutAccount.js';
import { creditRefundToPartnerWalletTx } from '../finance/partnerWalletCredit.js';

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

describe.skipIf(!mysqlOk)('customerPayoutAccount HR bank', () => {
  let db;
  let staffUserId;

  beforeEach(() => {
    process.env.ZAREWA_PARTNER_WALLET_V1 = '1';
    process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = '1';
    db = createDatabase(':memory:');
    const actor = db
      .prepare(`SELECT id FROM app_users WHERE status = 'active' ORDER BY username LIMIT 1`)
      .get();
    staffUserId = actor?.id;
    expect(staffUserId).toBeTruthy();

    const existing = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-HR-CLAIM');
    if (!existing) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status)
         VALUES ('CUS-HR-CLAIM', 'Staff Claim Customer', 'BR-KD', 'Active')`
      ).run();
    } else {
      db.prepare(
        `UPDATE customers SET bank_account_name = NULL, bank_name = NULL, bank_account_no = NULL,
         name = 'Staff Claim Customer', status = 'Active' WHERE customer_id = 'CUS-HR-CLAIM'`
      ).run();
    }

    const enc = encryptBankAccount('5566778899');
    const hasProf = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(staffUserId);
    if (hasProf) {
      db.prepare(
        `UPDATE hr_staff_profiles
         SET sales_customer_id = ?, bank_account_name = ?, bank_name = ?, bank_account_no = ?,
             bank_account_no_masked = ?, branch_id = COALESCE(NULLIF(branch_id,''), 'BR-KD')
         WHERE user_id = ?`
      ).run('CUS-HR-CLAIM', 'Staff Payee', 'Access Bank', enc, '******8899', staffUserId);
    } else {
      db.prepare(
        `INSERT INTO hr_staff_profiles (
           user_id, branch_id, employee_no, sales_customer_id,
           bank_account_name, bank_name, bank_account_no, bank_account_no_masked,
           base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn
         ) VALUES (?, 'BR-KD', 'EMP-HR-1', 'CUS-HR-CLAIM', 'Staff Payee', 'Access Bank', ?, '******8899', 0, 0, 0)`
      ).run(staffUserId, enc);
    }

    db.prepare(`UPDATE app_users SET display_name = 'Amina Staff' WHERE id = ?`).run(staffUserId);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    if (prevWallet === undefined) delete process.env.ZAREWA_PARTNER_WALLET_V1;
    else process.env.ZAREWA_PARTNER_WALLET_V1 = prevWallet;
    if (prevAssoc === undefined) delete process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1;
    else process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 = prevAssoc;
  });

  it('prefers HR bank when customer bank columns are empty', () => {
    const acct = savedCustomerPayoutAccount(db, 'CUS-HR-CLAIM');
    expect(acct).toBeTruthy();
    expect(acct.source).toBe('hr');
    expect(acct.payeeBankName).toBe('Access Bank');
    expect(acct.payeeAccountNo).toBe('5566778899');
    expect(acct.payeeName).toBe('Staff Payee');
    expect(acct.partyId).toBe('CUS-HR-CLAIM');
  });

  it('lists claiming staff with masked bank and hasBank', () => {
    const rows = listClaimingStaffForRefunds(db, 'ALL');
    const hit = rows.find((r) => r.customerID === 'CUS-HR-CLAIM');
    expect(hit).toBeTruthy();
    expect(hit.hasBank).toBe(true);
    expect(hit.bankName).toBe('Access Bank');
    expect(String(hit.bankAccountNoMasked || '')).toMatch(/8899$/);
    expect(String(hit.bankAccountNoMasked || '')).not.toContain('556677');
    expect(hit.name).toBe('Amina Staff');
    expect(hit.customerName).toBe('Staff Claim Customer');
    expect(hit.userId).toBe(staffUserId);
    expect(typeof hit.roleKey).toBe('string');
  });

  it('claimingStaffPayeeForUserId resolves via HR sales customer link', () => {
    const hit = claimingStaffPayeeForUserId(db, staffUserId);
    expect(hit).toBeTruthy();
    expect(hit.customerID).toBe('CUS-HR-CLAIM');
    expect(hit.userId).toBe(staffUserId);
  });

  it('defaultRefundPayeeForQuotation uses handled_by_user_id', () => {
    const hasCol = db.prepare(`PRAGMA table_info(quotations)`).all().some((c) => c.name === 'handled_by_user_id');
    if (!hasCol) {
      db.exec(`ALTER TABLE quotations ADD COLUMN handled_by_user_id TEXT`);
    }
    db.prepare(
      `INSERT INTO quotations (
         id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status,
         handled_by, handled_by_user_id, branch_id, lines_json
       ) VALUES (
         'QT-HB-1', 'CUS-HR-CLAIM', 'Staff Claim Customer', '2026-01-01', 1000, 1000, 'Paid', 'Approved',
         'Amina Staff', ?, 'BR-KD', '{}'
       )`
    ).run(staffUserId);
    const r = defaultRefundPayeeForQuotation(db, 'QT-HB-1');
    expect(r.ok).toBe(true);
    expect(r.payee?.customerID).toBe('CUS-HR-CLAIM');
    expect(r.source).toBe('handled_by_user_id');
  });

  it('defaultRefundPayeeForQuotation resolves legacy handled_by name', () => {
    const hasCol = db.prepare(`PRAGMA table_info(quotations)`).all().some((c) => c.name === 'handled_by_user_id');
    if (!hasCol) {
      db.exec(`ALTER TABLE quotations ADD COLUMN handled_by_user_id TEXT`);
    }
    db.prepare(`UPDATE app_users SET display_name = 'Suleiman Abdullahi Liman' WHERE id = ?`).run(staffUserId);
    if (!db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-OTHER')) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status) VALUES ('CUS-OTHER', 'Other', 'BR-KD', 'Active')`
      ).run();
    }
    db.prepare(
      `INSERT INTO quotations (
         id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status,
         handled_by, handled_by_user_id, branch_id, lines_json
       ) VALUES (
         'QT-HB-NAME', 'CUS-OTHER', 'Other', '2026-01-01', 1000, 1000, 'Paid', 'Approved',
         'Suleiman Abdullahi Liman', NULL, 'BR-KD', '{}'
       )`
    ).run();
    const r = defaultRefundPayeeForQuotation(db, 'QT-HB-NAME');
    expect(r.ok).toBe(true);
    expect(r.payee?.userId).toBe(staffUserId);
    expect(r.source).toBe('handled_by_name');
    const backfilled = db
      .prepare(`SELECT handled_by_user_id FROM quotations WHERE id = ?`)
      .get('QT-HB-NAME');
    expect(String(backfilled?.handled_by_user_id || '')).toBe(String(staffUserId));
  });

  it('defaultRefundPayeeForQuotation maps Branch Manager label to BM role login', () => {
    const hasCol = db.prepare(`PRAGMA table_info(quotations)`).all().some((c) => c.name === 'handled_by_user_id');
    if (!hasCol) {
      db.exec(`ALTER TABLE quotations ADD COLUMN handled_by_user_id TEXT`);
    }
    db.prepare(`UPDATE app_users SET display_name = 'Suleiman Abdullahi Liman', role_key = 'sales_manager' WHERE id = ?`).run(
      staffUserId
    );
    if (!db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-OTHER')) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status) VALUES ('CUS-OTHER', 'Other', 'BR-KD', 'Active')`
      ).run();
    }
    db.prepare(
      `INSERT INTO quotations (
         id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status,
         handled_by, handled_by_user_id, branch_id, lines_json
       ) VALUES (
         'QT-HB-BM', 'CUS-OTHER', 'Other', '2026-01-01', 1000, 1000, 'Paid', 'Approved',
         'Branch Manager', NULL, 'BR-KD', '{}'
       )`
    ).run();
    const r = defaultRefundPayeeForQuotation(db, 'QT-HB-BM');
    expect(r.ok).toBe(true);
    expect(r.payee?.userId).toBe(staffUserId);
    expect(r.source).toBe('handled_by_role_title');
    const row = db.prepare(`SELECT handled_by, handled_by_user_id FROM quotations WHERE id = ?`).get('QT-HB-BM');
    expect(String(row?.handled_by_user_id || '')).toBe(String(staffUserId));
    expect(String(row?.handled_by || '')).toBe('Suleiman Abdullahi Liman');
  });
    const hasCol = db.prepare(`PRAGMA table_info(quotations)`).all().some((c) => c.name === 'handled_by_user_id');
    if (!hasCol) {
      db.exec(`ALTER TABLE quotations ADD COLUMN handled_by_user_id TEXT`);
    }
    const otherUserId = 'usr-other-handler';
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all().map((c) => c.name);
    const insertCols = ['id', 'username', 'display_name', 'role_key', 'status'];
    const insertVals = [otherUserId, 'other.sales', 'Fatima Musa', 'sales', 'active'];
    if (cols.includes('password_hash')) {
      insertCols.push('password_hash');
      insertVals.push('x');
    }
    db.prepare(
      `INSERT INTO app_users (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`
    ).run(...insertVals);
    const enc = encryptBankAccount('9988776655');
    db.prepare(
      `INSERT INTO hr_staff_profiles (
         user_id, branch_id, employee_no, sales_customer_id,
         bank_account_name, bank_name, bank_account_no, bank_account_no_masked,
         base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn
       ) VALUES (?, 'BR-KD', 'EMP-F', 'CUS-FATIMA', 'Fatima Musa', 'Zenith Bank', ?, '****1234', 0, 0, 0)`
    ).run(otherUserId, enc);
    if (!db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-FATIMA')) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status)
         VALUES ('CUS-FATIMA', 'Fatima Musa', 'BR-KD', 'Active')`
      ).run();
    }
    if (!db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-OTHER')) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status) VALUES ('CUS-OTHER', 'Other', 'BR-KD', 'Active')`
      ).run();
    }
    db.prepare(`UPDATE app_users SET display_name = 'Suleiman Abdullahi Liman' WHERE id = ?`).run(staffUserId);
    db.prepare(
      `INSERT INTO quotations (
         id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status,
         handled_by, handled_by_user_id, agent_customer_id, agent_customer_name, branch_id, lines_json
       ) VALUES (
         'QT-HB-STALE', 'CUS-OTHER', 'Other', '2026-01-01', 1000, 1000, 'Paid', 'Approved',
         'Fatima Musa', ?, 'CUS-HR-CLAIM', 'Suleiman Abdullahi Liman', 'BR-KD', '{}'
       )`
    ).run(staffUserId);
    const r = defaultRefundPayeeForQuotation(db, 'QT-HB-STALE');
    expect(r.ok).toBe(true);
    expect(r.payee?.userId).toBe(otherUserId);
    expect(r.payee?.customerID).toBe('CUS-FATIMA');
    expect(r.source).toBe('handled_by_name_override');
  });

  it('partner wallet credit resolves HR bank when split omits payoutAccount', () => {
    const splitJson = JSON.stringify([
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-HR-CLAIM',
        amountNgn: 15000,
        note: 'Claiming staff',
      },
    ]);
    if (!db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-NOBANK-X')) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status)
         VALUES ('CUS-NOBANK-X', 'Walk-in', 'BR-KD', 'Active')`
      ).run();
    }
    db.prepare(`DELETE FROM partner_wallet_entries WHERE source_id = ?`).run('RF-HR-BANK-1');
    db.prepare(`DELETE FROM customer_refunds WHERE refund_id = ?`).run('RF-HR-BANK-1');
    db.prepare(
      `INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, calculation_lines_json, split_distributions_json, status,
        payee_name, payee_account_no, payee_bank_name, branch_id, requested_by, requested_at_iso,
        approved_amount_ngn
      ) VALUES (
        'RF-HR-BANK-1', 'CUS-NOBANK-X', 'Walk-in', 'QT-HR-1',
        ?, 'Claim via HR bank',
        15000, '[]', ?, 'Approved',
        '', '', '', 'BR-KD', 'Sales Staff', '2026-03-29T10:00:00.000Z',
        15000
      )`
    ).run('["Overpayment"]', splitJson);

    const refundRow = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get('RF-HR-BANK-1');
    const actor = db.prepare(`SELECT id, display_name, username FROM app_users WHERE id = ?`).get(staffUserId);
    const r = db.transaction(() =>
      creditRefundToPartnerWalletTx(db, refundRow, {
        approvedAmountNgn: 15000,
        actor: { id: actor.id, displayName: actor.display_name, username: actor.username },
      })
    )();
    expect(r.ok).toBe(true);
    const entry = db
      .prepare(
        `SELECT party_id, payee_name, payee_bank_name, payee_account_no, amount_ngn
         FROM partner_wallet_entries WHERE source_id = ? AND entry_type = 'credit'`
      )
      .get('RF-HR-BANK-1');
    expect(entry?.party_id).toBe('CUS-HR-CLAIM');
    expect(entry?.payee_bank_name).toBe('Access Bank');
    expect(entry?.payee_account_no).toBe('5566778899');
    expect(Number(entry?.amount_ngn)).toBe(15000);
  });
});
