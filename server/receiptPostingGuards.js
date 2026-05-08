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
