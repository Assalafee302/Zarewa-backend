import { actorName } from './auth.js';
import { appendAuditLog, assertPeriodOpen } from './controlOps.js';
import { applyAccessoryCompletionTx, planAccessoryCompletion } from './accessoryFulfillment.js';
import { tryPostProductionRecognitionGlTx } from './productionRecognitionGl.js';
import { quotationPriceViolations } from './pricingOps.js';
import { getQuotation } from './readModel.js';
import {
  isStoneMeterQuotationLinesJson,
  resolveStoneRawProductIdForQuotation,
} from './stoneInventory.js';
import {
  buildExpectedCoilSpecFromQuotation,
  coilSpecMismatchIssues,
} from '../shared/lib/coilSpecVersusProduct.js';

function nextId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIso(value) {
  if (!value) return nowIso();
  const raw = String(value).trim();
  if (!raw) return nowIso();
  return raw.includes('T') ? raw : `${raw}T12:00:00.000Z`;
}

function safeNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function positiveNumberOrNull(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function clampNonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

/** Closing weight below this (kg) may be paired with `finishCoil` to zero the roll off stock on completion. */
const COIL_TAIL_FINISH_MAX_KG = 85;

function parseGaugeMm(value) {
  const match = String(value ?? '')
    .replace(/,/g, '.')
    .match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const next = Number(match[1]);
  return Number.isFinite(next) ? next : null;
}

function toPercentVariance(actual, reference) {
  if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }
  return ((actual - reference) / reference) * 100;
}

function appendStockMovementTx(db, payload) {
  const id = nextId('MV');
  const atISO = normalizeIso(payload.atISO);
  db.prepare(
    `INSERT INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, date_iso, unit_price_ngn, value_ngn)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    atISO,
    payload.type,
    payload.ref ?? null,
    payload.productID ?? null,
    payload.qty ?? null,
    payload.detail ?? null,
    String(payload.dateISO ?? atISO).slice(0, 10),
    payload.unitPriceNgn ?? null,
    payload.valueNgn ?? null
  );
  return id;
}

function adjustProductStockTx(db, productID, delta) {
  if (!productID) return;
  const row = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(productID);
  if (!row) return;
  const next = clampNonNegative(Number(row.stock_level) + Number(delta || 0));
  db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(next, productID);
}

function coilRow(db, coilNo) {
  return db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
}

function listJobCoilsForJob(db, jobID) {
  return db
    .prepare(`SELECT * FROM production_job_coils WHERE job_id = ? ORDER BY sequence_no ASC, id ASC`)
    .all(jobID);
}

function mapProductionJobCoilRow(row) {
  return {
    id: row.id,
    jobID: row.job_id,
    sequenceNo: Number(row.sequence_no) || 0,
    coilNo: row.coil_no,
    productID: row.product_id ?? '',
    colour: row.colour ?? '',
    gaugeLabel: row.gauge_label ?? '',
    openingWeightKg: safeNumber(row.opening_weight_kg),
    closingWeightKg: safeNumber(row.closing_weight_kg),
    consumedWeightKg: safeNumber(row.consumed_weight_kg),
    metersProduced: safeNumber(row.meters_produced),
    actualConversionKgPerM: positiveNumberOrNull(row.actual_conversion_kg_per_m),
    allocationStatus: row.allocation_status ?? 'Allocated',
    specMismatch: Boolean(row.spec_mismatch),
    note: row.note ?? '',
    allocatedAtISO: row.allocated_at_iso ?? '',
  };
}

/** Coil allocation rows for a single job (read API / snapshot-friendly). */
export function listProductionJobCoilsForJob(db, jobID) {
  return listJobCoilsForJob(db, jobID).map(mapProductionJobCoilRow);
}

function productionJobRow(db, jobID) {
  return db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(jobID);
}

function jobIsStoneMeter(db, job) {
  const ref = String(job?.quotation_ref ?? '').trim();
  if (!ref) return false;
  const row = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  if (!row) return false;
  let j = {};
  try {
    j = JSON.parse(String(row.lines_json || '{}'));
  } catch {
    return false;
  }
  return isStoneMeterQuotationLinesJson(db, j);
}

function updateCoilDerivedStateTx(db, coilNo) {
  const row = coilRow(db, coilNo);
  if (!row) return;
  const qtyRemaining = clampNonNegative(row.qty_remaining ?? row.current_weight_kg ?? row.weight_kg ?? row.qty_received);
  const qtyReserved = clampNonNegative(Math.min(qtyRemaining, row.qty_reserved ?? 0));
  const currentStatus =
    qtyRemaining <= 0.0001 ? 'Consumed' : qtyReserved >= qtyRemaining - 0.0001 && qtyReserved > 0 ? 'Reserved' : 'Available';
  db.prepare(
    `UPDATE coil_lots
     SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, current_status = ?
     WHERE coil_no = ?`
  ).run(qtyRemaining, qtyReserved, qtyRemaining, currentStatus, coilNo);
}

function normalizeAllocationInput(payload, index) {
  const coilNo = String(payload?.coilNo ?? '').trim();
  const openingWeightKg = positiveNumberOrNull(payload?.openingWeightKg);
  if (!coilNo) throw new Error(`Allocation line ${index + 1} is missing a coil number.`);
  if (!openingWeightKg) throw new Error(`Allocation line ${index + 1} must have a reserved opening weight.`);
  return {
    coilNo,
    openingWeightKg,
    note: String(payload?.note ?? '').trim(),
    specMismatchAcknowledged: Boolean(payload?.specMismatchAcknowledged),
  };
}

function jobProductAttrsFromDb(db, productId) {
  const pid = String(productId ?? '').trim();
  if (!pid) return null;
  const row = db
    .prepare(
      `SELECT gauge, colour, material_type, dashboard_attrs_json FROM products WHERE product_id = ? LIMIT 1`
    )
    .get(pid);
  if (!row) return null;
  let extra = {};
  try {
    extra = JSON.parse(row.dashboard_attrs_json || '{}');
  } catch {
    extra = {};
  }
  return {
    gauge: row.gauge || extra.gauge || '',
    colour: row.colour || extra.colour || '',
    materialType: row.material_type || extra.materialType || extra.material_type || '',
  };
}

function allocationCoilSpecMismatched(db, job, coilNo) {
  const coil = coilRow(db, coilNo);
  if (!coil) return { mismatched: false, detail: '' };
  const qref = String(job.quotation_ref || '').trim();
  const quotation = qref ? getQuotation(db, qref) : null;
  const productAttrs = jobProductAttrsFromDb(db, job.product_id);
  const expected = buildExpectedCoilSpecFromQuotation(quotation, productAttrs);
  const lot = {
    gaugeLabel: coil.gauge_label,
    colour: coil.colour,
    materialTypeName: coil.material_type_name,
  };
  const { issues, hasExpected } = coilSpecMismatchIssues(lot, expected);
  if (!hasExpected || issues.length === 0) return { mismatched: false, detail: '' };
  return { mismatched: true, detail: issues.join('; ') };
}

function refreshJobCoilSpecFlagsTx(db, jobID) {
  const n =
    db.prepare(`SELECT COUNT(*) AS c FROM production_job_coils WHERE job_id = ? AND spec_mismatch = 1`).get(jobID)
      ?.c ?? 0;
  const pending = n > 0 ? 1 : 0;
  db.prepare(
    `UPDATE production_jobs SET coil_spec_mismatch_pending = ?, manager_review_required = CASE WHEN ? = 1 THEN 1 ELSE manager_review_required END WHERE job_id = ?`
  ).run(pending, pending, jobID);
}

function validateSpecAcknowledgements(db, job, normalizedLines) {
  const mismatches = [];
  for (const line of normalizedLines) {
    const r = allocationCoilSpecMismatched(db, job, line.coilNo);
    if (r.mismatched && !line.specMismatchAcknowledged) {
      mismatches.push({ coilNo: line.coilNo, detail: r.detail });
    }
  }
  if (!mismatches.length) return null;
  return {
    ok: false,
    code: 'PRODUCTION_SPEC_MISMATCH',
    error:
      'One or more coils do not match the quotation material specification (gauge / colour / material). Confirm to proceed and flag the branch manager, or pick matching coils.',
    mismatches,
  };
}

function validateUniqueCoils(lines) {
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line.coilNo)) {
      throw new Error(`Coil ${line.coilNo} is allocated more than once on the same job.`);
    }
    seen.add(line.coilNo);
  }
}

function materialTypeRowByName(db, name) {
  const value = String(name ?? '').trim();
  if (!value) return null;
  return (
    db.prepare(`SELECT * FROM setup_material_types WHERE lower(name) = lower(?) LIMIT 1`).get(value) ||
    null
  );
}

function gaugeRowByLabel(db, label) {
  const value = String(label ?? '').trim();
  if (!value) return null;
  return (
    db.prepare(`SELECT * FROM setup_gauges WHERE lower(label) = lower(?) LIMIT 1`).get(value) ||
    null
  );
}

/**
 * Procurement → Conversion catalogue: use as production "standard" kg/m when it matches coil product + gauge.
 * Tie-break: exact catalog `color` vs coil `colour`, else first row by id.
 */
function procurementCatalogStandardKgPerM(db, coil) {
  const pid = String(coil.product_id ?? '').trim();
  if (!pid) return null;
  const coilGaugeMm = parseGaugeMm(coil.gauge_label);
  if (!coilGaugeMm || coilGaugeMm <= 0) return null;

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, color, gauge, conversion_kg_per_m FROM procurement_catalog WHERE product_id = ? AND conversion_kg_per_m > 0`
      )
      .all(pid);
  } catch {
    return null;
  }
  if (!rows.length) return null;

  const matches = rows.filter((r) => {
    const rowMm = parseGaugeMm(r.gauge);
    return rowMm != null && Math.abs(rowMm - coilGaugeMm) < 1e-4;
  });
  if (!matches.length) return null;

  const coilColour = String(coil.colour ?? '').trim().toLowerCase();
  if (coilColour) {
    const exact = matches.find((r) => String(r.color ?? '').trim().toLowerCase() === coilColour);
    if (exact) return positiveNumberOrNull(exact.conversion_kg_per_m);
  }
  if (matches.length === 1) return positiveNumberOrNull(matches[0].conversion_kg_per_m);
  const sorted = [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return positiveNumberOrNull(sorted[0].conversion_kg_per_m);
}

function buildReferenceSet(db, coil, actualConversionKgPerM, excludeJobId = null) {
  const gaugeRow = gaugeRowByLabel(db, coil.gauge_label);
  const materialRow = materialTypeRowByName(db, coil.material_type_name);
  const gaugeMm = gaugeRow ? safeNumber(gaugeRow.gauge_mm) : parseGaugeMm(coil.gauge_label);
  const densityKgPerM3 = materialRow ? safeNumber(materialRow.density_kg_per_m3) : 0;
  const widthM = materialRow ? safeNumber(materialRow.width_m, 1.2) : 1.2;
  /** Fallback standard: setup material density × strip width (m) × gauge thickness (m). */
  const theoreticalStandardConversionKgPerM =
    gaugeMm && densityKgPerM3 ? densityKgPerM3 * widthM * (gaugeMm / 1000) : null;
  const procurementCatalogConversionKgPerM = procurementCatalogStandardKgPerM(db, coil);
  /** Production register standard: procurement catalogue first, else setup density. */
  const standardConversionKgPerM =
    procurementCatalogConversionKgPerM != null
      ? procurementCatalogConversionKgPerM
      : theoreticalStandardConversionKgPerM;
  const standardConversionSource =
    procurementCatalogConversionKgPerM != null
      ? 'procurement_catalog'
      : theoreticalStandardConversionKgPerM != null
        ? 'setup_density'
        : null;
  const supplierConversionKgPerM =
    positiveNumberOrNull(coil.supplier_conversion_kg_per_m) ||
    (() => {
      const supplierExpectedMeters = positiveNumberOrNull(coil.supplier_expected_meters);
      const coilWeight = positiveNumberOrNull(coil.weight_kg);
      if (!supplierExpectedMeters || !coilWeight) return null;
      return coilWeight / supplierExpectedMeters;
    })();
  const exJ = excludeJobId ? String(excludeJobId).trim() : '';
  const gaugeHistoryAvgKgPerM = exJ
    ? db
        .prepare(
          `SELECT AVG(actual_conversion_kg_per_m) AS avg_value
           FROM production_conversion_checks
           WHERE gauge_label = ? AND actual_conversion_kg_per_m > 0 AND job_id != ?`
        )
        .get(coil.gauge_label, exJ)?.avg_value ?? null
    : db
        .prepare(
          `SELECT AVG(actual_conversion_kg_per_m) AS avg_value
           FROM production_conversion_checks
           WHERE gauge_label = ? AND actual_conversion_kg_per_m > 0`
        )
        .get(coil.gauge_label)?.avg_value ?? null;
  const coilHistoryAvgKgPerM = exJ
    ? db
        .prepare(
          `SELECT AVG(actual_conversion_kg_per_m) AS avg_value
           FROM production_conversion_checks
           WHERE coil_no = ? AND actual_conversion_kg_per_m > 0 AND job_id != ?`
        )
        .get(coil.coil_no, exJ)?.avg_value ?? null
    : db
        .prepare(
          `SELECT AVG(actual_conversion_kg_per_m) AS avg_value
           FROM production_conversion_checks
           WHERE coil_no = ? AND actual_conversion_kg_per_m > 0`
        )
        .get(coil.coil_no)?.avg_value ?? null;
  const variances = {
    standardPct: toPercentVariance(actualConversionKgPerM, standardConversionKgPerM),
    supplierPct: toPercentVariance(actualConversionKgPerM, supplierConversionKgPerM),
    gaugeHistoryPct: toPercentVariance(actualConversionKgPerM, gaugeHistoryAvgKgPerM),
    coilHistoryPct: toPercentVariance(actualConversionKgPerM, coilHistoryAvgKgPerM),
  };
  return {
    gaugeLabel: coil.gauge_label ?? '',
    materialTypeName: coil.material_type_name ?? '',
    standardConversionKgPerM,
    standardConversionSource,
    theoreticalStandardConversionKgPerM,
    procurementCatalogConversionKgPerM,
    supplierConversionKgPerM,
    gaugeHistoryAvgKgPerM:
      Number.isFinite(gaugeHistoryAvgKgPerM) && gaugeHistoryAvgKgPerM > 0 ? gaugeHistoryAvgKgPerM : null,
    coilHistoryAvgKgPerM:
      Number.isFinite(coilHistoryAvgKgPerM) && coilHistoryAvgKgPerM > 0 ? coilHistoryAvgKgPerM : null,
    variances,
  };
}

function determineAlertState(actualConversionKgPerM, references) {
  const referenceValues = [
    references.standardConversionKgPerM,
    references.supplierConversionKgPerM,
    references.gaugeHistoryAvgKgPerM,
    references.coilHistoryAvgKgPerM,
  ].filter((value) => Number.isFinite(value) && value > 0);
  const highBreaches = referenceValues.filter((value) => actualConversionKgPerM > value * 1.1);
  const lowBreaches = referenceValues.filter((value) => actualConversionKgPerM < value * 0.9);
  const varianceValues = Object.values(references.variances).filter(
    (value) => Number.isFinite(value) && value != null
  );
  const maxVariance = varianceValues.length
    ? Math.max(...varianceValues.map((value) => Math.abs(Number(value) || 0)))
    : 0;
  if (highBreaches.length >= 2) {
    return { alertState: 'High', managerReviewRequired: 1 };
  }
  if (lowBreaches.length >= 2) {
    return { alertState: 'Low', managerReviewRequired: 1 };
  }
  if (maxVariance >= 6) {
    return { alertState: 'Watch', managerReviewRequired: 0 };
  }
  return { alertState: 'OK', managerReviewRequired: 0 };
}

function aggregateAlertState(alerts) {
  if (alerts.includes('High')) return 'High';
  if (alerts.includes('Low')) return 'Low';
  if (alerts.includes('Watch')) return 'Watch';
  return 'OK';
}

export function listProductionJobCoils(db, branchScope = 'ALL', opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : 0;
  const bid = String(branchScope ?? 'ALL').trim();
  const scoped = bid && bid !== 'ALL';
  const sql = scoped
    ? `SELECT c.*
       FROM production_job_coils c
       JOIN production_jobs j ON j.job_id = c.job_id
       WHERE j.branch_id = ?
       ORDER BY c.allocated_at_iso DESC, c.sequence_no ASC, c.id ASC`
    : `SELECT * FROM production_job_coils ORDER BY allocated_at_iso DESC, sequence_no ASC, id ASC`;
  const base = scoped ? db.prepare(sql).all(bid) : db.prepare(sql).all();
  const rows = limit > 0 ? base.slice(0, limit) : base;
  return rows.map(mapProductionJobCoilRow);
}

export function listProductionConversionChecks(db, branchScope = 'ALL', opts = {}) {
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : 0;
  const bid = String(branchScope ?? 'ALL').trim();
  const scoped = bid && bid !== 'ALL';
  const sql = scoped
    ? `SELECT c.*, j.cutting_list_id AS cutting_list_id_joined
       FROM production_conversion_checks c
       JOIN production_jobs j ON j.job_id = c.job_id
       WHERE j.branch_id = ?
       ORDER BY c.checked_at_iso DESC, c.job_id DESC, c.coil_no DESC, c.id DESC`
    : `SELECT c.*, j.cutting_list_id AS cutting_list_id_joined
       FROM production_conversion_checks c
       LEFT JOIN production_jobs j ON j.job_id = c.job_id
       ORDER BY c.checked_at_iso DESC, c.job_id DESC, c.coil_no DESC, c.id DESC`;
  const base = scoped ? db.prepare(sql).all(bid) : db.prepare(sql).all();
  const rows = limit > 0 ? base.slice(0, limit) : base;
  return rows
    .map((row) => {
      let varianceSummary = {};
      try {
        varianceSummary = JSON.parse(row.variance_summary_json || '{}');
      } catch {
        varianceSummary = {};
      }
      const variancesNested = varianceSummary.variances;
      const legacyShape =
        variancesNested && typeof variancesNested === 'object'
          ? variancesNested
          : varianceSummary.standardPct != null ||
              varianceSummary.supplierPct != null ||
              varianceSummary.gaugeHistoryPct != null ||
              varianceSummary.coilHistoryPct != null
            ? varianceSummary
            : {};
      return {
        id: row.id,
        jobID: row.job_id,
        cuttingListId: row.cutting_list_id_joined ?? '',
        coilNo: row.coil_no,
        gaugeLabel: row.gauge_label ?? '',
        materialTypeName: row.material_type_name ?? '',
        actualConversionKgPerM: positiveNumberOrNull(row.actual_conversion_kg_per_m),
        standardConversionKgPerM: positiveNumberOrNull(row.standard_conversion_kg_per_m),
        supplierConversionKgPerM: positiveNumberOrNull(row.supplier_conversion_kg_per_m),
        gaugeHistoryAvgKgPerM: positiveNumberOrNull(row.gauge_history_avg_kg_per_m),
        coilHistoryAvgKgPerM: positiveNumberOrNull(row.coil_history_avg_kg_per_m),
        alertState: row.alert_state ?? 'OK',
        managerReviewRequired: Boolean(row.manager_review_required),
        varianceSummary: {
          ...varianceSummary,
          variances: legacyShape,
        },
        checkedAtISO: row.checked_at_iso ?? '',
        note: row.note ?? '',
      };
    });
}

export function saveProductionJobAllocations(db, jobID, allocations, opts = {}) {
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  const status = job.status ?? 'Planned';
  const append = Boolean(opts.append);

  if (status === 'Cancelled') {
    return { ok: false, error: 'This production job was cancelled.' };
  }

  if (append) {
    if (status !== 'Running') {
      return { ok: false, error: 'Supplemental coils can only be added while the job is running.' };
    }
    try {
      const normalized = (allocations || []).map((line, index) => normalizeAllocationInput(line, index));
      if (!normalized.length) return { ok: false, error: 'Add at least one new coil allocation.' };
      const specBlock = validateSpecAcknowledgements(db, job, normalized);
      if (specBlock) return specBlock;
      validateUniqueCoils(normalized);
      const existing = listJobCoilsForJob(db, jobID);
      const existingCoils = new Set(existing.map((row) => row.coil_no));
      for (const line of normalized) {
        if (existingCoils.has(line.coilNo)) {
          return {
            ok: false,
            error: `Coil ${line.coilNo} is already on this job. Remove the duplicate line or pick another coil.`,
          };
        }
      }
      let maxSeq = existing.reduce((m, r) => Math.max(m, Number(r.sequence_no) || 0), 0);
      db.transaction(() => {
        const insertAllocation = db.prepare(
          `INSERT INTO production_job_coils (
            id, job_id, sequence_no, coil_no, product_id, colour, gauge_label, opening_weight_kg,
            closing_weight_kg, consumed_weight_kg, meters_produced, actual_conversion_kg_per_m,
            allocation_status, spec_mismatch, note, allocated_at_iso
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        const specMismatchCoils = [];
        for (const line of normalized) {
          const coil = coilRow(db, line.coilNo);
          if (!coil) throw new Error(`Coil ${line.coilNo} was not found.`);
          const nextReservedForJob = line.openingWeightKg;
          const qtyRemaining = clampNonNegative(
            coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
          );
          const qtyReserved = clampNonNegative(coil.qty_reserved);
          const availableForThisJob = qtyRemaining - qtyReserved;
          if (nextReservedForJob > availableForThisJob + 0.0001) {
            throw new Error(
              `Coil ${line.coilNo} only has ${availableForThisJob.toFixed(2)} kg available for allocation.`
            );
          }
          db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(
            clampNonNegative(qtyReserved + nextReservedForJob),
            line.coilNo
          );
          updateCoilDerivedStateTx(db, line.coilNo);
          maxSeq += 1;
          const sm = allocationCoilSpecMismatched(db, job, line.coilNo);
          const specFlag = sm.mismatched ? 1 : 0;
          if (specFlag) specMismatchCoils.push(line.coilNo);
          insertAllocation.run(
            nextId('PJC'),
            jobID,
            maxSeq,
            line.coilNo,
            coil?.product_id ?? null,
            coil?.colour ?? null,
            coil?.gauge_label ?? null,
            line.openingWeightKg,
            0,
            0,
            0,
            null,
            'Running',
            specFlag,
            line.note || null,
            nowIso()
          );
        }
        refreshJobCoilSpecFlagsTx(db, jobID);
        appendAuditLog(db, {
          actor: opts.actor,
          action: 'production.append_coils',
          entityKind: 'production_job',
          entityId: jobID,
          note: `${normalized.length} supplemental coil(s) added during run`,
          details: {
            jobID,
            coils: normalized.map((line) => ({ coilNo: line.coilNo, openingWeightKg: line.openingWeightKg })),
            specMismatchCoils,
          },
        });
      })();
      return { ok: true, allocations: listProductionJobCoilsForJob(db, jobID) };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  if (jobIsStoneMeter(db, job)) {
    if (append) {
      return { ok: false, error: 'Stone-coated jobs cannot add coil allocations mid-run.' };
    }
    if (Array.isArray(allocations) && allocations.length > 0) {
      return { ok: false, error: 'Stone-coated jobs do not use coil allocations.' };
    }
    try {
      db.transaction(() => {
        db.prepare(`DELETE FROM production_job_coils WHERE job_id = ?`).run(jobID);
        refreshJobCoilSpecFlagsTx(db, jobID);
        appendAuditLog(db, {
          actor: opts.actor,
          action: 'production.allocate_stone',
          entityKind: 'production_job',
          entityId: jobID,
          note: 'Stone-coated job — no coil allocations',
          details: { jobID },
        });
      })();
      return { ok: true, allocations: [] };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  if (status !== 'Planned') {
    return { ok: false, error: 'Coil allocation must be completed before the job starts.' };
  }
  try {
    const normalized = (allocations || []).map((line, index) => normalizeAllocationInput(line, index));
    if (!normalized.length) return { ok: false, error: 'Add at least one coil allocation.' };
    const specBlock = validateSpecAcknowledgements(db, job, normalized);
    if (specBlock) return specBlock;
    validateUniqueCoils(normalized);
    const existing = listJobCoilsForJob(db, jobID);
    const oldReservedByCoil = new Map(existing.map((row) => [row.coil_no, safeNumber(row.opening_weight_kg)]));
    const newReservedByCoil = new Map(normalized.map((row) => [row.coilNo, row.openingWeightKg]));
    db.transaction(() => {
      for (const coilNo of new Set([...oldReservedByCoil.keys(), ...newReservedByCoil.keys()])) {
        const coil = coilRow(db, coilNo);
        if (!coil) throw new Error(`Coil ${coilNo} was not found.`);
        const previousReserved = oldReservedByCoil.get(coilNo) || 0;
        const nextReservedForJob = newReservedByCoil.get(coilNo) || 0;
        const delta = nextReservedForJob - previousReserved;
        const qtyRemaining = clampNonNegative(
          coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
        );
        const qtyReserved = clampNonNegative(coil.qty_reserved);
        const availableForThisJob = qtyRemaining - (qtyReserved - previousReserved);
        if (nextReservedForJob > availableForThisJob + 0.0001) {
          throw new Error(
            `Coil ${coilNo} only has ${availableForThisJob.toFixed(2)} kg available for allocation.`
          );
        }
        db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(
          clampNonNegative(qtyReserved + delta),
          coilNo
        );
        updateCoilDerivedStateTx(db, coilNo);
      }
      db.prepare(`DELETE FROM production_job_coils WHERE job_id = ?`).run(jobID);
      const insertAllocation = db.prepare(
        `INSERT INTO production_job_coils (
          id, job_id, sequence_no, coil_no, product_id, colour, gauge_label, opening_weight_kg,
          closing_weight_kg, consumed_weight_kg, meters_produced, actual_conversion_kg_per_m,
          allocation_status, spec_mismatch, note, allocated_at_iso
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const specMismatchCoils = [];
      normalized.forEach((line, index) => {
        const coil = coilRow(db, line.coilNo);
        const sm = allocationCoilSpecMismatched(db, job, line.coilNo);
        const specFlag = sm.mismatched ? 1 : 0;
        if (specFlag) specMismatchCoils.push(line.coilNo);
        insertAllocation.run(
          nextId('PJC'),
          jobID,
          index + 1,
          line.coilNo,
          coil?.product_id ?? null,
          coil?.colour ?? null,
          coil?.gauge_label ?? null,
          line.openingWeightKg,
          0,
          0,
          0,
          null,
          'Allocated',
          specFlag,
          line.note || null,
          nowIso()
        );
      });
      refreshJobCoilSpecFlagsTx(db, jobID);
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.allocate_coils',
        entityKind: 'production_job',
        entityId: jobID,
        note: `${normalized.length} coil allocation(s) saved`,
        details: {
          jobID,
          coils: normalized.map((line) => ({ coilNo: line.coilNo, openingWeightKg: line.openingWeightKg })),
          specMismatchCoils,
        },
      });
    })();
    return { ok: true, allocations: listProductionJobCoilsForJob(db, jobID) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

export function startProductionJob(db, jobID, payload = {}, opts = {}) {
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if ((job.status ?? 'Planned') === 'Cancelled') {
    return { ok: false, error: 'Cancelled jobs cannot be started.' };
  }
  if ((job.status ?? 'Planned') === 'Completed') {
    return { ok: false, error: 'Completed jobs cannot be started again.' };
  }
  const qref = String(job.quotation_ref || '').trim();
  if (qref) {
    const quote = db
      .prepare(
        `SELECT id, lines_json, branch_id, md_price_exception_approved_at_iso FROM quotations WHERE id = ?`
      )
      .get(qref);
    if (quote) {
      const { violations, hasFloorRows } = quotationPriceViolations(db, quote);
      if (
        hasFloorRows &&
        violations.length > 0 &&
        !String(quote.md_price_exception_approved_at_iso || '').trim()
      ) {
        return {
          ok: false,
          code: 'PRICE_LIST_MD_APPROVAL_REQUIRED',
          error:
            'Quoted price is below the approved price list for one or more lines. The Managing Director must approve a price exception before production can start.',
          violations,
        };
      }
    }
  }
  const allocations = listJobCoilsForJob(db, jobID);
  if (!allocations.length && !jobIsStoneMeter(db, job)) {
    return { ok: false, error: 'Allocate at least one coil before starting production.' };
  }
  const startedAtISO = normalizeIso(payload.startedAtISO || job.start_date_iso || nowIso());
  try {
    assertPeriodOpen(db, startedAtISO, 'Production start date');
    db.transaction(() => {
      db.prepare(`UPDATE production_jobs SET status = ?, start_date_iso = ? WHERE job_id = ?`).run(
        'Running',
        startedAtISO,
        jobID
      );
      db.prepare(`UPDATE production_job_coils SET allocation_status = 'Running' WHERE job_id = ?`).run(jobID);
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'In production' WHERE id = ?`).run(job.cutting_list_id);
      }
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.start',
        entityKind: 'production_job',
        entityId: jobID,
        note: `Production started on ${jobID}`,
        details: { startedAtISO, coilCount: allocations.length, by: actorName(opts.actor) },
      });
    })();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function buildVarianceSummaryPayload(row) {
  return {
    variances: row.references.variances,
    actualConversionKgPerM: row.actualConversionKgPerM,
    references: {
      standardConversionKgPerM: row.references.standardConversionKgPerM,
      standardConversionSource: row.references.standardConversionSource ?? null,
      theoreticalStandardConversionKgPerM: row.references.theoreticalStandardConversionKgPerM ?? null,
      procurementCatalogConversionKgPerM: row.references.procurementCatalogConversionKgPerM ?? null,
      supplierConversionKgPerM: row.references.supplierConversionKgPerM,
      gaugeHistoryAvgKgPerM: row.references.gaugeHistoryAvgKgPerM,
      coilHistoryAvgKgPerM: row.references.coilHistoryAvgKgPerM,
    },
  };
}

/**
 * Validates completion readings and computes four-reference conversion rows (no DB writes).
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobID
 * @param {{ allocations?: unknown[], completedAtISO?: string }} payload
 */
export function computeCompletionConversionRows(db, jobID, payload = {}, opts = {}) {
  const requireFinishRollWhenTail = opts.requireFinishRollWhenTail !== false;
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if ((job.status ?? 'Planned') !== 'Running') {
    return { ok: false, error: 'Start the production job before completing it.' };
  }
  const existingAllocations = listJobCoilsForJob(db, jobID);
  if (!existingAllocations.length) {
    return { ok: false, error: 'No coil allocations are linked to this production job.' };
  }
  const submittedAllocations = Array.isArray(payload.allocations) ? payload.allocations : [];
  const submittedByAllocId = new Map();
  const submittedByCoil = new Map();
  for (const line of submittedAllocations) {
    const aid = String(line?.allocationId ?? line?.allocation_id ?? '').trim();
    if (aid) submittedByAllocId.set(aid, line);
    const cn = String(line?.coilNo ?? line?.coil_no ?? '').trim();
    if (cn) submittedByCoil.set(cn, line);
  }
  try {
    const conversionRows = existingAllocations.map((allocation) => {
      const coilKey = String(allocation.coil_no ?? '').trim();
      const submitted =
        submittedByAllocId.get(String(allocation.id ?? '').trim()) ?? submittedByCoil.get(coilKey);
      if (!submitted) {
        throw new Error(`Provide completion readings for coil ${coilKey || allocation.coil_no}.`);
      }
      const openingWeightKg = safeNumber(allocation.opening_weight_kg);
      const closingWeightKg = safeNumber(submitted.closingWeightKg);
      const metersProduced = safeNumber(submitted.metersProduced);
      const finishCoil = Boolean(submitted.finishCoil ?? submitted.finish_coil);
      if (closingWeightKg < 0 || closingWeightKg > openingWeightKg) {
        throw new Error(`Coil ${coilKey} closing kg must be between 0 and ${openingWeightKg}.`);
      }
      if (finishCoil && closingWeightKg >= COIL_TAIL_FINISH_MAX_KG) {
        throw new Error(
          `Coil ${coilKey}: “Finish roll” only applies when closing weight is below ${COIL_TAIL_FINISH_MAX_KG} kg.`
        );
      }
      if (
        requireFinishRollWhenTail &&
        closingWeightKg < COIL_TAIL_FINISH_MAX_KG &&
        !finishCoil
      ) {
        throw new Error(
          `Coil ${coilKey}: closing weight is below ${COIL_TAIL_FINISH_MAX_KG} kg (typical core/spool tail). Confirm “Finish roll” to clear the remaining tail from coil stock when completing, or raise closing kg if usable steel is still on the roll.`
        );
      }
      if (metersProduced <= 0) {
        throw new Error(`Coil ${coilKey} must produce a positive number of metres.`);
      }
      const consumedWeightKg = openingWeightKg - closingWeightKg;
      if (consumedWeightKg <= 0) {
        throw new Error(`Coil ${coilKey} shows no consumed kg.`);
      }
      const actualConversionKgPerM = consumedWeightKg / metersProduced;
      const coil = coilRow(db, allocation.coil_no);
      if (!coil) throw new Error(`Coil ${coilKey} was not found.`);
      const qtyRemaining = clampNonNegative(
        coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
      );
      if (consumedWeightKg > qtyRemaining + 0.0001) {
        throw new Error(`Coil ${coilKey} does not have enough remaining kg.`);
      }
      const references = buildReferenceSet(db, coil, actualConversionKgPerM, jobID);
      const alert = determineAlertState(actualConversionKgPerM, references);
      return {
        allocationId: allocation.id,
        coilNo: coilKey || allocation.coil_no,
        productID: coil.product_id ?? '',
        openingWeightKg,
        closingWeightKg,
        consumedWeightKg,
        metersProduced,
        actualConversionKgPerM,
        references,
        alertState: alert.alertState,
        managerReviewRequired: alert.managerReviewRequired,
        note: String(submitted.note ?? '').trim(),
        finishCoil,
      };
    });
    const totalMeters = conversionRows.reduce((sum, row) => sum + row.metersProduced, 0);
    const totalWeightKg = conversionRows.reduce((sum, row) => sum + row.consumedWeightKg, 0);
    const aggregatedAlertState = aggregateAlertState(conversionRows.map((row) => row.alertState));
    const managerReviewRequired = conversionRows.some((row) => row.managerReviewRequired);
    return {
      ok: true,
      conversionRows,
      totalMeters,
      totalWeightKg,
      aggregatedAlertState,
      managerReviewRequired,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/**
 * Preview four-reference conversion and alert flags without posting stock or job completion.
 */
export function previewProductionConversion(db, jobID, payload = {}) {
  const jobRow = productionJobRow(db, jobID);
  if (jobRow && jobIsStoneMeter(db, jobRow)) {
    const acc = planAccessoryCompletion(db, jobRow, payload);
    if (!acc.ok) return { ok: false, error: acc.error };
    return {
      ok: true,
      stoneMeterJob: true,
      rows: [],
      aggregatedAlertState: 'OK',
      managerReviewRequired: false,
      totalMeters: 0,
      totalWeightKg: 0,
      accessoryPlan: acc.plannedLines,
    };
  }
  const r = computeCompletionConversionRows(db, jobID, payload, { requireFinishRollWhenTail: false });
  if (!r.ok) return r;
  const acc = planAccessoryCompletion(db, jobRow, payload);
  if (!acc.ok) return { ok: false, error: acc.error };
  return {
    ok: true,
    rows: r.conversionRows.map((row) => ({
      allocationId: row.allocationId,
      coilNo: row.coilNo,
      metersProduced: row.metersProduced,
      consumedWeightKg: row.consumedWeightKg,
      actualConversionKgPerM: row.actualConversionKgPerM,
      standardConversionKgPerM: row.references.standardConversionKgPerM,
      standardConversionSource: row.references.standardConversionSource ?? null,
      supplierConversionKgPerM: row.references.supplierConversionKgPerM,
      gaugeHistoryAvgKgPerM: row.references.gaugeHistoryAvgKgPerM,
      coilHistoryAvgKgPerM: row.references.coilHistoryAvgKgPerM,
      variances: row.references.variances,
      alertState: row.alertState,
      managerReviewRequired: Boolean(row.managerReviewRequired),
      finishCoil: Boolean(row.finishCoil),
    })),
    aggregatedAlertState: r.aggregatedAlertState,
    managerReviewRequired: r.managerReviewRequired,
    totalMeters: r.totalMeters,
    totalWeightKg: r.totalWeightKg,
    accessoryPlan: acc.plannedLines,
  };
}

function completeProductionJobStone(db, job, jobID, payload = {}, opts = {}) {
  const completedAtISO = normalizeIso(payload.completedAtISO || payload.endDateISO || nowIso());
  const metres = safeNumber(
    payload.stoneMetersConsumed ?? payload.stoneMeters ?? payload.metersConsumed ?? payload.totalMeters
  );
  if (metres <= 0) {
    return { ok: false, error: 'Enter stone metres consumed for this completion.' };
  }
  const qref = String(job.quotation_ref ?? '').trim();
  const qRow = qref ? db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(qref) : null;
  const stonePid = qRow ? resolveStoneRawProductIdForQuotation(db, qRow) : null;
  if (!stonePid) {
    return {
      ok: false,
      error: 'Could not resolve stone-coated stock SKU from the quotation (design, colour, gauge).',
    };
  }
  const stockRow = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(stonePid);
  const stock = safeNumber(stockRow?.stock_level);
  if (stock < metres - 0.0001) {
    return { ok: false, error: `Insufficient stone-coated metres in stock (have ${stock.toFixed(2)} m).` };
  }
  let totalCogsForGl = 0;
  try {
    assertPeriodOpen(db, completedAtISO, 'Production completion date');
    db.transaction(() => {
      const accPlan = planAccessoryCompletion(db, job, payload);
      if (!accPlan.ok) throw new Error(accPlan.error);
      adjustProductStockTx(db, stonePid, -metres);
      appendStockMovementTx(db, {
        atISO: completedAtISO,
        type: 'STONE_CONSUMPTION',
        ref: jobID,
        productID: stonePid,
        qty: -metres,
        detail: `${jobID} stone-coated ${metres.toFixed(2)} m`,
      });
      if (job.product_id) {
        adjustProductStockTx(db, job.product_id, metres);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'FINISHED_GOODS_RECEIPT',
          ref: jobID,
          productID: job.product_id,
          qty: metres,
          detail: `${jobID} completed output (${job.product_name || job.product_id})`,
        });
      }
      db.prepare(
        `UPDATE production_jobs
         SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
             conversion_alert_state = ?, manager_review_required = ?
         WHERE job_id = ?`
      ).run('Completed', completedAtISO.slice(0, 10), completedAtISO, metres, 0, 'OK', 0, jobID);
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(job.cutting_list_id);
      }
      applyAccessoryCompletionTx(
        db,
        jobID,
        qref,
        completedAtISO,
        accPlan.plannedLines,
        adjustProductStockTx,
        appendStockMovementTx
      );
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.complete',
        entityKind: 'production_job',
        entityId: jobID,
        note: `Stone-coated production completed on ${jobID}`,
        details: { totalMeters: metres, stoneProductId: stonePid },
      });
      const glRec = tryPostProductionRecognitionGlTx(db, {
        jobID,
        quotationRef: qref,
        actualMeters: metres,
        totalCogsNgn: totalCogsForGl,
        completedAtISO,
        branchId: job.branch_id ?? null,
        createdByUserId: opts.actor?.id != null ? String(opts.actor.id) : null,
      });
      if (!glRec.ok) throw new Error(glRec.error || 'Production recognition GL failed.');
    })();
    return {
      ok: true,
      actualMeters: metres,
      actualWeightKg: 0,
      alertState: 'OK',
      managerReviewRequired: false,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

export function completeProductionJob(db, jobID, payload = {}, opts = {}) {
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') === 'Cancelled') {
    return { ok: false, error: 'This production job was cancelled.' };
  }
  if (jobIsStoneMeter(db, job)) {
    return completeProductionJobStone(db, job, jobID, payload, opts);
  }
  const completedAtISO = normalizeIso(payload.completedAtISO || payload.endDateISO || nowIso());
  try {
    assertPeriodOpen(db, completedAtISO, 'Production completion date');
    const computed = computeCompletionConversionRows(db, jobID, payload);
    if (!computed.ok) return computed;
    const { conversionRows, totalMeters, totalWeightKg, aggregatedAlertState, managerReviewRequired } = computed;
    let totalCogsForGl = 0;
    db.transaction(() => {
      const accPlan = planAccessoryCompletion(db, job, payload);
      if (!accPlan.ok) throw new Error(accPlan.error);
      const updateAllocation = db.prepare(
        `UPDATE production_job_coils
         SET closing_weight_kg = ?, consumed_weight_kg = ?, meters_produced = ?, actual_conversion_kg_per_m = ?,
             allocation_status = 'Completed', note = ?
         WHERE id = ?`
      );
      const insertCheck = db.prepare(
        `INSERT INTO production_conversion_checks (
          id, job_id, coil_no, gauge_label, material_type_name, actual_conversion_kg_per_m,
          standard_conversion_kg_per_m, supplier_conversion_kg_per_m, gauge_history_avg_kg_per_m,
          coil_history_avg_kg_per_m, alert_state, manager_review_required, variance_summary_json,
          checked_at_iso, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const row of conversionRows) {
        updateAllocation.run(
          row.closingWeightKg,
          row.consumedWeightKg,
          row.metersProduced,
          row.actualConversionKgPerM,
          row.note || null,
          row.allocationId
        );
        insertCheck.run(
          nextId('PCC'),
          jobID,
          row.coilNo,
          row.references.gaugeLabel || null,
          row.references.materialTypeName || null,
          row.actualConversionKgPerM,
          row.references.standardConversionKgPerM,
          row.references.supplierConversionKgPerM,
          row.references.gaugeHistoryAvgKgPerM,
          row.references.coilHistoryAvgKgPerM,
          row.alertState,
          row.managerReviewRequired,
          JSON.stringify(buildVarianceSummaryPayload(row)),
          completedAtISO,
          row.note || null
        );
        const coil = coilRow(db, row.coilNo);
        const qtyRemaining = clampNonNegative(
          safeNumber(coil?.qty_remaining ?? coil?.current_weight_kg ?? coil?.weight_kg ?? coil?.qty_received) -
            row.consumedWeightKg
        );
        const qtyReserved = clampNonNegative(safeNumber(coil?.qty_reserved) - row.openingWeightKg);
        const uc = Math.round(Number(coil?.unit_cost_ngn_per_kg) || 0);
        const cogsNgn = uc > 0 ? Math.round(row.consumedWeightKg * uc) : null;
        if (cogsNgn != null && cogsNgn > 0) totalCogsForGl += cogsNgn;
        const prevLanded = Math.round(Number(coil?.landed_cost_ngn) || 0);
        const nextLanded =
          cogsNgn != null && prevLanded > 0 ? Math.max(0, prevLanded - cogsNgn) : coil?.landed_cost_ngn ?? null;
        db.prepare(
          `UPDATE coil_lots
           SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, landed_cost_ngn = ?
           WHERE coil_no = ?`
        ).run(qtyRemaining, qtyReserved, qtyRemaining, nextLanded, row.coilNo);
        updateCoilDerivedStateTx(db, row.coilNo);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'COIL_CONSUMPTION',
          ref: jobID,
          productID: row.productID,
          qty: -row.consumedWeightKg,
          detail: `${row.coilNo} consumed for ${row.metersProduced.toFixed(2)} m on ${jobID}`,
          unitPriceNgn: uc || null,
          valueNgn: cogsNgn,
        });
        /** Keep `products.stock_level` aligned with coil draw-down (GRN increases this SKU; completion must decrease). */
        adjustProductStockTx(db, row.productID, -row.consumedWeightKg);
        const tailBookedKg = row.finishCoil ? qtyRemaining : 0;
        if (tailBookedKg > 1e-6) {
          db.prepare(
            `UPDATE coil_lots SET qty_remaining = 0, qty_reserved = 0, current_weight_kg = 0 WHERE coil_no = ?`
          ).run(row.coilNo);
          updateCoilDerivedStateTx(db, row.coilNo);
          const tailCogs = uc > 0 ? Math.round(tailBookedKg * uc) : null;
          adjustProductStockTx(db, row.productID, -tailBookedKg);
          appendStockMovementTx(db, {
            atISO: completedAtISO,
            type: 'COIL_CONSUMPTION',
            ref: jobID,
            productID: row.productID,
            qty: -tailBookedKg,
            detail: `${row.coilNo} roll finished — tail ${tailBookedKg.toFixed(2)} kg removed from yard stock (${jobID})`,
            unitPriceNgn: uc || null,
            valueNgn: tailCogs,
          });
          appendAuditLog(db, {
            actor: opts.actor,
            action: 'production.finish_coil_tail',
            entityKind: 'coil_lot',
            entityId: row.coilNo,
            status: 'success',
            note: `${tailBookedKg.toFixed(2)} kg tail cleared on completion`,
            details: { jobID, allocationId: row.allocationId, closingWeightKg: row.closingWeightKg },
          });
          if (tailCogs != null && tailCogs > 0) totalCogsForGl += tailCogs;
        }
      }
      if (job.product_id) {
        adjustProductStockTx(db, job.product_id, totalMeters);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'FINISHED_GOODS_RECEIPT',
          ref: jobID,
          productID: job.product_id,
          qty: totalMeters,
          detail: `${jobID} completed output (${job.product_name || job.product_id})`,
        });
      }
      db.prepare(
        `UPDATE production_jobs
         SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
             conversion_alert_state = ?, manager_review_required = ?
         WHERE job_id = ?`
      ).run(
        'Completed',
        completedAtISO.slice(0, 10),
        completedAtISO,
        totalMeters,
        totalWeightKg,
        aggregatedAlertState,
        managerReviewRequired ? 1 : 0,
        jobID
      );
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(job.cutting_list_id);
      }
      applyAccessoryCompletionTx(
        db,
        jobID,
        String(job.quotation_ref ?? '').trim(),
        completedAtISO,
        accPlan.plannedLines,
        adjustProductStockTx,
        appendStockMovementTx
      );
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.complete',
        entityKind: 'production_job',
        entityId: jobID,
        note:
          aggregatedAlertState === 'OK'
            ? `Production completed on ${jobID}`
            : `Production completed on ${jobID} with ${aggregatedAlertState.toLowerCase()} conversion alert`,
        details: {
          totalMeters,
          totalWeightKg,
          alertState: aggregatedAlertState,
          managerReviewRequired,
        },
      });

      const glRec = tryPostProductionRecognitionGlTx(db, {
        jobID,
        quotationRef: String(job.quotation_ref ?? '').trim(),
        actualMeters: totalMeters,
        totalCogsNgn: totalCogsForGl,
        completedAtISO,
        branchId: job.branch_id ?? null,
        createdByUserId: opts.actor?.id != null ? String(opts.actor.id) : null,
      });
      if (!glRec.ok) throw new Error(glRec.error || 'Production recognition GL failed.');
    })();
    return {
      ok: true,
      actualMeters: totalMeters,
      actualWeightKg: totalWeightKg,
      alertState: aggregatedAlertState,
      managerReviewRequired,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/**
 * Manager sign-off after conversion High/Low (or flagged manager review). Clears the open review flag; keeps alert state for history.
 * @param {import('better-sqlite3').Database} db
 */
export function signOffProductionManagerReview(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const row = productionJobRow(db, jobId);
  if (!row) return { ok: false, error: 'Production job not found.' };
  if (row.status !== 'Completed') {
    return { ok: false, error: 'Only completed jobs can be signed off.' };
  }
  if (row.manager_review_signed_at_iso) {
    return { ok: false, error: 'Manager review already signed off.' };
  }
  const mgrReq = Boolean(row.manager_review_required);
  const alert = String(row.conversion_alert_state || '');
  const needsSignoff = mgrReq || alert === 'High' || alert === 'Low';
  if (!needsSignoff) {
    return { ok: false, error: 'This job does not require manager conversion sign-off.' };
  }
  const remark = String(payload.remark ?? '').trim();
  if (remark.length < 3) {
    return { ok: false, error: 'Enter a remark (at least 3 characters).' };
  }
  const at = nowIso();
  const actor = opts.actor || {};
  const uid = actor.id != null ? String(actor.id) : '';
  const name = String(actorName(actor) || actor.displayName || '').trim() || 'Manager';

  db.prepare(
    `UPDATE production_jobs
     SET manager_review_required = 0,
         manager_review_signed_at_iso = ?,
         manager_review_signed_by_user_id = ?,
         manager_review_signed_by_name = ?,
         manager_review_remark = ?
     WHERE job_id = ?`
  ).run(at, uid || null, name, remark, jobId);

  appendAuditLog(db, {
    actor: opts.actor,
    action: 'production.manager_review_signoff',
    entityKind: 'production_job',
    entityId: jobId,
    note: remark.length > 200 ? `${remark.slice(0, 197)}…` : remark,
    details: {
      cuttingListId: row.cutting_list_id ?? null,
      conversionAlertState: alert,
    },
  });

  return {
    ok: true,
    jobID: jobId,
    managerReviewSignedAtISO: at,
    managerReviewSignedByName: name,
    managerReviewRemark: remark,
  };
}

/**
 * Undo "start" only: job goes back to Planned so coils can be re-saved. Does not delete allocations.
 * Reserved kg on coils is unchanged. Requires audit reason.
 */
function releaseProductionJobCoilReservationsTx(db, jobId) {
  const coilRows = listJobCoilsForJob(db, jobId);
  for (const row of coilRows) {
    const coilNo = String(row.coil_no ?? '').trim();
    const opening = safeNumber(row.opening_weight_kg);
    if (!coilNo || opening <= 0) continue;
    const coil = coilRow(db, coilNo);
    if (!coil) continue;
    const qtyReserved = clampNonNegative(safeNumber(coil.qty_reserved) - opening);
    db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(qtyReserved, coilNo);
    updateCoilDerivedStateTx(db, coilNo);
  }
  db.prepare(`DELETE FROM production_job_coils WHERE job_id = ?`).run(jobId);
  refreshJobCoilSpecFlagsTx(db, jobId);
}

/**
 * Cancel before completion: clears run readings if needed, releases coil reservations, deletes allocations, sets job Cancelled.
 * Allowed from Planned or Running only.
 */
export function cancelProductionJob(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  const st = String(job.status ?? 'Planned');
  if (st === 'Completed') {
    return { ok: false, error: 'Completed jobs cannot be cancelled.' };
  }
  if (st === 'Cancelled') {
    return { ok: false, error: 'This job is already cancelled.' };
  }
  if (st !== 'Planned' && st !== 'Running') {
    return { ok: false, error: 'Only planned or running jobs can be cancelled.' };
  }
  const reason = String(payload.reason ?? payload.note ?? '').trim();
  if (reason.length < 8) {
    return { ok: false, error: 'Enter a reason (at least 8 characters) for the audit trail.' };
  }
  const refIso = job.start_date_iso || job.created_at_iso || nowIso();
  try {
    assertPeriodOpen(db, refIso, 'Production cancel date');
    db.transaction(() => {
      if (st === 'Running') {
        db.prepare(
          `UPDATE production_job_coils
           SET closing_weight_kg = 0, consumed_weight_kg = 0, meters_produced = 0,
               actual_conversion_kg_per_m = NULL, allocation_status = 'Allocated'
           WHERE job_id = ?`
        ).run(jobId);
      }
      releaseProductionJobCoilReservationsTx(db, jobId);
      const at = nowIso();
      db.prepare(
        `UPDATE production_jobs
         SET status = 'Cancelled',
             start_date_iso = NULL,
             completed_at_iso = ?,
             actual_meters = 0,
             actual_weight_kg = 0,
             conversion_alert_state = 'Pending',
             manager_review_required = 0,
             coil_spec_mismatch_pending = 0
         WHERE job_id = ?`
      ).run(at, jobId);
      if (job.cutting_list_id) {
        /** Release queue registration so Sales can edit the cutting list again and a new job may be opened. */
        db.prepare(
          `UPDATE cutting_lists
           SET status = 'Waiting', production_registered = 0, production_register_ref = NULL
           WHERE id = ?`
        ).run(job.cutting_list_id);
      }
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.cancel',
        entityKind: 'production_job',
        entityId: jobId,
        note: reason.length > 240 ? `${reason.slice(0, 237)}…` : reason,
        details: { cuttingListId: job.cutting_list_id ?? null, priorStatus: st },
      });
    })();
    return { ok: true, jobID: jobId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function returnProductionJobToPlanned(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') !== 'Running') {
    return {
      ok: false,
      error:
        'Only a running job can be returned to Planned. If production is finished, use a completion adjustment for finished-goods metres (manager), or contact support for coil/inventory corrections.',
    };
  }
  const reason = String(payload.reason ?? payload.note ?? '').trim();
  if (reason.length < 8) {
    return { ok: false, error: 'Enter a reason (at least 8 characters) for the audit trail.' };
  }
  const refIso = job.start_date_iso || nowIso();
  try {
    assertPeriodOpen(db, refIso, 'Production run date');
    db.transaction(() => {
      db.prepare(
        `UPDATE production_job_coils
         SET closing_weight_kg = 0, consumed_weight_kg = 0, meters_produced = 0,
             actual_conversion_kg_per_m = NULL, allocation_status = 'Allocated'
         WHERE job_id = ?`
      ).run(jobId);
      db.prepare(`UPDATE production_jobs SET status = 'Planned', start_date_iso = NULL WHERE job_id = ?`).run(jobId);
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Waiting' WHERE id = ?`).run(job.cutting_list_id);
      }
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.return_to_planned',
        entityKind: 'production_job',
        entityId: jobId,
        note: reason.length > 240 ? `${reason.slice(0, 237)}…` : reason,
        details: { cuttingListId: job.cutting_list_id ?? null },
      });
    })();
    return { ok: true, jobID: jobId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Post-completion finished-goods metre correction: writes an adjustment row, updates product stock, stock_movements.
 * Original completion rows and conversion checks are not modified (audit integrity).
 */
export function applyProductionCompletionAdjustment(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') !== 'Completed') {
    return { ok: false, error: 'Adjustments apply only to completed jobs.' };
  }
  const productId = String(job.product_id ?? '').trim();
  if (!productId) {
    return { ok: false, error: 'This job has no finished-goods product; stock adjustment is not applicable.' };
  }
  const delta = Number(payload.deltaFinishedGoodsM ?? payload.deltaMeters ?? NaN);
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) {
    return { ok: false, error: 'Enter a non-zero adjustment in metres (finished goods).' };
  }
  const note = String(payload.note ?? '').trim();
  if (note.length < 12) {
    return { ok: false, error: 'Enter a detailed note (at least 12 characters) explaining the correction.' };
  }
  const atISO = normalizeIso(payload.atISO || payload.effectiveDateISO || nowIso());
  try {
    assertPeriodOpen(db, atISO, 'Adjustment date');
    const prodRow = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(productId);
    if (!prodRow) return { ok: false, error: 'Finished goods product not found.' };
    const current = Number(prodRow.stock_level) || 0;
    const next = current + delta;
    if (next < -0.0001) {
      return {
        ok: false,
        error: `This adjustment would send ${productId} stock negative (${next.toFixed(2)} m on hand). Reduce the correction or investigate inventory.`,
      };
    }
    const id = nextId('PCA');
    const branchId = job.branch_id ?? null;
    const uid = opts.actor?.id != null ? String(opts.actor.id) : '';
    const name = String(actorName(opts.actor) || opts.actor?.displayName || '').trim() || 'User';
    db.transaction(() => {
      db.prepare(
        `INSERT INTO production_completion_adjustments (
          id, job_id, branch_id, delta_finished_goods_m, note, at_iso, created_by_user_id, created_by_name
        ) VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, jobId, branchId, delta, note, atISO, uid || null, name);
      adjustProductStockTx(db, productId, delta);
      appendStockMovementTx(db, {
        atISO,
        type: 'PRODUCTION_FG_ADJUSTMENT',
        ref: jobId,
        productID: productId,
        qty: delta,
        detail: `FG adjustment ${jobId}: ${note.length > 100 ? `${note.slice(0, 97)}…` : note}`,
        dateISO: atISO,
      });
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.completion_adjustment',
        entityKind: 'production_job',
        entityId: jobId,
        note: `FG metres ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} m`,
        details: { adjustmentId: id, deltaFinishedGoodsM: delta, productId, note },
      });
    })();
    return { ok: true, adjustmentId: id, deltaFinishedGoodsM: delta, productStockMetersAfter: next };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
