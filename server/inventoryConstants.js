/**
 * Inventory behaviour routing (single source of truth for “coil vs stone vs consumable”).
 * UI does not expose a separate “material family”; material type rows carry inventory_model.
 */

export const INVENTORY_MODEL = {
  COIL_KG: 'coil_kg',
  STONE_METER: 'stone_meter',
  FINISHED_GOOD: 'finished_good',
  CONSUMABLE: 'consumable',
};

/** Seeded material type id for stone-coated (metre stock). */
export const STONE_COATED_MATERIAL_TYPE_ID = 'MAT-005';

/** Display label for fourth stone profile (industry-standard spelling). */
export const STONE_PROFILE_SHINGLE_LABEL = 'Shingle';

/**
 * Default accounting: mirror coil GRN — DR Raw materials inventory (1300), CR GRNI (2100).
 * Stone and accessory receipts use the same pattern unless finance configures otherwise.
 */
export const GL_STONE_RECEIPT_MEMO = 'Stone-coated receipt';
export const GL_ACCESSORY_RECEIPT_MEMO = 'Accessory inventory receipt';
