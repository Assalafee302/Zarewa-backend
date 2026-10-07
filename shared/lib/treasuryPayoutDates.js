/**
 * Per-line payout dates become treasury movement posted_at_iso (statements, reports, period locks).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/treasuryPayoutDates.js
 *
 * A typed line date that is not a real calendar day throws. It is never sliced into a
 * string like "262026-09-T12:00:00.000Z" (TM-2780) and never silently replaced by the fallback.
 */
import { IsoTimestampError, lagosCalendarDay, parseIsoTimestamp } from './isoTimestamp.js';

function validDayOrThrow(raw, label) {
  const parsed = parseIsoTimestamp(raw);
  if (!parsed.ok) throw new IsoTimestampError(`${label}: ${parsed.error}`, parsed.code);
  return parsed.day;
}

export function payoutLinePostedDay(line, fallbackDay = '') {
  const raw = String(line?.dateISO ?? line?.postedAtISO ?? line?.paidAtISO ?? '').trim();
  if (raw) return validDayOrThrow(raw, 'Payment line date');
  const fb = String(fallbackDay || '').trim();
  if (fb) return validDayOrThrow(fb, 'Payment date');
  return lagosCalendarDay();
}

/**
 * Day-only inputs post at noon UTC (stable calendar day across Lagos/UTC).
 * A full timestamp on the line is kept as written so vouchers show the real transfer time
 * (e.g. 17:39) instead of collapsing to noon or a date-only 01:00 Lagos display.
 */
export function payoutLinePostedAtISO(line, fallbackDay = '', _normalizeIsoTimestamp) {
  const raw = String(line?.dateISO ?? line?.postedAtISO ?? line?.paidAtISO ?? '').trim();
  if (raw.includes('T')) {
    const parsed = parseIsoTimestamp(raw);
    if (!parsed.ok) throw new IsoTimestampError(`Payment line date: ${parsed.error}`, parsed.code);
    return parsed.iso;
  }
  return `${payoutLinePostedDay(line, fallbackDay)}T12:00:00.000Z`;
}

/** Latest YYYY-MM-DD among payout lines (header paid_at_iso when batch has mixed dates). */
export function latestPayoutDay(lines, getDay, fallbackDay = '') {
  const days = (lines || []).map((line) => getDay(line)).filter(Boolean);
  if (!days.length) return payoutLinePostedDay({}, fallbackDay);
  return days.sort().pop();
}

/** Latest full posted-at among payout lines (prefer over date-only paid_at_iso on vouchers). */
export function latestPayoutPostedAtISO(lines, fallbackDay = '') {
  const stamps = (lines || [])
    .map((line) => {
      try {
        return payoutLinePostedAtISO(line, fallbackDay);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (!stamps.length) {
    return payoutLinePostedAtISO({}, fallbackDay);
  }
  return stamps.sort().pop();
}
