/**
 * AP3a — Costing policy & data readiness (read-only; no GL / inventory / payroll mutations).
 */
import { listProductionJobs } from './readModel.js';
import { parsePeriodKey, tableExists, hasColumn } from './ap2ReceivedBasisOps.js';
import {
  classifyExpenseForCosting,
  PROPOSED_COSTING_POLICY,
  PROPOSED_COSTING_POLICY_NOTES,
  COSTING_EXPENSE_BUCKET_LABELS,
} from './ap3CostingClassification.js';
import {
  roundMoney,
  isoInRange,
  jobIsCompleted,
  productionJobOutputDate,
  resolveCoilCost,
  productMeta,
  coilsForJob,
  confidenceLevel,
} from './ap3MaterialCostShared.js';

function computeReadinessScore(summary, dataQuality) {
  let score = 100;
  const jobs = summary.completedJobs || 0;
  if (jobs === 0) score -= 40;
  if (summary.jobsMissingMetres > 0) score -= Math.min(15, summary.jobsMissingMetres);
  if (summary.jobsMissingCoilConsumption > 0) score -= Math.min(20, summary.jobsMissingCoilConsumption * 2);
  if (summary.missingCoilCostCount > 0) score -= Math.min(25, summary.missingCoilCostCount * 2);
  if (summary.unclassifiedExpenseNgn > 0) score -= 5;
  if (!summary.payrollMappable) score -= 10;
  if (!summary.dieselSeparated) score -= 5;
  if ((dataQuality.highRisk || []).length > 0) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function emptyReport(branchScope, period, notes) {
  return {
    ok: true,
    status: 'readiness_only',
    label: 'Costing Policy & Data Readiness',
    disclaimer:
      'Read-only readiness report. No costing or GL values were changed.',
    generatedAtISO: new Date().toISOString(),
    branchScope,
    period,
    readinessScore: 0,
    summary: {
      completedJobs: 0,
      producedMetres: 0,
      jobsWithCoilConsumption: 0,
      jobsMissingCoilConsumption: 0,
      jobsMissingMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      materialCostPerMetreNgn: 0,
      missingCoilCostCount: 0,
      productionExpenseNgn: 0,
      dieselExpenseNgn: 0,
      labourExpenseNgn: 0,
      unclassifiedExpenseNgn: 0,
      payrollMappable: false,
      dieselSeparated: false,
    },
    byBranch: [],
    byProductFamily: [],
    byGaugeColour: [],
    productionJobs: { samples: [] },
    expenseClassification: [],
    labourReadiness: { ready: false, notes: [] },
    dieselReadiness: { ready: false, notes: [] },
    overheadReadiness: { notes: [] },
    dataQuality: { highRisk: [], warnings: [], missingData: [] },
    proposedCostingPolicy: { ...PROPOSED_COSTING_POLICY },
    policyNotes: [...PROPOSED_COSTING_POLICY_NOTES],
    nextSteps: [],
    notes,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string|null; period?: string|null; materialFamily?: string|null; gauge?: string|null; colour?: string|null; limitSamples?: number }} opts
 */
export function buildAp3CostingReadinessReport(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && String(opts.branchId).trim() !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';

  const periodKey = String(opts.period || '').trim() || new Date().toISOString().slice(0, 7);
  const period = parsePeriodKey(periodKey) || parsePeriodKey(new Date().toISOString().slice(0, 7));
  const filterFamily = String(opts.materialFamily || '').trim().toLowerCase() || null;
  const filterGauge = String(opts.gauge || '').trim() || null;
  const filterColour = String(opts.colour || '').trim() || null;
  const limitSamples = Number(opts.limitSamples) >= 0 ? Number(opts.limitSamples) : 25;

  const notes = [
    'Material cost per metre in this report is draft / estimated from coil consumption only.',
    'Labour, diesel, and production overhead are readiness indicators — not allocated to jobs in AP3a.',
    'HQ, admin, selling, and owner drawings are excluded from proposed cost-per-metre (see policy).',
  ];

  if (!tableExists(db, 'production_jobs')) {
    return emptyReport(branchScope, period, [...notes, 'Production jobs table not available.']);
  }

  const jobs = listProductionJobs(db, branchScope);
  const completedInPeriod = [];

  /** @type {Map<string, object>} */
  const byBranchMap = new Map();
  /** @type {Map<string, object>} */
  const byFamilyMap = new Map();
  /** @type {Map<string, object>} */
  const byGaugeColourMap = new Map();

  let producedMetres = 0;
  let jobsWithCoil = 0;
  let jobsMissingCoil = 0;
  let jobsMissingMetres = 0;
  let consumedKgTotal = 0;
  let materialCostTotal = 0;
  let missingCoilCostCount = 0;

  const missingDataSamples = [];
  const jobSamples = [];

  for (const job of jobs) {
    if (!jobIsCompleted(job)) continue;
    const outDate = productionJobOutputDate(job);
    if (!isoInRange(outDate, period.startISO, period.endISO)) continue;

    const metres = Math.round(Number(job.effectiveOutputMeters ?? job.actualMeters) || 0);
    const branchId = String(job.branchId || '').trim() || '(missing branch)';
    const meta = productMeta(db, job.productID);
    const coils = coilsForJob(db, job.jobID);

    let jobConsumedKg = 0;
    let jobMaterialCost = 0;
    let jobMissingCost = false;
    let gauge = meta.gauge;
    let colour = meta.colour;
    let productFamily = meta.productFamily;

    for (const c of coils) {
      const kg = Number(c.consumed_weight_kg) || 0;
      jobConsumedKg += kg;
      if (c.gauge_label) gauge = String(c.gauge_label).trim();
      if (c.colour) colour = String(c.colour).trim();
      const { costPerKg, basis } = resolveCoilCost(db, c.coil_no);
      if (costPerKg == null) {
        jobMissingCost = true;
        missingCoilCostCount += 1;
      } else {
        jobMaterialCost += roundMoney(kg * costPerKg);
      }
      if (!jobSamples.length && basis === 'missing' && limitSamples > 0) {
        missingDataSamples.push({
          kind: 'missing_coil_cost',
          jobId: job.jobID,
          coilNo: c.coil_no,
          branchId,
        });
      }
    }

    if (coils.length > 0) jobsWithCoil += 1;
    else jobsMissingCoil += 1;

    const missingMetres = metres <= 0;
    if (missingMetres) jobsMissingMetres += 1;
    else producedMetres += metres;

    const missingQuotation = !String(job.quotationRef || '').trim();
    const missingBranch = !String(job.branchId || '').trim();
    const missingProduct = !String(job.productID || '').trim();

    if (filterFamily && productFamily !== filterFamily) continue;
    if (filterGauge && gauge !== filterGauge) continue;
    if (filterColour && colour !== filterColour) continue;

    consumedKgTotal += jobConsumedKg;
    materialCostTotal += jobMaterialCost;

    const conf = confidenceLevel({
      metres,
      consumedKg: jobConsumedKg,
      materialCostNgn: jobMaterialCost,
      missingCostCount: jobMissingCost ? 1 : 0,
      coilRowCount: coils.length,
    });

    if (jobSamples.length < limitSamples) {
      jobSamples.push({
        jobId: job.jobID,
        branchId,
        quotationRef: job.quotationRef || null,
        productFamily,
        gauge,
        colour,
        metres,
        consumedKg: roundMoney(jobConsumedKg),
        materialCostNgn: jobMaterialCost > 0 ? jobMaterialCost : null,
        materialCostPerMetreNgn:
          metres > 0 && jobMaterialCost > 0 ? roundMoney(jobMaterialCost / metres) : null,
        hasCoilConsumption: coils.length > 0,
        missingCoilCost: jobMissingCost,
        missingMetres,
        confidence: conf,
        draft: true,
      });
    }

    if (missingMetres && missingDataSamples.length < limitSamples) {
      missingDataSamples.push({ kind: 'missing_metres', jobId: job.jobID, branchId });
    }
    if (!coils.length && metres > 0 && missingDataSamples.length < limitSamples) {
      missingDataSamples.push({ kind: 'no_coil_consumption', jobId: job.jobID, branchId, metres });
    }
    if (jobMaterialCost > 0 && metres <= 0 && missingDataSamples.length < limitSamples) {
      missingDataSamples.push({ kind: 'material_cost_no_metres', jobId: job.jobID, branchId });
    }

    const bump = (map, key, init) => {
      if (!map.has(key)) map.set(key, { ...init, key });
      const row = map.get(key);
      row.completedJobs += 1;
      row.producedMetres += metres;
      row.consumedKg += jobConsumedKg;
      row.materialCostNgn += jobMaterialCost;
      if (coils.length) row.jobsWithCoilConsumption += 1;
      else row.jobsMissingCoilConsumption += 1;
      if (missingMetres) row.jobsMissingMetres += 1;
      if (jobMissingCost) row.missingCostCount += 1;
      return row;
    };

    bump(byBranchMap, branchId, {
      branchId,
      completedJobs: 0,
      producedMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      jobsWithCoilConsumption: 0,
      jobsMissingCoilConsumption: 0,
      jobsMissingMetres: 0,
      missingCostCount: 0,
    });

    bump(byFamilyMap, productFamily, {
      productFamily,
      completedJobs: 0,
      producedMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      jobsWithCoilConsumption: 0,
      jobsMissingCoilConsumption: 0,
      jobsMissingMetres: 0,
      missingCostCount: 0,
    });

    const gcKey = `${gauge || '—'}|${colour || '—'}`;
    bump(byGaugeColourMap, gcKey, {
      gauge: gauge || '—',
      colour: colour || '—',
      completedJobs: 0,
      producedMetres: 0,
      consumedKg: 0,
      materialCostNgn: 0,
      jobsWithCoilConsumption: 0,
      jobsMissingCoilConsumption: 0,
      jobsMissingMetres: 0,
      missingCostCount: 0,
    });

    if (missingQuotation || missingBranch || missingProduct) {
      if (missingDataSamples.length < limitSamples) {
        missingDataSamples.push({
          kind: 'job_metadata_gap',
          jobId: job.jobID,
          missingQuotation,
          missingBranch,
          missingProduct,
        });
      }
    }

    completedInPeriod.push(job);
  }

  const finalizeAgg = (row) => {
    const metres = row.producedMetres || 0;
    const cost = row.materialCostNgn || 0;
    return {
      ...row,
      consumedKg: roundMoney(row.consumedKg),
      materialCostNgn: roundMoney(cost),
      materialCostPerMetreNgn: metres > 0 && cost > 0 ? roundMoney(cost / metres) : null,
      confidence: confidenceLevel({
        metres,
        consumedKg: row.consumedKg,
        materialCostNgn: cost,
        missingCostCount: row.missingCostCount,
        coilRowCount: row.jobsWithCoilConsumption,
      }),
      draft: true,
    };
  };

  const byBranch = [...byBranchMap.values()].map(finalizeAgg).sort((a, b) => b.producedMetres - a.producedMetres);
  const byProductFamily = [...byFamilyMap.values()].map(finalizeAgg).sort((a, b) => b.producedMetres - a.producedMetres);
  const byGaugeColour = [...byGaugeColourMap.values()].map(finalizeAgg).sort((a, b) => b.producedMetres - a.producedMetres);

  const expenseClassification = buildExpenseClassification(db, branchScope, period);
  const labourReadiness = buildLabourReadiness(db, branchScope, period);
  const dieselReadiness = buildDieselReadiness(db, branchScope, period, expenseClassification);
  const overheadReadiness = buildOverheadReadiness(expenseClassification);

  const materialCostPerMetreNgn =
    producedMetres > 0 && materialCostTotal > 0 ? roundMoney(materialCostTotal / producedMetres) : 0;

  const summary = {
    completedJobs: completedInPeriod.length,
    producedMetres,
    jobsWithCoilConsumption: jobsWithCoil,
    jobsMissingCoilConsumption: jobsMissingCoil,
    jobsMissingMetres,
    consumedKg: roundMoney(consumedKgTotal),
    materialCostNgn: roundMoney(materialCostTotal),
    materialCostPerMetreNgn,
    missingCoilCostCount,
    productionExpenseNgn: expenseClassification.productionExpenseNgn,
    dieselExpenseNgn: expenseClassification.dieselExpenseNgn,
    labourExpenseNgn: expenseClassification.labourExpenseNgn,
    unclassifiedExpenseNgn: expenseClassification.unclassifiedExpenseNgn,
    payrollMappable: labourReadiness.ready,
    dieselSeparated: dieselReadiness.ready,
  };

  const dataQuality = buildDataQuality(summary, labourReadiness, dieselReadiness, byBranch, missingDataSamples);
  const branchContributionDraft = buildBranchContributionDraft(byBranch, summary);

  const nextSteps = [
    'Review missing coil costs and complete GRN/coil costing before AP3b material allocation.',
    'Ensure completed jobs record actual metres and coil consumption rows.',
    'Classify unmapped expense categories for labour, diesel, and factory overhead.',
    'Confirm payroll branch mapping for production staff before overhead allocation (AP3c).',
    'Review branch contribution draft (AP3c) before branch P&L sign-off.',
    'Obtain MD and Head of Accounts sign-off on proposed costing policy.',
  ];

  return {
    ok: true,
    status: 'readiness_only',
    label: 'Costing Policy & Data Readiness',
    disclaimer:
      'Read-only readiness report. No costing or GL values were changed.',
    generatedAtISO: new Date().toISOString(),
    branchScope,
    period,
    readinessScore: computeReadinessScore(summary, dataQuality),
    summary,
    byBranch,
    branchContributionDraft,
    byProductFamily,
    byGaugeColour,
    productionJobs: { samples: jobSamples, totalInPeriod: completedInPeriod.length },
    expenseClassification: expenseClassification.rows,
    labourReadiness,
    dieselReadiness,
    overheadReadiness,
    missingDataSamples,
    dataQuality,
    proposedCostingPolicy: { ...PROPOSED_COSTING_POLICY },
    policyNotes: [...PROPOSED_COSTING_POLICY_NOTES],
    nextSteps,
    notes,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ startISO: string; endISO: string }} period
 */
function buildExpenseClassification(db, branchScope, period) {
  /** @type {Record<string, { bucket: string; label: string; amountNgn: number; count: number; unmappedCategories: Set<string> }>} */
  const buckets = {};
  for (const [key, label] of Object.entries(COSTING_EXPENSE_BUCKET_LABELS)) {
    buckets[key] = { bucket: key, label, amountNgn: 0, count: 0, unmappedCategories: new Set() };
  }

  let productionExpenseNgn = 0;
  let dieselExpenseNgn = 0;
  let labourExpenseNgn = 0;
  let unclassifiedExpenseNgn = 0;
  let missingBranchCount = 0;

  if (!tableExists(db, 'expenses')) {
    return {
      rows: Object.values(buckets).map((b) => ({
        bucket: b.bucket,
        label: b.label,
        amountNgn: 0,
        count: 0,
        unmappedCategories: [],
      })),
      productionExpenseNgn: 0,
      dieselExpenseNgn: 0,
      labourExpenseNgn: 0,
      unclassifiedExpenseNgn: 0,
      missingBranchCount: 0,
    };
  }

  const hasBranch = hasColumn(db, 'expenses', 'branch_id');
  const rows = db.prepare(`SELECT expense_id, amount_ngn, date, category, branch_id FROM expenses`).all();

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    if (!isoInRange(date, period.startISO, period.endISO)) continue;
    const branchId = hasBranch ? String(row.branch_id || '').trim() : '';
    if (branchScope !== 'ALL' && branchId && branchId !== branchScope) continue;
    if (branchScope !== 'ALL' && !branchId) {
      missingBranchCount += 1;
      continue;
    }

    const amount = roundMoney(row.amount_ngn);
    const { bucket, canonical, mapped } = classifyExpenseForCosting(row.category);
    const b = buckets[bucket];
    b.amountNgn += amount;
    b.count += 1;
    if (!mapped) b.unmappedCategories.add(String(row.category || canonical || '(blank)'));

    if (
      bucket === 'production_labour' ||
      bucket === 'production_repairs_maintenance' ||
      bucket === 'factory_consumables'
    ) {
      productionExpenseNgn += amount;
    }
    if (bucket === 'diesel_fuel') dieselExpenseNgn += amount;
    if (bucket === 'production_labour') labourExpenseNgn += amount;
    if (bucket === 'unclassified') unclassifiedExpenseNgn += amount;
  }

  return {
    rows: Object.values(buckets).map((b) => ({
      bucket: b.bucket,
      label: b.label,
      amountNgn: roundMoney(b.amountNgn),
      count: b.count,
      unmappedCategories: [...b.unmappedCategories].slice(0, 12),
    })),
    productionExpenseNgn: roundMoney(productionExpenseNgn),
    dieselExpenseNgn: roundMoney(dieselExpenseNgn),
    labourExpenseNgn: roundMoney(labourExpenseNgn),
    unclassifiedExpenseNgn: roundMoney(unclassifiedExpenseNgn),
    missingBranchCount,
  };
}

function buildLabourReadiness(db, branchScope, period) {
  const notes = [];
  if (!tableExists(db, 'hr_payroll_runs') || !tableExists(db, 'hr_payroll_lines')) {
    notes.push('Payroll tables not present — labour cannot be allocated from payroll in AP3b.');
    return { ready: false, runCount: 0, lineCount: 0, staffWithBranch: 0, notes };
  }

  let runCount = 0;
  try {
    const runs = db.prepare(`SELECT run_id, period_key, status FROM hr_payroll_runs`).all();
    for (const r of runs) {
      const pk = String(r.period_key || '').trim();
      if (pk === period.key || isoInRange(`${pk}-01`, period.startISO, period.endISO)) runCount += 1;
    }
  } catch {
    notes.push('Could not read payroll runs.');
  }

  let lineCount = 0;
  let staffWithBranch = 0;
  try {
    lineCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_payroll_lines`).get()?.c || 0;
  } catch {
    /* */
  }

  if (tableExists(db, 'hr_staff_profiles') && hasColumn(db, 'hr_staff_profiles', 'branch_id')) {
    try {
      staffWithBranch =
        db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE TRIM(COALESCE(branch_id,'')) != ''`).get()
          ?.c || 0;
    } catch {
      /* */
    }
  } else {
    notes.push('HR staff profiles lack branch_id — payroll not branch-mappable for costing.');
  }

  const hasProductionFlag =
    tableExists(db, 'hr_staff_profiles') &&
    (hasColumn(db, 'hr_staff_profiles', 'department') || hasColumn(db, 'hr_staff_profiles', 'job_title'));

  if (!hasProductionFlag) {
    notes.push('No production-staff flag on HR profiles — wages will rely on expense categories until AP3b.');
  }

  const ready = runCount > 0 && lineCount > 0 && staffWithBranch > 0;
  if (!ready) {
    notes.push('Payroll/HR data is not fully ready for branch production labour allocation.');
  }

  return { ready, runCount, lineCount, staffWithBranch, notes };
}

function buildDieselReadiness(db, branchScope, period, expenseClassification) {
  const notes = [];
  const dieselNgn = expenseClassification.dieselExpenseNgn || 0;
  const dieselRows =
    expenseClassification.rows?.find((r) => r.bucket === 'diesel_fuel')?.count || 0;

  if (dieselNgn <= 0 && dieselRows === 0) {
    notes.push('No diesel/fuel expenses recorded separately in this period — use Fuel & lubricant category.');
  }

  let branchTagged = 0;
  let untagged = 0;
  if (tableExists(db, 'expenses') && hasColumn(db, 'expenses', 'branch_id')) {
    try {
      const rows = db
        .prepare(
          `SELECT category, branch_id, amount_ngn, date FROM expenses WHERE category LIKE '%Fuel%' OR category LIKE '%fuel%' OR category LIKE '%lubricant%'`
        )
        .all();
      for (const row of rows) {
        const date = String(row.date || '').slice(0, 10);
        if (!isoInRange(date, period.startISO, period.endISO)) continue;
        const b = String(row.branch_id || '').trim();
        if (branchScope !== 'ALL' && b && b !== branchScope) continue;
        if (b) branchTagged += 1;
        else untagged += 1;
      }
    } catch {
      /* */
    }
  } else {
    notes.push('Expense branch_id not available — diesel cannot be branch-allocated reliably.');
  }

  if (untagged > 0) notes.push(`${untagged} fuel expense row(s) missing branch tag.`);

  const ready = dieselNgn > 0 && (branchTagged > 0 || branchScope === 'ALL');
  return {
    ready,
    dieselExpenseNgn: dieselNgn,
    dieselExpenseCount: dieselRows,
    branchTaggedCount: branchTagged,
    untaggedCount: untagged,
    notes,
  };
}

function buildOverheadReadiness(expenseClassification) {
  const rows = expenseClassification.rows || [];
  const maint = rows.find((r) => r.bucket === 'production_repairs_maintenance');
  const consumables = rows.find((r) => r.bucket === 'factory_consumables');
  const labour = rows.find((r) => r.bucket === 'production_labour');
  return {
    notes: [
      'Production overhead readiness uses expense classification only (no allocation in AP3a).',
      `Maintenance/repairs: ${formatNgnShort(maint?.amountNgn)} (${maint?.count || 0} rows).`,
      `Factory consumables: ${formatNgnShort(consumables?.amountNgn)} (${consumables?.count || 0} rows).`,
      `Production wages (expense): ${formatNgnShort(labour?.amountNgn)} (${labour?.count || 0} rows).`,
      'Depreciation and factory rent require fixed-asset / lease data — not in expense-only view.',
    ],
  };
}

function formatNgnShort(n) {
  const v = roundMoney(n);
  if (v >= 1_000_000) return `₦${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `₦${(v / 1_000).toFixed(0)}k`;
  return `₦${v}`;
}

function buildBranchContributionDraft(byBranch, summary) {
  const rows = byBranch || [];
  const totalMetres = rows.reduce((s, b) => s + (b.producedMetres || 0), 0);
  const labour = summary?.labourExpenseNgn || 0;
  const diesel = summary?.dieselExpenseNgn || 0;
  const productionExpense = summary?.productionExpenseNgn || 0;
  const overhead = Math.max(0, productionExpense - labour - diesel);

  const mapRow = (b, share) => {
    const metres = b.producedMetres || 0;
    const material = b.materialCostNgn || 0;
    const labourAlloc = roundMoney(labour * share);
    const dieselAlloc = roundMoney(diesel * share);
    const overheadAlloc = roundMoney(overhead * share);
    const total = roundMoney(material + labourAlloc + dieselAlloc + overheadAlloc);
    return {
      branchId: b.branchId,
      producedMetres: metres,
      metreShare: share,
      materialCostNgn: roundMoney(material),
      labourAllocatedNgn: labourAlloc,
      dieselAllocatedNgn: dieselAlloc,
      overheadAllocatedNgn: overheadAlloc,
      totalProductionCostNgn: total,
      draftCostPerMetreNgn: metres > 0 ? roundMoney(total / metres) : null,
      draft: true,
    };
  };

  if (totalMetres <= 0) {
    return {
      ok: false,
      method: 'proportional_by_metres',
      disclaimer:
        'Draft AP3c allocation — labour, diesel, and factory overhead allocated by branch metres share in period.',
      totalMetres: 0,
      poolNgn: {
        labour: roundMoney(labour),
        diesel: roundMoney(diesel),
        overhead: roundMoney(overhead),
        total: roundMoney(labour + diesel + overhead),
      },
      rows: rows.map((b) => mapRow(b, 0)),
    };
  }

  return {
    ok: true,
    method: 'proportional_by_metres',
    disclaimer:
      'Draft AP3c allocation — labour, diesel, and factory overhead allocated by branch metres share in period.',
    totalMetres,
    poolNgn: {
      labour: roundMoney(labour),
      diesel: roundMoney(diesel),
      overhead: roundMoney(overhead),
      total: roundMoney(labour + diesel + overhead),
    },
    rows: rows
      .map((b) => mapRow(b, (b.producedMetres || 0) / totalMetres))
      .sort((a, b) => b.producedMetres - a.producedMetres),
  };
}

export { buildBranchContributionDraft };

function buildDataQuality(summary, labourReadiness, dieselReadiness, byBranch, missingDataSamples) {
  const highRisk = [];
  const warnings = [];
  const missingData = [];

  if (summary.completedJobs === 0) highRisk.push('No completed production jobs in selected period.');
  if (summary.jobsMissingCoilConsumption > 0) {
    warnings.push(`${summary.jobsMissingCoilConsumption} completed job(s) have metres but no coil consumption.`);
  }
  if (summary.missingCoilCostCount > 0) {
    highRisk.push(`${summary.missingCoilCostCount} coil consumption row(s) missing unit/landed cost.`);
  }
  if (summary.jobsMissingMetres > 0) {
    warnings.push(`${summary.jobsMissingMetres} completed job(s) missing actual metres.`);
  }
  if (summary.unclassifiedExpenseNgn > 0) {
    warnings.push(`Unclassified expenses in period: ${formatNgnShort(summary.unclassifiedExpenseNgn)}.`);
  }
  if (!labourReadiness.ready) missingData.push('Payroll not mappable to branch/production staff.');
  if (!dieselReadiness.ready) missingData.push('Diesel/fuel not separated or branch-tagged for period.');

  for (const b of byBranch) {
    if (b.producedMetres > 0 && b.confidence === 'low') {
      warnings.push(`Branch ${b.branchId}: weak material cost confidence.`);
    }
  }

  for (const s of missingDataSamples.slice(0, 8)) {
    missingData.push(`${s.kind}: ${s.jobId || s.coilNo || '—'}`);
  }

  return { highRisk, warnings, missingData };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildAp3CostingReadinessTrialSummary(db, branchScope = 'ALL') {
  const r = buildAp3CostingReadinessReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
    limitSamples: 0,
  });
  return {
    available: true,
    readinessScore: r.readinessScore,
    materialCostPerMetreNgn: r.summary?.materialCostPerMetreNgn ?? 0,
    missingCoilCostCount: r.summary?.missingCoilCostCount ?? 0,
    completedJobs: r.summary?.completedJobs ?? 0,
    jobsMissingCoilConsumption: r.summary?.jobsMissingCoilConsumption ?? 0,
    payrollMappable: r.summary?.payrollMappable ?? false,
    dieselSeparated: r.summary?.dieselSeparated ?? false,
    highRiskCount: (r.dataQuality?.highRisk || []).length,
  };
}
