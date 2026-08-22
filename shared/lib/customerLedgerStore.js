/**
 * Customer ledger — deposits, receipts, advance applications, and overpayment credits (tracked separately).
 * Source of truth is the in-memory ledger snapshot replaced from bootstrap.
 * Do not persist AR/ledger rows to localStorage (shared PCs / XSS).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/customerLedgerStore.js
 */
import {
  sumForQuotationInEntries,
  amountDueOnQuotationFromEntries,
  receivableDueOnQuotationFromEntries,
  advanceBalanceFromEntries,
  overpayCreditBalanceFromEntries,
  ledgerReceiptTotalFromEntries,
  entriesForCustomerFromEntries,
  planAdvanceIn,
  planAdvanceApplied,
  planReceiptWithQuotation,
  planRefundAdvance,
  receiptResultFromSavedRows,
} from './customerLedgerCore.js';

const LEGACY_STORAGE_KEY = 'zarewa.customerLedger.v1';
let ledgerEntriesState = [];
let clearedLegacyStorage = false;

function clearLegacyLedgerStorage() {
  const storage = globalThis.localStorage;
  if (clearedLegacyStorage || !storage) return;
  clearedLegacyStorage = true;
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** @typedef {'ADVANCE_IN'|'ADVANCE_APPLIED'|'RECEIPT'|'OVERPAY_ADVANCE'|'OVERPAY_REVERSAL'|'REFUND_ADVANCE'|'REFUND_OVERPAY'} LedgerEntryType */

/**
 * @typedef {{
 *   id: string,
 *   atISO: string,
 *   type: LedgerEntryType,
 *   customerID: string,
 *   customerName?: string,
 *   amountNgn: number,
 *   quotationRef?: string,
 *   paymentMethod?: string,
 *   bankReference?: string,
 *   purpose?: string,
 *   note?: string,
 * }} LedgerEntry
 */

export function loadLedgerEntries() {
  return Array.isArray(ledgerEntriesState) ? ledgerEntriesState : [];
}

/** Replace ledger from server bootstrap (memory only). */
export function replaceLedgerEntries(entries) {
  clearLegacyLedgerStorage();
  if (!Array.isArray(entries)) return;
  ledgerEntriesState = entries.map((row) => ({ ...row }));
}

function saveLedgerEntries(list) {
  clearLegacyLedgerStorage();
  ledgerEntriesState = Array.isArray(list) ? list.map((row) => ({ ...row })) : [];
}

function nextId() {
  return `LE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function appendLedgerEntry(entry) {
  const amt = Math.round(Number(entry.amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Amount must be positive.' };
  const row = {
    ...entry,
    id: nextId(),
    atISO: entry.atISO || new Date().toISOString(),
    amountNgn: amt,
  };
  saveLedgerEntries([row, ...loadLedgerEntries()]);
  return { ok: true, entry: row };
}

export function sumForQuotation(quotationId, type) {
  return sumForQuotationInEntries(loadLedgerEntries(), quotationId, type);
}

/**
 * Amount still due on a quotation (`totalNgn − paidNgn`). With live data, `paidNgn` is synced from receipts
 * (and applied advances) on the server; update the quotation row after posting payments to match.
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} q
 */
export function amountDueOnQuotation(q) {
  return amountDueOnQuotationFromEntries(loadLedgerEntries(), q);
}

/** AR balance: due only when completed production exists on the quote. */
export function receivableDueOnQuotation(q, productionJobs = []) {
  return receivableDueOnQuotationFromEntries(loadLedgerEntries(), q, productionJobs);
}

/** Customer deposit advance balance (ADVANCE_IN, applications, refunds) — excludes quotation overpayments. */
export function advanceBalanceNgn(customerID) {
  return advanceBalanceFromEntries(loadLedgerEntries(), customerID);
}

/** Credit from paying more than the quote balance (OVERPAY_ADVANCE); reduced by reversals and refund payouts. */
export function overpayCreditBalanceNgn(customerID) {
  return overpayCreditBalanceFromEntries(loadLedgerEntries(), customerID);
}

/** Sum of receipt-type revenue postings linked to quotations (this ledger only). */
export function ledgerReceiptTotalNgn(customerID) {
  return ledgerReceiptTotalFromEntries(loadLedgerEntries(), customerID);
}

export function entriesForCustomer(customerID) {
  return entriesForCustomerFromEntries(loadLedgerEntries(), customerID);
}

/**
 * Post standalone advance (no quotation).
 */
export function recordAdvancePayment({
  customerID,
  customerName,
  amountNgn,
  paymentMethod,
  bankReference,
  purpose,
  dateISO,
}) {
  const plan = planAdvanceIn({
    customerID,
    customerName,
    amountNgn,
    paymentMethod,
    bankReference,
    purpose,
    dateISO,
  });
  if (!plan.ok) return plan;
  return appendLedgerEntry(plan.rows[0]);
}

/**
 * Apply existing advance to a quotation (reduces advance, reduces amount due on quote).
 */
export function recordAdvanceAppliedToQuotation({
  customerID,
  customerName,
  quotationRef,
  amountNgn,
}) {
  const plan = planAdvanceApplied(loadLedgerEntries(), {
    customerID,
    customerName,
    quotationRef,
    amountNgn,
  });
  if (!plan.ok) return plan;
  return appendLedgerEntry(plan.rows[0]);
}

/**
 * Payment with quotation: receipt portion + optional overpay → advance.
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} quotationRow - from workspace quotation row
 */
export function recordReceiptWithQuotation({
  customerID,
  customerName,
  quotationRow,
  amountNgn,
  paymentMethod,
  bankReference,
  dateISO,
  fullAmountAsReceipt,
}) {
  const plan = planReceiptWithQuotation(loadLedgerEntries(), {
    customerID,
    customerName,
    quotationRow,
    amountNgn,
    paymentMethod,
    bankReference,
    dateISO,
    fullAmountAsReceipt,
  });
  if (!plan.ok) return plan;

  const saved = [];
  for (const row of plan.rows) {
    const r = appendLedgerEntry(row);
    if (!r.ok) return r;
    saved.push(r.entry);
  }
  const { receipt, overpay } = receiptResultFromSavedRows(saved);
  return { ok: true, receipt, overpay };
}

export function recordRefundAdvance({ customerID, customerName, amountNgn, note }) {
  const plan = planRefundAdvance(loadLedgerEntries(), {
    customerID,
    customerName,
    amountNgn,
    note,
  });
  if (!plan.ok) return plan;
  return appendLedgerEntry(plan.rows[0]);
}
