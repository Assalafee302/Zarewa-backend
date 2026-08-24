/**
 * Save payout bank on customer or associated staff during refund allocation.
 * Lightweight path for refunds.request (does not require full customers.manage).
 * @module server/sales/refundPayoutBankOps
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';

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

  if (kind === 'associated_staff' || kind === 'staff') {
    const row = db.prepare(`SELECT id, name FROM associated_staff WHERE id = ?`).get(id);
    if (!row) return { ok: false, error: 'Associated staff not found.' };
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
    };
  }

  if (kind === 'customer') {
    const bid = trim(payload.branchId) || DEFAULT_BRANCH_ID;
    let row = db
      .prepare(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = ? AND branch_id = ?`)
      .get(id, bid);
    if (!row) {
      row = db.prepare(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = ?`).get(id);
    }
    if (!row) return { ok: false, error: 'Customer not found.' };
    db.prepare(
      `UPDATE customers
       SET bank_account_name = ?, bank_name = ?, bank_account_no = ?
       WHERE customer_id = ?`
    ).run(payeeName || String(row.name || '').trim(), bankName, bankAccountNo, id);
    return {
      ok: true,
      kind: 'customer',
      id,
      name: String(row.name || '').trim(),
      bankAccountName: payeeName || String(row.name || '').trim(),
      bankName,
      bankAccountNo,
      branchId: String(row.branch_id || '').trim(),
    };
  }

  return { ok: false, error: 'kind must be customer or associated_staff.' };
}
