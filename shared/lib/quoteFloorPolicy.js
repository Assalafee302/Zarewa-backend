/**
 * One floor for quote / cutting-list / MD below-floor gates.
 *
 * Floor is the material workbook `minimum_price_per_m_ngn`, never the published
 * list (floor + commission). A line stamp may freeze the gate **downward only**.
 * A stamp that equals the list/recommended badge is ignored — older clients
 * wrote list into `floorPricePerMeter`.
 *
 * Freeze (default `payment_lock`):
 * - first_payment: paid quotes lock workbook as of first receipt (else quote date)
 * - quotation_date: unpaid dated quotes lock as of quote date so later publishes
 *   do not mass-flag MD
 * - live: drafts with no date, or an explicit current-price check
 *
 * Frontend copies via sync → src/shared/lib/quoteFloorPolicy.js
 */
import { formatNgn } from './formatNgn.js';

export const QUOTE_FLOOR_FREEZE = {
  FIRST_PAYMENT: 'first_payment',
  QUOTATION_DATE: 'quotation_date',
  LIVE: 'live',
};

/**
 * Pick the gate floor for one quotation line.
 * Meter-sheet (roofing / flat sheet): never invent a min from a list stamp.
 *
 * @param {{
 *   workbookFloorNgn?: number | null;
 *   stampedFloorNgn?: number | null;
 *   listBadgeNgn?: number | null;
 *   meterSheet?: boolean;
 * }} input
 * @returns {{
 *   floorNgnPerM: number | null;
 *   source: 'workbook' | 'line_stamp';
 *   ignoredListStamp: boolean;
 *   stampedFloorNgnPerM: number;
 *   workbookFloorNgnPerM: number | null;
 * }}
 */
export function pickQuoteLineFloor(input = {}) {
  const meterSheet = input.meterSheet !== false;
  const listBadge = Math.round(Number(input.listBadgeNgn) || 0);
  let stamped = Math.round(Number(input.stampedFloorNgn) || 0);
  let ignoredListStamp = false;
  if (stamped > 0 && listBadge > 0 && stamped === listBadge) {
    stamped = 0;
    ignoredListStamp = true;
  }
  const workbook =
    input.workbookFloorNgn != null && Number(input.workbookFloorNgn) > 0
      ? Math.round(Number(input.workbookFloorNgn))
      : null;

  if (meterSheet) {
    if (workbook == null) {
      return {
        floorNgnPerM: null,
        source: 'workbook',
        ignoredListStamp,
        stampedFloorNgnPerM: stamped,
        workbookFloorNgnPerM: null,
      };
    }
    if (stamped > 0) {
      const floor = Math.min(stamped, workbook);
      return {
        floorNgnPerM: floor,
        source: floor === stamped ? 'line_stamp' : 'workbook',
        ignoredListStamp,
        stampedFloorNgnPerM: stamped,
        workbookFloorNgnPerM: workbook,
      };
    }
    return {
      floorNgnPerM: workbook,
      source: 'workbook',
      ignoredListStamp,
      stampedFloorNgnPerM: 0,
      workbookFloorNgnPerM: workbook,
    };
  }

  if (workbook != null && stamped > 0) {
    const floor = Math.min(stamped, workbook);
    return {
      floorNgnPerM: floor,
      source: floor === stamped ? 'line_stamp' : 'workbook',
      ignoredListStamp,
      stampedFloorNgnPerM: stamped,
      workbookFloorNgnPerM: workbook,
    };
  }
  if (stamped > 0) {
    return {
      floorNgnPerM: stamped,
      source: 'line_stamp',
      ignoredListStamp,
      stampedFloorNgnPerM: stamped,
      workbookFloorNgnPerM: workbook,
    };
  }
  return {
    floorNgnPerM: workbook,
    source: 'workbook',
    ignoredListStamp,
    stampedFloorNgnPerM: 0,
    workbookFloorNgnPerM: workbook,
  };
}

/**
 * @param {{ freezeEvent?: string | null; freezeDateIso?: string | null }} freeze
 */
export function describeQuoteFloorFreeze(freeze = {}) {
  const event = String(freeze.freezeEvent || '').trim();
  const day = String(freeze.freezeDateIso || '').trim().slice(0, 10);
  if (event === QUOTE_FLOOR_FREEZE.FIRST_PAYMENT) {
    return day
      ? `Workbook as of first payment (${day}). Later floor raises do not change this deal.`
      : 'Workbook as of first payment. Later floor raises do not change this deal.';
  }
  if (event === QUOTE_FLOOR_FREEZE.QUOTATION_DATE) {
    return day
      ? `Workbook as of quotation date (${day}) because this quote is unpaid. Later publishes do not mass-flag MD.`
      : 'Workbook as of quotation date because this quote is unpaid. Later publishes do not mass-flag MD.';
  }
  return 'Live workbook (draft with no quotation date, or an explicit current-price check).';
}

/**
 * Printable “why this floor” for a quote line (desk + PDF).
 *
 * @param {ReturnType<typeof pickQuoteLineFloor>} pick
 * @param {{ why?: string | null } | null} [freeze]
 */
export function describeQuoteLineFloor(pick, freeze = null) {
  const parts = [];
  if (pick?.ignoredListStamp) {
    parts.push('Ignored list-price stamp (equals recommended/list badge — not the workbook minimum).');
  }
  const floorNgn = pick?.floorNgnPerM;
  if (floorNgn == null || !(floorNgn > 0)) {
    parts.push('No workbook floor for this line — published list is not used as a minimum.');
  } else if (
    pick.source === 'line_stamp' &&
    pick.workbookFloorNgnPerM != null &&
    pick.stampedFloorNgnPerM > 0
  ) {
    parts.push(
      `Gate ${formatNgn(floorNgn)}/m from line stamp (workbook ${formatNgn(pick.workbookFloorNgnPerM)}/m). Stamp freezes downward only.`
    );
  } else {
    parts.push(`Gate ${formatNgn(floorNgn)}/m from material workbook minimum (not published list).`);
  }
  const freezeWhy = String(freeze?.why || '').trim();
  if (freezeWhy) parts.push(freezeWhy);
  return parts.join(' ');
}
