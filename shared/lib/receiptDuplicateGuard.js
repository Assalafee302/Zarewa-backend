/**
 * Finance Phase A (A2): a receipt for the same customer, same amount and the same quotation
 * (or the same cutting list) within 24 hours of another live receipt is blocked. Only a
 * Branch Manager / Operations Manager may post it, with a reason; the override is audited.
 */

export const RECEIPT_DUPLICATE_WINDOW_HOURS = 24;

function clean(v) {
  return String(v ?? '').trim();
}

function timeMs(iso) {
  const t = Date.parse(clean(iso));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {{ customerId: string, quotationRef?: string, cuttingListIds?: string[], amountNgn: number, atISO: string }} candidate
 * @param {Array<{ id: string, customerId: string, quotationRef?: string, cuttingListIds?: string[], amountNgn: number, atISO: string, reversed?: boolean }>} existing
 * @param {{ windowHours?: number }} [opts]
 * @returns {Array<{ id: string, quotationRef: string, atISO: string, matchedOn: 'quotation' | 'cutting_list', hoursApart: number }>}
 */
export function findReceiptDuplicatesWithinWindow(candidate, existing = [], { windowHours = RECEIPT_DUPLICATE_WINDOW_HOURS } = {}) {
  const customerId = clean(candidate?.customerId);
  const amount = Math.round(Number(candidate?.amountNgn) || 0);
  const at = timeMs(candidate?.atISO);
  if (!customerId || amount <= 0 || at == null) return [];
  const quote = clean(candidate?.quotationRef);
  const cls = new Set((candidate?.cuttingListIds || []).map(clean).filter(Boolean));
  const windowMs = windowHours * 3600 * 1000;
  const out = [];
  for (const row of Array.isArray(existing) ? existing : []) {
    if (!row || row.reversed) continue;
    if (clean(row.customerId) !== customerId) continue;
    if (Math.round(Number(row.amountNgn) || 0) !== amount) continue;
    const t = timeMs(row.atISO);
    if (t == null || Math.abs(t - at) > windowMs) continue;
    let matchedOn = null;
    if (quote && clean(row.quotationRef) === quote) matchedOn = 'quotation';
    else if ((row.cuttingListIds || []).some((id) => cls.has(clean(id)))) matchedOn = 'cutting_list';
    if (!matchedOn) continue;
    out.push({
      id: clean(row.id),
      quotationRef: clean(row.quotationRef),
      atISO: clean(row.atISO),
      matchedOn,
      hoursApart: Math.round((Math.abs(t - at) / 3600000) * 10) / 10,
    });
  }
  return out;
}

/** Refusal body for the receipt API when a 24-hour duplicate is found and no manager override is given. */
export function receiptDuplicateRefusal(matches, amountNgn) {
  const first = matches[0];
  const amount = Math.round(Number(amountNgn) || 0).toLocaleString('en-NG');
  const on = first.matchedOn === 'cutting_list' ? 'the same cutting list' : first.quotationRef;
  return {
    ok: false,
    code: 'RECEIPT_DUPLICATE_24H',
    error: `${first.id} already records ₦${amount} from this customer on ${on}, ${first.hoursApart} h apart. A Branch Manager or Operations Manager must post a second one, with a reason.`,
    duplicates: matches,
  };
}
