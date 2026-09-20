/**
 * Quote-floor freeze date for MD / cutting-list gates.
 * Arithmetic lives in `shared/lib/quoteFloorPolicy.js`; this module only names
 * the freeze event from payment + quotation date.
 */
import { quotationPricingLockAsAtIso } from '../pricingAsOf.js';
import {
  QUOTE_FLOOR_FREEZE,
  describeQuoteFloorFreeze,
} from '../../shared/lib/quoteFloorPolicy.js';

function quotationDateIso(quoteRow) {
  const d = String(quoteRow?.date_iso ?? quoteRow?.dateISO ?? '')
    .trim()
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/**
 * @param {import('better-sqlite3').Database | null | undefined} db
 * @param {{
 *   id?: string;
 *   date_iso?: string | null;
 *   dateISO?: string | null;
 *   paid_ngn?: number | null;
 *   paidNgn?: number | null;
 * } | null | undefined} quoteRow
 * @param {{ pricingMode?: 'current' | 'quotation_date' | 'payment_lock' }} [opts]
 * @returns {{
 *   freezeEvent: string;
 *   freezeDateIso: string | null;
 *   asAtIso: string | undefined;
 *   why: string;
 * }}
 */
export function resolveQuoteFloorFreeze(db, quoteRow, opts = {}) {
  const quoteDateIso = quotationDateIso(quoteRow);
  const hasQuoteDate = Boolean(quoteDateIso);
  const lockIso = quotationPricingLockAsAtIso(db, quoteRow);
  const paid = Math.round(Number(quoteRow?.paid_ngn ?? quoteRow?.paidNgn) || 0) > 0;

  let freezeEvent = QUOTE_FLOOR_FREEZE.LIVE;
  let freezeDateIso = null;
  let asAtIso;

  if (opts.pricingMode === 'current') {
    freezeEvent = QUOTE_FLOOR_FREEZE.LIVE;
    asAtIso = undefined;
  } else if (opts.pricingMode === 'quotation_date') {
    freezeEvent = hasQuoteDate ? QUOTE_FLOOR_FREEZE.QUOTATION_DATE : QUOTE_FLOOR_FREEZE.LIVE;
    freezeDateIso = hasQuoteDate ? quoteDateIso : null;
    asAtIso = freezeDateIso || undefined;
  } else if (paid || lockIso) {
    freezeEvent = QUOTE_FLOOR_FREEZE.FIRST_PAYMENT;
    freezeDateIso = lockIso || quoteDateIso || null;
    asAtIso = freezeDateIso || undefined;
  } else if (hasQuoteDate) {
    freezeEvent = QUOTE_FLOOR_FREEZE.QUOTATION_DATE;
    freezeDateIso = quoteDateIso;
    asAtIso = quoteDateIso;
  } else {
    freezeEvent = QUOTE_FLOOR_FREEZE.LIVE;
    asAtIso = undefined;
  }

  return {
    freezeEvent,
    freezeDateIso,
    asAtIso,
    why: describeQuoteFloorFreeze({ freezeEvent, freezeDateIso }),
  };
}

export { QUOTE_FLOOR_FREEZE, pickQuoteLineFloor, describeQuoteLineFloor } from '../../shared/lib/quoteFloorPolicy.js';
