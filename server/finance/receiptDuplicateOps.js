/**
 * Finance Phase A (A2): load the live receipts that could be a 24-hour duplicate of a new one.
 * Rule: shared/lib/receiptDuplicateGuard.js.
 */
import { findReceiptDuplicatesWithinWindow } from '../../shared/lib/receiptDuplicateGuard.js';

function clean(v) {
  return String(v ?? '').trim();
}

function cuttingListIdsByQuotation(db, quotationRefs) {
  const refs = [...new Set(quotationRefs.map(clean).filter(Boolean))];
  const map = new Map(refs.map((r) => [r, []]));
  if (!refs.length) return map;
  const rows = db
    .prepare(`SELECT id, quotation_ref FROM cutting_lists WHERE quotation_ref IN (${refs.map(() => '?').join(',')})`)
    .all(...refs);
  for (const row of rows) map.get(clean(row.quotation_ref))?.push(clean(row.id));
  return map;
}

/** When the new receipt is dated today (or undated) it is "now"; otherwise its bank date at the current time of day. */
export function receiptCandidateAtISO(dateISO, now = new Date()) {
  const day = clean(dateISO).slice(0, 10);
  const iso = now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return iso;
  return `${day}${iso.slice(10)}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ customerID: string, quotationId: string, amountNgn: number, dateISO?: string }} p
 */
export function receiptDuplicatesWithin24h(db, { customerID, quotationId, amountNgn, dateISO }) {
  const customerId = clean(customerID);
  const amount = Math.round(Number(amountNgn) || 0);
  if (!customerId || amount <= 0) return [];
  const rows = db
    .prepare(
      `SELECT sr.id, sr.customer_id, sr.quotation_ref, sr.amount_ngn, sr.status, sr.date_iso, le.at_iso
       FROM sales_receipts sr
       LEFT JOIN ledger_entries le ON le.id = sr.ledger_entry_id
       WHERE sr.customer_id = ? AND sr.amount_ngn = ?`
    )
    .all(customerId, amount);
  const clByQuote = cuttingListIdsByQuotation(db, [quotationId, ...rows.map((r) => r.quotation_ref)]);
  const existing = rows.map((r) => ({
    id: clean(r.id),
    customerId: clean(r.customer_id),
    quotationRef: clean(r.quotation_ref),
    cuttingListIds: clByQuote.get(clean(r.quotation_ref)) || [],
    amountNgn: Math.round(Number(r.amount_ngn) || 0),
    atISO: clean(r.at_iso) || clean(r.date_iso),
    reversed: /revers/i.test(clean(r.status)),
  }));
  return findReceiptDuplicatesWithinWindow(
    {
      customerId,
      quotationRef: clean(quotationId),
      cuttingListIds: clByQuote.get(clean(quotationId)) || [],
      amountNgn: amount,
      atISO: receiptCandidateAtISO(dateISO),
    },
    existing
  );
}
