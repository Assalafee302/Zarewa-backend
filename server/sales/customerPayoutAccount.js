/**
 * Customer / company-staff payout account resolution for refunds.
 * Staff-linked customers prefer HR payroll bank over customers.bank_*.
 * @module server/sales/customerPayoutAccount
 */
import { decryptBankAccount, storedBankToMasked } from '../hrBankCrypto.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { staffPurchaseCreditColumnsReady } from '../staffPurchaseCreditOps.js';
import { unclearedReceiptFloatBySalesCustomerIds } from './refundClaimingStaffUnclearedReceipts.js';

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * HR bank for a sales customer linked via hr_staff_profiles.sales_customer_id.
 * @returns {{ userId: string, employeeNo: string, displayName: string, payeeName: string, payeeBankName: string, payeeAccountNo: string, bankAccountNoMasked: string } | null}
 */
export function hrPayoutAccountForSalesCustomer(db, customerId) {
  const cid = trim(customerId);
  if (!cid || !staffPurchaseCreditColumnsReady(db)) return null;
  if (!hasColumn(db, 'hr_staff_profiles', 'bank_account_no')) return null;

  const row = db
    .prepare(
      `SELECT p.user_id, p.employee_no, p.bank_account_name, p.bank_name, p.bank_account_no,
              p.bank_account_no_masked, u.display_name, u.username, u.status AS user_status
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE trim(IFNULL(p.sales_customer_id, '')) = ?
       LIMIT 1`
    )
    .get(cid);
  if (!row) return null;

  const userStatus = trim(row.user_status || 'active').toLowerCase();
  if (userStatus && userStatus !== 'active') return null;

  const bankName = trim(row.bank_name);
  const payeeAccountNo = trim(decryptBankAccount(row.bank_account_no) || '');
  if (!bankName || !payeeAccountNo) return null;

  const displayName = trim(row.display_name || row.username || '');
  const payeeName = trim(row.bank_account_name) || displayName;
  const masked =
    trim(row.bank_account_no_masked) || storedBankToMasked(row.bank_account_no) || '';

  return {
    userId: trim(row.user_id),
    employeeNo: trim(row.employee_no),
    displayName,
    payeeName,
    payeeBankName: bankName,
    payeeAccountNo,
    bankAccountNoMasked: masked,
  };
}

/**
 * Prefer HR payroll bank when the customer is a staff purchase account; else customer bank columns.
 * @returns {{ partyKind: 'customer', partyId: string, partyName: string, payeeName: string, payeeAccountNo: string, payeeBankName: string, source?: 'hr'|'customer' } | null}
 */
export function savedCustomerPayoutAccount(db, customerId) {
  const cid = trim(customerId);
  if (!cid) return null;

  const cust = db
    .prepare(
      `SELECT name, bank_account_name, bank_name, bank_account_no
       FROM customers WHERE customer_id = ?`
    )
    .get(cid);
  if (!cust) return null;

  const partyName = trim(cust.name);
  const hr = hrPayoutAccountForSalesCustomer(db, cid);
  if (hr) {
    return {
      partyKind: 'customer',
      partyId: cid,
      partyName: partyName || hr.displayName || cid,
      payeeName: hr.payeeName || partyName,
      payeeAccountNo: hr.payeeAccountNo,
      payeeBankName: hr.payeeBankName,
      source: 'hr',
    };
  }

  const bankAccountNo = trim(cust.bank_account_no);
  const bankName = trim(cust.bank_name);
  const bankAccountName = trim(cust.bank_account_name);
  if (!bankAccountNo || !bankName) return null;

  return {
    partyKind: 'customer',
    partyId: cid,
    partyName,
    payeeName: bankAccountName || partyName,
    payeeAccountNo: bankAccountNo,
    payeeBankName: bankName,
    source: 'customer',
  };
}

/**
 * Directory for refund “claiming staff” picker (masked bank only).
 * Avoid decrypting every HR account — that made the refund form hang.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL'|string} [branchScope]
 */
export function listClaimingStaffForRefunds(db, branchScope = 'ALL') {
  if (!staffPurchaseCreditColumnsReady(db)) return [];
  if (!hasColumn(db, 'hr_staff_profiles', 'bank_account_no')) return [];

  const scope = trim(branchScope);
  const branchSql =
    scope && scope !== 'ALL' ? ` AND trim(IFNULL(p.branch_id, '')) = ?` : '';
  const args = scope && scope !== 'ALL' ? [scope] : [];

  const rows = db
    .prepare(
      `SELECT p.user_id, p.employee_no, p.sales_customer_id, p.bank_account_name, p.bank_name,
              p.bank_account_no, p.bank_account_no_masked, p.branch_id,
              u.display_name, u.username, u.role_key, u.status AS user_status,
              c.name AS customer_name, c.status AS customer_status
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       JOIN customers c ON trim(IFNULL(c.customer_id, '')) = trim(IFNULL(p.sales_customer_id, ''))
       WHERE trim(IFNULL(p.sales_customer_id, '')) != ''${branchSql}
       ORDER BY u.display_name
       LIMIT 500`
    )
    .all(...args);

  const staffRows = rows
    .map((row) => {
      const userStatus = trim(row.user_status || 'active').toLowerCase();
      if (userStatus && userStatus !== 'active') return null;
      const customerStatus = trim(row.customer_status || 'Active').toLowerCase();
      if (customerStatus && customerStatus !== 'active') return null;

      const customerID = trim(row.sales_customer_id);
      const bankName = trim(row.bank_name);
      const masked = trim(row.bank_account_no_masked);
      const encPresent = Boolean(trim(row.bank_account_no));
      // Fast hasBank: name + (masked or encrypted blob). Decrypt only at payout submit.
      const hasBank = Boolean(bankName && (masked || encPresent));
      const displayName = trim(row.display_name);
      const username = trim(row.username);
      const customerName = trim(row.customer_name);
      const name = displayName || username || customerName || customerID;

      return {
        customerID,
        userId: trim(row.user_id),
        name,
        /** Previous quote labels may still use sales-customer name after display_name changes. */
        customerName,
        username,
        roleKey: trim(row.role_key).toLowerCase(),
        employeeNo: trim(row.employee_no),
        bankName: hasBank ? bankName : '',
        bankAccountNoMasked: hasBank ? masked || '****' : '',
        hasBank,
        branchId: trim(row.branch_id),
      };
    })
    .filter(Boolean);

  const floatMap = unclearedReceiptFloatBySalesCustomerIds(
    db,
    staffRows.map((r) => r.customerID)
  );
  return staffRows.map((row) => {
    const info = floatMap.get(row.customerID);
    return {
      ...row,
      unclearedReceiptFloatNgn: info ? Math.round(Number(info.totalNgn) || 0) : 0,
      unclearedReceiptCount: info ? Number(info.receiptCount) || 0 : 0,
    };
  });
}
