/**
 * Save payout bank on customer or associated staff during refund allocation.
 * Lightweight path for refunds.request (does not require full customers.manage).
 * When the account number matches an active HR staff payroll account, the response
 * flags `staffBankAccountMatch` / `forceClaimingStaffCut` so the desk applies the 20% cut.
 * @module server/sales/refundPayoutBankOps
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
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

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * Remove one account number from customer profiles where it is the saved payout default.
 * Refund rows, payment requests, and staff payroll banks are left as history.
 * Bank name and account name stay; only bank_account_no is cleared, and only when it
 * matches this number exactly.
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountNo
 * @param {object | null} actor
 * @param {string} [note]
 */
export function clearSavedCustomerPayoutAccountNoTx(db, accountNo, actor = null, note = '') {
  const target = digitsOnly(accountNo);
  if (target.length < 6) return { ok: false, error: 'Account number is required.' };
  const rows = db
    .prepare(
      `SELECT customer_id, name, branch_id, bank_account_name, bank_name, bank_account_no
       FROM customers
       WHERE bank_account_no IS NOT NULL AND TRIM(bank_account_no) <> ''`
    )
    .all();
  const matches = rows.filter((row) => digitsOnly(row.bank_account_no) === target);
  const changed = [];
  for (const row of matches) {
    db.prepare(`UPDATE customers SET bank_account_no = NULL WHERE customer_id = ?`).run(row.customer_id);
    changed.push({
      customerId: String(row.customer_id),
      name: String(row.name || '').trim(),
      branchId: String(row.branch_id || '').trim(),
      bankName: String(row.bank_name || '').trim(),
      bankAccountName: String(row.bank_account_name || '').trim(),
    });
    appendAuditLog(db, {
      actor,
      action: 'customer.payout_account.clear',
      entityKind: 'customer',
      entityId: String(row.customer_id),
      note: String(note || '').trim() || 'Cleared saved payout account from the customer profile.',
      details: {
        customerId: String(row.customer_id),
        bankName: String(row.bank_name || '').trim(),
      },
    });
  }
  return { ok: true, changed };
}

/**
 * Record who the bank paid on the refund row only.
 * Does not write customers.bank_account_no, so a cleared profile default stays cleared.
 * Does not change approved or paid amounts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {{ payeeName: string, payeeBankName?: string, payeeAccountNo?: string, note?: string }} payload
 * @param {object | null} actor
 */
export function recordRefundBankPayeeTx(db, refundId, payload = {}, actor = null) {
  const id = trim(refundId);
  const payeeName = trim(payload.payeeName);
  if (!id) return { ok: false, error: 'Refund id is required.' };
  if (!payeeName) return { ok: false, error: 'Payee name is required.' };
  const row = db.prepare(`SELECT refund_id, payee_name, payment_note FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Refund not found.' };
  const payeeBankName = trim(payload.payeeBankName);
  const payeeAccountNo = trim(payload.payeeAccountNo).replace(/\s+/g, '');
  const clearAccount = payload.clearAccount === true;
  const extra = trim(payload.note);
  const prev = trim(row.payment_note);
  const paymentNote = extra && !prev.includes(extra) ? (prev ? `${prev} ${extra}` : extra) : prev;
  if ((payeeAccountNo || clearAccount) && hasColumn(db, 'customer_refunds', 'payee_account_no')) {
    db.prepare(
      `UPDATE customer_refunds
       SET payee_name = ?, payee_bank_name = ?, payee_account_no = ?, payment_note = ?
       WHERE refund_id = ?`
    ).run(payeeName, payeeBankName || null, payeeAccountNo, paymentNote || null, id);
  } else {
    db.prepare(
      `UPDATE customer_refunds SET payee_name = ?, payee_bank_name = ?, payment_note = ? WHERE refund_id = ?`
    ).run(payeeName, payeeBankName || null, paymentNote || null, id);
  }
  appendAuditLog(db, {
    actor,
    action: 'refund.bank_payee.record',
    entityKind: 'refund',
    entityId: id,
    note: extra || 'Recorded the bank payee on the refund.',
    details: {
      refundId: id,
      previousPayeeName: trim(row.payee_name),
      payeeName,
      payeeBankName,
    },
  });
  return { ok: true, refundId: id, payeeName, payeeBankName };
}
