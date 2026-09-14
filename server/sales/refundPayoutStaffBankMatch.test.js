/**
 * HR staff bank match → force 20% claiming-staff cut on refund payees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { encryptBankAccount } from '../hrBankCrypto.js';
import {
  buildHrStaffBankAccountKeySet,
  markRefundSplitsStaffBankMatch,
  payeeAccountMatchesHrStaffBank,
} from './refundPayoutStaffBankMatch.js';
import { saveRefundPayoutBank } from './refundPayoutBankOps.js';
import {
  applyRefundStaffAllocationDeduction,
  REFUND_STAFF_ALLOCATION_DEDUCTION_RATE,
} from '../../shared/lib/refundStaffAllocationDeduction.js';

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
const STAFF_ACCT = '5566778899';

describe.skipIf(!mysqlOk)('refundPayoutStaffBankMatch', () => {
  let db;
  let staffUserId;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const actor = db
      .prepare(`SELECT id FROM app_users WHERE status = 'active' ORDER BY username LIMIT 1`)
      .get();
    staffUserId = actor?.id;
    expect(staffUserId).toBeTruthy();

    const enc = encryptBankAccount(STAFF_ACCT);
    const hasProf = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(staffUserId);
    if (hasProf) {
      db.prepare(
        `UPDATE hr_staff_profiles
         SET bank_account_name = ?, bank_name = ?, bank_account_no = ?, bank_account_no_masked = ?
         WHERE user_id = ?`
      ).run('Staff Payee', 'Access Bank', enc, '******8899', staffUserId);
    } else {
      db.prepare(
        `INSERT INTO hr_staff_profiles (
           user_id, branch_id, employee_no,
           bank_account_name, bank_name, bank_account_no, bank_account_no_masked,
           base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn
         ) VALUES (?, 'BR-KD', 'EMP-BANK-MATCH', 'Staff Payee', 'Access Bank', ?, '******8899', 0, 0, 0)`
      ).run(staffUserId, enc);
    }

    const cust = db.prepare(`SELECT customer_id FROM customers WHERE customer_id = ?`).get('CUS-BANK-MATCH');
    if (!cust) {
      db.prepare(
        `INSERT INTO customers (customer_id, name, branch_id, status)
         VALUES ('CUS-BANK-MATCH', 'Quote Customer', 'BR-KD', 'Active')`
      ).run();
    }

    const staff = db.prepare(`SELECT id FROM associated_staff WHERE id = ?`).get('AST-BANK-MATCH');
    if (!staff) {
      db.prepare(
        `INSERT INTO associated_staff (id, name, branch_id, status, staff_type)
         VALUES ('AST-BANK-MATCH', 'Driver Match', 'BR-KD', 'Active', 'Driver')`
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

  it('detects payee account matching HR staff bank', () => {
    const keys = buildHrStaffBankAccountKeySet(db);
    expect(keys.has(STAFF_ACCT)).toBe(true);
    expect(payeeAccountMatchesHrStaffBank(STAFF_ACCT, keys)).toBe(true);
    expect(payeeAccountMatchesHrStaffBank('1111222233', keys)).toBe(false);
  });

  it('marks quote-customer split for 20% when account matches staff', () => {
    const marked = markRefundSplitsStaffBankMatch(db, [
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-BANK-MATCH',
        amountNgn: 50_000,
        payoutAccount: {
          partyKind: 'customer',
          partyId: 'CUS-BANK-MATCH',
          payeeAccountNo: STAFF_ACCT,
          payeeBankName: 'Access Bank',
          payeeName: 'Staff Payee',
        },
      },
    ]);
    expect(marked[0].staffBankAccountMatch).toBe(true);
    expect(marked[0].forceClaimingStaffCut).toBe(true);

    const cut = applyRefundStaffAllocationDeduction(marked[0], 'CUS-BANK-MATCH', {
      claimingStaffDeductionRate: REFUND_STAFF_ALLOCATION_DEDUCTION_RATE,
    });
    expect(cut.companyDeductionNgn).toBe(10_000);
    expect(cut.netPayoutNgn).toBe(40_000);
  });

  it('flags saveRefundPayoutBank when account matches HR staff', () => {
    const r = saveRefundPayoutBank(db, {
      kind: 'customer',
      id: 'CUS-BANK-MATCH',
      bankAccountName: 'Routed Staff',
      bankName: 'Access Bank',
      bankAccountNo: STAFF_ACCT,
      branchId: 'BR-KD',
    });
    expect(r.ok).toBe(true);
    expect(r.staffBankAccountMatch).toBe(true);
    expect(r.forceClaimingStaffCut).toBe(true);
    expect(r.forcedCompanyCutPct).toBe(20);
  });

  it('does not flag unrelated account numbers on save', () => {
    const r = saveRefundPayoutBank(db, {
      kind: 'associated_staff',
      id: 'AST-BANK-MATCH',
      bankAccountName: 'Driver',
      bankName: 'GTB',
      bankAccountNo: '1234567890',
    });
    expect(r.ok).toBe(true);
    expect(r.staffBankAccountMatch).toBe(false);
    expect(r.forceClaimingStaffCut).toBe(false);
  });
});
