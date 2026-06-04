/**
 * Estimated material cost per metre for executive dashboard (material only).
 */
import { productionOutputDateISO } from '../shared/lib/liveAnalytics.js';
import { getCostingSnapshot } from './accountingPhase2Ops.js';
import { listProductionJobs } from './readModel.js';

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function isoInRange(iso, startISO, endISO) {
  if (!iso) return false;
  return iso >= startISO && iso <= endISO;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} coilNo
 */
function coilUnitCostPerKg(db, coilNo) {
  const cn = String(coilNo || '').trim();
  if (!cn) return null;
  try {
    const row = db
      .prepare(
        `SELECT unit_cost_ngn_per_kg, landed_cost_ngn, current_weight_kg, qty_remaining
         FROM coil_lots WHERE coil_no = ?`
      )
      .get(cn);
    if (!row) return null;
    const unit = Number(row.unit_cost_ngn_per_kg);
    if (Number.isFinite(unit) && unit > 0) return Math.round(unit);
    const landed = Number(row.landed_cost_ngn);
    const kg = Number(row.current_weight_kg) || Number(row.qty_remaining) || 0;
    if (landed > 0 && kg > 0) return Math.round(landed / kg);
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobId
 */
function coilsForJob(db, jobId) {
  try {
    return db
      .prepare(
        `SELECT coil_no, consumed_weight_kg, product_id, gauge_label, colour
         FROM production_job_coils WHERE job_id = ? ORDER BY sequence_no`
      )
      .all(jobId);
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ startISO: string; endISO: string }} period
 */
export function buildMaterialCostingPanel(db, branchScope, period) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const startISO = String(period?.startISO || '').slice(0, 10);
  const endISO = String(period?.endISO || '').slice(0, 10);

  let standardByProduct = new Map();
  try {
    const snap = getCostingSnapshot(db, scope);
    for (const r of snap.rows || []) {
      standardByProduct.set(String(r.productId || '').trim(), r);
    }
  } catch {
    /* optional */
  }

  const jobs = listProductionJobs(db, scope);
  /** @type {object[]} */
  const rows = [];

  for (const job of jobs) {
    if (!productionJobIsCompleted(job)) continue;
    const outDate = productionOutputDateISO(job);
    if (!isoInRange(outDate, startISO, endISO)) continue;

    const metres = Math.round(Number(job.effectiveOutputMeters ?? job.actualMeters) || 0);
    const coils = coilsForJob(db, job.jobID);
    let consumedKg = 0;
    let materialCostNgn = 0;
    let missingCost = false;

    for (const c of coils) {
      const kg = Number(c.consumed_weight_kg) || 0;
      consumedKg += kg;
      const unit = coilUnitCostPerKg(db, c.coil_no);
      if (unit == null) {
        missingCost = true;
      } else {
        materialCostNgn += Math.round(kg * unit);
      }
    }

    if (missingCost && materialCostNgn <= 0) {
      rows.push({
        jobId: job.jobID,
        productLabel: job.productName || job.productID || '—',
        branchId: job.branchId || '',
        periodLabel: `${startISO} – ${endISO}`,
        actualMetres: metres || null,
        consumedKg: Math.round(consumedKg),
        estimatedMaterialCostNgn: null,
        estimatedMaterialCostPerMetreNgn: null,
        standardMaterialCostPerMetreNgn: null,
        varianceVsStandardPct: null,
        costUnavailable: true,
        estimated: true,
      });
      continue;
    }

    const costPerM =
      metres > 0 && materialCostNgn > 0 ? Math.round(materialCostNgn / metres) : null;
    const stdRow = standardByProduct.get(String(job.productID || '').trim());
    const stdPerKg = stdRow?.standardMaterialCostNgnPerKg ?? null;
    const stdPerM =
      stdPerKg != null && metres > 0 && consumedKg > 0
        ? Math.round((consumedKg * stdPerKg) / metres)
        : stdRow?.standardOverheadNgnPerM != null
          ? null
          : null;
    let varianceVsStandardPct = null;
    if (stdPerM != null && stdPerM > 0 && costPerM != null) {
      varianceVsStandardPct = Math.round(((costPerM - stdPerM) / stdPerM) * 1000) / 10;
    } else if (stdPerKg != null && stdPerKg > 0 && costPerM != null && consumedKg > 0 && metres > 0) {
      const impliedStdPerM = Math.round((consumedKg * stdPerKg) / metres);
      if (impliedStdPerM > 0) {
        varianceVsStandardPct = Math.round(((costPerM - impliedStdPerM) / impliedStdPerM) * 1000) / 10;
      }
    }

    rows.push({
      jobId: job.jobID,
      productLabel: job.productName || job.productID || '—',
      branchId: job.branchId || '',
      periodLabel: `${startISO} – ${endISO}`,
      actualMetres: metres || null,
      consumedKg: Math.round(consumedKg),
      estimatedMaterialCostNgn: materialCostNgn > 0 ? materialCostNgn : null,
      estimatedMaterialCostPerMetreNgn: costPerM,
      standardMaterialCostPerMetreNgn: stdPerM,
      standardMaterialCostPerKg: stdPerKg,
      varianceVsStandardPct,
      costUnavailable: false,
      estimated: true,
    });
  }

  rows.sort((a, b) => (b.estimatedMaterialCostNgn || 0) - (a.estimatedMaterialCostNgn || 0));

  return {
    label: 'Estimated material cost per metre',
    estimated: true,
    excludes: ['labour', 'diesel', 'machine overhead', 'transport', 'factory allocation'],
    notTrueTotalCost: true,
    period: { startISO, endISO },
    rows: rows.slice(0, 40),
    notes: [
      'Estimated material cost only.',
      'Excludes labour, diesel, machine overhead, transport, and full factory allocation.',
      'Not true total production cost.',
      'Where landed/unit cost is missing, cost is shown as unavailable.',
    ],
  };
}
