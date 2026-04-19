/** Keep in sync with server/quotationLifecycleOps.js */
export const QUOTATION_VALIDITY_DAYS = 10;
export const QUOTATION_FOLLOWUP_START_DAY = 5;

function parseIsoDate(s) {
  const t = String(s || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return new Date(`${t}T12:00:00.000Z`);
}

/** Calendar age of quote relative to today (client local UTC date string). */
export function quotationAgeCalendarDaysClient(quoteDateIso, todayIso = new Date().toISOString().slice(0, 10)) {
  const a = parseIsoDate(quoteDateIso);
  const b = parseIsoDate(todayIso);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

export function isQuotationArchivedRow(q) {
  if (!q) return false;
  if (q.archived) return true;
  const st = String(q.status || '').trim();
  return st === 'Expired' || st === 'Void';
}

/** Light-weight “needs follow-up” — no payment signal on the quote row (server may still have cutting lists). */
export function quotationLooksUncommittedForFollowUp(q) {
  if (!q) return true;
  if (Number(q.paidNgn) > 0) return false;
  const ps = String(q.paymentStatus || '').trim();
  if (ps && ps !== 'Unpaid') return false;
  return true;
}

/** Days 5–9 of validity: prompt sales to chase (quote still active). */
export function quotationNeedsFollowUpAlert(q) {
  if (isQuotationArchivedRow(q)) return false;
  const age = quotationAgeCalendarDaysClient(q.dateISO);
  if (age == null) return false;
  return (
    age >= QUOTATION_FOLLOWUP_START_DAY &&
    age < QUOTATION_VALIDITY_DAYS &&
    quotationLooksUncommittedForFollowUp(q)
  );
}
