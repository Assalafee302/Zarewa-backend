import { buildFloorExceptionLog, buildCostVarianceRows } from './pricingGovernanceOps.js';
import { buildMaintenanceInsightsPack } from './maintenanceInsightsOps.js';
import { listOtBoard } from './hrOtBoardOps.js';
import { OPS_METRIC_CATALOG } from '../shared/lib/opsMetricCatalog.js';

function tableExists(db, name) {
  try {
    return Boolean(
      db.prepare(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`
      ).get(name)
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
    } catch {
      return false;
    }
  }
}

function safeJson(value) {
  try {
    return JSON.parse(String(value || '[]'));
  } catch {
    return [];
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

export function buildOpsHealthAnalyticsPack(db, opts = {}) {
  const branchId = String(opts.branchId || '').trim();
  const scoped = branchId && branchId !== 'ALL';
  const scope = { branchId: scoped ? branchId : '', viewAll: !scoped };
  const otBoard = listOtBoard(db, opts);
  const otHours = Math.round(otBoard.reduce((sum, row) => sum + row.overtimeHours, 0) * 100) / 100;
  const attendance = {
    overtimeHours: otHours,
    overtimeRows: otBoard.length,
    rows: otBoard,
  };

  const deliveryArgs = [];
  let deliverySql = `SELECT id, satisfaction_score, status, quotation_ref FROM deliveries WHERE 1 = 1`;
  if (scoped) {
    deliverySql += ` AND branch_id = ?`;
    deliveryArgs.push(branchId);
  }
  const deliveries = tableExists(db, 'deliveries') ? db.prepare(deliverySql).all(...deliveryArgs) : [];
  const scored = deliveries.filter((row) => Number(row.satisfaction_score) >= 1 && Number(row.satisfaction_score) <= 5);
  const csatDistribution = [1, 2, 3, 4, 5].map((score) => ({
    score,
    count: scored.filter((row) => Number(row.satisfaction_score) === score).length,
  }));
  const csat = {
    deliveredCount: deliveries.filter((row) => String(row.status).toLowerCase() === 'delivered').length,
    scoredCount: scored.length,
    average: scored.length ? Math.round((scored.reduce((sum, row) => sum + Number(row.satisfaction_score), 0) / scored.length) * 100) / 100 : null,
    distribution: csatDistribution,
  };
  const floorExceptions = buildFloorExceptionLog(db, { branchId: scoped ? branchId : null });
  const floorGiveawayNgn = floorExceptions.reduce((sum, row) => sum + (Number(row.totalBelowFloorPerMeterNgn) || 0), 0);
  const costVariance = buildCostVarianceRows(db, { branchId: scoped ? branchId : null });
  const maintenance = buildMaintenanceInsightsPack(db, scope);
  const missingWorkedMinutes = [];
  if (tableExists(db, 'hr_daily_roll_calls')) {
    const rolls = db.prepare(`SELECT branch_id, day_iso, rows_json FROM hr_daily_roll_calls${scoped ? ' WHERE branch_id = ?' : ''}`).all(
      ...(scoped ? [branchId] : [])
    );
    for (const roll of rolls) {
      for (const row of Array.isArray(safeJson(roll.rows_json)) ? safeJson(roll.rows_json) : []) {
        if (String(row?.status || '').toLowerCase() === 'present' && row?.workedMinutes == null && row?.worked_minutes == null) {
          missingWorkedMinutes.push({ branchId: roll.branch_id, dayIso: roll.day_iso, userId: row?.userId || '' });
        }
      }
    }
  }
  const deliveredWithoutCsat = deliveries
    .filter((row) => String(row.status).toLowerCase() === 'delivered' && !(Number(row.satisfaction_score) >= 1))
    .map((row) => ({ deliveryId: row.id, quotationRef: row.quotation_ref || '' }));
  const missingVendorCostLines = tableExists(db, 'maintenance_cost_lines')
    ? db.prepare(
        `SELECT cl.id, cl.work_order_id FROM maintenance_cost_lines cl
         INNER JOIN maintenance_work_orders wo ON wo.id = cl.work_order_id
         WHERE cl.source_kind IN ('payment_request', 'expense') AND TRIM(COALESCE(wo.vendor_id, '')) = ''${scoped ? ' AND wo.branch_id = ?' : ''}`
      ).all(...(scoped ? [branchId] : [])).map((row) => ({ costLineId: row.id, workOrderId: row.work_order_id }))
    : [];
  const dq = { presentWithoutWorkedMinutes: missingWorkedMinutes, deliveredWithoutCsat, costLinesMissingVendor: missingVendorCostLines };
  const signals = [
    ...(csat.average != null && csat.average <= 3 ? [{ severity: 'red', code: 'LOW_CSAT', message: `Delivery CSAT averages ${csat.average}/5.` }] : []),
    ...(deliveredWithoutCsat.length ? [{ severity: 'amber', code: 'CSAT_MISSING', message: `${deliveredWithoutCsat.length} delivered order(s) lack CSAT.` }] : []),
    ...(missingVendorCostLines.length ? [{ severity: 'red', code: 'VENDOR_MISSING', message: `${missingVendorCostLines.length} maintenance cost line(s) lack a vendor.` }] : []),
    ...(costVariance.filter((row) => row.flagged).length ? [{ severity: 'amber', code: 'COST_VARIANCE', message: `${costVariance.filter((row) => row.flagged).length} workbook cost variance flag(s).` }] : []),
  ];
  const red = signals.filter((signal) => signal.severity === 'red').length;
  const amber = signals.filter((signal) => signal.severity === 'amber').length;
  const scorecard = {
    status: red ? 'red' : amber ? 'amber' : 'green',
    green: red === 0 && amber === 0 ? 1 : 0,
    amber,
    red,
    score: Math.max(0, 100 - red * 25 - amber * 10),
  };
  return {
    ok: true,
    metricCatalog: OPS_METRIC_CATALOG,
    summary: scorecard,
    attendance,
    csat,
    floorExceptions: { count: floorExceptions.length, floorGiveawayNgn, rows: floorExceptions },
    costVariance: { flaggedCount: costVariance.filter((row) => row.flagged).length, rows: costVariance },
    dataQuality: dq,
    vendors: maintenance.vendors,
    signals,
  };
}

export function opsHealthAnalyticsToCsv(pack) {
  const rows = [
    ['metric', 'value', 'status'],
    ['ops_health_status', pack.summary.status, pack.summary.status],
    ['ops_health_score', pack.summary.score, pack.summary.status],
    ['ot_hours', pack.attendance.overtimeHours, ''],
    ['csat_avg', pack.csat.average ?? '', ''],
    ['floor_giveaway_ngn', pack.floorExceptions.floorGiveawayNgn, ''],
    ['cost_variance_flags', pack.costVariance.flaggedCount, ''],
    ['delivered_without_csat', pack.dataQuality.deliveredWithoutCsat.length, ''],
    ['cost_lines_missing_vendor', pack.dataQuality.costLinesMissingVendor.length, ''],
    ...pack.vendors.map((vendor) => ['vendor_avg_job', vendor.avgCostPerJobNgn, vendor.vendorName]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`;
}
