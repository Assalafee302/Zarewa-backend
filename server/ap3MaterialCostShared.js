/**
 * AP3 — shared material cost from actual coil consumption (read-only).
 */
import { productionOutputDateISO } from '../shared/lib/liveAnalytics.js';
import { tableExists } from './ap2ReceivedBasisOps.js';

export function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

export function isoInRange(iso, startISO, endISO) {
  if (!iso) return false;
  const d = String(iso).slice(0, 10);
  return d >= startISO && d <= endISO;
}

export function jobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

export function productionJobOutputDate(job) {
  return productionOutputDateISO(job);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} coilNo
 * @returns {{ costPerKg: number|null; basis: 'unit_cost'|'landed_cost'|'missing' }}
 */
export function resolveCoilCost(db, coilNo) {
  const cn = String(coilNo || '').trim();
  if (!cn || !tableExists(db, 'coil_lots')) return { costPerKg: null, basis: 'missing' };
  try {
    const row = db
      .prepare(
        `SELECT unit_cost_ngn_per_kg, landed_cost_ngn, current_weight_kg, qty_remaining
         FROM coil_lots WHERE coil_no = ?`
      )
      .get(cn);
    if (!row) return { costPerKg: null, basis: 'missing' };
    const unit = Number(row.unit_cost_ngn_per_kg);
    if (Number.isFinite(unit) && unit > 0) {
      return { costPerKg: Math.round(unit), basis: 'unit_cost' };
    }
    const landed = Number(row.landed_cost_ngn);
    const kg = Number(row.current_weight_kg) || Number(row.qty_remaining) || 0;
    if (landed > 0 && kg > 0) {
      return { costPerKg: Math.round(landed / kg), basis: 'landed_cost' };
    }
    return { costPerKg: null, basis: 'missing' };
  } catch {
    return { costPerKg: null, basis: 'missing' };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 */
export function productMeta(db, productId) {
  const pid = String(productId || '').trim();
  if (!pid || !tableExists(db, 'products')) {
    return { productFamily: 'unknown', gauge: '', colour: '' };
  }
  try {
    const row = db
      .prepare(`SELECT material_type, gauge, colour, name FROM products WHERE product_id = ?`)
      .get(pid);
    if (!row) return { productFamily: 'unknown', gauge: '', colour: '' };
    const family = String(row.material_type || row.name || 'unknown').trim() || 'unknown';
    return {
      productFamily: family.toLowerCase(),
      gauge: String(row.gauge || '').trim(),
      colour: String(row.colour || '').trim(),
    };
  } catch {
    return { productFamily: 'unknown', gauge: '', colour: '' };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobId
 */
export function coilsForJob(db, jobId) {
  if (!tableExists(db, 'production_job_coils')) return [];
  try {
    return db
      .prepare(
        `SELECT coil_no, consumed_weight_kg, meters_produced, gauge_label, colour, product_id
         FROM production_job_coils WHERE job_id = ? ORDER BY sequence_no`
      )
      .all(jobId);
  } catch {
    return [];
  }
}

/**
 * @param {{ metres: number; consumedKg: number; materialCostNgn: number; missingCostCount: number; coilRowCount: number }} p
 */
export function confidenceLevel(p) {
  if (p.metres <= 0) return 'low';
  if (p.coilRowCount === 0) return 'low';
  if (p.missingCostCount > 0) return p.materialCostNgn > 0 ? 'medium' : 'low';
  if (p.consumedKg > 0 && p.materialCostNgn > 0 && p.metres > 0) return 'high';
  return 'medium';
}

/** @typedef {'trusted'|'partial'|'excluded'} MaterialCostTrust */

/**
 * @param {{ metres: number; consumedKg: number; materialCostNgn: number; missingCostCount: number; coilRowCount: number; confidence: string }} row
 * @returns {MaterialCostTrust}
 */
export function materialCostTrust(row) {
  if (row.metres <= 0 || row.coilRowCount === 0) return 'excluded';
  if (row.missingCostCount > 0 || row.confidence !== 'high') {
    return row.materialCostNgn > 0 ? 'partial' : 'excluded';
  }
  return 'trusted';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} job
 * @param {Map<string, object>} [standardByProduct]
 */
export function computeJobMaterialCost(db, job, standardByProduct = new Map()) {
  const metres = Math.round(Number(job.effectiveOutputMeters ?? job.actualMeters) || 0);
  const coils = coilsForJob(db, job.jobID);
  const meta = productMeta(db, job.productID);

  let consumedKg = 0;
  let materialCostNgn = 0;
  let missingCostCount = 0;
  let gauge = meta.gauge;
  let colour = meta.colour;
  const coilDetails = [];

  for (const c of coils) {
    const kg = Number(c.consumed_weight_kg) || 0;
    consumedKg += kg;
    if (c.gauge_label) gauge = String(c.gauge_label).trim();
    if (c.colour) colour = String(c.colour).trim();
    const { costPerKg, basis } = resolveCoilCost(db, c.coil_no);
    if (costPerKg == null) {
      missingCostCount += 1;
    } else {
      materialCostNgn += roundMoney(kg * costPerKg);
    }
    coilDetails.push({
      coilNo: c.coil_no,
      consumedKg: roundMoney(kg),
      costBasis: basis,
      costPerKgNgn: costPerKg,
      lineCostNgn: costPerKg != null ? roundMoney(kg * costPerKg) : null,
    });
  }

  const conf = confidenceLevel({
    metres,
    consumedKg,
    materialCostNgn,
    missingCostCount,
    coilRowCount: coils.length,
  });

  const costPerM = metres > 0 && materialCostNgn > 0 ? roundMoney(materialCostNgn / metres) : null;
  const stdRow = standardByProduct.get(String(job.productID || '').trim());
  const stdPerKg = stdRow?.standardMaterialCostNgnPerKg ?? null;
  let stdPerM = null;
  if (stdPerKg != null && metres > 0 && consumedKg > 0) {
    stdPerM = roundMoney((consumedKg * stdPerKg) / metres);
  }
  let varianceVsStandardPct = null;
  if (stdPerM != null && stdPerM > 0 && costPerM != null) {
    varianceVsStandardPct = Math.round(((costPerM - stdPerM) / stdPerM) * 1000) / 10;
  }

  let sellingPricePerMetreNgn = null;
  let materialMarginPerMetreNgn = null;
  const qRef = String(job.quotationRef || '').trim();
  if (qRef && tableExists(db, 'quotations') && metres > 0) {
    try {
      const q = db.prepare(`SELECT total_ngn FROM quotations WHERE id = ?`).get(qRef);
      const total = roundMoney(q?.total_ngn);
      if (total > 0) {
        sellingPricePerMetreNgn = roundMoney(total / metres);
        if (costPerM != null) materialMarginPerMetreNgn = roundMoney(sellingPricePerMetreNgn - costPerM);
      }
    } catch {
      /* optional */
    }
  }

  const base = {
    jobId: job.jobID,
    branchId: String(job.branchId || '').trim() || '(missing branch)',
    quotationRef: qRef || null,
    productId: job.productID || '',
    productFamily: meta.productFamily,
    productLabel: job.productName || job.productID || '—',
    gauge,
    colour,
    metres,
    consumedKg: roundMoney(consumedKg),
    materialCostNgn: materialCostNgn > 0 ? materialCostNgn : null,
    materialCostPerMetreNgn: costPerM,
    standardMaterialCostPerMetreNgn: stdPerM,
    varianceVsStandardPct,
    sellingPricePerMetreNgn,
    materialMarginPerMetreNgn,
    missingCoilCostCount: missingCostCount,
    hasCoilConsumption: coils.length > 0,
    confidence: conf,
    coilCount: coils.length,
    coilDetails,
  };

  const trust = materialCostTrust({
    metres,
    consumedKg,
    materialCostNgn,
    missingCostCount,
    coilRowCount: coils.length,
    confidence: conf,
  });

  return {
    ...base,
    trust,
    belowMaterialCostWarning:
      costPerM != null && sellingPricePerMetreNgn != null && sellingPricePerMetreNgn < costPerM,
  };
}

/**
 * @param {object} row aggregation row
 */
export function finalizeMaterialAgg(row) {
  const metres = row.trustedMetres ?? row.producedMetres ?? 0;
  const cost = row.trustedMaterialCostNgn ?? row.materialCostNgn ?? 0;
  return {
    ...row,
    consumedKg: roundMoney(row.consumedKg),
    materialCostNgn: roundMoney(row.materialCostNgn),
    trustedMaterialCostNgn: roundMoney(row.trustedMaterialCostNgn),
    materialCostPerMetreNgn: metres > 0 && cost > 0 ? roundMoney(cost / metres) : null,
    materialOnly: true,
  };
}
