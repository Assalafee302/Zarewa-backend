/**
 * Coarse material family for production conversion standards (kg/m).
 * Used to avoid applying procurement_catalog rows from the wrong metal family
 * when coil_lots.material_type_name was corrected but product_id still points
 * at another SKU (e.g. Aluzinc product on an Aluminium coil lot).
 */

/** @param {string | null | undefined} label */
export function materialFamilyKeyForConversion(label) {
  const s = String(label ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('alumin')) return 'aluminium';
  if (s.includes('aluz')) return 'aluzinc';
  if (s.includes('galval')) return 'aluzinc';
  if (s.includes('stone')) return 'stone';
  return null;
}

/**
 * When both sides resolve to a known family and they differ, procurement catalogue
 * tied to product_id must not override the coil's stated material.
 * @param {string | null | undefined} coilMaterialTypeName
 * @param {string | null | undefined} productMaterialType
 */
export function coilAndProductMaterialFamiliesConflict(coilMaterialTypeName, productMaterialType) {
  const coilKey = materialFamilyKeyForConversion(coilMaterialTypeName);
  if (!coilKey) return false;
  const productKey = materialFamilyKeyForConversion(productMaterialType);
  if (!productKey) return false;
  return coilKey !== productKey;
}
