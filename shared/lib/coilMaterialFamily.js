/**
 * Coarse material family for production conversion standards (kg/m).
 * Used to avoid applying procurement_catalog rows from the wrong metal family
 * when coil_lots.material_type_name was corrected but product_id still points
 * at another SKU (e.g. Aluzinc product on an Aluminium coil lot).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/coilMaterialFamily.js
 */

/** @param {string | null | undefined} label */
export function materialFamilyKeyForConversion(label) {
  const s = String(label ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('alumin')) return 'aluminium';
  if (s === 'alu' || s.startsWith('alu ') || s.startsWith('alu-') || s.startsWith('alu.')) return 'aluminium';
  if (s.includes('aluz')) return 'aluzinc';
  if (s.includes('galval')) return 'aluzinc';
  if (s.includes('stone')) return 'stone';
  return null;
}

/**
 * Prefer raw coil label, then Setup master name (exact match on coil label).
 * @param {string | null | undefined} coilMaterialTypeName
 * @param {string | null | undefined} setupMaterialTypeCanonicalName from setup_material_types.name
 */
export function resolveCoilMaterialFamilyKey(coilMaterialTypeName, setupMaterialTypeCanonicalName) {
  const k0 = materialFamilyKeyForConversion(coilMaterialTypeName);
  if (k0) return k0;
  return materialFamilyKeyForConversion(setupMaterialTypeCanonicalName);
}

/**
 * Catalogue is keyed by product_id. When the coil lot states a known metal family,
 * only use procurement_catalog if products.material_type resolves to that same family.
 * If the coil metal is unknown, keep legacy behaviour (trust catalogue for product_id).
 * @param {string | null | undefined} coilFamilyKey from resolveCoilMaterialFamilyKey
 * @param {string | null | undefined} productMaterialType from products.material_type
 */
export function procurementCatalogMaterialAlignedWithCoil(coilFamilyKey, productMaterialType) {
  if (!coilFamilyKey) return true;
  const productKey = materialFamilyKeyForConversion(productMaterialType);
  return productKey === coilFamilyKey;
}
