/**
 * Stain material (damaged-coil seconds): Type of material MAT-006.
 * Floor is the parent workbook floor minus ₦1,000. Stock is coil_stain incident metres.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/stainMaterialPolicy.js
 */

export const STAIN_MATERIAL_TYPE_ID = 'MAT-006';
export const STAIN_INVENTORY_MODEL = 'stain_meter';
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
