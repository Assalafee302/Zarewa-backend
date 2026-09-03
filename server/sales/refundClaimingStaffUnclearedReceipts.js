/**
 * Uncleared / unconfirmed sales receipts for refund payees (customers and claiming staff).
 * Till/bank payout is held until cashier confirms those receipts — admin may override at pay time.
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

function emptyFloat() {
  return { totalNgn: 0, receiptCount: 0, receiptIds: [] };
}

function accumulateUnclearedRow(out, customerId, row) {
  const cid = trim(customerId);
  if (!cid) return;
  if (!isReceiptPendingClearance(row) && row.finance_reconciliation_saved_at_iso) return;
  const amt = roundMoney(receiptEffectiveCashNgn(row));
  if (amt <= 0) return;
  const rid = trim(row.receipt_id ?? row.id);
  const prev = out.get(cid) || emptyFloat();
  if (rid && prev.receiptIds.includes(rid)) return;
  prev.totalNgn += amt;
  prev.receiptCount += 1;
  if (rid) prev.receiptIds.push(rid);
  out.set(cid, prev);
}

const PENDING_RECEIPT_SQL = `(sr.status IS NULL OR trim(lower(sr.status)) NOT IN ('reversed', 'cleared', 'confirmed'))
           AND (sr.finance_reconciliation_saved_at_iso IS NULL
                OR trim(sr.finance_reconciliation_saved_at_iso) = '')`;

/**
 * A receipt only blocks a payout if a cashier on that branch could plausibly find and confirm
 * it — so the hold is scoped to the receipt's own branch when both sides carry one.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchId]
 */
function branchFilterSql(db, branchId) {
  const bid = trim(branchId);
  if (!bid || !hasColumn(db, 'sales_receipts', 'branch_id')) return { sql: '', args: [] };
  return { sql: ` AND trim(IFNULL(sr.branch_id, '')) = ?`, args: [bid] };
}

/**
 * Receipts posted by claiming staff (HR login) that finance has not confirmed.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} salesCustomerIds
 * @param {Map<string, { totalNgn: number, receiptCount: number, receiptIds: string[] }>} [out]
 * @param {{ branchId?: string }} [opts]
 */
export function addUnclearedReceiptsPostedByClaimingStaff(db, salesCustomerIds, out = new Map(), opts = {}) {
  const ids = [...new Set((salesCustomerIds || []).map((id) => trim(id)).filter(Boolean))];
  if (!ids.length) return out;
  if (!staffPurchaseCreditColumnsReady(db)) return out;
  if (!hasColumn(db, 'hr_staff_profiles', 'sales_customer_id')) return out;

  const ph = ids.map(() => '?').join(',');
  const branch = branchFilterSql(db, opts.branchId);
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
           AND ${PENDING_RECEIPT_SQL}${branch.sql}`
      )
      .all(...ids, ...branch.args);
  } catch {
    return out;
  }

  for (const row of rows) {
    accumulateUnclearedRow(out, row.customer_id, row);
  }
  return out;
}

/**
 * Receipts sitting on the customer account that finance has not confirmed.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} customerIds
 * @param {Map<string, { totalNgn: number, receiptCount: number, receiptIds: string[] }>} [out]
 * @param {{ branchId?: string }} [opts]
 */
export function addUnclearedReceiptsOnCustomerAccounts(db, customerIds, out = new Map(), opts = {}) {
  const ids = [...new Set((customerIds || []).map((id) => trim(id)).filter(Boolean))];
  if (!ids.length) return out;

  const ph = ids.map(() => '?').join(',');
  const branch = branchFilterSql(db, opts.branchId);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT sr.customer_id AS customer_id,
                sr.id AS receipt_id,
                sr.amount_ngn,
                sr.bank_received_amount_ngn,
                sr.status,
                sr.finance_reconciliation_saved_at_iso
         FROM sales_receipts sr
         WHERE trim(IFNULL(sr.customer_id, '')) IN (${ph})
           AND ${PENDING_RECEIPT_SQL}${branch.sql}`
      )
      .all(...ids, ...branch.args);
  } catch {
    return out;
  }

  for (const row of rows) {
    accumulateUnclearedRow(out, row.customer_id, row);
  }
  return out;
}

/**
 * Combined uncleared float for refund payees: receipts they posted (staff) plus receipts on their account.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} salesCustomerIds
 * @param {{ branchId?: string }} [opts] scope to one branch (a cashier can only confirm receipts on
 *   their own branch, so a hold from another branch's receipt would otherwise be unresolvable)
 * @returns {Map<string, { totalNgn: number, receiptCount: number, receiptIds: string[] }>}
 */
export function unclearedReceiptFloatBySalesCustomerIds(db, salesCustomerIds, opts = {}) {
  const out = new Map();
  addUnclearedReceiptsPostedByClaimingStaff(db, salesCustomerIds, out, opts);
  addUnclearedReceiptsOnCustomerAccounts(db, salesCustomerIds, out, opts);
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} salesCustomerId
 * @param {{ branchId?: string }} [opts]
 */
export function unclearedReceiptFloatForSalesCustomer(db, salesCustomerId, opts = {}) {
  const map = unclearedReceiptFloatBySalesCustomerIds(db, [salesCustomerId], opts);
  return map.get(trim(salesCustomerId)) || emptyFloat();
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
