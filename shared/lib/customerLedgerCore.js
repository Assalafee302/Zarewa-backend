import { effectiveOutstandingNgn, rawOutstandingNgn } from './paymentOutstandingTolerance.js';
import { registerReceivableOutstandingNgn } from './receivableWriteOffPolicy.js';

/**
 * Pure customer-ledger rules (Zarewa payment model). Used by localStorage store and API server.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/customerLedgerCore.js
 * @typedef {'ADVANCE_IN'|'ADVANCE_APPLIED'|'RECEIPT'|'OVERPAY_ADVANCE'|'OVERPAY_APPLIED'|'OVERPAY_REVERSAL'|'REFUND_ADVANCE'|'REFUND_OVERPAY'|'RECEIPT_REVERSAL'|'ADVANCE_REVERSAL'} LedgerEntryType
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
  const overpayApplied = sumForQuotationInEntries(entries, id, 'OVERPAY_APPLIED');
  const receipts = sumForQuotationInEntries(entries, id, 'RECEIPT');
  const receiptReversals = sumForQuotationInEntries(entries, id, 'RECEIPT_REVERSAL');
  return Math.round(applied + overpayApplied + receipts - receiptReversals);
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
 * Customer-wide credit from quotation overpayments (split-till OVERPAY_ADVANCE), separate from voluntary deposits (ADVANCE_IN).
 * Reduced by OVERPAY_REVERSAL and by REFUND_OVERPAY when sales refunds pay out against this pool.
 * For **per-quotation** remaining split-till credit (used when a quote total increases), use
 * {@link overpayCreditRemainingOnQuotationFromEntries}.
 * @param {Array<{ customerID: string, type: string, amountNgn?: number }>} entries
 */
export function overpayCreditBalanceFromEntries(entries, customerID) {
  if (!customerID) return 0;
  return (entries || [])
    .filter((e) => e.customerID === customerID)
    .reduce((s, e) => {
      const n = Number(e.amountNgn) || 0;
      switch (e.type) {
        case 'OVERPAY_ADVANCE':
          return s + n;
        case 'OVERPAY_REVERSAL':
        case 'REFUND_OVERPAY':
          return s - n;
        default:
          return s;
      }
    }, 0);
}

/**
 * Same balance as {@link overpayCreditBalanceFromEntries}, computed for every customer in one pass.
 * @param {Array<{ customerID: string, type: string, amountNgn?: number }>} entries
 * @returns {Map<string, number>} customerID → positive unapplied overpay credit (₦); zero/negative omitted
 */
export function overpayCreditNgnByCustomerIdFromEntries(entries) {
  /** @type {Map<string, number>} */
  const sums = new Map();
  for (const e of entries || []) {
    const id = String(e?.customerID || '').trim();
    if (!id) continue;
    const n = Number(e.amountNgn) || 0;
    let delta = 0;
    if (e.type === 'OVERPAY_ADVANCE') delta = n;
    else if (e.type === 'OVERPAY_REVERSAL' || e.type === 'REFUND_OVERPAY') delta = -n;
    else continue;
    sums.set(id, (sums.get(id) || 0) + delta);
  }
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [id, sum] of sums) {
    const rounded = Math.round(sum);
    if (rounded > 0) out.set(id, rounded);
  }
  return out;
}

/**
 * Split-till overpayment credit **remaining on one quotation**: OVERPAY_ADVANCE on that quote minus
 * OVERPAY_REVERSAL on the same quote (e.g. auto-apply when total was raised). Does not include other
 * quotations' OVERPAY_ADVANCE rows for the same customer.
 * @param {Array<{ customerID: string, quotationRef?: string, type: string, amountNgn?: number }>} entries
 */
export function overpayCreditRemainingOnQuotationFromEntries(entries, customerID, quotationId) {
  const cid = String(customerID || '').trim();
  const qid = String(quotationId || '').trim();
  if (!cid || !qid) return 0;
  let adv = 0;
  let rev = 0;
  for (const e of entries || []) {
    if (String(e.customerID || '').trim() !== cid) continue;
    if (String(e.quotationRef || '').trim() !== qid) continue;
    const n = Math.round(Number(e.amountNgn) || 0);
    if (e.type === 'OVERPAY_ADVANCE') adv += n;
    else if (e.type === 'OVERPAY_REVERSAL') rev += n;
  }
  return Math.max(0, adv - rev);
}

/**
 * Amount still due on a quotation. Uses the quotation row only: `paidNgn` is maintained from **sales receipts**
 * plus **ADVANCE_APPLIED** and **OVERPAY_APPLIED** on the server. The `entries` argument is unused but kept
 * so call sites stay stable.
 * @param {unknown} _entries
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} q
 */
export function amountDueOnQuotationFromEntries(_entries, q) {
  if (!q?.id) return 0;
  const total = Math.round(Number(q.totalNgn) || 0);
  const rowPaid = Math.round(Number(q.paidNgn) || 0);
  return effectiveOutstandingNgn(total, rowPaid);
}

function toIsoDateOnly(value) {
  return String(value || '').slice(0, 10);
}

/**
 * True when at least one completed production job with metres exists for this quotation.
 * Unpaid quotes with no production are not receivable.
 * @param {string} quotationRef
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number }>} productionJobs
 */
export function quotationHasCompletedProduction(quotationRef, productionJobs = []) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return false;
  return (productionJobs || []).some((j) => {
    if (String(j?.status || '').trim() !== 'Completed') return false;
    if (String(j.quotationRef || '').trim() !== ref) return false;
    return (Number(j.actualMeters) || 0) > 0;
  });
}

/**
 * Earliest completion date for production on a quotation (aging basis for receivables).
 * @param {string} quotationRef
 * @param {Array<{ status?: string, quotationRef?: string, completedAtISO?: string, endDateISO?: string }>} productionJobs
 * @returns {string}
 */
export function firstProductionDateISO(quotationRef, productionJobs = []) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return '';
  let earliest = '';
  for (const j of productionJobs || []) {
    if (String(j?.status || '').trim() !== 'Completed') continue;
    if (String(j.quotationRef || '').trim() !== ref) continue;
    const iso = toIsoDateOnly(j.completedAtISO || j.endDateISO);
    if (!iso) continue;
    if (!earliest || iso < earliest) earliest = iso;
  }
  return earliest;
}

/**
 * Accounts receivable: balance still due only after completed production (pending balance on delivered work).
 * Quotes with no production output are excluded even if unpaid.
 * @param {unknown} entries
 * @param {{ id: string, totalNgn?: number, paidNgn?: number, dueDateISO?: string, dateISO?: string }} q
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>} productionJobs
 */
/** Waived balance on a quotation row (manager round-off / small balance write-off). */
export function quotationWaivedBalanceNgn(q) {
  return Math.round(Number(q?.paymentBalanceWaivedNgn ?? q?.payment_balance_waived_ngn) || 0);
}

/**
 * Accounts receivable outstanding — exact total minus paid minus manager waiver (no 99.5% tolerance).
 * @param {number} totalNgn
 * @param {number} paidNgn
 * @param {number} [waivedNgn]
 */
export function accountingReceivableOutstandingNgn(totalNgn, paidNgn, waivedNgn = 0) {
  const raw = rawOutstandingNgn(totalNgn, paidNgn);
  if (raw <= 0) return 0;
  const waived = Math.min(raw, Math.round(Number(waivedNgn) || 0));
  return Math.max(0, raw - waived);
}

export function receivableDueOnQuotationFromEntries(entries, q, productionJobs = []) {
  if (!quotationHasCompletedProduction(q?.id, productionJobs)) return 0;
  const total = Math.round(Number(q?.totalNgn ?? q?.total_ngn) || 0);
  const paid = Math.round(Number(q?.paidNgn ?? q?.paid_ngn) || 0);
  return registerReceivableOutstandingNgn(total, paid, quotationWaivedBalanceNgn(q));
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
 * Plan a quotation payment as one RECEIPT for the full cash amount (no RECEIPT/OVERPAY split at post time).
 * Finance may adjust allocation later via receipt split correction.
 * @param {unknown} entries — unused for due calculation (quotation row paid/total is authoritative).
 * @param {{
 *   customerID: string,
 *   customerName?: string,
 *   quotationRow: { id: string, totalNgn?: number, paidNgn?: number },
 *   amountNgn: number,
 *   paymentMethod?: string,
 *   bankReference?: string,
 *   dateISO?: string,
 *   fullAmountAsReceipt?: boolean,
 * }} opts — `fullAmountAsReceipt` is ignored (kept for API compatibility); always full amount on quote.
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
  const qid = quotationRow.id;
  let note = 'Payment (receipt)';
  if (due <= 0) {
    note = `Payment on ${qid} (quote already settled in records; full amount on quotation)`;
  } else if (amt > due) {
    note = `Payment on ${qid} (full amount on quotation; may exceed quote total)`;
  } else if (amt < due) {
    note = 'Part payment (receipt)';
  } else {
    note = 'Full settlement (receipt)';
  }

  return {
    ok: true,
    rows: [
      {
        type: 'RECEIPT',
        customerID,
        customerName,
        amountNgn: amt,
        quotationRef: qid,
        paymentMethod,
        bankReference,
        note,
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

/** Parse `REVERSAL_OF:<ledgerEntryId>` from reversal row metadata. */
export function reversalTargetIdFromLedgerRef(raw) {
  const m = String(raw ?? '').match(/REVERSAL_OF:([A-Za-z0-9-]+)/);
  return m ? m[1] : '';
}

/** ADVANCE_IN ids that have an ADVANCE_REVERSAL row. */
export function reversedAdvanceInEntryIdsFromEntries(entries) {
  const ids = new Set();
  for (const e of entries || []) {
    if (e.type !== 'ADVANCE_REVERSAL') continue;
    const tid = reversalTargetIdFromLedgerRef(e.bankReference || e.note);
    if (tid) ids.add(String(tid));
  }
  return ids;
}

/**
 * Remaining unused balance per ADVANCE_IN row (FIFO against customer ADVANCE_APPLIED + REFUND_ADVANCE).
 * @param {Array<{ id: string, customerID?: string, type: string, amountNgn?: number, atISO?: string }>} entries
 * @returns {Map<string, number>}
 */
export function advanceInRemainingNgnByIdFromEntries(entries) {
  const all = Array.isArray(entries) ? entries : [];
  const reversed = reversedAdvanceInEntryIdsFromEntries(all);
  /** @type {Map<string, Array<{ id: string, amountNgn: number, atISO?: string }>>} */
  const advancesByCustomer = new Map();

  for (const e of all) {
    if (e.type !== 'ADVANCE_IN') continue;
    const id = String(e.id || '').trim();
    if (!id || reversed.has(id)) continue;
    const cid = String(e.customerID || '').trim();
    if (!cid) continue;
    if (!advancesByCustomer.has(cid)) advancesByCustomer.set(cid, []);
    advancesByCustomer.get(cid).push({
      id,
      amountNgn: Math.round(Number(e.amountNgn) || 0),
      atISO: e.atISO,
    });
  }

  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const [cid, advList] of advancesByCustomer) {
    advList.sort((a, b) => {
      const d = String(a.atISO || '').localeCompare(String(b.atISO || ''));
      return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
    });
    for (const row of advList) {
      remaining.set(row.id, row.amountNgn);
    }

    let pool = 0;
    for (const e of all) {
      if (String(e.customerID || '').trim() !== cid) continue;
      const n = Math.round(Number(e.amountNgn) || 0);
      if (e.type === 'ADVANCE_APPLIED' || e.type === 'REFUND_ADVANCE') pool += n;
    }

    for (const row of advList) {
      if (pool <= 0) break;
      const cur = remaining.get(row.id) || 0;
      const take = Math.min(cur, pool);
      remaining.set(row.id, cur - take);
      pool -= take;
    }
  }

  return remaining;
}

/**
 * ADVANCE_IN rows still available to link (unused balance > 0), newest first.
 * Each row includes `originalAmountNgn` and `remainingNgn`; `amountNgn` is set to remaining for display.
 * @param {object[]} entries
 * @param {{ dismissedIds?: Set<string>|string[] }} [opts]
 */
export function pendingAdvanceDepositRowsFromEntries(entries, opts = {}) {
  const dismissed =
    opts.dismissedIds instanceof Set
      ? opts.dismissedIds
      : new Set((opts.dismissedIds || []).map(String));
  const remainingById = advanceInRemainingNgnByIdFromEntries(entries);
  const out = [];

  for (const e of entries || []) {
    if (e.type !== 'ADVANCE_IN') continue;
    const id = String(e.id || '').trim();
    if (!id || dismissed.has(id)) continue;
    const remainingNgn = remainingById.get(id);
    if (remainingNgn == null || remainingNgn <= 0) continue;
    const originalAmountNgn = Math.round(Number(e.amountNgn) || 0);
    out.push({
      ...e,
      originalAmountNgn,
      remainingNgn,
      amountNgn: remainingNgn,
    });
  }

  out.sort((a, b) => String(b.atISO || '').localeCompare(String(a.atISO || '')));
  return out;
}
