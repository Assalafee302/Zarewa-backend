/**
 * Pure customer-ledger rules (Zarewa payment model). Used by localStorage store and API server.
 * @typedef {'ADVANCE_IN'|'ADVANCE_APPLIED'|'RECEIPT'|'OVERPAY_ADVANCE'|'REFUND_ADVANCE'|'RECEIPT_REVERSAL'|'ADVANCE_REVERSAL'} LedgerEntryType
 */

/**
 * @param {Array<{ quotationRef?: string, type: string, amountNgn?: number }>} entries
 */
export function sumForQuotationInEntries(entries, quotationId, type) {
  return (entries || [])
    .filter((e) => e.quotationRef === quotationId && e.type === type)
    .reduce((s, e) => s + (Number(e.amountNgn) || 0), 0);
}

/** Paid toward a quotation from ledger only (applied advance + receipts − receipt reversals). */
export function ledgerAttributedPaidNgnForQuotation(entries, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return 0;
  const applied = sumForQuotationInEntries(entries, id, 'ADVANCE_APPLIED');
  const receipts = sumForQuotationInEntries(entries, id, 'RECEIPT');
  const receiptReversals = sumForQuotationInEntries(entries, id, 'RECEIPT_REVERSAL');
  return Math.round(applied + receipts - receiptReversals);
}

/**
 * @param {Array<{ customerID: string, type: string, amountNgn?: number }>} entries
 */
export function advanceBalanceFromEntries(entries, customerID) {
  if (!customerID) return 0;
  return (entries || [])
    .filter((e) => e.customerID === customerID)
    .reduce((s, e) => {
      const n = Number(e.amountNgn) || 0;
      switch (e.type) {
        case 'ADVANCE_IN':
        case 'OVERPAY_ADVANCE':
          return s + n;
        case 'ADVANCE_APPLIED':
        case 'REFUND_ADVANCE':
        case 'ADVANCE_REVERSAL':
          return s - n;
        default:
          return s;
      }
    }, 0);
}

/**
 * Amount still due on a quotation. Uses the quotation row only: `paidNgn` is maintained from **sales receipts**
 * (plus applied advances rolled into the same field on the server). The `entries` argument is unused but kept
 * so call sites stay stable.
 * @param {unknown} _entries
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} q
 */
export function amountDueOnQuotationFromEntries(_entries, q) {
  if (!q?.id) return 0;
  const total = Number(q.totalNgn) || 0;
  const rowPaid = Number(q.paidNgn) || 0;
  return Math.max(0, Math.round(total - rowPaid));
}

export function ledgerReceiptTotalFromEntries(entries, customerID) {
  if (!customerID) return 0;
  return (entries || []).reduce((s, e) => {
    if (e.customerID !== customerID) return s;
    const n = Number(e.amountNgn) || 0;
    if (e.type === 'RECEIPT') return s + n;
    if (e.type === 'RECEIPT_REVERSAL') return s - n;
    return s;
  }, 0);
}

export function entriesForCustomerFromEntries(entries, customerID) {
  return (entries || []).filter((e) => e.customerID === customerID);
}

export function planAdvanceIn({
  customerID,
  customerName,
  amountNgn,
  paymentMethod,
  bankReference,
  purpose,
  dateISO,
}) {
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Amount must be positive.' };
  return {
    ok: true,
    rows: [
      {
        type: 'ADVANCE_IN',
        customerID,
        customerName,
        amountNgn: amt,
        paymentMethod,
        bankReference,
        purpose,
        note: purpose,
        quotationRef: '',
        atISO: dateISO ? `${dateISO}T12:00:00.000Z` : undefined,
      },
    ],
  };
}

export function planAdvanceApplied(entries, { customerID, customerName, quotationRef, amountNgn }) {
  const bal = advanceBalanceFromEntries(entries, customerID);
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Enter a positive amount.' };
  if (amt > bal) return { ok: false, error: 'Amount exceeds customer advance balance.' };
  return {
    ok: true,
    rows: [
      {
        type: 'ADVANCE_APPLIED',
        customerID,
        customerName,
        amountNgn: amt,
        quotationRef,
        note: `Applied to ${quotationRef}`,
      },
    ],
  };
}

/**
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} quotationRow
 */
export function planReceiptWithQuotation(entries, {
  customerID,
  customerName,
  quotationRow,
  amountNgn,
  paymentMethod,
  bankReference,
  dateISO,
}) {
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Enter a positive amount.' };
  if (!quotationRow?.id) return { ok: false, error: 'Invalid quotation.' };

  const due = amountDueOnQuotationFromEntries(entries, quotationRow);
  const ts = dateISO ? `${dateISO}T12:00:00.000Z` : undefined;

  if (due <= 0) {
    return {
      ok: true,
      rows: [
        {
          type: 'OVERPAY_ADVANCE',
          customerID,
          customerName,
          amountNgn: amt,
          quotationRef: quotationRow.id,
          paymentMethod,
          bankReference,
          note: `Quote ${quotationRow.id} already settled in records — full payment to customer advance`,
          atISO: ts,
        },
      ],
    };
  }

  if (amt <= due) {
    return {
      ok: true,
      rows: [
        {
          type: 'RECEIPT',
          customerID,
          customerName,
          amountNgn: amt,
          quotationRef: quotationRow.id,
          paymentMethod,
          bankReference,
          note: amt < due ? 'Part payment (receipt)' : 'Full settlement (receipt)',
          atISO: ts,
        },
      ],
    };
  }

  const receiptPart = due;
  const over = amt - due;
  return {
    ok: true,
    rows: [
      {
        type: 'RECEIPT',
        customerID,
        customerName,
        amountNgn: receiptPart,
        quotationRef: quotationRow.id,
        paymentMethod,
        bankReference,
        note: 'Settlement to quotation balance (receipt)',
        atISO: ts,
      },
      {
        type: 'OVERPAY_ADVANCE',
        customerID,
        customerName,
        amountNgn: over,
        quotationRef: quotationRow.id,
        paymentMethod,
        bankReference,
        note: `Overpayment vs remaining balance on ${quotationRow.id} → advance`,
        atISO: ts,
      },
    ],
  };
}

export function planRefundAdvance(entries, { customerID, customerName, amountNgn, note }) {
  const bal = advanceBalanceFromEntries(entries, customerID);
  const amt = Math.round(Number(amountNgn) || 0);
  if (amt <= 0) return { ok: false, error: 'Enter a positive amount.' };
  if (amt > bal) return { ok: false, error: 'Refund cannot exceed advance balance.' };
  return {
    ok: true,
    rows: [
      {
        type: 'REFUND_ADVANCE',
        customerID,
        customerName,
        amountNgn: amt,
        note: note || 'Advance refunded to customer',
      },
    ],
  };
}

function normLedgerStr(v) {
  return String(v ?? '').trim();
}

/** Matches server `planReceiptWithQuotation` overpay note when payment exceeds quote due. */
const SPLIT_OVERPAY_NOTE_SNIP = 'Overpayment vs remaining balance on';

/**
 * When a customer pays more than the quote balance, the ledger stores RECEIPT (amount applied to the quote)
 * plus OVERPAY_ADVANCE (remainder). Rows from the same till payment share customer, quotation, atISO,
 * payment method, and bank reference. Returns a map RECEIPT entry id → companion overpay ₦ (for UI cash total).
 * @param {Array<{ id: string, type: string, customerID?: string, quotationRef?: string, atISO?: string, paymentMethod?: string, bankReference?: string, amountNgn?: number, note?: string }>} ledgerEntries
 * @returns {Map<string, number>}
 */
export function companionOverpayNgnByReceiptId(ledgerEntries) {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const groupKey = (e) =>
    [
      normLedgerStr(e.customerID),
      normLedgerStr(e.quotationRef),
      normLedgerStr(e.atISO),
      normLedgerStr(e.paymentMethod),
      normLedgerStr(e.bankReference),
    ].join('\u0001');

  const receipts = entries
    .filter((e) => e.type === 'RECEIPT' && normLedgerStr(e.quotationRef))
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const overpays = entries
    .filter(
      (e) =>
        e.type === 'OVERPAY_ADVANCE' &&
        normLedgerStr(e.quotationRef) &&
        String(e.note || '').includes(SPLIT_OVERPAY_NOTE_SNIP)
    )
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const bucket = (list) => {
    const m = new Map();
    for (const e of list) {
      const k = groupKey(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return m;
  };

  const rBy = bucket(receipts);
  const oBy = bucket(overpays);
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [k, rList] of rBy) {
    const oList = oBy.get(k) || [];
    for (let i = 0; i < rList.length; i++) {
      const o = oList[i];
      if (!o) continue;
      const n = Math.round(Number(o.amountNgn) || 0);
      if (n <= 0) continue;
      out.set(String(rList[i].id), n);
    }
  }
  return out;
}

/**
 * Map planned rows to receipt/overpay shape (frontend compatibility).
 * @param {Array<{ type: string }>} savedEntries - rows after assign id/atISO
 */
export function receiptResultFromSavedRows(savedEntries) {
  if (!savedEntries?.length) return { receipt: null, overpay: null };
  if (savedEntries.length === 1) {
    const [e] = savedEntries;
    if (e.type === 'RECEIPT') return { receipt: e, overpay: null };
    if (e.type === 'OVERPAY_ADVANCE') return { receipt: null, overpay: e };
  }
  if (savedEntries.length === 2) {
    return { receipt: savedEntries[0], overpay: savedEntries[1] };
  }
  return { receipt: null, overpay: null };
}
