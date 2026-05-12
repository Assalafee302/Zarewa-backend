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

/**
 * @param {unknown} linesJson — object or JSON string (quotation `lines_json` shape)
 * @returns {string} best-effort gauge label, or '' if none
 */
export function quotedGaugeLabelForSubstitutionComparison(linesJson) {
  const labels = [];
  try {
    const j = typeof linesJson === 'string' ? JSON.parse(linesJson || '{}') : linesJson;
    if (!j || typeof j !== 'object') return '';
    if (typeof j.materialGauge === 'string' && j.materialGauge.trim()) labels.push(j.materialGauge.trim());
    if (Array.isArray(j.products)) {
      for (const p of j.products) {
        const g = String(p?.materialGauge ?? p?.gauge ?? '').trim();
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
