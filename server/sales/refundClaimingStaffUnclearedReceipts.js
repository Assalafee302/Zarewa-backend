/**
 * Uncleared sales receipts posted by claiming staff (HR-linked sales customers).
 * Used to hold/offset staff refund net payouts until cashier clears those receipts.
 */
import { receiptEffectiveCashNgn, isReceiptPendingClearance } from '../../shared/lib/receiptClearance.js';
import { staffPurchaseCreditColumnsReady } from '../staffPurchaseCreditOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';

function trim(v) {
  return String(v ?? '').trim();
}

function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} salesCustomerIds
 * @returns {Map<string, { totalNgn: number, receiptCount: number, receiptIds: string[] }>}
 */
export function unclearedReceiptFloatBySalesCustomerIds(db, salesCustomerIds) {
  const out = new Map();
  const ids = [
    ...new Set((salesCustomerIds || []).map((id) => trim(id)).filter(Boolean)),
  ];
  if (!ids.length) return out;
  if (!staffPurchaseCreditColumnsReady(db)) return out;
  if (!hasColumn(db, 'hr_staff_profiles', 'sales_customer_id')) return out;

  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT h.sales_customer_id AS customer_id,
                sr.id AS receipt_id,
                sr.amount_ngn,
                sr.bank_received_amount_ngn,
                sr.status,
                sr.finance_reconciliation_saved_at_iso
         FROM hr_staff_profiles h
         JOIN ledger_entries le
           ON trim(IFNULL(le.created_by_user_id, '')) = trim(IFNULL(h.user_id, ''))
         JOIN sales_receipts sr
           ON trim(IFNULL(sr.ledger_entry_id, '')) = trim(IFNULL(le.id, ''))
         WHERE trim(IFNULL(h.sales_customer_id, '')) IN (${ph})
           AND (sr.status IS NULL OR trim(lower(sr.status)) NOT IN ('reversed', 'cleared', 'confirmed'))
           AND (sr.finance_reconciliation_saved_at_iso IS NULL
                OR trim(sr.finance_reconciliation_saved_at_iso) = '')`
      )
      .all(...ids);
  } catch {
    return out;
  }

  for (const row of rows) {
    const cid = trim(row.customer_id);
    if (!cid) continue;
    if (!isReceiptPendingClearance(row) && row.finance_reconciliation_saved_at_iso) continue;
    const amt = roundMoney(receiptEffectiveCashNgn(row));
    if (amt <= 0) continue;
    const prev = out.get(cid) || { totalNgn: 0, receiptCount: 0, receiptIds: [] };
    prev.totalNgn += amt;
    prev.receiptCount += 1;
    const rid = trim(row.receipt_id);
    if (rid) prev.receiptIds.push(rid);
    out.set(cid, prev);
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} salesCustomerId
 */
export function unclearedReceiptFloatForSalesCustomer(db, salesCustomerId) {
  const map = unclearedReceiptFloatBySalesCustomerIds(db, [salesCustomerId]);
  return map.get(trim(salesCustomerId)) || { totalNgn: 0, receiptCount: 0, receiptIds: [] };
}

/**
 * Flatten to customerId → totalNgn for deduction helpers.
 * @param {Map<string, { totalNgn: number }>} floatMap
 */
export function unclearedTotalsMap(floatMap) {
  const out = new Map();
  if (!(floatMap instanceof Map)) return out;
  for (const [cid, info] of floatMap) {
    out.set(cid, roundMoney(info?.totalNgn));
  }
  return out;
}
