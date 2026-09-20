/**
 * Save payout bank on customer or associated staff during refund allocation.
 * Lightweight path for refunds.request (does not require full customers.manage).
 * When the account number matches an active HR staff payroll account, the response
 * flags `staffBankAccountMatch` / `forceClaimingStaffCut` so the desk applies the 20% cut.
 * @module server/sales/refundPayoutBankOps
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { payeeAccountMatchesHrStaffBank } from './refundPayoutStaffBankMatch.js';

function trim(v) {
  return String(v ?? '').trim();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   kind: 'customer' | 'associated_staff';
 *   id: string;
 *   bankAccountName?: string;
 *   bankName?: string;
 *   bankAccountNo?: string;
 *   branchId?: string;
 * }} payload
 */
export function saveRefundPayoutBank(db, payload = {}) {
  const kind = trim(payload.kind).toLowerCase();
  const id = trim(payload.id);
  const bankAccountName = trim(payload.bankAccountName ?? payload.bank_account_name);
  const bankName = trim(payload.bankName ?? payload.bank_name);
  const bankAccountNo = trim(payload.bankAccountNo ?? payload.bank_account_no).replace(/\s+/g, '');

  if (!id) return { ok: false, error: 'Recipient id is required.' };
  if (!bankName) return { ok: false, error: 'Bank name is required.' };
  if (!bankAccountNo || bankAccountNo.length < 6) {
    return { ok: false, error: 'Enter a valid account number (at least 6 digits).' };
  }
  const payeeName = bankAccountName || '';
  const staffBankAccountMatch = payeeAccountMatchesHrStaffBank(bankAccountNo, null, db);
  const staffBankMatchFields = staffBankAccountMatch
    ? {
        staffBankAccountMatch: true,
        forceClaimingStaffCut: true,
        forcedCompanyCutPct: 20,
        message:
          'This account number matches an HR staff payroll account — the 20% company cut applies.',
      }
    : { staffBankAccountMatch: false, forceClaimingStaffCut: false };

  if (kind === 'associated_staff' || kind === 'staff') {
    const bid = trim(payload.branchId) || DEFAULT_BRANCH_ID;
    let row;
    if (hasColumn(db, 'associated_staff', 'branch_id')) {
      row = db
        .prepare(`SELECT id, name, branch_id FROM associated_staff WHERE id = ? AND branch_id = ?`)
        .get(id, bid);
      if (!row) {
        const any = db.prepare(`SELECT id, branch_id FROM associated_staff WHERE id = ?`).get(id);
        if (!any) return { ok: false, error: 'Associated staff not found.' };
        const other = trim(any.branch_id);
        if (other && other !== bid) {
          return {
            ok: false,
            error: `Associated staff belongs to branch ${other}. Switch workspace before saving bank details.`,
          };
        }
        return { ok: false, error: 'Associated staff not found in the current workspace branch.' };
      }
    } else {
      row = db.prepare(`SELECT id, name FROM associated_staff WHERE id = ?`).get(id);
      if (!row) return { ok: false, error: 'Associated staff not found.' };
    }
    db.prepare(
      `UPDATE associated_staff
       SET bank_account_name = ?, bank_name = ?, bank_account_no = ?
       WHERE id = ?`
    ).run(payeeName || String(row.name || '').trim(), bankName, bankAccountNo, id);
    return {
      ok: true,
      kind: 'associated_staff',
      id,
      name: String(row.name || '').trim(),
      bankAccountName: payeeName || String(row.name || '').trim(),
      bankName,
      bankAccountNo,
      ...staffBankMatchFields,
    };
  }

  if (kind === 'customer') {
    const bid = trim(payload.branchId) || DEFAULT_BRANCH_ID;
    // Never update a customer row from another branch (Kaduna must not overwrite Yola banks).
    const row = db
      .prepare(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = ? AND branch_id = ?`)
      .get(id, bid);
    if (!row) {
      const any = db
        .prepare(`SELECT customer_id, branch_id FROM customers WHERE customer_id = ?`)
        .get(id);
      if (!any) return { ok: false, error: 'Customer not found.' };
      const other = trim(any.branch_id);
      if (other && other !== bid) {
        return {
          ok: false,
          error: `Customer belongs to branch ${other}. Switch workspace before saving bank details.`,
        };
      }
      return { ok: false, error: 'Customer not found in the current workspace branch.' };
    }
    db.prepare(
      `UPDATE customers
       SET bank_account_name = ?, bank_name = ?, bank_account_no = ?
       WHERE customer_id = ? AND branch_id = ?`
    ).run(payeeName || String(row.name || '').trim(), bankName, bankAccountNo, id, bid);
    return {
      ok: true,
      kind: 'customer',
      id,
      name: String(row.name || '').trim(),
      bankAccountName: payeeName || String(row.name || '').trim(),
      bankName,
      bankAccountNo,
      branchId: String(row.branch_id || '').trim() || bid,
      ...staffBankMatchFields,
    };
  }

  return { ok: false, error: 'kind must be customer or associated_staff.' };
}
