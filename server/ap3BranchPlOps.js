/**
 * AP3d — Branch contribution P&L (management draft).
 * Revenue estimated from completed production jobs; factory cost from AP3c allocation.
 */
import { buildAp3CostingReadinessReport } from './ap3CostingReadinessOps.js';
import { listProductionJobs } from './readModel.js';
import { parsePeriodKey, tableExists } from './ap2ReceivedBasisOps.js';
import { trialBalanceRows } from './glOps.js';
import {
  roundMoney,
  isoInRange,
  jobIsCompleted,
  productionJobOutputDate,
} from './ap3MaterialCostShared.js';

function parseQuotedProductMeters(linesJson) {
  let lines = linesJson;
  if (typeof lines === 'string') {
    try {
      lines = JSON.parse(lines || '{}');
    } catch {
      lines = {};
    }
  }
  if (!lines || typeof lines !== 'object') return 0;
  const products = lines.products;
  if (!Array.isArray(products)) return 0;
  let m = 0;
  for (const p of products) {
    m += Number(String(p?.qty ?? '').replace(/,/g, '')) || 0;
  }
  return m;
}

/**
 * Estimate revenue for a completed job (same basis as production recognition GL).
 * @param {import('better-sqlite3').Database} db
 * @param {object} job
 */
export function estimateJobRevenueNgn(db, job) {
  const qref = String(job.quotationRef || '').trim();
  if (!qref || !tableExists(db, 'quotations')) return 0;
  let qrow;
  try {
    qrow = db.prepare(`SELECT total_ngn, lines_json FROM quotations WHERE id = ?`).get(qref);
  } catch {
    return 0;
  }
  if (!qrow) return 0;
  const totalNgn = roundMoney(qrow.total_ngn);
  const quotedMeters = parseQuotedProductMeters(qrow.lines_json);
  const actualMeters = Number(job.effectiveOutputMeters ?? job.actualMeters) || 0;
  if (totalNgn <= 0 || actualMeters <= 0) return 0;
  const denom = quotedMeters > 0 ? quotedMeters : actualMeters;
  return Math.min(totalNgn, Math.max(0, roundMoney(totalNgn * (actualMeters / denom))));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {{ startISO: string; endISO: string }} period
 */
function revenueByBranchFromJobs(db, branchScope, period) {
  /** @type {Record<string, { revenueNgn: number; jobCount: number; metres: number }>} */
  const map = {};
  if (!tableExists(db, 'production_jobs')) return map;

  for (const job of listProductionJobs(db, branchScope)) {
    if (!jobIsCompleted(job)) continue;
    const outDate = productionJobOutputDate(job);
    if (!outDate || !isoInRange(outDate, period.startISO, period.endISO)) continue;
    const bid = String(job.branchId || '').trim() || '(unassigned)';
    if (!map[bid]) map[bid] = { revenueNgn: 0, jobCount: 0, metres: 0 };
    map[bid].revenueNgn += estimateJobRevenueNgn(db, job);
    map[bid].jobCount += 1;
    map[bid].metres += Number(job.effectiveOutputMeters ?? job.actualMeters) || 0;
  }

  for (const k of Object.keys(map)) {
    map[k].revenueNgn = roundMoney(map[k].revenueNgn);
    map[k].metres = roundMoney(map[k].metres);
  }
  return map;
}

function glRevenueForPeriod(db, period, branchScope) {
  const tb = trialBalanceRows(db, period.startISO, period.endISO);
  if (!tb.ok) return { ok: false, revenueNgn: 0 };
  let revenue = 0;
  for (const r of tb.rows || []) {
    if (String(r.accountType || '').toLowerCase() !== 'revenue') continue;
    const d = roundMoney(r.debitNgn);
    const c = roundMoney(r.creditNgn);
    revenue += c - d;
  }
  return { ok: true, revenueNgn: roundMoney(revenue), branchScoped: branchScope !== 'ALL' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; period?: string | null }} [opts]
 */
export function buildAp3BranchPlReport(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && String(opts.branchId).trim() !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';

  const periodKey = String(opts.period || '').trim() || new Date().toISOString().slice(0, 7);
  const period = parsePeriodKey(periodKey);
  if (!period) return { ok: false, error: 'period must be YYYY-MM.' };

  const readiness = buildAp3CostingReadinessReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
    period: periodKey,
  });

  const contribution = readiness.branchContributionDraft || { ok: false, rows: [] };
  const revenueMap = revenueByBranchFromJobs(db, branchScope, period);
  const glRev = glRevenueForPeriod(db, period, branchScope);

  const rows = (contribution.rows || []).map((c) => {
    const rev = revenueMap[c.branchId] || { revenueNgn: 0, jobCount: 0, metres: 0 };
    const factoryCost = c.totalProductionCostNgn || 0;
    const contributionNgn = roundMoney(rev.revenueNgn - factoryCost);
    const marginPct =
      rev.revenueNgn > 0 ? Math.round((contributionNgn / rev.revenueNgn) * 1000) / 10 : null;
    return {
      branchId: c.branchId,
      producedMetres: c.producedMetres,
      jobCount: rev.jobCount,
      estimatedRevenueNgn: rev.revenueNgn,
      materialCostNgn: c.materialCostNgn,
      labourAllocatedNgn: c.labourAllocatedNgn,
      dieselAllocatedNgn: c.dieselAllocatedNgn,
      overheadAllocatedNgn: c.overheadAllocatedNgn,
      factoryCostNgn: factoryCost,
      contributionNgn,
      marginPct,
      costPerMetreNgn: c.draftCostPerMetreNgn,
      draft: true,
    };
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.revenueNgn += r.estimatedRevenueNgn;
      acc.factoryCostNgn += r.factoryCostNgn;
      acc.contributionNgn += r.contributionNgn;
      acc.metres += r.producedMetres;
      return acc;
    },
    { revenueNgn: 0, factoryCostNgn: 0, contributionNgn: 0, metres: 0 }
  );
  totals.revenueNgn = roundMoney(totals.revenueNgn);
  totals.factoryCostNgn = roundMoney(totals.factoryCostNgn);
  totals.contributionNgn = roundMoney(totals.contributionNgn);
  totals.marginPct =
    totals.revenueNgn > 0 ? Math.round((totals.contributionNgn / totals.revenueNgn) * 1000) / 10 : null;

  const revenueGlGap = glRev.ok ? roundMoney(totals.revenueNgn - glRev.revenueNgn) : null;
  const warnings = [];
  if (revenueGlGap != null && Math.abs(revenueGlGap) > Math.max(50_000, totals.revenueNgn * 0.05)) {
    warnings.push(
      `Estimated branch revenue (${totals.revenueNgn.toLocaleString()}) differs from GL revenue (${glRev.revenueNgn.toLocaleString()}) — review production jobs vs posted journals.`
    );
  }
  if (!contribution.ok) warnings.push('Factory cost allocation unavailable — no production metres in period.');
  if ((readiness.dataQuality?.highRisk || []).length) {
    warnings.push(...readiness.dataQuality.highRisk.slice(0, 3));
  }

  return {
    ok: true,
    status: 'management_draft',
    label: 'Branch contribution P&L',
    disclaimer:
      'Management draft only — revenue from completed jobs; factory cost from AP3c proportional allocation. Excludes HQ, selling, and admin. Not statutory accounts.',
    generatedAtISO: new Date().toISOString(),
    branchScope,
    periodKey: period.key,
    range: { start: period.startISO, end: period.endISO },
    allocationMethod: contribution.method || 'proportional_by_metres',
    readinessScore: readiness.readinessScore,
    glRevenueNgn: glRev.ok ? glRev.revenueNgn : null,
    revenueGlGapNgn: revenueGlGap,
    totals,
    rows: rows.sort((a, b) => b.contributionNgn - a.contributionNgn),
    warnings,
    summary:
      warnings.length > 0
        ? `${warnings.length} warning(s) — treat as draft until costing data is complete.`
        : rows.length
          ? `Branch contribution for ${period.key} — ${rows.length} branch(es).`
          : 'No branch production data for this period.',
  };
}
