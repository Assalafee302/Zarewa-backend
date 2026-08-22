/**
 * Single source of truth for coil strip density standards used by
 * procurement catalog, material pricing workbook, and related UIs.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/coilDensityStandard.js
 */

/** @type {readonly string[]} */
export const STANDARD_COIL_GAUGES_MM = Object.freeze([
  '0.18',
  '0.20',
  '0.22',
  '0.24',
  '0.28',
  '0.30',
  '0.40',
  '0.45',
  '0.50',
  '0.55',
  '0.70',
]);

/** Strip width for theoretical mass per metre (metres). */
export const COIL_STRIP_WIDTH_M = 1.2;

/** Mass density in g/cm³ (×1000 → kg/m³). */
export const DENSITY_ALUMINIUM_G_CM3 = 2.7;
export const DENSITY_ALUZINC_G_CM3 = 7.8;

/** Coil materials for density-based standard conversion (maps to stock product_id). */
export const PROCUREMENT_COIL_MATERIALS = Object.freeze([
  { key: 'alu', label: 'Aluminium', productID: 'COIL-ALU', defaultCatalogLabel: 'Aluminium' },
  { key: 'aluzinc', label: 'Aluzinc (PPGI)', productID: 'PRD-102', defaultCatalogLabel: 'Aluzinc (PPGI)' },
]);

/**
 * @param {string} materialKey
 * @returns {{ key: string; label: string; productID: string; defaultCatalogLabel: string }}
 */
export function procurementCoilMaterialByKey(materialKey) {
  const k = String(materialKey || '')
    .trim()
    .toLowerCase();
  return PROCUREMENT_COIL_MATERIALS.find((m) => m.key === k) ?? PROCUREMENT_COIL_MATERIALS[0];
}

/**
 * @param {string} materialKey
 * @returns {string}
 */
export function productIdForMaterialKey(materialKey) {
  const k = String(materialKey || '')
    .trim()
    .toLowerCase();
  if (k === 'alu') return 'COIL-ALU';
  if (k === 'aluzinc') return 'PRD-102';
  return '';
}

/**
 * @param {string} materialKey
 * @returns {number | null} kg/m³
 */
export function densityKgPerM3ForMaterialKey(materialKey) {
  const k = String(materialKey || '')
    .trim()
    .toLowerCase();
  if (k === 'alu') return DENSITY_ALUMINIUM_G_CM3 * 1000;
  if (k === 'aluzinc') return DENSITY_ALUZINC_G_CM3 * 1000;
  return null;
}

/**
 * Theoretical kg/m: ρ (kg/m³) × strip width (m) × thickness (m); gaugeMm is thickness in mm.
 * @param {string} materialKey
 * @param {number} gaugeMm
 * @returns {number | null}
 */
export function theoreticalKgPerM(materialKey, gaugeMm) {
  const rho = densityKgPerM3ForMaterialKey(materialKey);
  if (rho == null || !Number.isFinite(gaugeMm) || gaugeMm <= 0) return null;
  return rho * COIL_STRIP_WIDTH_M * (gaugeMm / 1000);
}

/** Alias used by pricing ops / FE. */
export const theoreticalStandardKgPerM = theoreticalKgPerM;
export const kgPerMFromStripDensity = theoreticalKgPerM;

/**
 * Map a thickness in mm to a standard workbook gauge key, or null.
 * @param {number} mm
 * @returns {string | null}
 */
export function standardGaugeKeyForMm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  for (const g of STANDARD_COIL_GAUGES_MM) {
    if (Math.abs(parseFloat(g, 10) - mm) < 1e-4) return g;
  }
  return null;
}
