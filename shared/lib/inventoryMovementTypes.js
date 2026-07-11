/**
 * Inventory-only stock movement types (excludes PO/treasury/finance noise).
 */
export const INVENTORY_MOVEMENT_TYPES = Object.freeze([
  'STORE_GRN',
  'STORE_GRN_STONE',
  'STORE_GRN_STONE_FLATSHEET',
  'STORE_GRN_ACCESSORY',
  'STORE_STONE_DIRECT',
  'STORE_STONE_FLATSHEET_DIRECT',
  'STORE_ACCESSORY_DIRECT',
  'ADJUSTMENT',
  'TRANSFER_TO_PRODUCTION',
  'WIP_CONSUMED',
  'FINISHED_GOODS',
  'COIL_CONSUMPTION',
  'COIL_SCRAP',
  'COIL_RETURN',
  'COIL_SPLIT',
  'SCRAP_INVENTORY',
  'CUSTOMER_DELIVERY',
]);

export function isInventoryMovementType(type) {
  return INVENTORY_MOVEMENT_TYPES.includes(String(type || '').trim());
}

/** ANNEX-H default variance investigation thresholds (fraction). */
export const STOCK_VARIANCE_THRESHOLDS = Object.freeze({
  coilKg: 0.01,
  finishedGoodsM: 0.02,
  accessories: 0.05,
});

/** Thin-coil / finish-roll threshold (kg) — keep one number across Ops UI. */
export const THIN_COIL_KG_THRESHOLD = 85;
