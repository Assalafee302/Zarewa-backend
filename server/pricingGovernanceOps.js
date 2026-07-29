/**
 * Finance / Pricing governance — Phase 3 profitability desk pack.
 * Cost variance (workbook vs GRN WAC), floor-exception log, margin consistency.
 */
import { productIdForMaterialKey } from '../shared/lib/coilDensityStandard.js';
import { purchaseWeightedAvgCostPerKgLastDays } from './materialPricingOps.js';
import { appendAuditLog } from './controlOps.js';

/** Flag when |workbook − GRN WAC| / GRN WAC exceeds this percent. Mid of 5–10% band. */
export const COST_VARIANCE_THRESHOLD_PCT = 8;

/** Relative spread of Profit/Overhead across same material+gauge before flagging. */
export const MARGIN_CONSISTENCY_REL_PCT = 15;

/** Absolute ₦/m spread that also triggers a consistency flag (avoids noise on tiny bases). */
export const MARGIN_CONSISTENCY_ABS_NGN = 50;

export const GRN_LOOKBACK_DAYS = 30;

function tableExists(db, name) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = ?`
        )
        .get(name)
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
    } catch {
      return false;
    }
  }
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function actorDisplayName(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  if (!tableExists(db, 'app_users')) return uid;
  try {
    const row = db
      .prepare(`SELECT display_name, username FROM app_users WHERE id = ? LIMIT 1`)
      .get(uid);
    return String(row?.display_name || row?.username || uid).trim();
  } catch {
    return uid;
  }
}

function pctDiff(workbook, actual) {
  const a = Number(actual);
  const w = Number(workbook);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(w)) return null;
  return Math.round(((w - a) / a) * 1000) / 10;
}

/**
 * Workbook cost_per_kg vs 30-day weighted-average GRN coil cost, by material/gauge/branch.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null }} [opts]
 */
export function buildCostVarianceRows(db, opts = {}) {
  if (!tableExists(db, 'material_pricing_sheet_rows')) return [];
  const branchFilter = String(opts.branchId || '').trim();
  let sql = `SELECT * FROM material_pricing_sheet_rows WHERE 1=1`;
  const args = [];
  if (branchFilter && branchFilter !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(branchFilter);
  }
  sql += ` ORDER BY material_key, gauge_mm, branch_id, design_key`;
  const rows = db.prepare(sql).all(...args);

  /** Cache WAC by product|branch */
  const wacCache = new Map();
  function wacFor(materialKey, branchId) {
    const pid = productIdForMaterialKey(materialKey);
    if (!pid) return null;
    const key = `${pid}|${branchId}`;
    if (!wacCache.has(key)) {
      wacCache.set(key, purchaseWeightedAvgCostPerKgLastDays(db, pid, branchId, GRN_LOOKBACK_DAYS));
    }
    return wacCache.get(key);
  }

  const out = [];
  for (const row of rows) {
    const materialKey = String(row.material_key || '').trim();
    const gaugeMm = String(row.gauge_mm || '').trim();
    const branchId = String(row.branch_id || '').trim();
    const designKey = String(row.design_key || '').trim();
    const workbookCost = Number(row.cost_per_kg_ngn) || 0;
    const grnWac = wacFor(materialKey, branchId);
    const variancePct = grnWac != null ? pctDiff(workbookCost, grnWac) : null;
    const flagged =
      variancePct != null && Math.abs(variancePct) >= COST_VARIANCE_THRESHOLD_PCT;
    out.push({
      id: row.id,
      materialKey,
      gaugeMm,
      branchId,
      designKey,
      workbookCostPerKgNgn: workbookCost,
      grnWeightedAvgCostPerKgNgn: grnWac,
      variancePct,
      varianceNgn: grnWac != null ? Math.round(workbookCost - grnWac) : null,
      flagged,
      lookbackDays: GRN_LOOKBACK_DAYS,
      note:
        grnWac == null
          ? materialKey === 'stone-coated'
            ? 'No coil GRN WAC for stone-coated'
            : 'No GRN unit cost in lookback window'
          : flagged
            ? `Workbook diverges ≥${COST_VARIANCE_THRESHOLD_PCT}% from 30-day GRN WAC`
            : null,
    });
  }
  return out;
}

/**
 * Apply the current GRN WAC to a flagged workbook row. This is a proposal action,
 * but intentionally writes only the cost field so the workbook retains its pricing controls.
 */
export function proposeWorkbookCostRefresh(db, rowId, actor) {
  const id = String(rowId || '').trim();
  if (!id) return { ok: false, error: 'rowId is required.' };
  const row = buildCostVarianceRows(db, { branchId: null }).find((entry) => entry.id === id);
  if (!row) return { ok: false, error: 'Workbook row not found.' };
  if (!row.flagged || row.grnWeightedAvgCostPerKgNgn == null) {
    return { ok: false, error: 'Only flagged rows with a GRN WAC can be refreshed.' };
  }
  const nextCost = Math.round(Number(row.grnWeightedAvgCostPerKgNgn) || 0);
  if (nextCost <= 0) return { ok: false, error: 'GRN WAC must be positive.' };
  db.prepare(`UPDATE material_pricing_sheet_rows SET cost_per_kg_ngn = ? WHERE id = ?`).run(nextCost, id);
  appendAuditLog(db, {
    actor,
    action: 'pricing_governance.propose_cost_refresh',
    entityKind: 'material_pricing_sheet_row',
    entityId: id,
    note: `Workbook cost refreshed from ₦${row.workbookCostPerKgNgn} to GRN WAC ₦${nextCost}.`,
    details: { branchId: row.branchId, materialKey: row.materialKey, priorCost: row.workbookCostPerKgNgn, nextCost },
  });
  return { ok: true, rowId: id, priorCostPerKgNgn: row.workbookCostPerKgNgn, costPerKgNgn: nextCost };
}

/**
 * MD-approved below-floor quotes — reuses md_price_exception_* columns (no new logging).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null, limit?: number }} [opts]
 */
export function buildFloorExceptionLog(db, opts = {}) {
  if (!tableExists(db, 'quotations')) return [];
  const branchFilter = String(opts.branchId || '').trim();
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  let sql = `SELECT id, customer_id, customer_name, project_name, branch_id, date_iso, total_ngn,
                    md_price_exception_approved_at_iso, md_price_exception_approved_by_user_id,
                    md_price_exception_snapshot_json, price_exception_md_review_required
             FROM quotations
             WHERE md_price_exception_approved_at_iso IS NOT NULL
               AND TRIM(IFNULL(md_price_exception_approved_at_iso, '')) <> ''`;
  const args = [];
  if (branchFilter && branchFilter !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(branchFilter);
  }
  sql += ` ORDER BY md_price_exception_approved_at_iso DESC LIMIT ?`;
  args.push(limit);

  let rows = [];
  try {
    rows = db.prepare(sql).all(...args);
  } catch {
    // Snapshot column may be missing on very stale schema — fall back without it.
    sql = sql.replace(', md_price_exception_snapshot_json', '');
    try {
      rows = db.prepare(sql).all(...args);
    } catch {
      return [];
    }
  }

  return rows.map((row) => {
    const violations = Array.isArray(safeJsonParse(row.md_price_exception_snapshot_json, []))
      ? safeJsonParse(row.md_price_exception_snapshot_json, [])
      : [];
    const lineDeltas = violations.map((v) => {
      const floor = Number(v.floorPerMeter ?? v.floor_per_meter);
      const quoted = Number(v.quotedPerMeter ?? v.quoted_per_meter);
      const below =
        Number.isFinite(floor) && Number.isFinite(quoted) ? Math.round(floor - quoted) : null;
      return {
        lineIndex: v.lineIndex ?? v.line_index ?? null,
        lineName: v.lineName || v.line_name || v.lineCategory || '',
        gauge: v.gauge || '',
        design: v.design || '',
        quotedPerMeter: Number.isFinite(quoted) ? quoted : null,
        floorPerMeter: Number.isFinite(floor) ? floor : null,
        belowFloorPerMeterNgn: below,
      };
    });
    const totalBelowNgn = lineDeltas.reduce(
      (s, d) => s + (d.belowFloorPerMeterNgn != null && d.belowFloorPerMeterNgn > 0 ? d.belowFloorPerMeterNgn : 0),
      0
    );
    const approvedByUserId = row.md_price_exception_approved_by_user_id || '';
    return {
      quotationId: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      projectName: row.project_name || '',
      branchId: row.branch_id,
      dateIso: row.date_iso,
      totalNgn: Number(row.total_ngn) || 0,
      approvedAtIso: row.md_price_exception_approved_at_iso,
      approvedByUserId,
      approvedByName: actorDisplayName(db, approvedByUserId),
      lineCount: lineDeltas.length,
      totalBelowFloorPerMeterNgn: totalBelowNgn,
      lines: lineDeltas,
      reviewRequired: Number(row.price_exception_md_review_required) === 1,
    };
  });
}

function spreadFlag(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length < 2) return { flagged: false, min: null, max: null, spread: null };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const spread = Math.round(max - min);
  const base = Math.max(Math.abs(min), Math.abs(max), 1);
  const relPct = Math.round((spread / base) * 1000) / 10;
  const flagged = spread >= MARGIN_CONSISTENCY_ABS_NGN && relPct >= MARGIN_CONSISTENCY_REL_PCT;
  return { flagged, min, max, spread, relPct };
}

/**
 * Same material/gauge with meaningfully different Profit or Overhead across branch/design rows.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null }} [opts]
 */
export function buildMarginConsistencyRows(db, opts = {}) {
  if (!tableExists(db, 'material_pricing_sheet_rows')) return [];
  const branchFilter = String(opts.branchId || '').trim();
  let sql = `SELECT * FROM material_pricing_sheet_rows WHERE 1=1`;
  const args = [];
  // Consistency is cross-branch/design; optional branch filter still limits the sample set.
  if (branchFilter && branchFilter !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(branchFilter);
  }
  const rows = db.prepare(sql).all(...args);

  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const row of rows) {
    const materialKey = String(row.material_key || '').trim();
    const gaugeMm = String(row.gauge_mm || '').trim();
    if (!materialKey || !gaugeMm) continue;
    const key = `${materialKey}|${gaugeMm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      id: row.id,
      materialKey,
      gaugeMm,
      branchId: String(row.branch_id || '').trim(),
      designKey: String(row.design_key || '').trim(),
      overheadNgnPerM: Number(row.overhead_ngn_per_m) || 0,
      profitNgnPerM: Number(row.profit_ngn_per_m) || 0,
      costPerKgNgn: Number(row.cost_per_kg_ngn) || 0,
      minimumPricePerMeterNgn: Number(row.minimum_price_per_m_ngn) || 0,
    });
  }

  const out = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const profit = spreadFlag(members.map((m) => m.profitNgnPerM));
    const overhead = spreadFlag(members.map((m) => m.overheadNgnPerM));
    if (!profit.flagged && !overhead.flagged) continue;
    out.push({
      materialKey: members[0].materialKey,
      gaugeMm: members[0].gaugeMm,
      rowCount: members.length,
      profitSpreadNgn: profit.spread,
      profitRelPct: profit.relPct,
      profitFlagged: profit.flagged,
      overheadSpreadNgn: overhead.spread,
      overheadRelPct: overhead.relPct,
      overheadFlagged: overhead.flagged,
      flagged: true,
      rows: members,
      note: [
        profit.flagged
          ? `Profit varies ₦${profit.spread}/m (${profit.relPct}%) across ${members.length} rows`
          : null,
        overhead.flagged
          ? `Overhead varies ₦${overhead.spread}/m (${overhead.relPct}%) across ${members.length} rows`
          : null,
      ]
        .filter(Boolean)
        .join('; '),
    });
  }
  out.sort((a, b) => String(a.materialKey).localeCompare(String(b.materialKey)) || String(a.gaugeMm).localeCompare(String(b.gaugeMm)));
  return out;
}

/**
 * Full pack for Accounting Desk Pricing governance tab.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null, limit?: number }} [opts]
 */
export function buildPricingGovernancePack(db, opts = {}) {
  const costVariance = buildCostVarianceRows(db, opts);
  const floorExceptions = buildFloorExceptionLog(db, opts);
  const marginConsistency = buildMarginConsistencyRows(db, opts);
  const flaggedCost = costVariance.filter((r) => r.flagged).length;
  const missingGrn = costVariance.filter((r) => r.grnWeightedAvgCostPerKgNgn == null).length;
  return {
    ok: true,
    thresholds: {
      costVariancePct: COST_VARIANCE_THRESHOLD_PCT,
      marginConsistencyRelPct: MARGIN_CONSISTENCY_REL_PCT,
      marginConsistencyAbsNgn: MARGIN_CONSISTENCY_ABS_NGN,
      grnLookbackDays: GRN_LOOKBACK_DAYS,
    },
    summary: {
      costVarianceRows: costVariance.length,
      costVarianceFlagged: flaggedCost,
      costVarianceMissingGrn: missingGrn,
      floorExceptionCount: floorExceptions.length,
      marginConsistencyFlagged: marginConsistency.length,
    },
    costVariance,
    floorExceptions,
    marginConsistency,
  };
}
