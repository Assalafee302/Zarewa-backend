/**
 * Pure helpers for receipt posting safeguards (testable without HTTP/DB).
 */

export function normalizeReceiptReferenceToken(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * @param {Array<{ id: string, amount_ngn?: number, at_iso?: string, bank_reference?: string }>} rows
 * @param {{ amountNgn: unknown, bankReference?: string }} input
 */
export function receiptDuplicateSignalsFromLedgerRows(rows, { amountNgn, bankReference }) {
  const out = [];
  const amount = Math.round(Number(amountNgn) || 0);
  if (amount <= 0) return out;

  const list = Array.isArray(rows) ? rows : [];
  const refToken = normalizeReceiptReferenceToken(bankReference);

  for (const row of list) {
    const rowAmount = Math.round(Number(row.amount_ngn) || 0);
    if (rowAmount === amount) {
      out.push({
        code: 'DUPLICATE_AMOUNT',
        message: `A receipt with the same amount already exists (${row.id}).`,
        receiptId: row.id,
      });
      break;
    }
  }

  if (refToken) {
    for (const row of list) {
      const existingRef = normalizeReceiptReferenceToken(row.bank_reference);
      if (!existingRef) continue;
      if (existingRef.includes(refToken) || refToken.includes(existingRef)) {
        out.push({
          code: 'DUPLICATE_REFERENCE',
          message: `Reference appears to match an existing receipt (${row.id}).`,
          receiptId: row.id,
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Same customer paid the same amount on another quotation within a short window (duplicate entry risk).
 * @param {Array<{ quotation_ref?: string, amount_ngn?: number, at_iso?: string }>} rows — RECEIPT rows for this customer (recent)
 * @param {{ quotationId: string, amountNgn: number, dateISO?: string }} input
 */
export function receiptDuplicateAcrossQuotationsSignals(rows, { quotationId, amountNgn, dateISO }) {
  const out = [];
  const amount = Math.round(Number(amountNgn) || 0);
  const qid = String(quotationId || '').trim();
  const day = String(dateISO || '').slice(0, 10);
  if (!qid || amount <= 0) return out;

  for (const row of Array.isArray(rows) ? rows : []) {
    const otherRef = String(row.quotation_ref || '').trim();
    if (!otherRef || otherRef === qid) continue;
    const rowAmount = Math.round(Number(row.amount_ngn) || 0);
    if (rowAmount !== amount) continue;
    const rowDay = String(row.at_iso || '').slice(0, 10);
    if (day && rowDay && rowDay !== day) continue;
    out.push({
      code: 'DUPLICATE_AMOUNT_OTHER_QUOTATION',
      message: `Another quotation (${otherRef}) already has a receipt for ₦${amount.toLocaleString('en-NG')}${day ? ` on ${day}` : ''}.`,
      relatedQuotationId: otherRef,
    });
    break;
  }
  return out;
}
