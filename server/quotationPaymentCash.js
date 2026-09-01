/**
 * Per-quotation cash totals for refunds (receipt cash + deposit applied; no double-counted overpay).
 */
import { companionOverpayNgnByReceiptId } from '../shared/lib/customerLedgerCore.js';
import { SETTLED_QUOTE_OVERPAY_NOTE_SNIP } from '../shared/lib/customerPaymentIntegrity.js';
import { quotationActualCashInNgn } from '../shared/lib/refundQuotationMoney.js';
import {
  receiptAuthoritativeBankCashNgn,
  receiptEffectiveCashNgn,
  receiptReconciledCashNgn,
} from '../shared/lib/receiptClearance.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function mapLedgerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    customerID: row.customer_id,
    quotationRef: row.quotation_ref,
    atISO: row.at_iso,
    paymentMethod: row.payment_method,
    bankReference: row.bank_reference,
    amountNgn: row.amount_ngn,
    note: row.note,
  };
}

export function emptyQuotationPaymentCashBreakdown() {
  return {
    receiptCashNgn: 0,
    receiptAllocatedSumNgn: 0,
    advanceAppliedNgn: 0,
    overpayAppliedNgn: 0,
    staffPurchaseCreditNgn: 0,
    netOverpayLedgerNgn: 0,
    companionOverpayOnQuoteNgn: 0,
    settledQuoteFullOverpayNgn: 0,
    reconciledReceiptCashNgn: 0,
    cashInNgn: 0,
  };
}

/**
 * Pure cash breakdown from already-loaded receipt + ledger rows for one quotation.
 * @param {Array<object>} receiptRows
 * @param {Array<object>} ledgerRows mapped via {@link mapLedgerRow}
 */
export function quotationPaymentCashBreakdownFromRows(receiptRows, ledgerRows) {
  const companion = companionOverpayNgnByReceiptId(ledgerRows || []);
  let receiptCashNgn = 0;
  let reconciledReceiptCashNgn = 0;
  let receiptAllocatedSumNgn = 0;
  let companionOverpayOnQuoteNgn = 0;
  for (const r of receiptRows || []) {
    const rid = String(r.id || '');
    const lid = r.ledger_entry_id != null ? String(r.ledger_entry_id) : '';
    const extra = companion.get(rid) || (lid ? companion.get(lid) : 0) || 0;
    const receiptRow = {
      amountNgn: r.amount_ngn,
      amount_ngn: r.amount_ngn,
      status: r.status,
      financeReconciliationSavedAtISO: r.finance_reconciliation_saved_at_iso,
      bankReceivedAmountNgn: r.bank_received_amount_ngn,
      bank_received_amount_ngn: r.bank_received_amount_ngn,
    };
    const reconciled = receiptReconciledCashNgn(receiptRow);
    receiptAllocatedSumNgn += reconciled != null ? reconciled : roundMoney(r.amount_ngn);
    const authoritativeBank = receiptAuthoritativeBankCashNgn(receiptRow);
    if (authoritativeBank != null) {
      reconciledReceiptCashNgn += authoritativeBank;
    } else {
      const cash = receiptEffectiveCashNgn(receiptRow, { companionOverpayNgn: extra });
      receiptCashNgn += cash;
      companionOverpayOnQuoteNgn += extra;
    }
  }
  receiptCashNgn += reconciledReceiptCashNgn;

  const rows = ledgerRows || [];
  let advanceAppliedNgn = 0;
  let overpayAppliedNgn = 0;
  let staffPurchaseCreditNgn = 0;
  let overpayAdvanceNgn = 0;
  let overpayReversalNgn = 0;
  let settledQuoteFullOverpayNgn = 0;
  for (const e of rows) {
    const amt = roundMoney(e.amountNgn);
    switch (String(e.type || '')) {
      case 'ADVANCE_APPLIED':
        advanceAppliedNgn += amt;
        break;
      case 'OVERPAY_APPLIED':
        overpayAppliedNgn += amt;
        break;
      case 'STAFF_PURCHASE_CREDIT':
        staffPurchaseCreditNgn += amt;
        break;
      case 'OVERPAY_ADVANCE':
        overpayAdvanceNgn += amt;
        if (String(e.note || '').includes(SETTLED_QUOTE_OVERPAY_NOTE_SNIP)) {
          settledQuoteFullOverpayNgn += amt;
        }
        break;
      case 'OVERPAY_REVERSAL': {
        // Leftover moved onto another job posts CREDIT_APPLY reversals on the source.
        // Cash received on this quote does not change — Create Refund subtracts that ₦ as credit-out.
        const bref = String(e.bankReference || '').trim();
        if (bref.startsWith('CREDIT_APPLY')) break;
        overpayReversalNgn += amt;
        break;
      }
      default:
        break;
    }
  }
  const netOverpayLedgerNgn = Math.max(0, overpayAdvanceNgn - overpayReversalNgn);

  const cashInNgn =
    reconciledReceiptCashNgn > 0
      ? roundMoney(
          receiptCashNgn + advanceAppliedNgn + overpayAppliedNgn + staffPurchaseCreditNgn
        )
      : quotationActualCashInNgn({
          receiptCashNgn,
          advanceAppliedNgn,
          netOverpayLedgerNgn,
          companionOverpayOnQuoteNgn,
          settledQuoteFullOverpayNgn,
        });

  return {
    receiptCashNgn,
    receiptAllocatedSumNgn,
    advanceAppliedNgn,
    overpayAppliedNgn,
    staffPurchaseCreditNgn,
    netOverpayLedgerNgn,
    companionOverpayOnQuoteNgn,
    settledQuoteFullOverpayNgn,
    reconciledReceiptCashNgn,
    cashInNgn,
  };
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function quotationPaymentCashBreakdown(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return emptyQuotationPaymentCashBreakdown();

  const receiptRows = db
    .prepare(
      `SELECT id, amount_ngn, ledger_entry_id, finance_reconciliation_saved_at_iso, bank_received_amount_ngn, status
       FROM sales_receipts
       WHERE quotation_ref = ?
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
    )
    .all(ref);

  const ledgerRows = db
    .prepare(
      `SELECT id, type, customer_id, quotation_ref, at_iso, payment_method, bank_reference, amount_ngn, note
       FROM ledger_entries WHERE quotation_ref = ?`
    )
    .all(ref)
    .map(mapLedgerRow)
    .filter(Boolean);

  return quotationPaymentCashBreakdownFromRows(receiptRows, ledgerRows);
}

/**
 * Batch cash breakdown for many quotations (one/few round-trips instead of ~7 queries each).
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} quotationRefs
 * @returns {Map<string, ReturnType<typeof quotationPaymentCashBreakdownFromRows>>}
 */
export function quotationPaymentCashBreakdownByRef(db, quotationRefs) {
  /** @type {Map<string, ReturnType<typeof quotationPaymentCashBreakdownFromRows>>} */
  const out = new Map();
  const refs = [
    ...new Set(
      (Array.isArray(quotationRefs) ? quotationRefs : [])
        .map((r) => String(r || '').trim())
        .filter(Boolean)
    ),
  ];
  if (refs.length === 0) return out;

  /** @type {Map<string, object[]>} */
  const receiptsByRef = new Map();
  /** @type {Map<string, object[]>} */
  const ledgerByRef = new Map();
  for (const ref of refs) {
    receiptsByRef.set(ref, []);
    ledgerByRef.set(ref, []);
  }

  // SQLite default max variable count is 999 — keep headroom.
  for (const chunk of chunkArray(refs, 400)) {
    const placeholders = chunk.map(() => '?').join(',');
    const receiptRows = db
      .prepare(
        `SELECT id, quotation_ref, amount_ngn, ledger_entry_id, finance_reconciliation_saved_at_iso,
                bank_received_amount_ngn, status
         FROM sales_receipts
         WHERE quotation_ref IN (${placeholders})
           AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
      )
      .all(...chunk);
    for (const row of receiptRows) {
      const ref = String(row.quotation_ref || '').trim();
      const list = receiptsByRef.get(ref);
      if (list) list.push(row);
    }

    const ledgerRows = db
      .prepare(
        `SELECT id, type, customer_id, quotation_ref, at_iso, payment_method, bank_reference, amount_ngn, note
         FROM ledger_entries
         WHERE quotation_ref IN (${placeholders})`
      )
      .all(...chunk);
    for (const row of ledgerRows) {
      const mapped = mapLedgerRow(row);
      if (!mapped) continue;
      const ref = String(mapped.quotationRef || '').trim();
      const list = ledgerByRef.get(ref);
      if (list) list.push(mapped);
    }
  }

  for (const ref of refs) {
    out.set(
      ref,
      quotationPaymentCashBreakdownFromRows(receiptsByRef.get(ref) || [], ledgerByRef.get(ref) || [])
    );
  }
  return out;
}
