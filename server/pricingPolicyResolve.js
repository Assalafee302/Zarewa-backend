/**
 * Published price rounding, trading bands, ridge-derived floors, quotation line snapshots.
 */

import { resolvePriceListItemFloorNgn } from './pricingResolve.js';
import {
  materialKeyFromMaterialTypeId,
  workbookFloorPerMeterForQuotation,
} from './materialWorkbookQuotationPrice.js';
import { isMeterSheetProductLine } from '../shared/lib/materialWorkbookQuotationPrice.js';

export const STONE_COATED_MATERIAL_KEY = 'stone-coated';
export const STONE_COATED_DESIGN_KEY = 'stone-coated';
export const STONE_COATED_GAUGES = ['0.20', '0.22', '0.24'];

export function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** &lt; ₦5,000 → nearest ₦50; ≥ ₦5,000 → nearest ₦100 */
export function roundPublishedPrice(ngn) {
  const n = Math.round(Number(ngn) || 0);
  if (n <= 0) return 0;
  if (n < 5000) {
    return Math.round(n / 50) * 50;
  }
  return Math.round(n / 100) * 100;
}

/** Metcoppo / Steptiles column for customer PDF: 3.5% on base, then rounding. */
export function premiumProfilePriceFromBase(base) {
  return roundPublishedPrice((Number(base) || 0) * 1.035);
}

export function parseGaugeMm(label) {
  const s = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const m = s.match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function defaultTradingBand(db) {
  try {
    const row = db.prepare(`SELECT default_trading_band_ngn FROM pricing_policy WHERE id = 'default'`).get();
    return Math.max(0, Math.round(Number(row?.default_trading_band_ngn) || 50));
  } catch {
    return 50;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} gaugeLabel
 */
export function tradingBandForGauge(db, gaugeLabel) {
  const mm = parseGaugeMm(gaugeLabel);
  if (mm == null) return defaultTradingBand(db);
  try {
    const tiers = db
      .prepare(`SELECT gauge_min_mm, gauge_max_mm, band_ngn FROM pricing_trading_band_tiers ORDER BY sort_order ASC`)
      .all();
    for (const t of tiers) {
      const lo = Number(t.gauge_min_mm) || 0;
      const hi = Number(t.gauge_max_mm) || 999;
      if (mm >= lo && mm <= hi) {
        return Math.max(0, Math.round(Number(t.band_ngn) || 0));
      }
    }
  } catch {
    /* table missing in tests */
  }
  return defaultTradingBand(db);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key normalized alias key
 */
export function resolveAliasForDesign(db, key) {
  if (!key) return '';
  try {
    const row = db.prepare(`SELECT canonical_design_key FROM pricing_profile_aliases WHERE alias_key = ?`).get(key);
    const d = String(row?.canonical_design_key ?? '').trim();
    return d ? normKey(d) : '';
  } catch {
    return '';
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} girthMm
 * @param {string} materialFamily
 */
export function ridgeAddOnNgnForGirth(db, girthMm, materialFamily) {
  const g = Number(girthMm);
  if (!Number.isFinite(g) || g <= 0) return 0;
  const mf = normKey(materialFamily || '');
  try {
    const rows = db.prepare(`SELECT girth_mm, material_family, add_on_ngn FROM pricing_ridge_add_ons ORDER BY sort_order ASC`).all();
    let best = 0;
    for (const r of rows) {
      if (Math.abs(Number(r.girth_mm) - g) > 0.001) continue;
      const rmf = normKey(r.material_family || '');
      if (rmf && mf && rmf !== mf) continue;
      best = Math.max(best, Math.round(Number(r.add_on_ngn) || 0));
    }
    return best;
  } catch {
    return 0;
  }
}

/**
 * Build ctx for resolvePriceListItemFloorNgn from a quotation service line.
 * @param {import('better-sqlite3').Database} db
 * @param {object} line
 * @param {string | null} branchId
 */
export function serviceLineToFloorCtx(db, line, branchId) {
  const gauge = normKey(line?.gauge ?? line?.gaugeLabel ?? '');
  const colourRaw = String(line?.colour ?? line?.color ?? '').trim();
  const designRaw = String(line?.design ?? '').trim();
  const profileRaw = String(line?.profile ?? line?.profileName ?? line?.profileKey ?? '').trim();

  const lineKind = String(line?.lineKind ?? 'roofing')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (lineKind === 'stone_coated') {
    return {
      gaugeLabel: gauge,
      designLabel: STONE_COATED_DESIGN_KEY,
      colourName: '',
      profileName: '',
      materialTypeName: STONE_COATED_MATERIAL_KEY,
      branchId,
    };
  }

  let designLabel = normKey(designRaw || colourRaw);
  let colourName = normKey(colourRaw);
  let profileName = normKey(profileRaw);

  const aliasFromProfile = profileName ? resolveAliasForDesign(db, profileName) : '';
  const aliasFromDesign = designLabel ? resolveAliasForDesign(db, designLabel) : '';
  if (aliasFromProfile) designLabel = aliasFromProfile;
  else if (aliasFromDesign) designLabel = aliasFromDesign;

  return {
    gaugeLabel: gauge,
    designLabel: designLabel || colourName,
    colourName,
    profileName,
    materialTypeName: normKey(line?.materialType ?? line?.materialTypeKey ?? ''),
    branchId,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} line
 * @param {string | null} branchId
 * @param {{ materialTypeId?: string; materialGauge?: string; materialDesign?: string; productName?: string } | null} [headerCtx]
 * @returns {number | null}
 */
export function floorNgnForServiceLine(db, line, branchId, headerCtx = null) {
  const asAtIso = headerCtx?.asAtIso;
  const productName = String(headerCtx?.productName ?? line?.name ?? '').trim();
  const isMeterSheet =
    isMeterSheetProductLine(productName) ||
    (!String(line?.lineKind ?? '').trim() && isMeterSheetProductLine(line?.name));
  if (isMeterSheet && headerCtx) {
    const mk =
      materialKeyFromMaterialTypeId(db, headerCtx.materialTypeId) ||
      normKey(line?.materialType ?? line?.materialTypeKey ?? '');
    const wb = workbookFloorPerMeterForQuotation(db, {
      materialKey: mk,
      materialTypeId: headerCtx.materialTypeId,
      gaugeLabel: headerCtx.materialGauge ?? line?.gauge ?? line?.gaugeLabel,
      designLabel: headerCtx.materialDesign ?? line?.design ?? line?.profile,
      branchId,
      asAtIso,
    });
    if (wb != null && wb > 0) return wb;
  }

  const lineKind = String(line?.lineKind ?? 'roofing')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (lineKind === 'ridge' || lineKind === 'flashing') {
    const girthMm = Number(line?.girthMm ?? line?.girth ?? 0) || 0;
    const roofingLine = { ...line, lineKind: 'roofing' };
    const ctx = serviceLineToFloorCtx(db, roofingLine, branchId);
    const base = resolvePriceListItemFloorNgn(db, { ...ctx, asAtIso });
    if (!base?.unitPricePerMeterNgn || girthMm <= 0) {
      const direct = resolvePriceListItemFloorNgn(db, { ...serviceLineToFloorCtx(db, line, branchId), asAtIso });
      return direct?.unitPricePerMeterNgn ?? null;
    }
    const segments = 1200 / girthMm;
    if (!Number.isFinite(segments) || segments <= 0) return null;
    const addOn = ridgeAddOnNgnForGirth(db, girthMm, line?.materialFamily ?? line?.ridgeMaterialFamily ?? '');
    const derived = roundPublishedPrice(base.unitPricePerMeterNgn / segments + addOn);
    return derived > 0 ? derived : null;
  }

  const ctx = serviceLineToFloorCtx(db, line, branchId);
  const floor = resolvePriceListItemFloorNgn(db, { ...ctx, asAtIso });
  return floor?.unitPricePerMeterNgn ?? null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} line
 * @param {string | null} branchId
 */
export function pricingPolicyNumbersForServiceLine(db, line, branchId, headerCtx = null) {
  const gauge = normKey(line?.gauge ?? line?.gaugeLabel ?? '');
  const design = serviceLineToFloorCtx(db, line, branchId).designLabel;
  const floor = floorNgnForServiceLine(db, line, branchId, headerCtx);
  const band = gauge ? tradingBandForGauge(db, gauge) : defaultTradingBand(db);
  const recRaw = Number(line?.recommendedPricePerMeter);
  let recommended =
    Number.isFinite(recRaw) && recRaw > 0 && floor != null ? Math.max(recRaw, floor) : floor != null ? floor : null;
  if (recommended == null) {
    return {
      floor: null,
      recommended: null,
      band,
      minAllowed: null,
      designKey: design,
      gaugeKey: gauge,
    };
  }
  if (floor != null && recommended < floor) recommended = floor;
  const minAllowed = floor != null ? Math.max(floor, recommended - band) : recommended - band;
  return { floor, recommended, band, minAllowed: Math.max(0, minAllowed), designKey: design, gaugeKey: gauge };
}

/**
 * Mutates services array: sets floorPricePerMeter, recommendedPricePerMeter snapshots when floor resolvable.
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} services
 * @param {string | null} branchId
 */
export function applyPricingSnapshotsToServices(db, services, branchId, headerCtx = null) {
  if (!Array.isArray(services)) return;
  for (const line of services) {
    if (!line || typeof line !== 'object') continue;
    const nums = pricingPolicyNumbersForServiceLine(db, line, branchId, headerCtx);
    if (nums.floor != null) line.floorPricePerMeter = nums.floor;
    if (nums.recommended != null) {
      const had = Number(line.recommendedPricePerMeter);
      if (!Number.isFinite(had) || had <= 0) {
        line.recommendedPricePerMeter = nums.recommended;
      } else {
        line.recommendedPricePerMeter = Math.max(had, nums.floor ?? had);
      }
    }
  }
}
