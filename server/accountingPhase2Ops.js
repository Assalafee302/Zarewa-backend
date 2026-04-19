/**
 * Phase 2 HQ accounting: fixed asset register, standard costs, costing snapshot vs GRN/coil data.
 * @param {import('better-sqlite3').Database} db
 */

import { assertPeriodOpen } from './controlOps.js';
import { listProducts } from './readModel.js';

function hasBranchColumn(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'branch_id');
  } catch {
    return false;
  }
}

/** @param {'ALL' | string} scope */
function branchSqlArgs(db, table, scope) {
  if (!scope || scope === 'ALL' || !hasBranchColumn(db, table)) {
    return { sql: '', args: [] };
  }
  return { sql: ' AND branch_id = ? ', args: [scope] };
}

/** @param {'ALL' | string} scope @param {string} alias Table alias (e.g. pj) */
function branchSqlArgsForAlias(db, table, scope, alias) {
  if (!scope || scope === 'ALL' || !hasBranchColumn(db, table)) {
    return { sql: '', args: [] };
  }
  return { sql: ` AND ${alias}.branch_id = ? `, args: [scope] };
}

export function ensureAccountingPhase2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      branch_id TEXT NOT NULL,
      acquisition_date_iso TEXT NOT NULL,
      cost_ngn INTEGER NOT NULL DEFAULT 0,
      salvage_ngn INTEGER NOT NULL DEFAULT 0,
      useful_life_months INTEGER NOT NULL DEFAULT 60,
      depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
      status TEXT NOT NULL DEFAULT 'active',
      disposal_date_iso TEXT,
      treasury_reference TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_branch ON fixed_assets(branch_id);
    CREATE TABLE IF NOT EXISTS product_standard_costs (
      product_id TEXT PRIMARY KEY,
      standard_material_cost_ngn_per_kg INTEGER,
      standard_overhead_ngn_per_m INTEGER,
      effective_from_iso TEXT NOT NULL,
      notes TEXT,
      updated_at_iso TEXT NOT NULL,
      updated_by_user_id TEXT
    );
  `);
}

function nextFixedAssetId() {
  return `FA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function monthsBetweenAcquisitionAnd(isoDate, endIso) {
  const a = String(isoDate || '').slice(0, 10);
  const e = String(endIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return 0;
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = e.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1));
}

function mapFixedAssetRow(row) {
  if (!row) return null;
  const cost = Math.round(Number(row.cost_ngn) || 0);
  const salvage = Math.round(Number(row.salvage_ngn) || 0);
  const life = Math.max(1, Math.round(Number(row.useful_life_months) || 1));
  const depBase = Math.max(0, cost - salvage);
  const monthlyDepreciationNgn = row.depreciation_method === 'straight_line' ? Math.round(depBase / life) : 0;
  const endDate =
    row.status === 'disposed' && row.disposal_date_iso
      ? String(row.disposal_date_iso).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const monthsRun = monthsBetweenAcquisitionAnd(row.acquisition_date_iso, endDate);
  const accumulatedNgn =
    row.depreciation_method === 'straight_line'
      ? Math.min(depBase, monthlyDepreciationNgn * monthsRun)
      : 0;
  const netBookValueNgn = Math.max(salvage, cost - accumulatedNgn);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    branchId: row.branch_id,
    acquisitionDateIso: row.acquisition_date_iso,
    costNgn: cost,
    salvageNgn: salvage,
    usefulLifeMonths: life,
    depreciationMethod: row.depreciation_method,
    status: row.status,
    disposalDateIso: row.disposal_date_iso ?? '',
    treasuryReference: row.treasury_reference ?? '',
    notes: row.notes ?? '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    createdByUserId: row.created_by_user_id ?? '',
    updatedByUserId: row.updated_by_user_id ?? '',
    monthlyDepreciationNgn,
    accumulatedDepreciationNgn: accumulatedNgn,
    netBookValueNgn,
  };
}

const ASSET_CATEGORIES = new Set(['plant', 'vehicle', 'it', 'building', 'land', 'other']);

/** @param {import('better-sqlite3').Database} db @param {'ALL' | string} branchScope */
export function listFixedAssets(db, branchScope) {
  ensureAccountingPhase2Schema(db);
  const b = branchSqlArgs(db, 'fixed_assets', branchScope);
  const rows = db
    .prepare(
      `SELECT * FROM fixed_assets WHERE 1=1${b.sql} ORDER BY acquisition_date_iso DESC, name COLLATE NOCASE`
    )
    .all(...b.args);
  return { ok: true, assets: rows.map(mapFixedAssetRow) };
}

/** @param {import('better-sqlite3').Database} db */
export function createFixedAsset(db, body, user) {
  ensureAccountingPhase2Schema(db);
  const name = String(body?.name || '').trim();
  if (!name) return { ok: false, error: 'Asset name is required.' };
  let category = String(body?.category || 'other').toLowerCase();
  if (!ASSET_CATEGORIES.has(category)) category = 'other';
  const branchId = String(body?.branchId || '').trim();
  if (!branchId) return { ok: false, error: 'Branch is required.' };
  const acquisitionDateIso = String(body?.acquisitionDateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDateIso)) {
    return { ok: false, error: 'Valid acquisition date (YYYY-MM-DD) is required.' };
  }
  try {
    assertPeriodOpen(db, acquisitionDateIso, 'Fixed asset acquisition date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const costNgn = Math.round(Number(body?.costNgn) || 0);
  if (costNgn < 0) return { ok: false, error: 'Cost cannot be negative.' };
  const salvageNgn = Math.max(0, Math.round(Number(body?.salvageNgn) || 0));
  const usefulLifeMonths = Math.max(1, Math.round(Number(body?.usefulLifeMonths) || 60));
  const method = String(body?.depreciationMethod || 'straight_line');
  const depMethod = method === 'straight_line' ? 'straight_line' : 'straight_line';
  const now = new Date().toISOString();
  const id = nextFixedAssetId();
  const uid = user?.id ? String(user.id) : null;
  db.prepare(
    `INSERT INTO fixed_assets (
      id, name, category, branch_id, acquisition_date_iso, cost_ngn, salvage_ngn, useful_life_months,
      depreciation_method, status, disposal_date_iso, treasury_reference, notes,
      created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    category,
    branchId,
    acquisitionDateIso,
    costNgn,
    salvageNgn,
    usefulLifeMonths,
    depMethod,
    'active',
    null,
    String(body?.treasuryReference || '').trim() || null,
    String(body?.notes || '').trim() || null,
    now,
    now,
    uid,
    uid
  );
  const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  return { ok: true, asset: mapFixedAssetRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function updateFixedAsset(db, assetId, body, user) {
  ensureAccountingPhase2Schema(db);
  const id = String(assetId || '').trim();
  const cur = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  if (!cur) return { ok: false, error: 'Asset not found.' };
  if (cur.status === 'disposed') return { ok: false, error: 'Disposed assets cannot be edited.' };

  const name = body?.name != null ? String(body.name).trim() : cur.name;
  if (!name) return { ok: false, error: 'Asset name is required.' };
  let category = body?.category != null ? String(body.category).toLowerCase() : cur.category;
  if (!ASSET_CATEGORIES.has(category)) category = cur.category;
  const branchId = body?.branchId != null ? String(body.branchId).trim() : cur.branch_id;
  if (!branchId) return { ok: false, error: 'Branch is required.' };
  const acquisitionDateIso =
    body?.acquisitionDateIso != null
      ? String(body.acquisitionDateIso).slice(0, 10)
      : cur.acquisition_date_iso;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDateIso)) {
    return { ok: false, error: 'Valid acquisition date (YYYY-MM-DD) is required.' };
  }
  const costNgn =
    body?.costNgn != null ? Math.round(Number(body.costNgn) || 0) : Math.round(Number(cur.cost_ngn) || 0);
  if (costNgn < 0) return { ok: false, error: 'Cost cannot be negative.' };
  const salvageNgn =
    body?.salvageNgn != null
      ? Math.max(0, Math.round(Number(body.salvageNgn) || 0))
      : Math.round(Number(cur.salvage_ngn) || 0);
  const usefulLifeMonths =
    body?.usefulLifeMonths != null
      ? Math.max(1, Math.round(Number(body.usefulLifeMonths) || 1))
      : Math.round(Number(cur.useful_life_months) || 60);
  const treasuryReference =
    body?.treasuryReference != null
      ? String(body.treasuryReference).trim() || null
      : cur.treasury_reference;
  const notes = body?.notes != null ? String(body.notes).trim() || null : cur.notes;
  const now = new Date().toISOString();
  const uid = user?.id ? String(user.id) : null;

  const financialTouch =
    body?.acquisitionDateIso != null ||
    body?.costNgn != null ||
    body?.salvageNgn != null ||
    body?.usefulLifeMonths != null ||
    body?.branchId != null ||
    body?.category != null ||
    body?.treasuryReference != null;
  if (financialTouch) {
    try {
      assertPeriodOpen(db, acquisitionDateIso, 'Fixed asset acquisition date');
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  db.prepare(
    `UPDATE fixed_assets SET
      name = ?, category = ?, branch_id = ?, acquisition_date_iso = ?,
      cost_ngn = ?, salvage_ngn = ?, useful_life_months = ?,
      treasury_reference = ?, notes = ?, updated_at_iso = ?, updated_by_user_id = ?
    WHERE id = ?`
  ).run(
    name,
    category,
    branchId,
    acquisitionDateIso,
    costNgn,
    salvageNgn,
    usefulLifeMonths,
    treasuryReference,
    notes,
    now,
    uid,
    id
  );
  const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  return { ok: true, asset: mapFixedAssetRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function disposeFixedAsset(db, assetId, disposalDateIso, user) {
  ensureAccountingPhase2Schema(db);
  const id = String(assetId || '').trim();
  const cur = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  if (!cur) return { ok: false, error: 'Asset not found.' };
  const d = String(disposalDateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, error: 'Valid disposal date (YYYY-MM-DD) is required.' };
  }
  try {
    assertPeriodOpen(db, d, 'Fixed asset disposal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const now = new Date().toISOString();
  const uid = user?.id ? String(user.id) : null;
  db.prepare(
    `UPDATE fixed_assets SET status = 'disposed', disposal_date_iso = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE id = ?`
  ).run(d, now, uid, id);
  const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(id);
  return { ok: true, asset: mapFixedAssetRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function listProductStandardCosts(db) {
  ensureAccountingPhase2Schema(db);
  const rows = db.prepare(`SELECT * FROM product_standard_costs ORDER BY product_id`).all();
  return {
    ok: true,
    costs: rows.map((r) => ({
      productId: r.product_id,
      standardMaterialCostNgnPerKg: r.standard_material_cost_ngn_per_kg,
      standardOverheadNgnPerM: r.standard_overhead_ngn_per_m,
      effectiveFromIso: r.effective_from_iso,
      notes: r.notes ?? '',
      updatedAtIso: r.updated_at_iso,
      updatedByUserId: r.updated_by_user_id ?? '',
    })),
  };
}

/** @param {import('better-sqlite3').Database} db */
export function upsertProductStandardCost(db, productId, body, user) {
  ensureAccountingPhase2Schema(db);
  const pid = String(productId || '').trim();
  if (!pid) return { ok: false, error: 'Product id is required.' };
  const prod = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get(pid);
  if (!prod) return { ok: false, error: 'Unknown product.' };

  const mat =
    body?.standardMaterialCostNgnPerKg == null || body.standardMaterialCostNgnPerKg === ''
      ? null
      : Math.max(0, Math.round(Number(body.standardMaterialCostNgnPerKg)));
  const ovh =
    body?.standardOverheadNgnPerM == null || body.standardOverheadNgnPerM === ''
      ? null
      : Math.max(0, Math.round(Number(body.standardOverheadNgnPerM)));
  const effectiveFromIso = String(body?.effectiveFromIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFromIso)) {
    return { ok: false, error: 'Valid effective-from date (YYYY-MM-DD) is required.' };
  }
  try {
    assertPeriodOpen(db, effectiveFromIso, 'Standard cost effective date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const notes = String(body?.notes || '').trim() || null;
  const now = new Date().toISOString();
  const uid = user?.id ? String(user.id) : null;

  db.prepare(
    `INSERT INTO product_standard_costs (product_id, standard_material_cost_ngn_per_kg, standard_overhead_ngn_per_m, effective_from_iso, notes, updated_at_iso, updated_by_user_id)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(product_id) DO UPDATE SET
       standard_material_cost_ngn_per_kg = excluded.standard_material_cost_ngn_per_kg,
       standard_overhead_ngn_per_m = excluded.standard_overhead_ngn_per_m,
       effective_from_iso = excluded.effective_from_iso,
       notes = excluded.notes,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id`
  ).run(pid, mat, ovh, effectiveFromIso, notes, now, uid);

  const row = db.prepare(`SELECT * FROM product_standard_costs WHERE product_id = ?`).get(pid);
  return {
    ok: true,
    cost: {
      productId: row.product_id,
      standardMaterialCostNgnPerKg: row.standard_material_cost_ngn_per_kg,
      standardOverheadNgnPerM: row.standard_overhead_ngn_per_m,
      effectiveFromIso: row.effective_from_iso,
      notes: row.notes ?? '',
      updatedAtIso: row.updated_at_iso,
      updatedByUserId: row.updated_by_user_id ?? '',
    },
  };
}

/** @param {import('better-sqlite3').Database} db @param {'ALL' | string} branchScope */
export function getCostingSnapshot(db, branchScope) {
  ensureAccountingPhase2Schema(db);
  const products = listProducts(db, branchScope);
  const stdRows = db.prepare(`SELECT * FROM product_standard_costs`).all();
  const stdMap = new Map(stdRows.map((r) => [r.product_id, r]));

  const coilB = branchSqlArgs(db, 'coil_lots', branchScope);
  const coilAgg = db
    .prepare(
      `SELECT product_id AS product_id,
        COUNT(*) AS lot_count,
        SUM(CASE WHEN unit_cost_ngn_per_kg IS NOT NULL AND unit_cost_ngn_per_kg > 0 THEN 1 ELSE 0 END) AS lots_with_cost,
        AVG(CASE WHEN unit_cost_ngn_per_kg IS NOT NULL AND unit_cost_ngn_per_kg > 0 THEN unit_cost_ngn_per_kg END) AS avg_cost_per_kg,
        SUM(CASE WHEN landed_cost_ngn IS NOT NULL AND landed_cost_ngn > 0 THEN landed_cost_ngn ELSE 0 END) AS sum_landed_ngn
      FROM coil_lots WHERE 1=1${coilB.sql}
      GROUP BY product_id`
    )
    .all(...coilB.args);
  const coilMap = new Map(coilAgg.map((r) => [r.product_id, r]));

  const pjB = branchSqlArgsForAlias(db, 'production_jobs', branchScope, 'pj');
  const prodAgg = db
    .prepare(
      `SELECT pjc.product_id AS product_id,
        SUM(pjc.consumed_weight_kg) AS kg_consumed_90d,
        COUNT(DISTINCT pjc.job_id) AS jobs_touched
      FROM production_job_coils pjc
      INNER JOIN production_jobs pj ON pj.job_id = pjc.job_id
      WHERE date(pj.created_at_iso) >= date('now', '-90 days')${pjB.sql}
      GROUP BY pjc.product_id`
    )
    .all(...pjB.args);
  const prodMap = new Map(prodAgg.map((r) => [r.product_id, r]));

  const rows = products.map((p) => {
    const std = stdMap.get(p.productID) || null;
    const coil = coilMap.get(p.productID) || null;
    const pr = prodMap.get(p.productID) || null;
    const avgActual = coil?.avg_cost_per_kg != null ? Math.round(Number(coil.avg_cost_per_kg)) : null;
    const stdMat = std?.standard_material_cost_ngn_per_kg != null ? std.standard_material_cost_ngn_per_kg : null;
    let variancePct = null;
    if (stdMat != null && stdMat > 0 && avgActual != null) {
      variancePct = Math.round(((avgActual - stdMat) / stdMat) * 1000) / 10;
    }
    return {
      productId: p.productID,
      productName: p.name,
      unit: p.unit || '',
      standardMaterialCostNgnPerKg: stdMat,
      standardOverheadNgnPerM: std?.standard_overhead_ngn_per_m ?? null,
      effectiveFromIso: std?.effective_from_iso ?? '',
      coilLotCount: coil ? Number(coil.lot_count) || 0 : 0,
      coilLotsWithUnitCost: coil ? Number(coil.lots_with_cost) || 0 : 0,
      actualAvgUnitCostNgnPerKg: avgActual,
      varianceMaterialPct: variancePct,
      consumedKgLast90d: pr ? Number(pr.kg_consumed_90d) || 0 : 0,
      productionJobsLast90d: pr ? Number(pr.jobs_touched) || 0 : 0,
    };
  });

  return { ok: true, branchScope, rows };
}
