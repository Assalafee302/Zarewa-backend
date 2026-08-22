export const QUOTATION_MATERIAL_HEADER_CODE = 'QUOTATION_MATERIAL_HEADER_REQUIRED';

/**
 * Every quotation must carry material type, gauge, colour, and profile (design) on lines_json header.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/quotationMaterialHeader.js
 * @param {object | null | undefined} linesJson
 * @returns {{ ok: true } | { ok: false, error: string, code: string, details: { missing: string[] } }}
 */
export function validateQuotationMaterialHeaderRequired(linesJson) {
  const j = linesJson && typeof linesJson === 'object' ? linesJson : {};
  const missing = [];
  if (!String(j.materialTypeId || '').trim()) missing.push('material type');
  if (!String(j.materialGauge || '').trim()) missing.push('gauge');
  if (!String(j.materialColor || '').trim()) missing.push('colour');
  if (!String(j.materialDesign || '').trim()) missing.push('profile');
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    code: QUOTATION_MATERIAL_HEADER_CODE,
    error: `Quotation material header is incomplete — select ${missing.join(', ')}.`,
    details: { missing },
  };
}

/**
 * @param {object | null | undefined} linesJson
 */
export function assertQuotationMaterialHeaderRequired(linesJson) {
  const r = validateQuotationMaterialHeaderRequired(linesJson);
  if (r.ok) return;
  const err = new Error(r.error);
  err.code = r.code;
  err.details = r.details;
  err.statusCode = 422;
  throw err;
}

/**
 * SPA-friendly message from an API error body (`code` + `error`).
 * @param {{ code?: string, error?: string } | null | undefined} data
 */
export function quotationMaterialHeaderErrorMessage(data) {
  if (!data || data.code !== QUOTATION_MATERIAL_HEADER_CODE) return data?.error || '';
  return String(data.error || 'Complete material type, gauge, colour, and profile.').trim();
}
