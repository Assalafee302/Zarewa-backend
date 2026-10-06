/**
 * Forward refund controls: a usable payee account, a bank-line match to that account,
 * and a cap at the customer's open ledger credit unless MD approves.
 */
import { refundExceedsOpenCredit, refundIdFromSystemMatch, payeeAccountDigits, payeeAccountRejection, statementContainsPayeeAccount } from '../../shared/lib/refundPayeeAccount.js';

export { payeeAccountRejection, refundExceedsOpenCredit, statementContainsPayeeAccount };

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

/** Deposit advance plus quotation overpay credit. Receipts already recognised are not open credit. */
export function customerOpenCreditNgn(db, customerId, branchId) {
  const id = String(customerId || '').trim();
  if (!id) return 0;
  const bid = String(branchId || '').trim();
  const rows = bid
    ? db.prepare(`SELECT type, amount_ngn FROM ledger_entries WHERE customer_id = ? AND branch_id = ?`).all(id, bid)
    : db.prepare(`SELECT type, amount_ngn FROM ledger_entries WHERE customer_id = ?`).all(id);
  let credit = 0;
  for (const row of rows || []) {
    const amount = roundMoney(row.amount_ngn);
    switch (String(row.type || '')) {
      case 'ADVANCE_IN':
      case 'OVERPAY_ADVANCE':
        credit += amount;
        break;
      case 'ADVANCE_APPLIED':
      case 'REFUND_ADVANCE':
      case 'ADVANCE_REVERSAL':
      case 'OVERPAY_REVERSAL':
      case 'REFUND_OVERPAY':
        credit -= amount;
        break;
      default:
        break;
    }
  }
  return roundMoney(credit);
}

/**
 * A matched reconciliation line for a refund must name that refund's payee account.
 * Receipt matches are left to the receipt check.
 */
export function assertMatchedRefundStatement(db, systemMatch, description) {
  const refundId = refundIdFromSystemMatch(systemMatch);
  if (!refundId) return { ok: true };
  const row = db.prepare(`SELECT payee_account_no, payee_name FROM customer_refunds WHERE refund_id = ?`).get(refundId);
  if (!row) return { ok: false, error: `No refund found for ${refundId}.` };
  const rejection = payeeAccountRejection(row.payee_account_no);
  if (rejection) {
    return { ok: false, error: `Refund ${refundId} has no usable payee account to match to the bank line.` };
  }
  const digits = payeeAccountDigits(row.payee_account_no);
  if (!statementContainsPayeeAccount(description, digits)) {
    const name = String(row.payee_name || 'payee').trim();
    return {
      ok: false,
      error: `Bank line for ${refundId} must contain payee account ${digits} (${name}).`,
    };
  }
  return { ok: true };
}
