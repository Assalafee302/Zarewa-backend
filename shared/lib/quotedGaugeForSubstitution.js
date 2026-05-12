/**
 * Quoted gauge used for refund substitution: compare the strictest (thickest) gauge
 * the customer was offered on the quotation header or any product line against
 * physical coil / produced gauge. Mirrors sales UI where header gauge can differ
 * from line-level defaults.
 */

export function firstGaugeMmFromLabel(label) {
  const m = String(label ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Same field precedence as CuttingListModal / sales UI (camelCase + legacy snake_case). */
export function gaugeLabelFromQuotationJsonNode(node) {
  if (!node || typeof node !== 'object') return '';
  const g = String(
    node.materialGauge ?? node.material_gauge ?? node.gauge ?? node.gaugeLabel ?? ''
  ).trim();
  return g;
}

/**
 * @param {unknown} linesJson — object or JSON string (quotation `lines_json` shape)
 * @returns {string} best-effort gauge label, or '' if none
 */
export function quotedGaugeLabelForSubstitutionComparison(linesJson) {
  const labels = [];
  try {
    const j = typeof linesJson === 'string' ? JSON.parse(linesJson || '{}') : linesJson;
    if (!j || typeof j !== 'object') return '';
    const headerG = gaugeLabelFromQuotationJsonNode(j);
    if (headerG) labels.push(headerG);
    if (Array.isArray(j.products)) {
      for (const p of j.products) {
        const g = gaugeLabelFromQuotationJsonNode(p);
        if (g) labels.push(g);
      }
    }
  } catch {
    return '';
  }
  if (labels.length === 0) return '';
  let best = labels[0];
  let bestMm = firstGaugeMmFromLabel(best);
  if (bestMm == null) bestMm = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < labels.length; i++) {
    const L = labels[i];
    const mm = firstGaugeMmFromLabel(L);
    if (mm != null && (bestMm === Number.NEGATIVE_INFINITY || mm > bestMm)) {
      bestMm = mm;
      best = L;
    }
  }
  if (bestMm === Number.NEGATIVE_INFINITY) return labels[0];
  return best;
}
