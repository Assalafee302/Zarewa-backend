/**
 * Branch-local coil gauge names (Yola trade labels) vs canonical setup_gauges / stock mm.
 * Frontend copies via sync → src/shared/lib/gaugeDisplayAlias.js
 *
 * Yola desk: "0.35" means true 0.28mm; "0.30" means true 0.24mm.
 * Kaduna and other branches keep canonical labels only.
 */

export const YOLA_BRANCH_ID = 'BR-YL';

/**
 * Canonical setup label → Yola customer / quotation display label.
 * @type {Readonly<Record<string, string>>}
 */
export const YOLA_GAUGE_DISPLAY_BY_CANONICAL = Object.freeze({
  '0.24mm': '0.30mm',
  '0.28mm': '0.35mm',
});

/**
 * Master gauges whose labels are Yola *display* names for other thicknesses —
 * hide them as quotation picks on Yola so "0.35" is unambiguous (true 0.28).
 * @type {ReadonlySet<string>}
 */
export const YOLA_QUOTATION_HIDDEN_CANONICAL_LABELS = Object.freeze(
  new Set(Object.values(YOLA_GAUGE_DISPLAY_BY_CANONICAL))
);

/**
 * @param {string | null | undefined} branchId
 */
export function branchUsesYolaGaugeNames(branchId) {
  return String(branchId || '').trim() === YOLA_BRANCH_ID;
}

/**
 * Leading numeric mm token from a gauge label ("0.28mm", "0.28", " 0.28 MM ").
 * @param {unknown} label
 * @returns {string} e.g. "0.28" or ""
 */
export function gaugeMmTokenFromLabel(label) {
  const s = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

/**
 * Normalize to setup-style label when a mm token is present ("0.28" → "0.28mm").
 * Returns trimmed original when no leading number.
 * @param {unknown} label
 */
export function formatGaugeLabelMm(label) {
  const raw = String(label ?? '').trim();
  const token = gaugeMmTokenFromLabel(raw);
  if (!token) return raw;
  return `${token}mm`;
}

/**
 * Customer-facing gauge string for a branch (quotations / print).
 * Non-Yola: canonical label unchanged.
 * @param {string | null | undefined} branchId
 * @param {unknown} canonicalLabel — stored materialGauge / setup label
 */
export function displayGaugeLabelForBranch(branchId, canonicalLabel) {
  const formatted = formatGaugeLabelMm(canonicalLabel);
  if (!formatted) return '';
  if (!branchUsesYolaGaugeNames(branchId)) return formatted;
  return YOLA_GAUGE_DISPLAY_BY_CANONICAL[formatted] || formatted;
}

/**
 * Map desk input (Yola trade name or canonical) → canonical setup label for storage / matching.
 * Kaduna / others: format to `N.NNmm` when numeric; otherwise leave trimmed.
 * @param {string | null | undefined} branchId
 * @param {unknown} inputLabel
 */
export function canonicalGaugeLabelForBranchInput(branchId, inputLabel) {
  const raw = String(inputLabel ?? '').trim();
  if (!raw) return '';
  const formatted = formatGaugeLabelMm(raw);
  if (!branchUsesYolaGaugeNames(branchId)) return formatted || raw;

  // Display → true thickness (0.35 → 0.28, 0.30 → 0.24).
  for (const [canonical, display] of Object.entries(YOLA_GAUGE_DISPLAY_BY_CANONICAL)) {
    if (formatted === display) return canonical;
    if (formatted === canonical) return canonical;
  }
  return formatted || raw;
}

/**
 * @param {string | null | undefined} branchId
 * @param {unknown} canonicalLabel
 */
export function isYolaQuotationHiddenGauge(branchId, canonicalLabel) {
  if (!branchUsesYolaGaugeNames(branchId)) return false;
  const formatted = formatGaugeLabelMm(canonicalLabel);
  return YOLA_QUOTATION_HIDDEN_CANONICAL_LABELS.has(formatted);
}

/**
 * Decorate setup_gauges rows for SPA dropdowns.
 * Keeps `label` / `gaugeMm` canonical; adds `displayLabel` and `quotationOption`.
 * @param {Array<object>} gauges
 * @param {string | null | undefined} branchId — omit / ALL / non-Yola → displayLabel === label
 */
export function decorateSetupGaugesForBranch(gauges, branchId) {
  const list = Array.isArray(gauges) ? gauges : [];
  const yola = branchUsesYolaGaugeNames(branchId);
  return list.map((g) => {
    const label = String(g?.label ?? '').trim();
    const displayLabel = yola ? displayGaugeLabelForBranch(branchId, label) : label;
    const quotationOption = yola ? !isYolaQuotationHiddenGauge(branchId, label) : true;
    return {
      ...g,
      label,
      displayLabel,
      quotationOption,
    };
  });
}

/**
 * Select options: value = canonical label (submit this), label = what the desk sees.
 * @param {Array<object>} gauges — raw or decorated setup gauges
 * @param {string | null | undefined} branchId
 * @returns {Array<{ value: string, label: string, gaugeMm: number, id: string }>}
 */
export function quotationGaugeSelectOptions(gauges, branchId) {
  const decorated = decorateSetupGaugesForBranch(gauges, branchId);
  return decorated
    .filter((g) => g.active !== false && g.quotationOption !== false)
    .map((g) => ({
      id: String(g.id ?? ''),
      value: String(g.label ?? '').trim(),
      label: String(g.displayLabel || g.label || '').trim(),
      gaugeMm: Number(g.gaugeMm) || 0,
    }));
}
