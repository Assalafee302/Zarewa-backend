/**
 * Stone-coated metre SKUs and helpers (no coil_lots).
 */

import { INVENTORY_MODEL, STONE_COATED_MATERIAL_TYPE_ID } from './inventoryConstants.js';
import { normalizeStoneFlatsheetLengthM } from '../shared/lib/stoneCoatedQuotationPolicy.js';
import { getProductRowForWorkspace } from './productBranchInventory.js';

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

function productRowForLookup(db, productId, branchId) {
  const pid = String(productId || '').trim();
  if (!pid) return null;
  const bid = String(branchId ?? '').trim();
  if (bid) {
    return (
      getProductRowForWorkspace(db, pid, bid) ??
      db.prepare(`SELECT * FROM products WHERE product_id = ? LIMIT 1`).get(pid)
    );
  }
  return db.prepare(`SELECT * FROM products WHERE product_id = ? LIMIT 1`).get(pid);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} [branchId]
 */
export function inventoryModelForProductId(db, productId, branchId) {
  const row = productRowForLookup(db, productId, branchId);
  const attrs = parseProductDashboardAttrs(row);
  if (attrs.inventoryModel) return String(attrs.inventoryModel);
  return null;
}

export function isStoneMeterProductRow(productRow) {
  if (!productRow) return false;
  const attrs = parseProductDashboardAttrs(productRow);
  if (attrs.stoneFlatsheet) return true;
  if (attrs.inventoryModel === INVENTORY_MODEL.STONE_METER) return true;
  if (String(productRow.unit || '').toLowerCase() === 'm' && attrs.stoneDesign) return true;
  return String(productRow.product_id || '').startsWith('STONE-');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} [branchId]
 */
export function isStoneMeterProductId(db, productId, branchId) {
  return isStoneMeterProductRow(productRowForLookup(db, productId, branchId));
}

/**
 * Stone-coated roofing **metre** raw stock (design / colour / gauge), not stone flatsheet m² SKUs.
 * Stock for this class may go negative when production posts consumption without enough on-hand metres.
 */
export function isStoneFlatsheetProductRow(productRow) {
  if (!productRow) return false;
  const attrs = parseProductDashboardAttrs(productRow);
  if (attrs.stoneFlatsheet) return true;
  return /^STONE-FS-/i.test(String(productRow.product_id || ''));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} [branchId]
 */
export function isStoneFlatsheetProductId(db, productId, branchId) {
  return isStoneFlatsheetProductRow(productRowForLookup(db, productId, branchId));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} [branchId]
 */
export function isStoneCoatedMetreProductId(db, productId, branchId) {
  const row = productRowForLookup(db, productId, branchId);
  if (!row) return false;
  const attrs = parseProductDashboardAttrs(row);
  if (attrs.stoneFlatsheet) return false;
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
  const branchId = String(spec.branchId ?? '').trim() || 'BR-KD';
  const existing = db
    .prepare(`SELECT product_id FROM products WHERE product_id = ? AND branch_id = ?`)
    .get(id, branchId);
  if (existing) return id;

  const name = `Stone coated ${designLabel} / ${colourLabel} / ${gaugeLabel}`.replace(/\s+/g, ' ').trim();
  const dash = JSON.stringify({
    inventoryModel: INVENTORY_MODEL.STONE_METER,
    stoneDesign: designLabel,
    stoneColour: colourLabel,
    stoneGauge: gaugeLabel,
    materialTypeId: STONE_COATED_MATERIAL_TYPE_ID,
  });
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
 * Stable product_id for stone flatsheet (m² stock) by colour + length (1.4 m or 2 m).
 * Legacy 1.5 length is normalized to 1.4 before calling this.
 * @param {string} colourLabel
 * @param {1.4 | 2} lengthNormalized
 */
export function stoneFlatsheetProductIdFromSpec(colourLabel, lengthNormalized) {
  const a = slugPart(colourLabel) || 'x';
  const slug = lengthNormalized === 1.4 ? '1p4m' : '2m';
  return `STONE-FS-${a}-${slug}`;
}

/**
 * Ensure a stone flatsheet SKU exists (m² unit, colour + length only).
 * @param {import('better-sqlite3').Database} db
 * @param {{ colourLabel: string, lengthM: unknown, branchId?: string }} spec
 */
export function ensureStoneFlatsheetProduct(db, spec) {
  const colourLabel = String(spec.colourLabel || '').trim();
  const lengthM = normalizeStoneFlatsheetLengthM(spec.lengthM);
  if (!colourLabel || lengthM == null) {
    throw new Error('Stone flatsheet requires colour and length (1.4 m or 2 m).');
  }
  const id = stoneFlatsheetProductIdFromSpec(colourLabel, lengthM);
  const branchId = String(spec.branchId ?? '').trim() || 'BR-KD';
  const existing = db
    .prepare(`SELECT product_id FROM products WHERE product_id = ? AND branch_id = ?`)
    .get(id, branchId);
  if (existing) return id;

  const name = `Stone flatsheet ${colourLabel} / ${lengthM} m`.replace(/\s+/g, ' ').trim();
  const dash = JSON.stringify({
    inventoryModel: INVENTORY_MODEL.STONE_METER,
    stoneFlatsheet: true,
    stoneFlatsheetLengthM: lengthM,
    stoneFlatsheetColour: colourLabel,
    materialTypeId: STONE_COATED_MATERIAL_TYPE_ID,
  });
  db.prepare(
    `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    0,
    'm2',
    0,
    0,
    '',
    colourLabel,
    'Stone coated',
    dash,
    branchId
  );
  return id;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | string | null | undefined} linesJson — quotation lines_json object or JSON string
 */
export function isStoneMeterQuotationLinesJson(db, linesJson) {
  let j = linesJson;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j || '{}');
    } catch {
      j = {};
    }
  }
  j = j && typeof j === 'object' ? j : {};
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
 * @param {object} quotation — row with lines_json, optional branch_id
 * @param {string} [branchId] workspace / job branch (defaults quotation.branch_id or BR-KD)
 */
export function resolveStoneRawProductIdForQuotation(db, quotation, branchId) {
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
  const bid =
    String(branchId ?? quotation?.branch_id ?? '').trim() || 'BR-KD';
  return ensureStoneProduct(db, {
    designLabel: design,
    colourLabel: colour,
    gaugeLabel: gauge,
    branchId: bid,
  });
}
