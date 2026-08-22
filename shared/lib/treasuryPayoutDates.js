/**
 * Per-line payout dates become treasury movement posted_at_iso (statements, reports, period locks).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/treasuryPayoutDates.js
 */

export function payoutLinePostedDay(line, fallbackDay = '') {
  const raw = String(line?.dateISO ?? line?.postedAtISO ?? line?.paidAtISO ?? '').trim();
  const day = raw.slice(0, 10);
  const fb = String(fallbackDay || '').trim().slice(0, 10);
  return day || fb || new Date().toISOString().slice(0, 10);
}

export function payoutLinePostedAtISO(line, fallbackDay = '', normalizeIsoTimestamp) {
  const day = payoutLinePostedDay(line, fallbackDay);
  if (typeof normalizeIsoTimestamp === 'function' && day.includes('T')) {
    return normalizeIsoTimestamp(day);
  }
  return `${day}T12:00:00.000Z`;
}

/** Latest YYYY-MM-DD among payout lines (header paid_at_iso when batch has mixed dates). */
export function latestPayoutDay(lines, getDay, fallbackDay = '') {
  const days = (lines || []).map((line) => getDay(line)).filter(Boolean);
  if (!days.length) return payoutLinePostedDay({}, fallbackDay);
  return days.sort().pop();
}
