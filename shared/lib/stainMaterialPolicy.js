/**
 * Stain material (damaged-coil seconds): Type of material MAT-006.
 * Floor is the parent workbook floor minus ₦1,000. Stock is coil_stain incident metres,
 * and stained sections may also remain on a coil already in production.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/stainMaterialPolicy.js
 */

export const STAIN_MATERIAL_TYPE_ID = 'MAT-006';
export const STAIN_INVENTORY_MODEL = 'stain_meter';
export const STONE_COATED_MATERIAL_TYPE_ID = 'MAT-005';
export const STONE_INVENTORY_MODEL = 'stone_meter';
export const STAIN_FLOOR_DISCOUNT_NGN = 1000;
export const STAIN_INCIDENT_TYPE = 'coil_stain';

/** Parent families whose workbook floor stain quotes inherit. */
export const STAIN_SOURCE_MATERIAL_TYPE_IDS = new Set(['MAT-001', 'MAT-002', 'MAT-005']);

/**
 * @param {string | null | undefined} materialTypeId
 */
export function isStainMaterialTypeId(materialTypeId) {
  const id = String(materialTypeId ?? '').trim();
  if (id === STAIN_MATERIAL_TYPE_ID) return true;
  return id.toLowerCase() === 'stain';
}

/**
 * @param {string | null | undefined} inventoryModel
 */
export function isStainInventoryModel(inventoryModel) {
  return String(inventoryModel ?? '').trim() === STAIN_INVENTORY_MODEL;
}

/**
 * @param {string | null | undefined} materialTypeId
 */
export function isStoneCoatedMaterialTypeId(materialTypeId) {
  const id = String(materialTypeId ?? '').trim();
  if (id === STONE_COATED_MATERIAL_TYPE_ID) return true;
  const low = id.toLowerCase();
  return low === 'stone-coated' || low === 'stone coated' || low === 'stonecoated';
}

/**
 * @param {string | null | undefined} inventoryModel
 */
export function isStoneInventoryModel(inventoryModel) {
  return String(inventoryModel ?? '').trim() === STONE_INVENTORY_MODEL;
}

/**
 * Branch-owned stone SKU row from listProducts (not a coil lot).
 * @param {object | null | undefined} row
 */
export function isStoneStockCheckProduct(row) {
  if (!row || typeof row !== 'object') return false;
  const pid = String(row.productID || row.product_id || '').trim();
  const attrs = row.dashboardAttrs && typeof row.dashboardAttrs === 'object' ? row.dashboardAttrs : {};
  if (isStoneInventoryModel(attrs.inventoryModel || row.inventoryModel)) return true;
  if (attrs.stoneDesign || attrs.stoneFlatsheet || row.stoneDesign || row.stoneFlatsheet) return true;
  return /^STONE-/i.test(pid);
}

/**
 * Branch-owned accessory SKU row from listProducts.
 * @param {object | null | undefined} row
 */
export function isAccessoryStockCheckProduct(row) {
  if (!row || typeof row !== 'object') return false;
  const pid = String(row.productID || row.product_id || '').trim();
  const attrs = row.dashboardAttrs && typeof row.dashboardAttrs === 'object' ? row.dashboardAttrs : {};
  if (String(attrs.inventoryModel || row.inventoryModel || '').trim() === 'consumable') return true;
  if (attrs.accessoryKind || row.accessoryKind) return true;
  return /^ACC-/i.test(pid);
}

function productStockQty(row) {
  const n = Number(row?.stockLevel ?? row?.stock_level);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map this-branch product rows to Sales stock-check shape (metres / m², not coil kg).
 * @param {object[]} products listProducts for the workspace branch
 */
export function stockCheckRowsFromStoneProducts(products = []) {
  return (products || []).filter(isStoneStockCheckProduct).map((p) => {
    const attrs = p.dashboardAttrs && typeof p.dashboardAttrs === 'object' ? p.dashboardAttrs : {};
    const unit = String(p.unit || '').trim().toLowerCase();
    const qty = productStockQty(p);
    return {
      productID: String(p.productID || p.product_id || '').trim(),
      branchId: String(p.branchId || p.branch_id || '').trim(),
      name: String(p.name || '').trim(),
      materialType: String(attrs.materialType || p.materialType || 'Stone coated').trim() || 'Stone coated',
      colour: String(attrs.colour || attrs.stoneColour || p.colour || '').trim(),
      colourRaw: String(attrs.colour || attrs.stoneColour || p.colour || '').trim(),
      gaugeLabel: String(attrs.gauge || attrs.stoneGauge || p.gauge || '').trim(),
      unit,
      estMeters: unit === 'm2' || unit === 'm²' ? 0 : qty,
      m2: unit === 'm2' || unit === 'm²' ? qty : 0,
      kg: 0,
      inventoryModel: STONE_INVENTORY_MODEL,
      stoneFlatsheet: Boolean(attrs.stoneFlatsheet),
    };
  });
}

/**
 * Quotation header / lines_json is Type of material = Stain.
 * @param {Record<string, unknown> | null | undefined} quotationOrLines
 */
export function quotationIsStainMeterHeader(quotationOrLines) {
  if (!quotationOrLines || typeof quotationOrLines !== 'object') return false;
  if (quotationOrLines.stainMeterQuote === true) return true;
  const mid = String(
    quotationOrLines.materialTypeId ?? quotationOrLines.material_type_id ?? ''
  ).trim();
  if (isStainMaterialTypeId(mid)) return true;
  return isStainInventoryModel(quotationOrLines.inventoryModel ?? quotationOrLines.inventory_model);
}

/**
 * @param {number | null | undefined} parentFloor
 * @returns {number | null} stain floor ₦/m, or null when parent is not a usable floor
 */
export function stainFloorFromParentFloor(parentFloor) {
  const p = Math.round(Number(parentFloor) || 0);
  if (p <= 0) return null;
  const stain = p - STAIN_FLOOR_DISCOUNT_NGN;
  return stain > 0 ? stain : null;
}

/**
 * Workbook material type id to look up (parent family for stain quotes).
 * @param {{ materialTypeId?: string; stainSourceMaterialTypeId?: string } | null | undefined} headerCtx
 */
export function stainWorkbookMaterialTypeId(headerCtx) {
  const mid = String(headerCtx?.materialTypeId ?? '').trim();
  if (!isStainMaterialTypeId(mid)) return mid;
  const src = String(headerCtx?.stainSourceMaterialTypeId ?? '').trim();
  return STAIN_SOURCE_MATERIAL_TYPE_IDS.has(src) ? src : '';
}

/**
 * @param {number | null | undefined} parentFloor
 * @param {{ materialTypeId?: string } | null | undefined} headerCtx
 * @returns {number | null}
 */
export function applyStainFloorIfNeeded(parentFloor, headerCtx) {
  if (parentFloor == null || !(Number(parentFloor) > 0)) return parentFloor ?? null;
  if (!isStainMaterialTypeId(headerCtx?.materialTypeId)) return Math.round(Number(parentFloor));
  return stainFloorFromParentFloor(parentFloor);
}

/**
 * Incident material_family ↔ stain source type id.
 * @param {string | null | undefined} materialTypeId
 */
export function stainSourceMaterialTypeIdToFamilyKey(materialTypeId) {
  const id = String(materialTypeId ?? '').trim();
  if (id === 'MAT-001') return 'aluminium';
  if (id === 'MAT-002') return 'aluzinc';
  if (id === 'MAT-005') return 'stone_meter';
  return '';
}

/**
 * Coil-lot material_type_name for a stain quotation’s parent family.
 * @param {string | null | undefined} materialTypeId
 */
export function stainSourceMaterialTypeIdToDisplayName(materialTypeId) {
  const id = String(materialTypeId ?? '').trim();
  if (id === 'MAT-001') return 'Aluminium';
  if (id === 'MAT-002') return 'Aluzinc';
  if (id === 'MAT-005') return 'Stone coated';
  return '';
}

/**
 * @param {string | null | undefined} incidentFamily
 * @param {string | null | undefined} sourceTypeId
 */
export function incidentFamilyMatchesStainSource(incidentFamily, sourceTypeId) {
  const expected = stainSourceMaterialTypeIdToFamilyKey(sourceTypeId);
  const raw = String(incidentFamily ?? '')
    .trim()
    .toLowerCase();
  if (!expected) return true;
  if (!raw) return false;
  if (raw === expected) return true;
  if (expected === 'aluminium' && raw.includes('alumin')) return true;
  if (expected === 'aluzinc' && (raw.includes('aluzinc') || raw.includes('ppgi') || raw.includes('galvan'))) {
    return true;
  }
  if (expected === 'stone_meter' && raw.includes('stone')) return true;
  return false;
}

function firstGaugeNumber(value) {
  const m = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1], 10) : null;
}

function coloursLooselyMatch(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * @param {{ incidentType?: string; incident_type?: string; gaugeLabel?: string; gauge_label?: string; colour?: string; materialFamily?: string; material_family?: string }} incident
 * @param {{ materialGauge?: string; materialColor?: string; stainSourceMaterialTypeId?: string }} quoteSpec
 */
export function incidentMatchesStainQuoteSpec(incident, quoteSpec) {
  const type = String(incident?.incidentType ?? incident?.incident_type ?? '').trim();
  if (type !== STAIN_INCIDENT_TYPE) return false;
  const gInc = firstGaugeNumber(incident?.gaugeLabel ?? incident?.gauge_label);
  const gQ = firstGaugeNumber(quoteSpec?.materialGauge);
  if (gInc != null && gQ != null && Math.abs(gInc - gQ) > 0.02) return false;
  const cInc = incident?.colour;
  const cQ = quoteSpec?.materialColor;
  if (String(cInc ?? '').trim() && String(cQ ?? '').trim() && !coloursLooselyMatch(cInc, cQ)) {
    return false;
  }
  const family = incident?.materialFamily ?? incident?.material_family;
  const sourceId = quoteSpec?.stainSourceMaterialTypeId;
  if (sourceId && !incidentFamilyMatchesStainSource(family, sourceId)) return false;
  return true;
}

/**
 * Pool row (bySpec or incident) vs stain quotation header.
 * @param {{ materialFamily?: string; gaugeLabel?: string; colour?: string; metersAvailable?: number; incidentType?: string; poolKind?: string }} row
 * @param {Record<string, unknown>} quotation
 */
export function stainPoolRowMatchesQuotation(row, quotation) {
  if (!row || !quotation) return false;
  if (Number(row.metersAvailable) <= 0) return false;
  const poolKind = String(row.poolKind ?? '').trim();
  if (poolKind && poolKind !== 'stain') return false;
  const type = String(row.incidentType ?? row.incident_type ?? '').trim();
  if (type && type !== STAIN_INCIDENT_TYPE) return false;
  return incidentMatchesStainQuoteSpec(
    {
      incidentType: STAIN_INCIDENT_TYPE,
      gaugeLabel: row.gaugeLabel,
      colour: row.colour,
      materialFamily: row.materialFamily,
    },
    {
      materialGauge: quotation.materialGauge,
      materialColor: quotation.materialColor,
      stainSourceMaterialTypeId: quotation.stainSourceMaterialTypeId,
    }
  );
}

/**
 * Posted coil_stain metres are sellable stain; other incident types stay production offcut.
 * @param {string | null | undefined} incidentType
 */
export function incidentPoolKind(incidentType) {
  return String(incidentType ?? '').trim() === STAIN_INCIDENT_TYPE ? 'stain' : 'offcut';
}

/**
 * @param {string | null | undefined} family
 */
export function stainFamilyKeyToDisplayName(family) {
  const raw = String(family ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (raw.includes('alumin')) return 'Aluminium';
  if (raw.includes('aluzinc') || raw.includes('ppgi') || raw.includes('galvan')) return 'Aluzinc';
  if (raw.includes('stone')) return 'Stone coated';
  return '';
}

function remainingKgForIncident(row) {
  const metersAvailable = Number(row?.metersAvailable ?? row?.meters_available) || 0;
  const totalM = Number(row?.totalMeters ?? row?.total_meters) || 0;
  const kgDeducted = Number(row?.kgDeducted ?? row?.kg_deducted) || 0;
  if (!(kgDeducted > 0)) return 0;
  if (totalM > 0 && metersAvailable >= 0) return kgDeducted * (metersAvailable / totalM);
  return kgDeducted;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Trackable stain stock from posted coil_stain incidents (remaining metres).
 * Shape matches Sales stock-check rows (`estMeters`, `kg`, `materialType`) plus lot trace fields.
 * @param {object[]} incidents — pool-summary incidents or mapped material_incidents
 * @returns {{
 *   lots: object[];
 *   bySpec: object[];
 *   totals: { lotCount: number; metersAvailable: number; kgBooked: number };
 * }}
 */
export function buildStainInventorySnapshot(incidents = []) {
  const lots = [];
  const bySpec = new Map();
  let metersAvailableTotal = 0;
  let kgTotal = 0;
  for (const row of incidents || []) {
    const type = String(row?.incidentType ?? row?.incident_type ?? '').trim();
    const poolKind = String(row?.poolKind ?? '').trim() || incidentPoolKind(type);
    if (poolKind !== 'stain' && type !== STAIN_INCIDENT_TYPE) continue;
    const metersAvailable = Number(row?.metersAvailable ?? row?.meters_available) || 0;
    if (!(metersAvailable > 0.001)) continue;
    const family = String(row?.materialFamily ?? row?.material_family ?? '').trim();
    const kgBooked = round2(remainingKgForIncident(row));
    const lot = {
      id: String(row?.id ?? '').trim(),
      poolKind: 'stain',
      inventoryModel: STAIN_INVENTORY_MODEL,
      materialType: 'Stain',
      materialTypeId: STAIN_MATERIAL_TYPE_ID,
      materialFamily: family,
      sourceMaterialTypeName: stainFamilyKeyToDisplayName(family),
      gaugeLabel: String(row?.gaugeLabel ?? row?.gauge_label ?? '').trim(),
      colour: String(row?.colour ?? '').trim(),
      profileLabel: String(row?.profileLabel ?? row?.profile_label ?? '').trim(),
      coilNo: String(row?.coilNo ?? row?.coil_no ?? '').trim(),
      productionJobId: String(row?.productionJobId ?? row?.production_job_id ?? '').trim(),
      quotationRef: String(row?.quotationRef ?? row?.quotation_ref ?? '').trim(),
      metersAvailable: round2(metersAvailable),
      estMeters: round2(metersAvailable),
      kg: kgBooked,
      kgBooked,
      dateISO: String(row?.dateISO ?? row?.date_iso ?? '').trim(),
    };
    lots.push(lot);
    metersAvailableTotal += metersAvailable;
    kgTotal += kgBooked;
    const key = `${family}|${lot.gaugeLabel}|${lot.colour}|${lot.profileLabel}`;
    const prev = bySpec.get(key) || {
      id: `stain-spec:${key}`,
      poolKind: 'stain',
      inventoryModel: STAIN_INVENTORY_MODEL,
      materialType: 'Stain',
      materialTypeId: STAIN_MATERIAL_TYPE_ID,
      materialFamily: family,
      sourceMaterialTypeName: lot.sourceMaterialTypeName,
      gaugeLabel: lot.gaugeLabel,
      colour: lot.colour,
      profileLabel: lot.profileLabel,
      metersAvailable: 0,
      estMeters: 0,
      kg: 0,
      kgBooked: 0,
      incidentCount: 0,
      incidentIds: [],
      coilNos: [],
    };
    prev.metersAvailable = round2(prev.metersAvailable + metersAvailable);
    prev.estMeters = prev.metersAvailable;
    prev.kg = round2(prev.kg + kgBooked);
    prev.kgBooked = prev.kg;
    prev.incidentCount += 1;
    if (lot.id) prev.incidentIds.push(lot.id);
    if (lot.coilNo && !prev.coilNos.includes(lot.coilNo)) prev.coilNos.push(lot.coilNo);
    bySpec.set(key, prev);
  }
  return {
    lots,
    bySpec: [...bySpec.values()],
    totals: {
      lotCount: lots.length,
      metersAvailable: round2(metersAvailableTotal),
      kgBooked: round2(kgTotal),
    },
  };
}

/**
 * Sales stock-check: stain lots, stone-coated SKUs (this branch), or coil/yard lots.
 * Pass `productRows` from the workspace `products` snapshot — never a global SKU map.
 * @param {{
 *   coilRows?: object[];
 *   productRows?: object[];
 *   products?: object[];
 *   stainInventory?: { lots?: object[]; bySpec?: object[] } | null;
 *   materialTypeId?: string;
 *   inventoryModel?: string;
 * }} args
 */
export function stockCheckRowsForMaterialType(args = {}) {
  const typeId = args.materialTypeId;
  const model = args.inventoryModel;
  if (isStainMaterialTypeId(typeId) || isStainInventoryModel(model)) {
    const inv = args.stainInventory;
    if (Array.isArray(inv?.lots) && inv.lots.length) return inv.lots;
    if (Array.isArray(inv?.bySpec)) return inv.bySpec;
    return [];
  }
  if (isStoneCoatedMaterialTypeId(typeId) || isStoneInventoryModel(model)) {
    const products = Array.isArray(args.productRows)
      ? args.productRows
      : Array.isArray(args.products)
        ? args.products
        : [];
    return stockCheckRowsFromStoneProducts(products);
  }
  return Array.isArray(args.coilRows) ? args.coilRows : [];
}

/**
 * @param {object | null | undefined} row
 */
export function isStainInventoryRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.poolKind || '').trim() === 'stain') return true;
  if (isStainInventoryModel(row.inventoryModel)) return true;
  if (isStainMaterialTypeId(row.materialTypeId)) return true;
  return false;
}
