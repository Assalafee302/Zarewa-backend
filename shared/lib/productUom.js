/**
 * Accessory / stone pack-size conversion (base unit ↔ pack units).
 * Quotes stay in base units; PO / GRN / count may choose a pack unit.
 */

/**
 * @typedef {{ unitCode: string, factorToBase: number, label?: string, active?: boolean }} PackSize
 */

/**
 * @param {number} qty
 * @param {number} factorToBase — how many base units in one of this pack unit
 */
export function toBaseQty(qty, factorToBase) {
  const q = Number(qty);
  const f = Number(factorToBase);
  if (!Number.isFinite(q) || !Number.isFinite(f) || f <= 0) return 0;
  return q * f;
}

/**
 * @param {number} baseQty
 * @param {number} factorToBase
 */
export function fromBaseQty(baseQty, factorToBase) {
  const q = Number(baseQty);
  const f = Number(factorToBase);
  if (!Number.isFinite(q) || !Number.isFinite(f) || f <= 0) return 0;
  return q / f;
}

/**
 * @param {string | null | undefined} unitCode
 * @param {string | null | undefined} baseUnit
 * @param {PackSize[]} packSizes
 * @returns {number} factor to base (1 for base unit / unknown)
 */
export function factorForUnit(unitCode, baseUnit, packSizes = []) {
  const code = String(unitCode || '')
    .trim()
    .toLowerCase();
  const base = String(baseUnit || '')
    .trim()
    .toLowerCase();
  if (!code || !base || code === base) return 1;
  for (const p of packSizes || []) {
    if (p?.active === false) continue;
    const uc = String(p.unitCode || p.unit_code || '')
      .trim()
      .toLowerCase();
    if (uc && uc === code) {
      const f = Number(p.factorToBase ?? p.factor_to_base);
      if (Number.isFinite(f) && f > 0) return f;
    }
  }
  return 1;
}

/**
 * @param {number} qtyInUnit
 * @param {string} unitCode
 * @param {string} baseUnit
 * @param {PackSize[]} packSizes
 */
export function qtyToBase(qtyInUnit, unitCode, baseUnit, packSizes) {
  return toBaseQty(qtyInUnit, factorForUnit(unitCode, baseUnit, packSizes));
}

/**
 * Human display: "2 cartons = 60 packs"
 * @param {number} qtyInUnit
 * @param {string} unitCode
 * @param {string} baseUnit
 * @param {PackSize[]} packSizes
 * @param {{ unitLabel?: string, baseLabel?: string }} [labels]
 */
export function formatQtyBothUnits(qtyInUnit, unitCode, baseUnit, packSizes, labels = {}) {
  const unit = String(unitCode || baseUnit || 'unit').trim() || 'unit';
  const base = String(baseUnit || 'unit').trim() || 'unit';
  const q = Number(qtyInUnit) || 0;
  const factor = factorForUnit(unit, base, packSizes);
  const baseQty = toBaseQty(q, factor);
  const unitLabel = labels.unitLabel || unit;
  const baseLabel = labels.baseLabel || base;
  if (factor === 1 || unit.toLowerCase() === base.toLowerCase()) {
    return `${trimNum(q)} ${baseLabel}`;
  }
  return `${trimNum(q)} ${unitLabel} = ${trimNum(baseQty)} ${baseLabel}`;
}

function trimNum(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Identity pack row for a product with no configured cartons.
 * @param {string} baseUnit
 */
export function identityPackSize(baseUnit) {
  const u = String(baseUnit || 'unit').trim() || 'unit';
  return { unitCode: u, factorToBase: 1, label: u, active: true };
}
