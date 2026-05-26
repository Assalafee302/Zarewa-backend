/**
 * Per-quotation cash totals for refunds (receipt cash + deposit applied; no double-counted overpay).
 */
import { companionOverpayNgnByReceiptId } from '../shared/lib/customerLedgerCore.js';
import { SETTLED_QUOTE_OVERPAY_NOTE_SNIP } from '../shared/lib/customerPaymentIntegrity.js';
import { quotationActualCashInNgn } from '../shared/lib/refundQuotationMoney.js';

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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function quotationPaymentCashBreakdown(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) {
    return {
      receiptCashNgn: 0,
      receiptAllocatedSumNgn: 0,
      advanceAppliedNgn: 0,
      netOverpayLedgerNgn: 0,
      companionOverpayOnQuoteNgn: 0,
      settledQuoteFullOverpayNgn: 0,
      cashInNgn: 0,
    };
  }

  const receiptRows = db
    .prepare(
      `SELECT id, amount_ngn, ledger_entry_id, finance_reconciliation_saved_at_iso, bank_received_amount_ngn
       FROM sales_receipts
       WHERE quotation_ref = ?
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
    )
    .all(ref);

  const ledgerRows = db
    .prepare(`SELECT * FROM ledger_entries WHERE quotation_ref = ?`)
    .all(ref)
    .map(mapLedgerRow)
    .filter(Boolean);

  const companion = companionOverpayNgnByReceiptId(ledgerRows);
  let receiptCashNgn = 0;
  let receiptAllocatedSumNgn = 0;
  let companionOverpayOnQuoteNgn = 0;
  for (const r of receiptRows) {
    const reconciled = String(r.finance_reconciliation_saved_at_iso || '').trim() !== '';
    const confirmed =
      reconciled && r.bank_received_amount_ngn != null && roundMoney(r.bank_received_amount_ngn) > 0
        ? roundMoney(r.bank_received_amount_ngn)
        : null;
    if (confirmed != null) {
      receiptAllocatedSumNgn += confirmed;
      receiptCashNgn += confirmed;
      continue;
    }
    const alloc = roundMoney(r.amount_ngn);
    const rid = String(r.id || '');
    const lid = r.ledger_entry_id != null ? String(r.ledger_entry_id) : '';
    const extra = companion.get(rid) || (lid ? companion.get(lid) : 0) || 0;
    receiptAllocatedSumNgn += alloc;
    receiptCashNgn += alloc + extra;
    companionOverpayOnQuoteNgn += extra;
  }

  const advanceAppliedNgn = roundMoney(
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
         WHERE type = 'ADVANCE_APPLIED' AND quotation_ref = ?`
      )
      .get(ref)?.s ?? 0
  );

  const overpayRows = db
    .prepare(
      `SELECT amount_ngn, note FROM ledger_entries
       WHERE type = 'OVERPAY_ADVANCE' AND quotation_ref = ?`
    )
    .all(ref);
  const overpayAdvanceNgn = overpayRows.reduce((s, row) => s + roundMoney(row.amount_ngn), 0);
  const overpayReversalNgn = roundMoney(
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
         WHERE type = 'OVERPAY_REVERSAL' AND quotation_ref = ?`
      )
      .get(ref)?.s ?? 0
  );
  const netOverpayLedgerNgn = Math.max(0, overpayAdvanceNgn - overpayReversalNgn);

  let settledQuoteFullOverpayNgn = 0;
  for (const row of overpayRows) {
    const note = String(row.note || '');
    if (!note.includes(SETTLED_QUOTE_OVERPAY_NOTE_SNIP)) continue;
    settledQuoteFullOverpayNgn += roundMoney(row.amount_ngn);
  }

  const cashInNgn = quotationActualCashInNgn({
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
    netOverpayLedgerNgn,
    companionOverpayOnQuoteNgn,
    settledQuoteFullOverpayNgn,
    cashInNgn,
  };
}
