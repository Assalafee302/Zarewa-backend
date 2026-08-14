/**
 * DB-backed material workbook prices for quotations.
 */
import { resolveAliasForDesign, normKey } from './pricingPolicyResolve.js';
import { listMaterialPricingRowsAsOf } from './pricingAsOf.js';
import {
  designKeysToTry,
  gaugeMmKeyFromLabel,
  materialKeyFromMaterialTypeRow,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
} from '../shared/lib/materialWorkbookQuotationPrice.js';

export {
  gaugeMmKeyFromLabel,
  materialKeyFromMaterialTypeRow,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
  isMeterSheetProductLine,
} from '../shared/lib/materialWorkbookQuotationPrice.js';

export function canReadMaterialPricingSheetRows(db) {
  try {
    db.prepare(`SELECT 1 FROM material_pricing_sheet_rows LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} branchScope
 */
export function listMaterialPricingRowsForSnapshot(db, branchScope = null) {
  if (!canReadMaterialPricingSheetRows(db)) return [];
  const scope = branchScope != null ? String(branchScope).trim() : '';
  // HQ / view-all uses branchScope "ALL" — that is not a real branch_id.
  const allBranches = !scope || scope.toUpperCase() === 'ALL';
  let rows;
  if (!allBranches) {
    rows = db
      .prepare(
        `SELECT id, material_key, gauge_mm, branch_id, design_key,
                minimum_price_per_m_ngn, commission_ngn_per_m
         FROM material_pricing_sheet_rows
         WHERE branch_id = ?
         ORDER BY material_key ASC, gauge_mm ASC, design_key ASC`
      )
      .all(scope);
  } else {
    rows = db
      .prepare(
        `SELECT id, material_key, gauge_mm, branch_id, design_key,
                minimum_price_per_m_ngn, commission_ngn_per_m
         FROM material_pricing_sheet_rows
         ORDER BY branch_id ASC, material_key ASC, gauge_mm ASC, design_key ASC`
      )
      .all();
  }
  return rows.map((r) => {
    const floor = Math.round(Number(r.minimum_price_per_m_ngn) || 0);
    const commission = Math.max(0, Number(r.commission_ngn_per_m) || 0);
    return {
      id: r.id,
      materialKey: r.material_key,
      gaugeMm: r.gauge_mm,
      branchId: r.branch_id,
      designKey: r.design_key ?? '',
      minimumPricePerMeterNgn: floor,
      commissionNgnPerM: commission,
      publishedListPriceNgn: publishedListPriceFromWorkbook(floor, commission),
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialTypeId
 */
export function materialKeyFromMaterialTypeId(db, materialTypeId) {
  const id = String(materialTypeId || '').trim();
  if (!id) return '';
  try {
    const row = db.prepare(`SELECT id, name FROM setup_material_types WHERE id = ?`).get(id);
    return materialKeyFromMaterialTypeRow(row);
  } catch {
    return materialKeyFromMaterialTypeRow({ id });
  }
}

function expandedDesignKeys(db, designLabelRaw) {
  const keys = designKeysToTry(designLabelRaw);
  const base = normKey(designLabelRaw);
  if (base) {
    try {
      const canon = resolveAliasForDesign(db, base);
      if (canon) keys.push(canon);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(keys.map((k) => normKey(k)).filter(Boolean))];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {string} materialKey
 * @param {string} gaugeMm
 */
export function listMaterialPricingRowsForQuotationLookup(db, branchId, materialKey, gaugeMm) {
  if (!canReadMaterialPricingSheetRows(db)) return [];
  const bid = String(branchId || '').trim();
  const mk = normKey(materialKey);
  const g = gaugeMmKeyFromLabel(gaugeMm);
  if (!bid || !mk || !g) return [];
  const rows = db
    .prepare(
      `SELECT id, material_key, gauge_mm, branch_id, design_key,
              minimum_price_per_m_ngn, commission_ngn_per_m
       FROM material_pricing_sheet_rows
       WHERE branch_id = ? AND material_key = ?
       ORDER BY design_key ASC`
    )
    .all(bid, mk)
    .filter((r) => gaugeMmKeyFromLabel(r.gauge_mm) === g);
  return rows.map((r) => {
    const floor = Math.round(Number(r.minimum_price_per_m_ngn) || 0);
    const commission = Math.max(0, Number(r.commission_ngn_per_m) || 0);
    return {
      id: r.id,
      materialKey: r.material_key,
      gaugeMm: r.gauge_mm,
      branchId: r.branch_id,
      designKey: r.design_key ?? '',
      minimumPricePerMeterNgn: floor,
      commissionNgnPerM: commission,
      publishedListPriceNgn: publishedListPriceFromWorkbook(floor, commission),
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   materialTypeId?: string;
 *   materialKey?: string;
 *   gaugeLabel?: string;
 *   designLabel?: string;
 *   branchId?: string;
 *   asAtIso?: string;
 * }} ctx
 */
export function resolveMaterialWorkbookPriceForQuotation(db, ctx) {
  if (!canReadMaterialPricingSheetRows(db)) return null;
  const bid = String(ctx.branchId || '').trim();
  if (!bid) return null;
  const mk =
    normKey(ctx.materialKey) ||
    materialKeyFromMaterialTypeId(db, ctx.materialTypeId);
  const g = gaugeMmKeyFromLabel(ctx.gaugeLabel);
  if (!mk || !g) return null;

  const designKeys = expandedDesignKeys(db, ctx.designLabel);
  const asAt = ctx.asAtIso != null && String(ctx.asAtIso).trim() ? String(ctx.asAtIso).trim().slice(0, 10) : null;
  const rows = asAt
    ? listMaterialPricingRowsAsOf(db, bid, asAt).filter(
        (r) => normKey(r.materialKey) === mk && gaugeMmKeyFromLabel(r.gaugeMm) === g
      )
    : listMaterialPricingRowsForQuotationLookup(db, bid, mk, g);
  return resolveMaterialWorkbookPriceFromRows(rows, {
    materialKey: mk,
    gaugeMm: g,
    branchId: bid,
    designLabel: ctx.designLabel,
    designKeys,
  });
}

/**
 * Workbook minimum ₦/m only (no commission).
 * @param {import('better-sqlite3').Database} db
 * @param {Parameters<typeof resolveMaterialWorkbookPriceForQuotation>[1]} ctx
 * @returns {number | null}
 */
export function workbookFloorPerMeterForQuotation(db, ctx) {
  const hit = resolveMaterialWorkbookPriceForQuotation(db, ctx);
  return hit?.floorPerMeter > 0 ? hit.floorPerMeter : null;
}
