/**
 * Machine lifetime maintenance + vendor cost comparison (from maintenance_cost_lines only).
 * Does not change Spend category totals (those stay on paymentRequests/expenses).
 */
import { mapFixedAssetRow } from './accountingPhase2Ops.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { repairReplaceFlag, repairReplaceLabel } from '../shared/maintenanceRepairReplace.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean }} [scope]
 */
export function buildMaintenanceMachineInsights(db, scope = {}) {
  const branchId = String(scope.branchId || '').trim();
  const viewAll = Boolean(scope.viewAll);

  let machineSql = `SELECT * FROM machines WHERE LOWER(COALESCE(status, 'active')) != 'disposed'`;
  const machineArgs = [];
  if (!viewAll && branchId) {
    machineSql += ` AND branch_id = ?`;
    machineArgs.push(branchId);
  }
  machineSql += ` ORDER BY name COLLATE NOCASE`;
  const machines = db.prepare(machineSql).all(...machineArgs);

  const costByMachine = new Map();
  const costRows = db
    .prepare(
      `SELECT wo.machine_id AS machine_id, SUM(cl.amount_ngn) AS lifetime_ngn, COUNT(*) AS line_count
       FROM maintenance_cost_lines cl
       INNER JOIN maintenance_work_orders wo ON wo.id = cl.work_order_id
       WHERE cl.source_kind IN ('payment_request', 'expense')
         AND TRIM(COALESCE(cl.source_id, '')) != ''
       GROUP BY wo.machine_id`
    )
    .all();
  for (const r of costRows) {
    costByMachine.set(String(r.machine_id), {
      lifetimeNgn: Math.round(Number(r.lifetime_ngn) || 0),
      lineCount: Number(r.line_count) || 0,
    });
  }

  const openReplaceByMachine = new Map();
  const openWoByMachine = new Map();
  const flagRows = db
    .prepare(
      `SELECT machine_id,
              MAX(replacement_required) AS replacement_required,
              COUNT(*) AS open_count
       FROM maintenance_work_orders
       WHERE LOWER(COALESCE(status, '')) NOT IN ('closed', 'cancelled', 'rejected')
       GROUP BY machine_id`
    )
    .all();
  for (const r of flagRows) {
    openReplaceByMachine.set(String(r.machine_id), Number(r.replacement_required) || 0);
    openWoByMachine.set(String(r.machine_id), Number(r.open_count) || 0);
  }

  const outputMetresByMachine = new Map();
  try {
    const outputRows = db
      .prepare(
        `SELECT m.id AS machine_id, SUM(COALESCE(pj.actual_meters, 0)) AS output_metres
         FROM machines m
         LEFT JOIN production_jobs pj
           ON pj.machine_id = m.id OR (pj.machine_id IS NULL AND pj.machine_name = m.name)
         GROUP BY m.id`
      )
      .all();
    for (const r of outputRows) outputMetresByMachine.set(String(r.machine_id), Number(r.output_metres) || 0);
  } catch {
    try {
      const outputRows = db
        .prepare(
          `SELECT m.id AS machine_id, SUM(COALESCE(pj.actual_meters, 0)) AS output_metres
           FROM machines m LEFT JOIN production_jobs pj ON pj.machine_name = m.name GROUP BY m.id`
        )
        .all();
      for (const r of outputRows) outputMetresByMachine.set(String(r.machine_id), Number(r.output_metres) || 0);
    } catch {
      // Production jobs cannot be linked to machines in this schema.
    }
  }
  const downtimeByMachine = new Map();
  const downtimeRows = db
    .prepare(
      `SELECT machine_id, SUM(COALESCE(downtime_hours, 0)) AS downtime_hours
       FROM maintenance_work_orders GROUP BY machine_id`
    )
    .all();
  for (const r of downtimeRows) downtimeByMachine.set(String(r.machine_id), Number(r.downtime_hours) || 0);

  const primaryAssetByMachine = new Map();
  const linkRows = db
    .prepare(
      `SELECT machine_id, asset_id FROM machine_asset_links
       WHERE relation_kind = 'primary' OR relation_kind IS NULL OR TRIM(relation_kind) = ''
       ORDER BY relation_kind DESC`
    )
    .all();
  for (const r of linkRows) {
    const mid = String(r.machine_id);
    if (!primaryAssetByMachine.has(mid)) primaryAssetByMachine.set(mid, String(r.asset_id));
  }

  const assetCache = new Map();
  const getAsset = (assetId) => {
    if (!assetId) return null;
    if (assetCache.has(assetId)) return assetCache.get(assetId);
    const row = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(assetId);
    const mapped = mapFixedAssetRow(row);
    assetCache.set(assetId, mapped);
    return mapped;
  };

  const machinesOut = machines.map((m) => {
    const mid = String(m.id);
    const costs = costByMachine.get(mid) || { lifetimeNgn: 0, lineCount: 0 };
    const assetId = primaryAssetByMachine.get(mid) || '';
    const asset = getAsset(assetId);
    const costNgn = asset ? asset.costNgn : null;
    const nbv = asset ? asset.netBookValueNgn : null;
    const replacementRequired = Boolean(openReplaceByMachine.get(mid));
    const flag = repairReplaceFlag({
      lifetimeMaintenanceNgn: costs.lifetimeNgn,
      costNgn,
      netBookValueNgn: nbv,
      replacementRequired,
    });
    const pctOfCost =
      costNgn && costNgn > 0 ? Math.round((costs.lifetimeNgn / costNgn) * 1000) / 10 : null;
    const pctOfNbv = nbv && nbv > 0 ? Math.round((costs.lifetimeNgn / nbv) * 1000) / 10 : null;
    return {
      machineId: mid,
      name: m.name,
      machineCode: m.machine_code || '',
      code: m.machine_code || '',
      branchId: m.branch_id,
      status: m.status,
      assetId,
      assetName: asset?.name || '',
      costNgn,
      purchaseCost: costNgn,
      netBookValueNgn: nbv,
      netBookValue: nbv,
      lifetimeMaintenanceNgn: costs.lifetimeNgn,
      lifetimeRepairCost: costs.lifetimeNgn,
      costLineCount: costs.lineCount,
      outputMetres: outputMetresByMachine.get(mid) || 0,
      downtimeHours: downtimeByMachine.get(mid) || 0,
      openWorkOrders: openWoByMachine.get(mid) || 0,
      pctOfCost,
      ratioOfCost: costNgn && costNgn > 0 ? costs.lifetimeNgn / costNgn : null,
      pctOfNbv,
      flag,
      signal: flag === 'urgent' ? 'replace_review' : flag,
      urgent: flag === 'urgent',
      flagLabel: repairReplaceLabel(flag),
      replacementRequired,
    };
  });

  machinesOut.sort((a, b) => {
    const rank = { urgent: 0, replace_review: 1, watch: 2, ok: 3 };
    const dr = (rank[a.flag] ?? 9) - (rank[b.flag] ?? 9);
    if (dr !== 0) return dr;
    return b.lifetimeMaintenanceNgn - a.lifetimeMaintenanceNgn;
  });

  return machinesOut;
}

/**
 * Vendor spend attributed via cost lines on work orders with vendor_id / vendor_name.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean }} [scope]
 */
export function buildMaintenanceVendorCostComparison(db, scope = {}) {
  const branchId = String(scope.branchId || '').trim();
  const viewAll = Boolean(scope.viewAll);

  let sql = `
    SELECT
      COALESCE(NULLIF(TRIM(wo.vendor_id), ''), 'unassigned') AS vendor_key,
      COALESCE(NULLIF(TRIM(wo.vendor_name), ''), v.name, 'Unassigned') AS vendor_name,
      wo.vendor_id AS vendor_id,
      MAX(COALESCE(v.specialty, '')) AS specialty,
      MAX(COALESCE(v.phone, '')) AS phone,
      SUM(cl.amount_ngn) AS total_ngn,
      SUM(CASE
            WHEN DATE(COALESCE(cl.posted_at_iso, wo.opened_at_iso)) >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
            THEN cl.amount_ngn ELSE 0
          END) AS last90_ngn,
      COUNT(*) AS line_count,
      COUNT(DISTINCT wo.id) AS job_count,
      COUNT(DISTINCT wo.machine_id) AS machine_count
    FROM maintenance_cost_lines cl
    INNER JOIN maintenance_work_orders wo ON wo.id = cl.work_order_id
    LEFT JOIN maintenance_vendors v ON v.id = wo.vendor_id
    WHERE cl.source_kind IN ('payment_request', 'expense')
      AND TRIM(COALESCE(cl.source_id, '')) != ''
  `;
  const args = [];
  if (!viewAll && branchId) {
    sql += ` AND wo.branch_id = ?`;
    args.push(branchId);
  }
  sql += `
    GROUP BY vendor_key, vendor_name, wo.vendor_id
    ORDER BY total_ngn DESC
  `;
  return db.prepare(sql).all(...args).map((r) => {
    const totalNgn = Math.round(Number(r.total_ngn) || 0);
    const last90Ngn = Math.round(Number(r.last90_ngn) || 0);
    const jobCount = Number(r.job_count) || 0;
    const avg = jobCount > 0 ? Math.round(totalNgn / jobCount) : 0;
    return {
      vendorId: r.vendor_id || r.vendor_key || '',
      vendorKey: r.vendor_key,
      vendorName: r.vendor_name || 'Unassigned',
      name: r.vendor_name || 'Unassigned',
      specialty: String(r.specialty || '').trim(),
      phone: String(r.phone || '').trim(),
      totalNgn,
      totalSpend: totalNgn,
      last90Ngn,
      last90Spend: last90Ngn,
      lineCount: Number(r.line_count) || 0,
      jobCount,
      avgCostPerJobNgn: avg,
      avgPerJob: avg,
      machineCount: Number(r.machine_count) || 0,
    };
  });
}

/**
 * Full pack for Spend Machines panel + vendor comparison.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean }} [scope]
 */
export function buildMaintenanceInsightsPack(db, scope = {}) {
  const branchId =
    scope.viewAll ? String(scope.branchId || '').trim() : String(scope.branchId || DEFAULT_BRANCH_ID).trim();
  const viewAll = Boolean(scope.viewAll);
  const machines = buildMaintenanceMachineInsights(db, { branchId, viewAll });
  const vendors = buildMaintenanceVendorCostComparison(db, { branchId, viewAll });
  const watchlist = machines.filter((m) => m.flag !== 'ok');
  return {
    ok: true,
    machines,
    vendors,
    watchlist,
    summary: {
      machineCount: machines.length,
      withMaintenanceSpend: machines.filter((m) => m.lifetimeMaintenanceNgn > 0).length,
      watchCount: machines.filter((m) => m.flag === 'watch').length,
      replaceReviewCount: machines.filter((m) => m.flag === 'replace_review' || m.flag === 'urgent').length,
      vendorCount: vendors.length,
      totalAttributedNgn: machines.reduce((s, m) => s + m.lifetimeMaintenanceNgn, 0),
    },
  };
}
