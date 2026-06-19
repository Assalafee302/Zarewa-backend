/**
 * Unified selling-price resolution: setup_price_lists (primary) with specificity scoring,
 * then optional floor from price_list_items when extended keys match.
 */

import {
  normalizePricingAsAtIso,
  resolvePriceListItemFloorNgnAsOf,
  resolveSetupPriceListUnitNgnAsOf,
  resolveQuotedUnitPriceAsOf,
} from './pricingAsOf.js';

export {
  normalizePricingAsAtIso,
  quotationPricingAsAtIso,
  listPriceListItemsAsOf,
  listMaterialPricingRowsAsOf,
  floorPricePerMeterForGaugeDesignAsOf,
  workbookFloorPerMeterAsOf,
  workbookFloorMinPerMeterAsOf,
  resolveWorkbookRowStateAsOf,
  resolveQuotedUnitPriceAsOf,
  selectPriceListRowsAsOf,
} from './pricingAsOf.js';

/** Portable check (SQLite + MySQL); avoid sqlite_master on MySQL. */
export function canReadPriceListItems(db) {
  try {
    db.prepare(`SELECT 1 FROM price_list_items LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quoteItemId?: string,
 *   gaugeId?: string,
 *   colourId?: string,
 *   materialTypeId?: string,
 *   profileId?: string,
 *   branchId?: string | null,
 * }} ctx
 * @returns {{ unitPriceNgn: number, source: string, priceId?: string } | null}
 */
export function resolveSetupPriceListUnitNgn(db, ctx) {
  const asAt = normalizePricingAsAtIso(ctx?.asAtIso);
  return resolveSetupPriceListUnitNgnAsOf(db, ctx, asAt);
}

/**
 * Extended floor / list row from price_list_items (gauge_key, design_key, optional material/colour/profile keys).
 * @param {import('better-sqlite3').Database} db
 */
export function resolvePriceListItemFloorNgn(db, ctx) {
  const asAt = normalizePricingAsAtIso(ctx?.asAtIso);
  return resolvePriceListItemFloorNgnAsOf(db, ctx, asAt);
}

/**
 * Prefer setup list; fall back to price_list_items floor.
 */
export function resolveQuotedUnitPrice(db, ctx) {
  const asAt = normalizePricingAsAtIso(ctx?.asAtIso);
  return resolveQuotedUnitPriceAsOf(db, ctx, asAt);
}
