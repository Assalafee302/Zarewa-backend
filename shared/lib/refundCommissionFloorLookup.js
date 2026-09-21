/**
 * Resolve quotation gauge/design + material hints for agent-commission (price-above-floor) workbook lookup.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/refundCommissionFloorLookup.js
 */

/** Workbook design_key used for stone-coated metre sheet rows. */
export const STONE_COATED_COMMISSION_DESIGN_KEY = 'stone-coated';

/**
 * @param {unknown} linesJson
 * @returns {object | null}
 */
export function parseQuotationLinesPayload(linesJson) {
  if (linesJson && typeof linesJson === 'object') return /** @type {object} */ (linesJson);
  if (typeof linesJson === 'string') {
    try {
      return JSON.parse(linesJson || '{}');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * First product line with gauge + design/colour.
 * @param {unknown} linesJson
 * @returns {{ gauge: string, design: string } | null}
 */
export function firstQuotedProductGaugeDesign(linesJson) {
  const payload = parseQuotationLinesPayload(linesJson);
  const prods = payload?.products;
  if (!Array.isArray(prods)) return null;
  for (const p of prods) {
    if (!String(p?.name ?? '').trim()) continue;
    const gauge = String(
      p?.materialGauge ?? p?.material_gauge ?? p?.gauge ?? p?.gaugeLabel ?? ''
    ).trim();
    const design = String(
      p?.materialDesign ?? p?.design ?? p?.materialColor ?? p?.colour ?? p?.color ?? ''
    ).trim();
    if (gauge && design) return { gauge, design };
  }
  return null;
}

/**
 * Gauge + design for commission floor lookup.
 * Stone-coated (MAT-005) prefers header materialGauge so a stray product line cannot pick 0.20.
 *
 * @param {unknown} linesJson
 * @returns {{ gauge: string, design: string } | null}
 */
export function quotedGaugeDesignForCommission(linesJson) {
  const payload = parseQuotationLinesPayload(linesJson);
  const fromLine = firstQuotedProductGaugeDesign(linesJson);
  const headerGauge = String(payload?.materialGauge ?? payload?.material_gauge ?? '').trim();
  const headerDesign = String(
    payload?.materialDesign ??
      payload?.material_design ??
      payload?.materialColor ??
      payload?.materialColour ??
      ''
  ).trim();
  const typeId = String(payload?.materialTypeId ?? payload?.materialType ?? payload?.material_type_id ?? '').trim();
  const typeName = String(payload?.materialTypeName ?? payload?.materialTypeKey ?? '')
    .trim()
    .toLowerCase();
  const isStone = typeId === 'MAT-005' || typeName.includes('stone');

  if (isStone && headerGauge) {
    let design = headerDesign || String(fromLine?.design || '').trim();
    if (!design) design = STONE_COATED_COMMISSION_DESIGN_KEY;
    return { gauge: headerGauge, design };
  }

  const gauge = String(fromLine?.gauge || headerGauge || '').trim();
  let design = String(fromLine?.design || headerDesign || '').trim();
  if (!design && isStone) design = STONE_COATED_COMMISSION_DESIGN_KEY;
  if (gauge && design) return { gauge, design };
  return fromLine;
}

/**
 * Material type id from quotation header (stain source not resolved here — caller may remap).
 * @param {unknown} linesJson
 * @returns {string}
 */
export function quotationMaterialTypeIdFromLines(linesJson) {
  const payload = parseQuotationLinesPayload(linesJson);
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.materialTypeId ?? payload.materialType ?? payload.material_type_id ?? '').trim();
}
