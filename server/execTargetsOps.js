/**
 * Company-level targets vs actuals for executive dashboard.
 */
import { productionOutputDateISO } from '../shared/lib/liveAnalytics.js';
import { getJsonBlob } from './readModel.js';
import { listProductionJobs } from './readModel.js';

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function isoInRange(iso, startISO, endISO) {
  if (!iso) return false;
  return iso >= startISO && iso <= endISO;
}

function targetStatus(actual, target) {
  const t = Number(target) || 0;
  const a = Number(actual) || 0;
  if (!(t > 0)) return 'No Target Set';
  if (a >= t * 1.05) return 'Ahead';
  if (a <= t * 0.95) return 'Behind';
  return 'On Track';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ startISO: string; endISO: string; monthKey?: string }} period
 * @param {{ producedRevenueNgn?: number }} sales
 */
export function buildExecTargetsPanel(db, branchScope, period, sales = {}) {
  const monthKey = String(period?.monthKey || period?.endISO || '').slice(0, 7);
  const startISO = String(period?.startISO || '').slice(0, 10);
  const endISO = String(period?.endISO || '').slice(0, 10);

  const raw = getJsonBlob(db, 'org.manager_targets.v1');
  const nairaTarget =
    raw && Number.isFinite(Number(raw.nairaTargetPerMonth)) && Number(raw.nairaTargetPerMonth) > 0
      ? Math.round(Number(raw.nairaTargetPerMonth))
      : null;
  const metreTarget =
    raw && Number.isFinite(Number(raw.meterTargetPerMonth)) && Number(raw.meterTargetPerMonth) > 0
      ? Math.round(Number(raw.meterTargetPerMonth))
      : null;

  const configured = nairaTarget != null || metreTarget != null;

  let productionMetres = 0;
  try {
    for (const job of listProductionJobs(db, branchScope)) {
      if (!productionJobIsCompleted(job)) continue;
      const d = productionOutputDateISO(job);
      if (!isoInRange(d, startISO, endISO)) continue;
      productionMetres += Number(job.effectiveOutputMeters ?? job.actualMeters) || 0;
    }
  } catch {
    productionMetres = 0;
  }
  productionMetres = Math.round(productionMetres);

  const actualRevenue = Math.round(Number(sales.producedRevenueNgn) || 0);

  /** @type {object[]} */
  const rows = [];

  if (nairaTarget != null) {
    const variance = actualRevenue - nairaTarget;
    rows.push({
      metricKey: 'naira_sales',
      label: 'Produced revenue (month target)',
      target: nairaTarget,
      actual: actualRevenue,
      varianceNgn: variance,
      variancePct: nairaTarget > 0 ? Math.round((variance / nairaTarget) * 1000) / 10 : null,
      status: targetStatus(actualRevenue, nairaTarget),
      unit: 'NGN',
      basis: 'produced_revenue_in_period',
    });
  } else {
    rows.push({
      metricKey: 'naira_sales',
      label: 'Produced revenue (month target)',
      target: null,
      actual: actualRevenue,
      varianceNgn: null,
      variancePct: null,
      status: 'No Target Set',
      unit: 'NGN',
      basis: 'produced_revenue_in_period',
    });
  }

  if (metreTarget != null) {
    const variance = productionMetres - metreTarget;
    rows.push({
      metricKey: 'production_metres',
      label: 'Production metres (month target)',
      target: metreTarget,
      actual: productionMetres,
      varianceNgn: variance,
      variancePct: metreTarget > 0 ? Math.round((variance / metreTarget) * 1000) / 10 : null,
      status: targetStatus(productionMetres, metreTarget),
      unit: 'm',
      basis: 'completed_job_output_metres_in_period',
    });
  } else {
    rows.push({
      metricKey: 'production_metres',
      label: 'Production metres (month target)',
      target: null,
      actual: productionMetres,
      varianceNgn: null,
      variancePct: null,
      status: 'No Target Set',
      unit: 'm',
      basis: 'completed_job_output_metres_in_period',
    });
  }

  return {
    basis: 'company',
    configured,
    monthKey,
    period: { startISO, endISO },
    rows,
    note: configured
      ? 'Targets from org.manager_targets.v1. Compare period actuals — not cash-based.'
      : 'No target configured. Set company targets via org manager targets setup.',
  };
}
