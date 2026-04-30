/**
 * Stone-coated metre SKUs and helpers (no coil_lots).
 */

import { INVENTORY_MODEL, STONE_COATED_MATERIAL_TYPE_ID } from './inventoryConstants.js';

function slugPart(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, 48);
}

/**
 * Stable product_id for a stone SKU from human-readable dimensions.
 */
export function stoneProductIdFromSpec(designLabel, colourLabel, gaugeLabel) {
  const a = slugPart(designLabel) || 'x';
  const b = slugPart(colourLabel) || 'x';
  const c = slugPart(gaugeLabel) || 'x';
  return `STONE-${a}-${b}-${c}`;
}

export function parseProductDashboardAttrs(row) {
  if (!row?.dashboard_attrs_json) return {};
  try {
    const j = JSON.parse(row.dashboard_attrs_json);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialTypeId
 */
export function inventoryModelForMaterialTypeId(db, materialTypeId) {
  const id = String(materialTypeId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(`SELECT inventory_model FROM setup_material_types WHERE material_type_id = ?`)
    .get(id);
  return row?.inventory_model != null ? String(row.inventory_model).trim() || null : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 */
export function inventoryModelForProductId(db, productId) {
  const pid = String(productId || '').trim();
  if (!pid) return null;
  const row = db.prepare(`SELECT dashboard_attrs_json FROM products WHERE product_id = ?`).get(pid);
  const attrs = parseProductDashboardAttrs(row);
  if (attrs.inventoryModel) return String(attrs.inventoryModel);
  return null;
}

export function isStoneMeterProductRow(productRow) {
  if (!productRow) return false;
  const attrs = parseProductDashboardAttrs(productRow);
  if (attrs.inventoryModel === INVENTORY_MODEL.STONE_METER) return true;
  if (String(productRow.unit || '').toLowerCase() === 'm' && attrs.stoneDesign) return true;
  return String(productRow.product_id || '').startsWith('STONE-');
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function isStoneMeterProductId(db, productId) {
  const row = db.prepare(`SELECT * FROM products WHERE product_id = ?`).get(productId);
  return isStoneMeterProductRow(row);
}

/**
 * Ensure a metre-based stone product exists; returns product_id.
 * @param {import('better-sqlite3').Database} db
 * @param {{ designLabel: string, colourLabel: string, gaugeLabel: string, branchId?: string }} spec
 */
export function ensureStoneProduct(db, spec) {
  const designLabel = String(spec.designLabel || '').trim();
  const colourLabel = String(spec.colourLabel || '').trim();
  const gaugeLabel = String(spec.gaugeLabel || '').trim();
  const id = stoneProductIdFromSpec(designLabel, colourLabel, gaugeLabel);
  const existing = db.prepare(`SELECT product_id FROM products WHERE product_id = ?`).get(id);
  if (existing) return id;

  const name = `Stone coated ${designLabel} / ${colourLabel} / ${gaugeLabel}`.replace(/\s+/g, ' ').trim();
  const dash = JSON.stringify({
    inventoryModel: INVENTORY_MODEL.STONE_METER,
    stoneDesign: designLabel,
    stoneColour: colourLabel,
    stoneGauge: gaugeLabel,
    materialTypeId: STONE_COATED_MATERIAL_TYPE_ID,
  });
  const branchId = String(spec.branchId ?? '').trim() || '';
  db.prepare(
    `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    0,
    'm',
    0,
    0,
    gaugeLabel,
    colourLabel,
    'Stone coated',
    dash,
    branchId
  );
  return id;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} linesJson — quotation lines_json object
 */
export function isStoneMeterQuotationLinesJson(db, linesJson) {
  const j = linesJson && typeof linesJson === 'object' ? linesJson : {};
  const mid = String(j.materialTypeId || '').trim();
  if (mid === STONE_COATED_MATERIAL_TYPE_ID) return true;
  if (mid) {
    const m = inventoryModelForMaterialTypeId(db, mid);
    if (m === INVENTORY_MODEL.STONE_METER) return true;
  }
  return false;
}

/**
 * Resolve stone raw product from quotation header spec.
 * @param {import('better-sqlite3').Database} db
 * @param {object} quotation — row with lines_json
 */
export function resolveStoneRawProductIdForQuotation(db, quotation) {
  if (!quotation?.lines_json) return null;
  let j = {};
  try {
    j = JSON.parse(String(quotation.lines_json));
  } catch {
    return null;
  }
  if (!isStoneMeterQuotationLinesJson(db, j)) return null;
  const design = String(j.materialDesign || '').trim();
  const colour = String(j.materialColor || '').trim();
  const gauge = String(j.materialGauge || '').trim();
  if (!design || !colour || !gauge) return null;
  return ensureStoneProduct(db, { designLabel: design, colourLabel: colour, gaugeLabel: gauge });
}
