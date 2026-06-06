/**
 * AP3b — Material cost per metre from actual coil consumption (read-only; material only).
 */
import { listProductionJobs } from './readModel.js';
import { getCostingSnapshot } from './accountingPhase2Ops.js';
import { parsePeriodKey, tableExists } from './ap2ReceivedBasisOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import {
  roundMoney,
  isoInRange,
  jobIsCompleted,
  productionJobOutputDate,
  computeJobMaterialCost,
  finalizeMaterialAgg,
} from './ap3MaterialCostShared.js';

const MATERIAL_EXCLUDES = Object.freeze([
  'labour',
  'diesel',
  'machine overhead',
  'transport allocation',
  'HQ / admin',
  'selling expenses',
]);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
function standardCostByProduct(db, branchScope) {
  const map = new Map();
  try {
    const snap = getCostingSnapshot(db, branchScope);
    for (const r of snap.rows || []) {
      map.set(String(r.productId || '').trim(), r);
    }
  } catch {
    /* optional */
  }
  return map;
}

function bumpAgg(map, key, init, jobRow, trustedOnly) {
  if (!map.has(key)) map.set(key, { ...init, key });
  const row = map.get(key);
  row.jobCount += 1;
  row.producedMetres += jobRow.metres || 0;
  row.consumedKg += jobRow.consumedKg || 0;
  row.materialCostNgn += jobRow.materialCostNgn || 0;
  if (jobRow.trust === 'trusted') {
    row.trustedJobCount += 1;
    row.trustedMetres += jobRow.metres || 0;
    row.trustedMaterialCostNgn += jobRow.materialCostNgn || 0;
  } else if (jobRow.trust === 'partial') {
    row.partialJobCount += 1;
  } else {
    row.excludedJobCount += 1;
  }
  if (jobRow.belowMaterialCostWarning) row.belowMaterialCostWarningCount += 1;
  if (trustedOnly && jobRow.trust !== 'trusted') return row;
  return row;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null; period?: string|null; materialFamily?: string|null; gauge?: string|null; colour?: string|null; trustFilter?: string|null; limitJobs?: number }} opts
 */
export function buildAp3MaterialCostReport(db, opts = {}) {
  const flags = readFinanceFeatureFlags();
  const enabled = flags.ap3MaterialCostReportEnabled !== false;

  const branchScope =
    opts.branchId && String(opts.branchId).trim() && String(opts.branchId).trim() !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';

  const periodKey = String(opts.period || '').trim() || new Date().toISOString().slice(0, 7);
  const period = parsePeriodKey(periodKey) || parsePeriodKey(new Date().toISOString().slice(0, 7));
  const filterFamily = String(opts.materialFamily || '').trim().toLowerCase() || null;
  const filterGauge = String(opts.gauge || '').trim() || null;
  const filterColour = String(opts.colour || '').trim() || null;
  const trustFilter = String(opts.trustFilter || '').trim().toLowerCase() || null;
  const limitJobs = Number(opts.limitJobs) >= 0 ? Number(opts.limitJobs) : 50;

  const notes = [
    'Material cost per metre from actual coil consumption on completed jobs.',
    'Trusted totals include only jobs with metres, coil consumption, and full coil unit/landed cost.',
    'Excludes labour, diesel, production overhead, and HQ/admin costs (AP3c).',
    'Not full factory cost per metre — material only.',
  ];

  if (!enabled) {
    return {
      ok: true,
      status: 'disabled',
      label: 'Material Cost per Metre (AP3b)',
      disclaimer: 'AP3 material cost report is disabled. Set AP3_MATERIAL_COST_REPORT_ENABLED=1.',
      enabled: false,
      branchScope,
      period,
      notes,
      flags: { ap3MaterialCostReportEnabled: false },
    };
  }

  if (!tableExists(db, 'production_jobs')) {
    return emptyReport(branchScope, period, notes, flags);
  }

  const standardByProduct = standardCostByProduct(db, branchScope);
  const jobs = listProductionJobs(db, branchScope);

  /** @type {object[]} */
  const jobRows = [];
  /** @type {Map<string, object>} */
  const byBranchMap = new Map();
  /** @type {Map<string, object>} */
  const byFamilyMap = new Map();

  let trustedJobCount = 0;
  let partialJobCount = 0;
  let excludedJobCount = 0;
  let trustedMetres = 0;
  let trustedMaterialCostNgn = 0;
  let allMaterialCostNgn = 0;
  let allMetres = 0;
  let belowMaterialCostWarningCount = 0;

  for (const job of jobs) {
    if (!jobIsCompleted(job)) continue;
    const outDate = productionJobOutputDate(job);
    if (!isoInRange(outDate, period.startISO, period.endISO)) continue;

    const row = computeJobMaterialCost(db, job, standardByProduct);

    if (filterFamily && row.productFamily !== filterFamily) continue;
    if (filterGauge && row.gauge !== filterGauge) continue;
    if (filterColour && row.colour !== filterColour) continue;
    if (trustFilter === 'trusted' && row.trust !== 'trusted') continue;
    if (trustFilter === 'partial' && row.trust !== 'partial') continue;

    if (row.trust === 'trusted') {
      trustedJobCount += 1;
      trustedMetres += row.metres || 0;
      trustedMaterialCostNgn += row.materialCostNgn || 0;
    } else if (row.trust === 'partial') {
      partialJobCount += 1;
    } else {
      excludedJobCount += 1;
    }

    allMetres += row.metres || 0;
    allMaterialCostNgn += row.materialCostNgn || 0;
    if (row.belowMaterialCostWarning) belowMaterialCostWarningCount += 1;

    if (jobRows.length < limitJobs) {
      jobRows.push({
        ...row,
        materialOnly: true,
        coilDetails: row.coilDetails?.slice(0, 6),
      });
    }

    const branchInit = {
      branchId: row.branchId,
      jobCount: 0,
      trustedJobCount: 0,
      partialJobCount: 0,
      excludedJobCount: 0,
      producedMetres: 0,
      trustedMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      trustedMaterialCostNgn: 0,
      belowMaterialCostWarningCount: 0,
    };
    bumpAgg(byBranchMap, row.branchId, branchInit, row, false);

    const famInit = {
      productFamily: row.productFamily,
      jobCount: 0,
      trustedJobCount: 0,
      partialJobCount: 0,
      excludedJobCount: 0,
      producedMetres: 0,
      trustedMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      trustedMaterialCostNgn: 0,
      belowMaterialCostWarningCount: 0,
    };
    bumpAgg(byFamilyMap, row.productFamily, famInit, row, false);
  }

  const byBranch = [...byBranchMap.values()].map(finalizeMaterialAgg).sort((a, b) => b.trustedMetres - a.trustedMetres);
  const byProductFamily = [...byFamilyMap.values()].map(finalizeMaterialAgg).sort((a, b) => b.trustedMetres - a.trustedMetres);

  const trustedMaterialCostPerMetreNgn =
    trustedMetres > 0 && trustedMaterialCostNgn > 0 ? roundMoney(trustedMaterialCostNgn / trustedMetres) : null;

  const allMaterialCostPerMetreNgn =
    allMetres > 0 && allMaterialCostNgn > 0 ? roundMoney(allMaterialCostNgn / allMetres) : null;

  return {
    ok: true,
    status: 'material_cost_only',
    label: 'Material Cost per Metre (AP3b)',
    disclaimer:
      'Material cost only from coil consumption. No GL or inventory values were changed. Not full factory cost.',
    enabled: true,
    materialCostBasis: 'actual_coil_consumption',
    materialFallback: 'landed_cost_then_unit_cost_then_missing',
    excludes: [...MATERIAL_EXCLUDES],
    generatedAtISO: new Date().toISOString(),
    branchScope,
    period,
    summary: {
      jobCount: trustedJobCount + partialJobCount + excludedJobCount,
      trustedJobCount,
      partialJobCount,
      excludedJobCount,
      trustedMetres,
      trustedMaterialCostNgn: roundMoney(trustedMaterialCostNgn),
      trustedMaterialCostPerMetreNgn,
      allMetres,
      allMaterialCostNgn: roundMoney(allMaterialCostNgn),
      allMaterialCostPerMetreNgn,
      belowMaterialCostWarningCount,
    },
    byBranch,
    byProductFamily,
    jobRows,
    notes,
    flags: { ap3MaterialCostReportEnabled: true },
  };
}

function emptyReport(branchScope, period, notes, flags) {
  return {
    ok: true,
    status: 'material_cost_only',
    label: 'Material Cost per Metre (AP3b)',
    disclaimer: 'Material cost only. No data in scope.',
    enabled: true,
    materialCostBasis: 'actual_coil_consumption',
    excludes: [...MATERIAL_EXCLUDES],
    branchScope,
    period,
    summary: {
      jobCount: 0,
      trustedJobCount: 0,
      partialJobCount: 0,
      excludedJobCount: 0,
      trustedMetres: 0,
      trustedMaterialCostNgn: 0,
      trustedMaterialCostPerMetreNgn: null,
      allMetres: 0,
      allMaterialCostNgn: 0,
      allMaterialCostPerMetreNgn: null,
      belowMaterialCostWarningCount: 0,
    },
    byBranch: [],
    byProductFamily: [],
    jobRows: [],
    notes,
    flags: { ap3MaterialCostReportEnabled: flags.ap3MaterialCostReportEnabled !== false },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildAp3MaterialCostTrialSummary(db, branchScope = 'ALL') {
  const r = buildAp3MaterialCostReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
    limitJobs: 0,
  });
  if (!r.enabled || r.status === 'disabled') {
    return { available: false, enabled: false };
  }
  return {
    available: true,
    enabled: true,
    trustedMaterialCostPerMetreNgn: r.summary?.trustedMaterialCostPerMetreNgn ?? null,
    trustedJobCount: r.summary?.trustedJobCount ?? 0,
    partialJobCount: r.summary?.partialJobCount ?? 0,
    belowMaterialCostWarningCount: r.summary?.belowMaterialCostWarningCount ?? 0,
    trustedMetres: r.summary?.trustedMetres ?? 0,
  };
}
