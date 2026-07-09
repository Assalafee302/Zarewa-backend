import { actorName } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog, assertPeriodOpen } from './controlOps.js';
import {
  applyAccessoryCompletionTx,
  buildAccessorySuppliedLookup,
  parseQuotationAccessoryLines,
  planAccessoryCompletion,
  resolveAccessoryInventoryProductId,
  resolveSuppliedQtyFromPayloadMaps,
  sumPriorAccessorySuppliedForLine,
} from './accessoryFulfillment.js';
import {
  applyStoneFlatsheetCompletionTx,
  planStoneFlatsheetFulfillment,
} from './stoneFlatsheetFulfillment.js';
import {
  jobEffectiveOutputMetres,
  validateProductionEditAgainstPaidRefunds,
} from './refundPaidProductionEditGate.js';
import { tryPostProductionRecognitionGlTx } from './productionRecognitionGl.js';
import { quotationPriceViolations } from './pricingOps.js';
import { quotationBelowFloorExceptionApproved } from '../shared/lib/quotationPriceException.js';
import { validateQuotationProductionPaymentGate, recalculateCoilLotBook } from './writeOps.js';
import { getQuotation } from './readModel.js';
import {
  isStoneMeterQuotationLinesJson,
  resolveStoneRawProductIdForQuotation,
} from './stoneInventory.js';
import {
  buildExpectedCoilSpecFromQuotation,
  coilSpecMismatchIssues,
} from '../shared/lib/coilSpecVersusProduct.js';
import { quotationRequiresStoneMetreConsumption } from '../shared/lib/stoneCoatedQuotationPolicy.js';
import { coloursMatchWithMaster } from '../shared/lib/stockCheckMasterOptions.js';
import {
  adjustProductStockForBranch,
  getProductRowForWorkspace,
} from './productBranchInventory.js';
import {
  procurementCatalogMaterialAlignedWithCoil,
  resolveCoilMaterialFamilyKey,
} from '../shared/lib/coilMaterialFamily.js';
import { listMasterData } from './masterData.js';
function coilProductionBlocked(db, coilNo) {
  const cn = String(coilNo || '').trim();
  if (!cn) return false;
  const cols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
  if (!cols.some((c) => c.name === 'production_blocked')) return false;
  const row = db.prepare(`SELECT production_blocked, production_block_reason FROM coil_lots WHERE coil_no = ?`).get(cn);
  return row?.production_blocked ? String(row.production_block_reason || 'Coil blocked for production.') : false;
}

function roundWholeKg(n) {
  return Math.round(Number(n) || 0);
}
import { issueOffcutSupplyForProductionTx } from './materialIncidentOps.js';
import { assertCoilInWorkspaceBranch, insertProductionOffcutPoolIssueTx } from './writeOps.js';
import { insertStockMovementTx } from './stockMovementOps.js';
import {
  persistProductionConversionVarianceReason,
  validateConversionVarianceReason,
} from '../shared/productionConversionReasons.js';
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';

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

/** Threshold (kg): UI shows “Roll finished” when closing is below this; checking it clears residual tail from coil stock on complete. Not required to complete if steel remains on the roll. */
const COIL_TAIL_FINISH_MAX_KG = 85;

function jobBranchId(job) {
  return String(job?.branch_id ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
}

function planAccessoryCorrectionExcludingJob(db, jobRow, jobId, payload = {}) {
  const quotationRef = String(jobRow?.quotation_ref ?? '').trim();
  if (!quotationRef) return { ok: true, plannedLines: [], accessoryStockWarnings: [] };
  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(quotationRef);
  if (!quote) return { ok: false, error: 'Quotation not found for accessory validation.' };
  const accessoryLines = parseQuotationAccessoryLines(quote.lines_json);
  if (!accessoryLines.length) return { ok: true, plannedLines: [], accessoryStockWarnings: [] };

  const accessoriesSupplied = Array.isArray(payload.accessoriesSupplied) ? payload.accessoriesSupplied : [];
  const maps = buildAccessorySuppliedLookup(accessoriesSupplied);

  const plannedLines = [];
  const accessoryStockWarnings = [];
  const EPS = 1e-6;
  const branchId = jobBranchId(jobRow);

  for (const line of accessoryLines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const prior = sumPriorAccessorySuppliedForLine(db, quotationRef, stableKey, {
      excludeJobId: jobId,
      lineKey,
      name: line.name,
    });
    const remaining = Math.max(0, line.orderedQty - prior);
    const supplied = resolveSuppliedQtyFromPayloadMaps(line, maps, remaining);
    if (!Number.isFinite(supplied) || supplied < 0 - EPS) {
      return { ok: false, error: `Invalid supplied quantity for accessory "${line.name}".` };
    }
    if (supplied > remaining + EPS) {
      return {
        ok: false,
        error: `Accessory "${line.name}": supplied ${supplied} exceeds remaining ${remaining.toFixed(2)} (ordered ${line.orderedQty}, already issued ${prior.toFixed(2)}).`,
      };
    }
    const inventoryProductId = resolveAccessoryInventoryProductId(db, lineKey, line.name);
    if (inventoryProductId) {
      const p = getProductRowForWorkspace(db, inventoryProductId, branchId);
      if (!p) {
        return { ok: false, error: `Accessory "${line.name}" maps to unknown stock product ${inventoryProductId}.` };
      }
      const stock = Number(p.stock_level) || 0;
      if (stock + EPS < supplied) {
        accessoryStockWarnings.push(
          `"${line.name}" (${p.name || inventoryProductId}): issuing ${supplied} units but only ${stock} on hand — accessory balance will go negative.`
        );
      }
    }
    plannedLines.push({
      quoteLineId: stableKey,
      name: line.name,
      orderedQty: line.orderedQty,
      suppliedQty: supplied,
      unitPriceNgn: line.unitPriceNgn,
      inventoryProductId,
    });
  }
  return { ok: true, plannedLines, accessoryStockWarnings };
}

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

export function appendStockMovementTx(db, payload) {
  const id = nextId('MV');
  const atISO = normalizeIso(payload.atISO);
  insertStockMovementTx(db, {
    ...payload,
    id,
    atISO,
    productID: payload.productID,
    dateISO: String(payload.dateISO ?? atISO).slice(0, 10),
    branchId: payload.branchId ?? payload.stockBranch,
  });
  return id;
}

export function adjustProductStockTx(db, productID, delta, branchId) {
  if (!productID) return;
  const bid = String(branchId ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  adjustProductStockForBranch(db, productID, delta, bid);
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

/**
 * Bootstrap trims productionJobCoils globally (recency cap). Ensure every job that
 * appears in the partial slice — or is Planned/Running — still carries its full coil set.
 */
export function repairProductionJobCoilIntegrity(db, productionJobs, partialCoils) {
  const coils = Array.isArray(partialCoils) ? [...partialCoils] : [];
  if (!db) return coils;
  const seen = new Set(coils.map((c) => c.id).filter((id) => id != null && id !== ''));
  const partialCountByJob = new Map();
  for (const c of coils) {
    const jid = String(c.jobID ?? c.job_id ?? '').trim();
    if (!jid) continue;
    partialCountByJob.set(jid, (partialCountByJob.get(jid) || 0) + 1);
  }
  const jobIdsToCheck = new Set(partialCountByJob.keys());
  for (const j of productionJobs || []) {
    const st = String(j.status ?? '').trim().toLowerCase();
    if (st !== 'planned' && st !== 'running') continue;
    const jid = String(j.jobID ?? j.job_id ?? '').trim();
    if (jid) jobIdsToCheck.add(jid);
  }
  if (!jobIdsToCheck.size) return coils;
  const ids = [...jobIdsToCheck];
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM production_job_coils WHERE job_id IN (${ph}) ORDER BY job_id ASC, sequence_no ASC, id ASC`
    )
    .all(...ids);
  for (const row of rows) {
    const mapped = mapProductionJobCoilRow(row);
    if (mapped.id != null && mapped.id !== '' && seen.has(mapped.id)) continue;
    coils.push(mapped);
    if (mapped.id != null && mapped.id !== '') seen.add(mapped.id);
  }
  return coils;
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

function quotationHasPositiveProductLines(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const arr = payload?.products;
  if (!Array.isArray(arr)) return false;
  return arr.some((row) => {
    const name = String(row?.name ?? '').trim();
    const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
    return name && qty > 0;
  });
}

/** Stone-coated quote with accessories only (no roofing / flatsheet product lines). */
function quotationIsAccessoriesOnlyForJob(db, job) {
  const qref = String(job?.quotation_ref ?? '').trim();
  if (!qref) return false;
  const row = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(qref);
  if (!row) return false;
  return parseQuotationAccessoryLines(row.lines_json).length > 0 && !quotationHasPositiveProductLines(row.lines_json);
}

function completionModeFromPayload(payload) {
  const mode = String(payload?.startMode ?? payload?.completeMode ?? payload?.completionMode ?? '')
    .trim()
    .toLowerCase();
  return mode === 'offcut' || mode === 'accessories_only' || mode === 'accessory_only' ? 'offcut' : 'coil';
}

function offcutMetersFromPayload(payload) {
  return safeNumber(
    payload?.offcutMetersProduced ?? payload?.offcutMeters ?? payload?.metersProduced ?? payload?.totalMeters,
    0
  );
}

function offcutInventoryMetersFromPayload(payload) {
  return clampNonNegative(safeNumber(payload?.offcutInventoryMeters ?? payload?.offcut_inventory_meters, 0));
}

/** Resolve FG output metres and offcut stock metres for offcut-only completion (preview + post). */
function resolveOffcutCompletionMetres(payload = {}) {
  let metres = offcutMetersFromPayload(payload);
  let offInv = offcutInventoryMetersFromPayload(payload);
  const offcutSupplyRaw = payload.offcutSupply ?? payload.offcutIssues ?? payload.offcut_supply;
  const offcutSupplyList = Array.isArray(offcutSupplyRaw) ? offcutSupplyRaw : [];
  if (offcutSupplyList.length > 0) {
    const supplySum = offcutSupplyList.reduce((s, row) => s + (Number(row.meters) || 0), 0);
    if (supplySum > 0) {
      if (offInv <= 0) offInv = supplySum;
      if (metres <= 0) metres = supplySum;
    }
  }
  if (metres <= 0 && offInv > 0) metres = offInv;
  if (offInv <= 0 && metres > 0) offInv = metres;
  return { metres, offInv, offcutSupplyList };
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

function masterDataForCoilColourMatch(db) {
  return { colours: listMasterData(db).colours || [] };
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

function allocationCoilSpecMismatched(db, job, coilNo, masterDataForCoil) {
  const coil = coilRow(db, coilNo);
  if (!coil) return { mismatched: false, detail: '' };
  const qref = String(job.quotation_ref || '').trim();
  const quotation = qref ? getQuotation(db, qref) : null;
  const productAttrs = jobProductAttrsFromDb(db, job.product_id);
  const expected = buildExpectedCoilSpecFromQuotation(quotation, productAttrs);
  const lot = {
    gaugeLabel: coil.gauge_label,
    colour: coil.colour,
    colourRaw: coil.colour,
    materialTypeName: coil.material_type_name,
  };
  const { issues, hasExpected } = coilSpecMismatchIssues(lot, expected, masterDataForCoil);
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
  const masterDataForCoil = masterDataForCoilColourMatch(db);
  const mismatches = [];
  for (const line of normalizedLines) {
    const r = allocationCoilSpecMismatched(db, job, line.coilNo, masterDataForCoil);
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

/** Adjust qty_reserved on a coil lot (delta can be negative). Throws if coil missing or reservation would exceed remaining. */
function bumpCoilReservedKgTx(db, coilNo, deltaKg) {
  const cn = String(coilNo ?? '').trim();
  if (!cn || Math.abs(Number(deltaKg) || 0) < 1e-9) return;
  const coil = coilRow(db, cn);
  if (!coil) throw new Error(`Coil ${cn} was not found.`);
  const qtyRemaining = clampNonNegative(
    coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
  );
  const qtyReserved = clampNonNegative(coil.qty_reserved ?? 0);
  const next = qtyReserved + deltaKg;
  if (next < -0.0001) {
    throw new Error(`Coil ${cn}: reservation adjustment would go negative.`);
  }
  if (next > qtyRemaining + 0.0001) {
    const avail = Math.max(0, qtyRemaining - qtyReserved);
    throw new Error(`Coil ${cn} only has ${avail.toFixed(2)} kg available for allocation.`);
  }
  db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(clampNonNegative(next), cn);
  updateCoilDerivedStateTx(db, cn);
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
 * When the coil states a known metal family, catalogue is used only if products.material_type matches that family
 * (empty product material no longer inherits Aluzinc rows for an Aluminium coil).
 * Tie-break: catalog `color` vs coil `colour` using Setup colours when needed (full name ↔ abbreviation), else first row by id.
 */
function procurementCatalogStandardKgPerM(db, coil) {
  const pid = String(coil.product_id ?? '').trim();
  if (!pid) return null;
  const coilMtName = String(coil.material_type_name ?? '').trim();
  const setupCoilMaterial = coilMtName ? materialTypeRowByName(db, coilMtName) : null;
  const setupCanonicalName = String(setupCoilMaterial?.name ?? '').trim();
  const coilFamilyKey = resolveCoilMaterialFamilyKey(coilMtName, setupCanonicalName);
  if (coilFamilyKey) {
    let productMaterialType = '';
    try {
      const pr = db.prepare(`SELECT material_type FROM products WHERE product_id = ? LIMIT 1`).get(pid);
      productMaterialType = String(pr?.material_type ?? '').trim();
    } catch {
      productMaterialType = '';
    }
    if (!procurementCatalogMaterialAlignedWithCoil(coilFamilyKey, productMaterialType)) {
      return null;
    }
  }
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

  const masterDataForColour = masterDataForCoilColourMatch(db);
  const coilColour = String(coil.colour ?? '').trim().toLowerCase();
  if (coilColour) {
    const exact = matches.find((r) => coloursMatchWithMaster(masterDataForColour, r.color, coil.colour));
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
  const rounded = {
    gaugeLabel: coil.gauge_label ?? '',
    materialTypeName: coil.material_type_name ?? '',
    standardConversionKgPerM: roundConv2(standardConversionKgPerM),
    standardConversionSource,
    theoreticalStandardConversionKgPerM: roundConv2(theoreticalStandardConversionKgPerM),
    procurementCatalogConversionKgPerM: roundConv2(procurementCatalogConversionKgPerM),
    supplierConversionKgPerM: roundConv2(supplierConversionKgPerM),
    gaugeHistoryAvgKgPerM: roundConv2(gaugeHistoryAvgKgPerM),
    coilHistoryAvgKgPerM: roundConv2(coilHistoryAvgKgPerM),
  };
  rounded.variances = {
    standardPct: toPercentVariance(actualConversionKgPerM, rounded.standardConversionKgPerM),
    supplierPct: toPercentVariance(actualConversionKgPerM, rounded.supplierConversionKgPerM),
    gaugeHistoryPct: toPercentVariance(actualConversionKgPerM, rounded.gaugeHistoryAvgKgPerM),
    coilHistoryPct: toPercentVariance(actualConversionKgPerM, rounded.coilHistoryAvgKgPerM),
  };
  return rounded;
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
        actualConversionKgPerM: roundConv2(positiveNumberOrNull(row.actual_conversion_kg_per_m)),
        standardConversionKgPerM: roundConv2(positiveNumberOrNull(row.standard_conversion_kg_per_m)),
        supplierConversionKgPerM: roundConv2(positiveNumberOrNull(row.supplier_conversion_kg_per_m)),
        gaugeHistoryAvgKgPerM: roundConv2(positiveNumberOrNull(row.gauge_history_avg_kg_per_m)),
        coilHistoryAvgKgPerM: roundConv2(positiveNumberOrNull(row.coil_history_avg_kg_per_m)),
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
        const masterDataForCoil = masterDataForCoilColourMatch(db);
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
          const sm = allocationCoilSpecMismatched(db, job, line.coilNo, masterDataForCoil);
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
      const stockRecalc = recalculateProductionJobCoilStock(db, jobID, {
        extraCoilNos: normalized.map((line) => line.coilNo),
        workspaceBranchId: opts.workspaceBranchId,
        actor: opts.actor,
      });
      return { ok: true, allocations: listProductionJobCoilsForJob(db, jobID), stockRecalc };
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
      const masterDataForCoil = masterDataForCoilColourMatch(db);
      normalized.forEach((line, index) => {
        const coil = coilRow(db, line.coilNo);
        const sm = allocationCoilSpecMismatched(db, job, line.coilNo, masterDataForCoil);
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
    const stockRecalc = recalculateProductionJobCoilStock(db, jobID, {
      extraCoilNos: [...oldReservedByCoil.keys(), ...newReservedByCoil.keys()],
      workspaceBranchId: opts.workspaceBranchId,
      actor: opts.actor,
    });
    return { ok: true, allocations: listProductionJobCoilsForJob(db, jobID), stockRecalc };
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
        `SELECT id, lines_json, branch_id, md_price_exception_approved_at_iso, price_exception_md_confirmed_at_iso
         FROM quotations WHERE id = ?`
      )
      .get(qref);
    if (quote) {
      const { violations, hasFloorRows } = quotationPriceViolations(db, quote);
      if (
        hasFloorRows &&
        violations.length > 0 &&
        !quotationBelowFloorExceptionApproved({
          mdPriceExceptionApprovedAtISO: quote.md_price_exception_approved_at_iso,
          priceExceptionMdConfirmedAtISO: quote.price_exception_md_confirmed_at_iso,
        })
      ) {
        return {
          ok: false,
          code: 'PRICE_LIST_MD_APPROVAL_REQUIRED',
          error:
            'Quoted price is below the workbook floor on one or more lines. The Managing Director or an administrator must approve a below-floor price exception before production can start.',
          violations,
        };
      }
      const payGate = validateQuotationProductionPaymentGate(db, qref);
      if (!payGate.ok) {
        return { ok: false, error: payGate.error, code: payGate.code };
      }
    }
  }
  const allocations = listJobCoilsForJob(db, jobID);
  const startMode = completionModeFromPayload(payload);
  if (!allocations.length && !jobIsStoneMeter(db, job) && startMode !== 'offcut') {
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
        details: { startedAtISO, coilCount: allocations.length, startMode, by: actorName(opts.actor) },
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
  /** When true, block completion if closing &lt; tail threshold without “finish roll”. Default off — remainder may stay on the coil. */
  const requireFinishRollWhenTail = opts.requireFinishRollWhenTail === true;
  const partialPreview = Boolean(opts.partialPreview);
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  const jobStatus = String(job.status ?? 'Planned');
  if (jobStatus !== 'Running' && !(partialPreview && jobStatus === 'Completed')) {
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
    const conversionRows = [];
    const existingById = new Map(existingAllocations.map((a) => [String(a.id ?? '').trim(), a]));
    for (const allocation of existingAllocations) {
      const coilKey = String(allocation.coil_no ?? '').trim();
      const submitted =
        submittedByAllocId.get(String(allocation.id ?? '').trim()) ?? submittedByCoil.get(coilKey);
      if (!submitted) {
        if (partialPreview) continue;
        throw new Error(`Provide completion readings for coil ${coilKey || allocation.coil_no}.`);
      }
      const hasOpenInPayload =
        Object.prototype.hasOwnProperty.call(submitted, 'openingWeightKg') ||
        Object.prototype.hasOwnProperty.call(submitted, 'opening_weight_kg');
      const openingWeightKg = hasOpenInPayload
        ? safeNumber(submitted.openingWeightKg ?? submitted.opening_weight_kg)
        : safeNumber(allocation.opening_weight_kg);
      const hasCoilInPayload = Object.prototype.hasOwnProperty.call(submitted, 'coilNo');
      const coilNoForRow = hasCoilInPayload
        ? String(submitted.coilNo ?? submitted.coil_no ?? '').trim()
        : coilKey;
      const closingWeightKg = safeNumber(submitted.closingWeightKg);
      const metersProduced = safeNumber(submitted.metersProduced);
      const finishCoil = Boolean(submitted.finishCoil ?? submitted.finish_coil);
      const rowLabel = coilNoForRow || coilKey || allocation.coil_no;
      if (closingWeightKg < 0 || closingWeightKg > openingWeightKg) {
        if (partialPreview) continue;
        throw new Error(`Coil ${rowLabel} closing kg must be between 0 and ${openingWeightKg}.`);
      }
      if (finishCoil && closingWeightKg >= COIL_TAIL_FINISH_MAX_KG) {
        if (partialPreview) continue;
        throw new Error(
          `Coil ${rowLabel}: “Finish roll” only applies when closing weight is below ${COIL_TAIL_FINISH_MAX_KG} kg.`
        );
      }
      if (
        requireFinishRollWhenTail &&
        closingWeightKg < COIL_TAIL_FINISH_MAX_KG &&
        !finishCoil
      ) {
        if (partialPreview) continue;
        throw new Error(
          `Coil ${rowLabel}: closing weight is below ${COIL_TAIL_FINISH_MAX_KG} kg (typical core/spool tail). Confirm “Finish roll” to clear the remaining tail from coil stock when completing, or raise closing kg if usable steel is still on the roll.`
        );
      }
      if (metersProduced <= 0) {
        if (partialPreview) continue;
        throw new Error(`Coil ${rowLabel} must produce a positive number of metres.`);
      }
      const consumedWeightKg = openingWeightKg - closingWeightKg;
      if (consumedWeightKg <= 0) {
        if (partialPreview) continue;
        throw new Error(`Coil ${rowLabel} shows no consumed kg.`);
      }
      const actualConversionKgPerM = roundConv2(consumedWeightKg / metersProduced);
      const coil = coilRow(db, coilNoForRow);
      if (!coil) throw new Error(`Coil ${rowLabel} was not found.`);
      const qtyRemaining = clampNonNegative(
        coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
      );
      if (consumedWeightKg > qtyRemaining + 0.0001) {
        if (partialPreview) continue;
        throw new Error(`Coil ${rowLabel} does not have enough remaining kg.`);
      }
      const references = buildReferenceSet(db, coil, actualConversionKgPerM, jobID);
      const alert = determineAlertState(actualConversionKgPerM, references);
      conversionRows.push({
        allocationId: allocation.id,
        coilNo: coilNoForRow || allocation.coil_no,
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
      });
    }
    if (partialPreview && jobStatus === 'Completed') {
      for (const line of submittedAllocations) {
        const aid = String(line?.allocationId ?? line?.allocation_id ?? '').trim();
        const cn = String(line?.coilNo ?? line?.coil_no ?? '').trim();
        if (!cn) continue;
        if (aid && existingById.has(aid)) continue;
        if (!aid && conversionRows.some((r) => String(r.coilNo ?? '').trim() === cn)) continue;
        const openingWeightKg = safeNumber(line.openingWeightKg ?? line.opening_weight_kg);
        const closingWeightKg = safeNumber(line.closingWeightKg ?? line.closing_weight_kg);
        const metersProduced = safeNumber(line.metersProduced ?? line.meters_produced);
        const finishCoil = Boolean(line.finishCoil ?? line.finish_coil);
        if (openingWeightKg <= 0 || closingWeightKg < 0 || closingWeightKg > openingWeightKg + 0.0001) {
          continue;
        }
        if (finishCoil && closingWeightKg >= COIL_TAIL_FINISH_MAX_KG) continue;
        if (metersProduced <= 0) continue;
        const consumedWeightKg = openingWeightKg - closingWeightKg;
        if (consumedWeightKg <= 0) continue;
        const coil = coilRow(db, cn);
        if (!coil) continue;
        const qtyRemaining = clampNonNegative(
          coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
        );
        if (consumedWeightKg > qtyRemaining + 0.0001) continue;
        const actualConversionKgPerM = roundConv2(consumedWeightKg / metersProduced);
        const references = buildReferenceSet(db, coil, actualConversionKgPerM, jobID);
        const alert = determineAlertState(actualConversionKgPerM, references);
        conversionRows.push({
          allocationId: null,
          coilNo: cn,
          productID: coil.product_id ?? '',
          openingWeightKg,
          closingWeightKg,
          consumedWeightKg,
          metersProduced,
          actualConversionKgPerM,
          references,
          alertState: alert.alertState,
          managerReviewRequired: alert.managerReviewRequired,
          note: String(line.note ?? '').trim(),
          finishCoil,
        });
      }
    }
    if (conversionRows.length === 0) {
      return {
        ok: false,
        error: partialPreview
          ? 'Enter closing kg and metres on at least one coil to preview conversion (other coils can stay open until you finish each roll).'
          : 'No valid conversion rows — check coil readings.',
      };
    }
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
      previewPartial: partialPreview,
      previewCoilCount: partialPreview ? conversionRows.length : undefined,
      previewCoilsTotal: partialPreview
        ? jobStatus === 'Completed'
          ? conversionRows.length
          : existingAllocations.length
        : undefined,
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
  if (!jobRow) return { ok: false, error: 'Production job not found.' };
  if (
    completionModeFromPayload(payload) === 'offcut' ||
    (jobRow && quotationIsAccessoriesOnlyForJob(db, jobRow))
  ) {
    const { metres, offInv } = resolveOffcutCompletionMetres(payload);
    if (metres < 0) {
      return { ok: false, error: 'Offcut produced metres must be zero or greater.' };
    }
    const acc = planAccessoryCompletion(db, jobRow, payload);
    if (!acc.ok) return { ok: false, error: acc.error };
    return {
      ok: true,
      offcutMode: true,
      rows: [],
      aggregatedAlertState: 'OK',
      managerReviewRequired: false,
      totalMeters: metres,
      totalOutputMeters: metres,
      offcutInventoryMeters: offInv,
      totalWeightKg: 0,
      accessoryPlan: acc.plannedLines,
      accessoryStockWarnings: acc.accessoryStockWarnings ?? [],
    };
  }
  if (jobRow && jobIsStoneMeter(db, jobRow)) {
    const acc = planAccessoryCompletion(db, jobRow, payload);
    if (!acc.ok) return { ok: false, error: acc.error };
    const sf = planStoneFlatsheetFulfillment(db, jobRow, payload, {});
    if (!sf.ok) return { ok: false, error: sf.error };
    return {
      ok: true,
      stoneMeterJob: true,
      rows: [],
      aggregatedAlertState: 'OK',
      managerReviewRequired: false,
      totalMeters: 0,
      totalWeightKg: 0,
      accessoryPlan: acc.plannedLines,
      accessoryStockWarnings: acc.accessoryStockWarnings ?? [],
      stoneFlatsheetPlan: sf.plannedLines,
      stoneFlatsheetStockWarnings: sf.stoneFlatsheetStockWarnings ?? [],
    };
  }
  const r = computeCompletionConversionRows(db, jobID, payload, {
    requireFinishRollWhenTail: false,
    partialPreview: true,
  });
  if (!r.ok) return r;
  const acc = planAccessoryCompletion(db, jobRow, payload);
  if (!acc.ok) return { ok: false, error: acc.error };
  const offInvPreview = offcutInventoryMetersFromPayload(payload);
  const totalOutputMeters = r.totalMeters + offInvPreview;
  return {
    ok: true,
    previewPartial: Boolean(r.previewPartial),
    previewCoilCount: r.previewCoilCount,
    previewCoilsTotal: r.previewCoilsTotal,
    accessoryStockWarnings: acc.accessoryStockWarnings ?? [],
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
    totalOutputMeters,
    offcutInventoryMeters: offInvPreview,
    totalWeightKg: r.totalWeightKg,
    accessoryPlan: acc.plannedLines,
  };
}

/**
 * Persist closing kg, metres, and note on allocated coils while the job is running (no stock move, not completion).
 * Lets operators save progress between coils or from a phone before hitting Complete.
 *
 * Each reading may optionally include `coilNo` and/or `openingWeightKg` to correct a mistaken allocation
 * (same permission as production.manage). Reservations on coil_lots are adjusted; no finished-goods or COGS move.
 */
export function saveProductionCoilRunLogDraft(db, jobID, payload = {}, opts = {}) {
  const job = productionJobRow(db, jobID);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (jobIsStoneMeter(db, job)) {
    return { ok: false, error: 'Stone-coated jobs do not use coil run log rows.' };
  }
  if ((job.status ?? '') !== 'Running') {
    return { ok: false, error: 'Run log can only be saved while the job is running.' };
  }
  const lines = Array.isArray(payload.readings) ? payload.readings : [];
  if (!lines.length) return { ok: false, error: 'Nothing to save — add readings for at least one coil line.' };
  const existing = listJobCoilsForJob(db, jobID);
  const byId = new Map(existing.map((row) => [String(row.id ?? '').trim(), row]));

  const parsed = [];
  for (const line of lines) {
    const aid = String(line?.allocationId ?? line?.allocation_id ?? '').trim();
    if (!aid) continue;
    const row = byId.get(aid);
    if (!row) return { ok: false, error: `Unknown coil line ${aid} on this job.` };
    const st = String(row.allocation_status ?? '').trim();
    if (st === 'Completed') {
      return { ok: false, error: `Coil line ${aid} is already completed and cannot be changed here.` };
    }
    const hasCoilInPayload = Object.prototype.hasOwnProperty.call(line, 'coilNo');
    const hasOpenInPayload =
      Object.prototype.hasOwnProperty.call(line, 'openingWeightKg') ||
      Object.prototype.hasOwnProperty.call(line, 'opening_weight_kg');
    const nextCoil = hasCoilInPayload ? String(line.coilNo ?? '').trim() : String(row.coil_no ?? '').trim();
    if (hasCoilInPayload && !nextCoil) {
      return { ok: false, error: 'Each run log line must have a coil number when coil is sent in the payload.' };
    }
    const nextOpening = hasOpenInPayload
      ? safeNumber(line.openingWeightKg ?? line.opening_weight_kg)
      : safeNumber(row.opening_weight_kg);
    if (nextOpening <= 0) {
      return { ok: false, error: `Opening kg must be greater than 0 (line ${aid}).` };
    }
    const closing = safeNumber(line.closingWeightKg ?? line.closing_weight_kg);
    const meters = safeNumber(line.metersProduced ?? line.meters_produced);
    if (closing < 0 || closing > nextOpening + 0.0001) {
      return {
        ok: false,
        error: `Coil ${nextCoil || row.coil_no}: closing kg must be between 0 and ${nextOpening}.`,
      };
    }
    if (meters < 0) {
      return { ok: false, error: `Coil ${nextCoil || row.coil_no}: metres cannot be negative.` };
    }
    const note = String(line.note ?? '').trim();
    const specMismatchAcknowledged = Boolean(line.specMismatchAcknowledged);
    const oldCoil = String(row.coil_no ?? '').trim();
    const oldOpen = safeNumber(row.opening_weight_kg);
    const identityChanged =
      nextCoil !== oldCoil || Math.abs(nextOpening - oldOpen) > 0.0001;
    parsed.push({
      aid,
      row,
      nextCoil,
      nextOpening,
      closing,
      meters,
      note,
      specMismatchAcknowledged,
      identityChanged,
    });
  }
  if (!parsed.length) {
    return { ok: false, error: 'Nothing to save — add readings for at least one coil line.' };
  }
  const totalMetersSaved = parsed.reduce((s, p) => s + Math.max(0, p.meters), 0);
  if (totalMetersSaved <= 0) {
    return {
      ok: false,
      error:
        'Metres produced must be greater than zero before saving. Use Cancel job if nothing was produced.',
    };
  }

  const coilsAfter = [];
  for (const r of existing) {
    const id = String(r.id ?? '').trim();
    const hit = parsed.find((p) => p.aid === id);
    const cn = hit ? hit.nextCoil : String(r.coil_no ?? '').trim();
    if (cn) coilsAfter.push(cn);
  }
  try {
    validateUniqueCoils(coilsAfter.map((coilNo) => ({ coilNo })));
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const specLines = parsed
    .filter((p) => String(p.nextCoil) !== String(p.row.coil_no ?? '').trim())
    .map((p) => ({
      coilNo: p.nextCoil,
      note: '',
      specMismatchAcknowledged: p.specMismatchAcknowledged,
    }));
  if (specLines.length) {
    const specBlock = validateSpecAcknowledgements(db, job, specLines);
    if (specBlock) return specBlock;
  }

  const updFull = db.prepare(
    `UPDATE production_job_coils
     SET coil_no = ?, product_id = ?, colour = ?, gauge_label = ?, opening_weight_kg = ?,
         closing_weight_kg = ?, consumed_weight_kg = ?, meters_produced = ?, actual_conversion_kg_per_m = ?,
         spec_mismatch = ?, note = ?
     WHERE id = ? AND job_id = ?`
  );
  try {
    db.transaction(() => {
      const masterDataForCoil = masterDataForCoilColourMatch(db);
      for (const p of parsed) {
        const oldCoil = String(p.row.coil_no ?? '').trim();
        const oldOpen = safeNumber(p.row.opening_weight_kg);
        if (p.identityChanged) {
          if (p.nextCoil === oldCoil) {
            bumpCoilReservedKgTx(db, oldCoil, p.nextOpening - oldOpen);
          } else {
            bumpCoilReservedKgTx(db, oldCoil, -oldOpen);
            bumpCoilReservedKgTx(db, p.nextCoil, p.nextOpening);
          }
        }
        const consumed = p.nextOpening - p.closing;
        const actual =
          p.meters > 0.0001 && consumed > 0.0001 ? consumed / p.meters : null;
        const newCoilRow = coilRow(db, p.nextCoil);
        const sm = allocationCoilSpecMismatched(db, job, p.nextCoil, masterDataForCoil);
        updFull.run(
          p.nextCoil,
          newCoilRow?.product_id ?? null,
          newCoilRow?.colour ?? null,
          newCoilRow?.gauge_label ?? null,
          p.nextOpening,
          p.closing,
          consumed,
          p.meters,
          actual,
          sm.mismatched ? 1 : 0,
          p.note || null,
          p.aid,
          jobID
        );
      }
      refreshJobCoilSpecFlagsTx(db, jobID);
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.run_log_draft',
        entityKind: 'production_job',
        entityId: jobID,
        note: `Run log draft saved (${parsed.length} line(s))`,
        details: {
          jobID,
          identityCorrections: parsed
            .filter((p) => p.identityChanged)
            .map((p) => ({
              allocationId: p.aid,
              from: { coilNo: p.row.coil_no, openingWeightKg: safeNumber(p.row.opening_weight_kg) },
              to: { coilNo: p.nextCoil, openingWeightKg: p.nextOpening },
            })),
        },
      });
    })();
    const stockRecalc = recalculateProductionJobCoilStock(db, jobID, {
      workspaceBranchId: opts.workspaceBranchId,
      actor: opts.actor,
    });
    return { ok: true, allocations: listProductionJobCoilsForJob(db, jobID), stockRecalc };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function completeProductionJobStone(db, job, jobID, payload = {}, opts = {}) {
  const completedAtISO = normalizeIso(payload.completedAtISO || payload.endDateISO || nowIso());
  const metresRaw = safeNumber(
    payload.stoneMetersConsumed ?? payload.stoneMeters ?? payload.metersConsumed ?? payload.totalMeters
  );
  const qref = String(job.quotation_ref ?? '').trim();
  const qRow = qref ? db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(qref) : null;
  let requiresStoneMetres = false;
  if (qRow?.lines_json) {
    try {
      requiresStoneMetres = quotationRequiresStoneMetreConsumption(qRow.lines_json);
    } catch {
      requiresStoneMetres = false;
    }
  }
  const metres = requiresStoneMetres ? metresRaw : 0;
  if (!Number.isFinite(metresRaw)) {
    return { ok: false, error: 'Stone metres consumed must be a number.' };
  }
  if (requiresStoneMetres && Math.abs(metres) < 1e-9) {
    return {
      ok: false,
      error:
        'Enter stone metres consumed as a non-zero number (positive draws stock; negative returns metres to stock).',
    };
  }
  const stonePid =
    requiresStoneMetres && Math.abs(metres) >= 1e-9 && qRow
      ? resolveStoneRawProductIdForQuotation(db, qRow, jobBranchId(job))
      : null;
  if (requiresStoneMetres && Math.abs(metres) >= 1e-9 && !stonePid) {
    return {
      ok: false,
      error: 'Could not resolve stone-coated stock SKU from the quotation (design, colour, gauge).',
    };
  }
  const accPlanPre = planAccessoryCompletion(db, job, payload);
  if (!accPlanPre.ok) return accPlanPre;
  const sfPlanPre = planStoneFlatsheetFulfillment(db, job, payload, {});
  if (!sfPlanPre.ok) return sfPlanPre;
  const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
    proposedJobOutputMetres: Math.max(0, metres),
    plannedAccessoryLines: accPlanPre.plannedLines,
    plannedStoneFlatsheetLines: sfPlanPre.plannedLines,
  });
  if (!paidRefundGate.ok) return paidRefundGate;
  let totalCogsForGl = 0;
  try {
    assertPeriodOpen(db, completedAtISO, 'Production completion date');
    const accPlan = planAccessoryCompletion(db, job, payload);
    if (!accPlan.ok) return { ok: false, error: accPlan.error };
    const sfPlan = planStoneFlatsheetFulfillment(db, job, payload, {});
    if (!sfPlan.ok) return { ok: false, error: sfPlan.error };
    const accessoryStockWarnings = [
      ...(accPlan.accessoryStockWarnings ?? []),
      ...(sfPlan.stoneFlatsheetStockWarnings ?? []),
    ];
    const stockBranch = jobBranchId(job);
    const adjustStock = (db, pid, delta) => adjustProductStockTx(db, pid, delta, stockBranch);
    db.transaction(() => {
      if (stonePid && Math.abs(metres) >= 1e-9) {
        adjustProductStockTx(db, stonePid, -metres, stockBranch);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'STONE_CONSUMPTION',
          ref: jobID,
          productID: stonePid,
          qty: -metres,
          branchId: stockBranch,
          detail:
            metres < 0
              ? `${jobID} stone-coated return ${Math.abs(metres).toFixed(2)} m`
              : `${jobID} stone-coated ${metres.toFixed(2)} m`,
        });
      }
      if (job.product_id && metres > 0) {
        adjustProductStockTx(db, job.product_id, metres, stockBranch);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'FINISHED_GOODS_RECEIPT',
          ref: jobID,
          productID: job.product_id,
          qty: metres,
          branchId: stockBranch,
          detail: `${jobID} completed output (${job.product_name || job.product_id})`,
        });
      }
      db.prepare(
        `UPDATE production_jobs
         SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
             conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?
         WHERE job_id = ?`
      ).run('Completed', completedAtISO.slice(0, 10), completedAtISO, metres, 0, 'OK', 0, 0, jobID);
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(job.cutting_list_id);
      }
      applyAccessoryCompletionTx(
        db,
        jobID,
        qref,
        completedAtISO,
        accPlan.plannedLines,
        adjustStock,
        appendStockMovementTx
      );
      applyStoneFlatsheetCompletionTx(
        db,
        jobID,
        qref,
        completedAtISO,
        sfPlan.plannedLines,
        adjustStock,
        appendStockMovementTx
      );
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.complete',
        entityKind: 'production_job',
        entityId: jobID,
        note: `Stone-coated production completed on ${jobID}`,
        details: { totalMeters: metres, stoneProductId: stonePid, offcutInventoryMeters: 0 },
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
      accessoryStockWarnings,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function completeProductionJobOffcut(db, job, jobID, payload = {}, opts = {}) {
  const completedAtISO = normalizeIso(payload.completedAtISO || payload.endDateISO || nowIso());
  const resolved = resolveOffcutCompletionMetres(payload);
  let metres = resolved.metres;
  let offInv = resolved.offInv;
  const offcutSupplyList = resolved.offcutSupplyList;
  if (!Number.isFinite(metres) || metres < 0) {
    return { ok: false, error: 'Offcut produced metres must be zero or greater.' };
  }
  let accessoryStockWarnings = [];
  try {
    assertPeriodOpen(db, completedAtISO, 'Production completion date');
    const stockBranch = jobBranchId(job);
    const adjustStock = (db, pid, delta) => adjustProductStockTx(db, pid, delta, stockBranch);
    db.transaction(() => {
      const accPlan = planAccessoryCompletion(db, job, payload);
      if (!accPlan.ok) throw new Error(accPlan.error);
      accessoryStockWarnings = accPlan.accessoryStockWarnings ?? [];

      let offcutSupplyJson = null;
      if (offcutSupplyList.length > 0) {
        const supply = issueOffcutSupplyForProductionTx(db, job, offcutSupplyList, opts.actor);
        offcutSupplyJson = JSON.stringify(supply);
        const sumIssued = supply.reduce((s, x) => s + (Number(x.meters) || 0), 0);
        if (sumIssued > 0) {
          if (offInv <= 0) offInv = sumIssued;
          if (Math.abs(sumIssued - offInv) > 0.02) {
            throw new Error(
              `Offcut issue total (${sumIssued.toFixed(2)} m) must match offcut stock metres (${offInv.toFixed(2)} m).`
            );
          }
        }
      }

      const allocations = listJobCoilsForJob(db, jobID);
      for (const row of allocations) {
        const coilNo = String(row.coil_no ?? '').trim();
        if (!coilNo) continue;
        const openingKg = clampNonNegative(safeNumber(row.opening_weight_kg));
        const coil = coilRow(db, coilNo);
        if (coil) {
          const nextReserved = clampNonNegative(safeNumber(coil.qty_reserved) - openingKg);
          db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(nextReserved, coilNo);
          updateCoilDerivedStateTx(db, coilNo);
        }
        db.prepare(
          `UPDATE production_job_coils
           SET closing_weight_kg = ?, consumed_weight_kg = 0, meters_produced = 0, actual_conversion_kg_per_m = NULL,
               allocation_status = 'Completed', note = COALESCE(NULLIF(note,''), ?)
           WHERE id = ?`
        ).run(openingKg, 'Completed from offcut/accessories mode.', row.id);
      }

      if (job.product_id && metres > 0) {
        adjustProductStockTx(db, job.product_id, metres, stockBranch);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'FINISHED_GOODS_RECEIPT',
          ref: jobID,
          productID: job.product_id,
          qty: metres,
          branchId: stockBranch,
          detail: `${jobID} completed from offcut/accessories mode (${job.product_name || job.product_id})`,
        });
      }
      const pjColsOffcut = db.prepare(`PRAGMA table_info(production_jobs)`).all();
      const hasOffcutSupplyCol = pjColsOffcut.some((c) => c.name === 'offcut_supply_json');
      if (hasOffcutSupplyCol) {
        db.prepare(
          `UPDATE production_jobs
           SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
               conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?, offcut_supply_json = ?
           WHERE job_id = ?`
        ).run(
          'Completed',
          completedAtISO.slice(0, 10),
          completedAtISO,
          metres,
          0,
          'OK',
          0,
          offInv,
          offcutSupplyJson,
          jobID
        );
      } else {
        db.prepare(
          `UPDATE production_jobs
           SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
               conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?
           WHERE job_id = ?`
        ).run('Completed', completedAtISO.slice(0, 10), completedAtISO, metres, 0, 'OK', 0, offInv, jobID);
      }
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(job.cutting_list_id);
      }
      applyAccessoryCompletionTx(
        db,
        jobID,
        String(job.quotation_ref ?? '').trim(),
        completedAtISO,
        accPlan.plannedLines,
        adjustStock,
        appendStockMovementTx
      );
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.complete_offcut',
        entityKind: 'production_job',
        entityId: jobID,
        note: `Production completed on ${jobID} (offcut/accessories mode)`,
        details: {
          totalMeters: metres,
          releasedCoilLines: allocations.length,
          offcutInventoryMeters: offInv,
          offcutSupplyCount: offcutSupplyList.length,
        },
      });
      const glRec = tryPostProductionRecognitionGlTx(db, {
        jobID,
        quotationRef: String(job.quotation_ref ?? '').trim(),
        actualMeters: metres,
        totalCogsNgn: 0,
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
      accessoryStockWarnings,
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
  if (jobIsStoneMeter(db, job) && quotationIsAccessoriesOnlyForJob(db, job)) {
    return completeProductionJobOffcut(db, job, jobID, payload, opts);
  }
  if (jobIsStoneMeter(db, job)) {
    return completeProductionJobStone(db, job, jobID, payload, opts);
  }
  if (completionModeFromPayload(payload) === 'offcut') {
    return completeProductionJobOffcut(db, job, jobID, payload, opts);
  }
  const completedAtISO = normalizeIso(payload.completedAtISO || payload.endDateISO || nowIso());
  const productionDateISO = String(payload.productionDateISO || payload.production_date_iso || completedAtISO).slice(0, 10);
  try {
    assertPeriodOpen(db, completedAtISO, 'Production completion date');
    const computed = computeCompletionConversionRows(db, jobID, payload);
    if (!computed.ok) return computed;
    const { conversionRows, totalMeters, totalWeightKg, aggregatedAlertState, managerReviewRequired } = computed;
    for (const row of conversionRows) {
      const blockReason = coilProductionBlocked(db, row.coilNo);
      if (blockReason) {
        return { ok: false, error: `Coil ${row.coilNo} is blocked: ${blockReason}` };
      }
    }
    const reasonCheck = validateConversionVarianceReason(payload, aggregatedAlertState);
    if (!reasonCheck.ok) return reasonCheck;
    const offInv = offcutInventoryMetersFromPayload(payload);
    if (offInv > 0 && totalMeters <= 0) {
      return {
        ok: false,
        error:
          'Use “Produced from offcut / accessories only” when no metres are produced from coils, or enter coil metres for a mixed run.',
      };
    }
    const outputMeters = totalMeters + offInv;
    const accPlanPre = planAccessoryCompletion(db, job, payload);
    if (!accPlanPre.ok) return accPlanPre;
    const sfPlanPre = planStoneFlatsheetFulfillment(db, job, payload, {});
    if (!sfPlanPre.ok) return sfPlanPre;
    const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
      proposedJobOutputMetres: outputMeters,
      plannedAccessoryLines: accPlanPre.plannedLines,
      plannedStoneFlatsheetLines: sfPlanPre.plannedLines,
    });
    if (!paidRefundGate.ok) return paidRefundGate;
    const plannedM = Number(job.planned_meters) || 0;
    if (plannedM > 0 && outputMeters > plannedM + 0.001) {
      const remark = String(payload?.meterOverrunRemark ?? '').trim();
      if (remark.length < 3) {
        return {
          ok: false,
          error:
            'Output exceeds planned metres. Enter a manager overrun remark (at least 3 characters) or reduce coil/offcut metres.',
        };
      }
    }
    let totalCogsForGl = 0;
    let accessoryStockWarnings = [];
    const stockBranch = jobBranchId(job);
    const adjustStock = (db, pid, delta) => adjustProductStockTx(db, pid, delta, stockBranch);
    db.transaction(() => {
      const accPlan = planAccessoryCompletion(db, job, payload);
      if (!accPlan.ok) throw new Error(accPlan.error);
      accessoryStockWarnings = accPlan.accessoryStockWarnings ?? [];
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
          branchId: stockBranch,
          detail: `${row.coilNo} consumed for ${row.metersProduced.toFixed(2)} m on ${jobID}`,
          unitPriceNgn: uc || null,
          valueNgn: cogsNgn,
        });
        /** Keep `products.stock_level` aligned with coil draw-down (GRN increases this SKU; completion must decrease). */
        adjustProductStockTx(db, row.productID, -row.consumedWeightKg, stockBranch);
        const tailBookedKg = row.finishCoil ? qtyRemaining : 0;
        if (tailBookedKg > 1e-6) {
          db.prepare(
            `UPDATE coil_lots SET qty_remaining = 0, qty_reserved = 0, current_weight_kg = 0 WHERE coil_no = ?`
          ).run(row.coilNo);
          updateCoilDerivedStateTx(db, row.coilNo);
          const tailCogs = uc > 0 ? Math.round(tailBookedKg * uc) : null;
          adjustProductStockTx(db, row.productID, -tailBookedKg, stockBranch);
          appendStockMovementTx(db, {
            atISO: completedAtISO,
            type: 'COIL_CONSUMPTION',
            ref: jobID,
            productID: row.productID,
            qty: -tailBookedKg,
            branchId: stockBranch,
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
      const qrefPool = String(job.quotation_ref ?? '').trim();
      const qMapPool = qrefPool ? getQuotation(db, qrefPool) : null;
      const gaugeForPool = String(qMapPool?.materialGauge ?? '').trim();
      const colourForPool = String(qMapPool?.materialColor ?? '').trim();
      const branchForPool = String(job.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
      const offcutSupplyRaw = payload.offcutSupply ?? payload.offcutIssues ?? payload.offcut_supply;
      const offcutSupplyList = Array.isArray(offcutSupplyRaw) ? offcutSupplyRaw : [];
      let offcutSupplyJson = null;
      if (offcutSupplyList.length > 0) {
        const supply = issueOffcutSupplyForProductionTx(db, job, offcutSupplyList, opts.actor);
        offcutSupplyJson = JSON.stringify(supply);
        const sumIssued = supply.reduce((s, x) => s + (Number(x.meters) || 0), 0);
        if (Math.abs(sumIssued - offInv) > 0.02 && offInv > 0) {
          throw new Error(
            `Offcut issue total (${sumIssued.toFixed(2)} m) must match offcut stock metres (${offInv.toFixed(2)} m).`
          );
        }
      } else if (offInv > 0 && gaugeForPool && colourForPool && job.product_id) {
        insertProductionOffcutPoolIssueTx(
          db,
          {
            branchId: branchForPool,
            jobID,
            quotationRef: qrefPool,
            cuttingListId: String(job.cutting_list_id || '').trim(),
            productId: String(job.product_id),
            gaugeLabel: gaugeForPool,
            colour: colourForPool,
            meters: offInv,
            customerName: String(job.customer_name || '').trim(),
            dateIso: completedAtISO.slice(0, 10),
          },
          opts.actor
        );
      }
      if (job.product_id) {
        adjustProductStockTx(db, job.product_id, outputMeters, stockBranch);
        appendStockMovementTx(db, {
          atISO: completedAtISO,
          type: 'FINISHED_GOODS_RECEIPT',
          ref: jobID,
          productID: job.product_id,
          qty: outputMeters,
          branchId: stockBranch,
          detail: `${jobID} completed output (${job.product_name || job.product_id})`,
        });
      }
      const pjColsComplete = db.prepare(`PRAGMA table_info(production_jobs)`).all();
      const hasOffcutSupplyCol = pjColsComplete.some((c) => c.name === 'offcut_supply_json');
      const hasProdDateCol = pjColsComplete.some((c) => c.name === 'production_date_iso');
      if (hasOffcutSupplyCol && hasProdDateCol) {
        db.prepare(
          `UPDATE production_jobs
           SET status = ?, end_date_iso = ?, completed_at_iso = ?, production_date_iso = ?, actual_meters = ?, actual_weight_kg = ?,
               conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?, offcut_supply_json = ?
           WHERE job_id = ?`
        ).run(
          'Completed',
          completedAtISO.slice(0, 10),
          completedAtISO,
          productionDateISO,
          outputMeters,
          roundWholeKg(totalWeightKg),
          aggregatedAlertState,
          managerReviewRequired ? 1 : 0,
          offInv,
          offcutSupplyJson,
          jobID
        );
      } else if (hasOffcutSupplyCol) {
        db.prepare(
          `UPDATE production_jobs
           SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
               conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?, offcut_supply_json = ?
           WHERE job_id = ?`
        ).run(
          'Completed',
          completedAtISO.slice(0, 10),
          completedAtISO,
          outputMeters,
          totalWeightKg,
          aggregatedAlertState,
          managerReviewRequired ? 1 : 0,
          offInv,
          offcutSupplyJson,
          jobID
        );
      } else {
        db.prepare(
          `UPDATE production_jobs
           SET status = ?, end_date_iso = ?, completed_at_iso = ?, actual_meters = ?, actual_weight_kg = ?,
               conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ?
           WHERE job_id = ?`
        ).run(
          'Completed',
          completedAtISO.slice(0, 10),
          completedAtISO,
          outputMeters,
          totalWeightKg,
          aggregatedAlertState,
          managerReviewRequired ? 1 : 0,
          offInv,
          jobID
        );
      }
      if (job.cutting_list_id) {
        db.prepare(`UPDATE cutting_lists SET status = 'Finished' WHERE id = ?`).run(job.cutting_list_id);
      }
      if (reasonCheck.code) {
        persistProductionConversionVarianceReason(db, jobID, {
          code: reasonCheck.code,
          band: reasonCheck.band || aggregatedAlertState,
          text: reasonCheck.text,
        });
      }
      applyAccessoryCompletionTx(
        db,
        jobID,
        String(job.quotation_ref ?? '').trim(),
        completedAtISO,
        accPlan.plannedLines,
        adjustStock,
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
            : reasonCheck.code
              ? `Production completed on ${jobID} with ${aggregatedAlertState.toLowerCase()} conversion (${reasonCheck.code})`
              : `Production completed on ${jobID} with ${aggregatedAlertState.toLowerCase()} conversion alert`,
        details: {
          coilMeters: totalMeters,
          offcutInventoryMeters: offInv,
          outputMeters,
          totalWeightKg,
          alertState: aggregatedAlertState,
          managerReviewRequired,
          conversionVarianceReasonCode: reasonCheck.code || null,
          conversionVarianceReasonText: reasonCheck.text || null,
        },
      });

      const glRec = tryPostProductionRecognitionGlTx(db, {
        jobID,
        quotationRef: String(job.quotation_ref ?? '').trim(),
        actualMeters: outputMeters,
        totalCogsNgn: totalCogsForGl,
        completedAtISO,
        branchId: job.branch_id ?? null,
        createdByUserId: opts.actor?.id != null ? String(opts.actor.id) : null,
      });
      if (!glRec.ok) throw new Error(glRec.error || 'Production recognition GL failed.');
    })();
    const stockRecalc = recalculateProductionJobCoilStock(db, jobID, {
      workspaceBranchId: stockBranch,
      actor: opts.actor,
    });
    return {
      ok: true,
      actualMeters: outputMeters,
      actualWeightKg: totalWeightKg,
      alertState: aggregatedAlertState,
      managerReviewRequired,
      accessoryStockWarnings,
      stockRecalc,
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
    if (delta > 0) {
      const effective = jobEffectiveOutputMetres(db, jobId);
      const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
        proposedJobOutputMetres: effective + delta,
      });
      if (!paidRefundGate.ok) return paidRefundGate;
    }
    const stockBranch = jobBranchId(job);
    const prodRow = getProductRowForWorkspace(db, productId, stockBranch);
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
    /** Single outer transaction comes from handleWriteWithEditApproval (MySQL nested SAVEPOINTs are fragile). */
    db.prepare(
      `INSERT INTO production_completion_adjustments (
        id, job_id, branch_id, delta_finished_goods_m, note, at_iso, created_by_user_id, created_by_name
      ) VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, jobId, branchId, delta, note, atISO, uid || null, name);
    adjustProductStockTx(db, productId, delta, stockBranch);
    appendStockMovementTx(db, {
      atISO,
      type: 'PRODUCTION_FG_ADJUSTMENT',
      ref: jobId,
      productID: productId,
      qty: delta,
      branchId: stockBranch,
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
    return { ok: true, adjustmentId: id, deltaFinishedGoodsM: delta, productStockMetersAfter: next };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function undoSingleCompletedCoilLineTx(db, row, atISO, jobId, stockBranch) {
  const coilNo = String(row.coil_no ?? '').trim();
  const opening = safeNumber(row.opening_weight_kg);
  const consumed = safeNumber(row.consumed_weight_kg);
  const productId = String(row.product_id ?? '').trim();
  const coil = coilRow(db, coilNo);
  if (!coil) throw new Error(`Coil ${coilNo} not found.`);
  const branch =
    String(stockBranch ?? coil?.branch_id ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const rem = clampNonNegative(
    coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received
  );
  const res = clampNonNegative(coil.qty_reserved ?? 0);
  const uc = Math.round(Number(coil.unit_cost_ngn_per_kg) || 0);
  const cogsNgn = uc > 0 ? Math.round(consumed * uc) : null;
  const prevLanded = Math.round(Number(coil.landed_cost_ngn) || 0);
  const nextLanded =
    cogsNgn != null && prevLanded > 0 ? prevLanded + cogsNgn : coil.landed_cost_ngn ?? null;
  db.prepare(
    `UPDATE coil_lots SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, landed_cost_ngn = ? WHERE coil_no = ?`
  ).run(
    clampNonNegative(rem + consumed),
    clampNonNegative(res + opening),
    clampNonNegative(rem + consumed),
    nextLanded,
    coilNo
  );
  updateCoilDerivedStateTx(db, coilNo);
  if (productId) adjustProductStockTx(db, productId, consumed, branch);
  appendStockMovementTx(db, {
    atISO,
    type: 'COIL_CONSUMPTION',
    ref: jobId,
    productID: productId || null,
    qty: consumed,
    branchId: branch,
    detail: `Completion coil correction — restore ${consumed.toFixed(2)} kg to ${coilNo} (${jobId})`,
    dateISO: atISO,
    unitPriceNgn: uc || null,
    valueNgn: cogsNgn,
  });
}

function applySingleCompletedCoilLineTx(db, jobId, line, atISO, stockBranch) {
  const { coilNo, openingWeightKg, consumedWeightKg, metersProduced, productID } = line;
  const coil = coilRow(db, coilNo);
  if (!coil) throw new Error(`Coil ${coilNo} not found.`);
  const branch =
    String(stockBranch ?? coil?.branch_id ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const qtyRemaining = clampNonNegative(
    safeNumber(coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? coil.qty_received) -
      consumedWeightKg
  );
  const qtyReserved = clampNonNegative(safeNumber(coil.qty_reserved) - openingWeightKg);
  const uc = Math.round(Number(coil.unit_cost_ngn_per_kg) || 0);
  const cogsNgn = uc > 0 ? Math.round(consumedWeightKg * uc) : null;
  const prevLanded = Math.round(Number(coil.landed_cost_ngn) || 0);
  const nextLanded =
    cogsNgn != null && prevLanded > 0 ? Math.max(0, prevLanded - cogsNgn) : coil.landed_cost_ngn ?? null;
  db.prepare(
    `UPDATE coil_lots SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, landed_cost_ngn = ? WHERE coil_no = ?`
  ).run(qtyRemaining, qtyReserved, qtyRemaining, nextLanded, coilNo);
  updateCoilDerivedStateTx(db, coilNo);
  if (productID) adjustProductStockTx(db, productID, -consumedWeightKg, branch);
  appendStockMovementTx(db, {
    atISO,
    type: 'COIL_CONSUMPTION',
    ref: jobId,
    productID: productID || null,
    qty: -consumedWeightKg,
    branchId: branch,
    detail: `${coilNo} consumed for ${metersProduced.toFixed(2)} m on ${jobId} (completion correction)`,
    dateISO: atISO,
    unitPriceNgn: uc || null,
    valueNgn: cogsNgn,
  });
}

/**
 * Re-normalize coil on-hand, reserved kg, raw product roll-up, and planned/running reservations
 * for every coil tied to a production job (plus optional extra coils from a correction swap).
 */
export function recalculateProductionJobCoilStock(db, jobID, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };

  const coilNos = new Set(
    listJobCoilsForJob(db, jobId)
      .map((r) => String(r.coil_no ?? '').trim())
      .filter(Boolean)
  );
  for (const cn of opts.extraCoilNos || []) {
    const t = String(cn ?? '').trim();
    if (t) coilNos.add(t);
  }
  if (!coilNos.size) {
    return { ok: true, jobID: jobId, coils: [], unchanged: true };
  }

  const coils = [];
  const errors = [];
  for (const coilNo of coilNos) {
    const bookReconcile = reconcileCoilBookFromProductionHolders(db, coilNo, {
      workspaceBranchId: opts.workspaceBranchId,
    });
    if (!bookReconcile.ok) {
      errors.push({ coilNo, step: 'book', error: bookReconcile.error });
      continue;
    }
    const reservation = reconcileCoilReservationFromProductionJobs(db, coilNo, {
      workspaceBranchId: opts.workspaceBranchId,
      actor: opts.actor,
    });
    if (!reservation.ok) {
      errors.push({ coilNo, step: 'reservation', error: reservation.error });
      continue;
    }
    coils.push({ coilNo, bookReconcile, reservation });
  }

  if (!coils.length && errors.length) {
    return { ok: false, error: errors[0].error, errors };
  }

  appendAuditLog(db, {
    actor: opts.actor,
    action: 'production.recalculate_stock',
    entityKind: 'production_job',
    entityId: jobId,
    note: `Stock recalculated for ${coils.length} coil(s) on ${jobId}`,
    details: {
      coilNos: coils.map((c) => c.coilNo),
      errors: errors.length ? errors : undefined,
    },
  });

  return {
    ok: true,
    jobID: jobId,
    coils,
    errors: errors.length ? errors : undefined,
    recalculatedCount: coils.length,
  };
}

function productionJobHasFinishCoilTailInMovements(db, jobId) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM stock_movements WHERE ref = ? AND type = 'COIL_CONSUMPTION' AND detail LIKE ?`
    )
    .get(jobId, '%roll finished%');
  return safeNumber(r?.c) > 0;
}

/**
 * After completion, correct recorded coil lines (coil, opening/closing kg, metres) and restate inventory.
 * Same permission intent as completion-adjustments (release / operations). Does not rewrite GL recognition.
 * Blocked when the job used “finish roll” tail clearing (stock_movements detail contains roll finished).
 */
export function applyCompletedProductionCoilCorrections(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') !== 'Completed') {
    return { ok: false, error: 'Coil correction applies only to completed jobs.' };
  }
  if (jobIsStoneMeter(db, job)) {
    return { ok: false, error: 'Stone-coated jobs have no coil lines to correct.' };
  }
  const note = String(payload.reason ?? payload.note ?? '').trim();
  if (note.length < 12) {
    return { ok: false, error: 'Enter a detailed reason (at least 12 characters) for this correction.' };
  }
  if (productionJobHasFinishCoilTailInMovements(db, jobId)) {
    return {
      ok: false,
      error:
        'This job cleared a roll “tail” on completion. Automated coil correction cannot safely reverse that yet. Use manual stock movements or contact support.',
    };
  }
  const lines = Array.isArray(payload.readings) ? payload.readings : [];
  if (!lines.length) return { ok: false, error: 'Send corrected readings for each coil line.' };

  const existing = listJobCoilsForJob(db, jobId);
  const oldCoilNos = existing.map((r) => String(r.coil_no ?? '').trim()).filter(Boolean);
  const byAid = new Map(existing.map((r) => [String(r.id ?? '').trim(), r]));

  const parsed = [];
  let newLineCounter = 0;
  for (const raw of lines) {
    const aid = String(raw?.allocationId ?? raw?.allocation_id ?? '').trim();
    const nextCoil = String(raw.coilNo ?? raw.coil_no ?? '').trim();
    if (!nextCoil) return { ok: false, error: 'Each line must have a coil number.' };
    const nextOpening = safeNumber(raw.openingWeightKg ?? raw.opening_weight_kg);
    const nextClosing = safeNumber(raw.closingWeightKg ?? raw.closing_weight_kg);
    const nextMeters = safeNumber(raw.metersProduced ?? raw.meters_produced);
    const newCoilRow = coilRow(db, nextCoil);
    if (!newCoilRow) return { ok: false, error: `Coil ${nextCoil} not found.` };

    if (!aid) {
      newLineCounter += 1;
      const label = `New coil line ${newLineCounter}`;
      if (nextOpening <= 0) return { ok: false, error: `${label}: opening kg must be greater than 0.` };
      if (nextClosing < 0 || nextClosing > nextOpening + 0.0001) {
        return { ok: false, error: `${label}: closing kg must be between 0 and opening.` };
      }
      if (nextMeters <= 0) return { ok: false, error: `${label}: metres must be greater than 0.` };
      const nextConsumed = nextOpening - nextClosing;
      if (nextConsumed <= 0) return { ok: false, error: `${label}: consumed kg must be greater than 0.` };
      parsed.push({
        isNew: true,
        aid: null,
        row: null,
        nextCoil,
        nextOpening,
        nextClosing,
        nextMeters,
        nextConsumed,
        newProductId: String(newCoilRow.product_id ?? '').trim(),
        lineNote: String(raw.note ?? '').trim(),
        specAck: Boolean(raw.specMismatchAcknowledged),
      });
      continue;
    }

    const row = byAid.get(aid);
    if (!row) return { ok: false, error: `Unknown allocation ${aid}.` };
    if (String(row.allocation_status ?? '') !== 'Completed') {
      return { ok: false, error: `Allocation ${aid} is not in Completed state.` };
    }
    if (nextOpening <= 0) return { ok: false, error: `Line ${aid}: opening kg must be greater than 0.` };
    if (nextClosing < 0 || nextClosing > nextOpening + 0.0001) {
      return { ok: false, error: `Line ${aid}: closing kg must be between 0 and opening.` };
    }
    if (nextMeters <= 0) return { ok: false, error: `Line ${aid}: metres must be greater than 0.` };
    const nextConsumed = nextOpening - nextClosing;
    if (nextConsumed <= 0) return { ok: false, error: `Line ${aid}: consumed kg must be greater than 0.` };
    parsed.push({
      isNew: false,
      aid,
      row,
      nextCoil,
      nextOpening,
      nextClosing,
      nextMeters,
      nextConsumed,
      newProductId: String(newCoilRow.product_id ?? '').trim(),
      lineNote: String(raw.note ?? '').trim(),
      specAck: Boolean(raw.specMismatchAcknowledged),
    });
  }

  const existingParsed = parsed.filter((p) => !p.isNew);
  if (!existing.length) {
    if (!parsed.length || parsed.some((p) => !p.isNew)) {
      return {
        ok: false,
        error:
          'This job has no coil lines yet. Add new coil rows (leave allocationId blank) with opening, closing, and metres.',
      };
    }
  } else {
    if (existingParsed.length !== existing.length) {
      return {
        ok: false,
        error: `Send all ${existing.length} saved coil line(s) (each with allocationId), plus optional extra lines with no allocationId for new rolls.`,
      };
    }
    const aidsSeen = new Set(existingParsed.map((p) => p.aid));
    if (aidsSeen.size !== existingParsed.length) {
      return { ok: false, error: 'Duplicate allocationId in readings.' };
    }
    for (const r of existing) {
      if (!aidsSeen.has(String(r.id ?? '').trim())) {
        return { ok: false, error: `Missing reading for allocation ${r.id}.` };
      }
    }
  }

  try {
    validateUniqueCoils(parsed.map((p) => ({ coilNo: p.nextCoil })));
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const specChanged = parsed.filter(
    (p) => p.isNew || String(p.nextCoil) !== String(p.row?.coil_no ?? '').trim()
  );
  if (specChanged.length) {
    const specBlock = validateSpecAcknowledgements(
      db,
      job,
      specChanged.map((p) => ({ coilNo: p.nextCoil, note: '', specMismatchAcknowledged: p.specAck }))
    );
    if (specBlock) return specBlock;
  }

  const oldTotalM = existing.reduce((s, r) => s + safeNumber(r.meters_produced), 0);
  const newTotalM = parsed.reduce((s, p) => s + p.nextMeters, 0);
  const oldOff = clampNonNegative(safeNumber(job.offcut_inventory_meters, 0));
  const newOff =
    payload?.offcutInventoryMeters !== undefined || payload?.offcut_inventory_meters !== undefined
      ? offcutInventoryMetersFromPayload(payload)
      : oldOff;
  const newTotalKg = parsed.reduce((s, p) => s + p.nextConsumed, 0);
  const deltaM = newTotalM - oldTotalM + (newOff - oldOff);
  const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
    proposedJobOutputMetres: newTotalM + newOff,
  });
  if (!paidRefundGate.ok) return paidRefundGate;
  const productId = String(job.product_id ?? '').trim();
  const atISO = normalizeIso(payload.atISO || nowIso());

  const updPjc = db.prepare(
    `UPDATE production_job_coils
     SET coil_no = ?, product_id = ?, colour = ?, gauge_label = ?, opening_weight_kg = ?, closing_weight_kg = ?,
         consumed_weight_kg = ?, meters_produced = ?, actual_conversion_kg_per_m = ?, spec_mismatch = ?, note = ?
     WHERE id = ? AND job_id = ?`
  );
  const insPjcCompleted = db.prepare(
    `INSERT INTO production_job_coils (
      id, job_id, sequence_no, coil_no, product_id, colour, gauge_label, opening_weight_kg,
      closing_weight_kg, consumed_weight_kg, meters_produced, actual_conversion_kg_per_m,
      allocation_status, spec_mismatch, note, allocated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  try {
    assertPeriodOpen(db, atISO, 'Production coil correction date');
    const stockBranch = jobBranchId(job);
    /** Outer transaction from handleWriteWithEditApproval — avoid nested db.transaction for MySQL SAVEPOINTs. */
    for (const r of existing) {
      undoSingleCompletedCoilLineTx(db, r, atISO, jobId, stockBranch);
    }
    if (productId && Math.abs(deltaM) > 1e-6) {
      const prodRow = getProductRowForWorkspace(db, productId, stockBranch);
      const current = Number(prodRow?.stock_level) || 0;
      const next = current + deltaM;
      if (next < -0.0001) {
        throw new Error(
          `This correction would send finished goods ${productId} negative (${next.toFixed(2)} m on hand).`
        );
      }
      adjustProductStockTx(db, productId, deltaM, stockBranch);
      appendStockMovementTx(db, {
        atISO,
        type: 'PRODUCTION_FG_ADJUSTMENT',
        ref: jobId,
        productID: productId,
        qty: deltaM,
        branchId: stockBranch,
        detail: `Coil completion correction ${jobId}: ${note.length > 120 ? `${note.slice(0, 117)}…` : note}`,
        dateISO: atISO,
      });
    }

    const masterDataForCoil = masterDataForCoilColourMatch(db);
    const alertStates = [];
    let anyMgr = false;
    let maxSeq = existing.reduce((m, r) => Math.max(m, Number(r.sequence_no) || 0), 0);
    for (const p of parsed) {
      const act = p.nextConsumed / p.nextMeters;
      const coilForRef = coilRow(db, p.nextCoil);
      const references = buildReferenceSet(db, coilForRef, act, jobId);
      const alert = determineAlertState(act, references);
      alertStates.push(alert.alertState);
      if (alert.managerReviewRequired) anyMgr = true;
      const sm = allocationCoilSpecMismatched(db, job, p.nextCoil, masterDataForCoil);
      if (p.isNew) {
        const c0 = coilRow(db, p.nextCoil);
        if (!c0) throw new Error(`Coil ${p.nextCoil} not found.`);
        const qtyRemaining0 = clampNonNegative(
          safeNumber(c0.qty_remaining ?? c0.current_weight_kg ?? c0.weight_kg ?? c0.qty_received)
        );
        const qtyReserved0 = clampNonNegative(safeNumber(c0.qty_reserved));
        const availableForThisJob = qtyRemaining0 - qtyReserved0;
        if (p.nextOpening > availableForThisJob + 0.0001) {
          throw new Error(
            `Coil ${p.nextCoil} only has ${availableForThisJob.toFixed(2)} kg available for allocation.`
          );
        }
        db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(
          clampNonNegative(qtyReserved0 + p.nextOpening),
          p.nextCoil
        );
        updateCoilDerivedStateTx(db, p.nextCoil);
        maxSeq += 1;
        const newId = nextId('PJC');
        insPjcCompleted.run(
          newId,
          jobId,
          maxSeq,
          p.nextCoil,
          coilForRef?.product_id ?? null,
          coilForRef?.colour ?? null,
          coilForRef?.gauge_label ?? null,
          p.nextOpening,
          p.nextClosing,
          p.nextConsumed,
          p.nextMeters,
          act,
          'Completed',
          sm.mismatched ? 1 : 0,
          p.lineNote || null,
          atISO
        );
      } else {
        updPjc.run(
          p.nextCoil,
          coilForRef?.product_id ?? null,
          coilForRef?.colour ?? null,
          coilForRef?.gauge_label ?? null,
          p.nextOpening,
          p.nextClosing,
          p.nextConsumed,
          p.nextMeters,
          act,
          sm.mismatched ? 1 : 0,
          p.lineNote || null,
          p.aid,
          jobId
        );
      }
      applySingleCompletedCoilLineTx(
        db,
        jobId,
        {
          coilNo: p.nextCoil,
          openingWeightKg: p.nextOpening,
          consumedWeightKg: p.nextConsumed,
          metersProduced: p.nextMeters,
          productID: p.newProductId,
        },
        atISO,
        stockBranch
      );
    }

    const aggregated = aggregateAlertState(alertStates);
    db.prepare(
      `UPDATE production_jobs SET actual_meters = ?, actual_weight_kg = ?, conversion_alert_state = ?, manager_review_required = ?, offcut_inventory_meters = ? WHERE job_id = ?`
    ).run(newTotalM + newOff, newTotalKg, aggregated, anyMgr ? 1 : 0, newOff, jobId);
    refreshJobCoilSpecFlagsTx(db, jobId);
    appendAuditLog(db, {
      actor: opts.actor,
      action: 'production.completion_coil_correct',
      entityKind: 'production_job',
      entityId: jobId,
      note: note.length > 200 ? `${note.slice(0, 197)}…` : note,
      details: {
        reason: note,
        oldTotalM,
        newTotalM,
        oldOffcutInventoryMeters: oldOff,
        newOffcutInventoryMeters: newOff,
        deltaM,
        lines: parsed.map((p) => ({
          allocationId: p.isNew ? null : p.aid,
          coilNo: p.nextCoil,
          isNew: p.isNew,
        })),
      },
    });
    const stockRecalc = recalculateProductionJobCoilStock(db, jobId, {
      extraCoilNos: [...oldCoilNos, ...parsed.map((p) => p.nextCoil)],
      workspaceBranchId: stockBranch,
      actor: opts.actor,
    });
    return {
      ok: true,
      allocations: listProductionJobCoilsForJob(db, jobId),
      actualMeters: newTotalM + newOff,
      actualWeightKg: newTotalKg,
      stockRecalc,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * After completion, restate accessory issue quantities for the job (ordered vs supplied on quotation accessories).
 * Same permission intent as other post-completion corrections; does not rewrite GL recognition.
 * @param {{ actor?: object, outerTransaction?: boolean }} [opts] When `outerTransaction` is true, skip `db.transaction`
 * (caller is already inside one — e.g. `handleWriteWithEditApproval` on MySQL SAVEPOINT stack).
 */
export function applyCompletedProductionAccessoryCorrections(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') !== 'Completed') {
    return { ok: false, error: 'Accessory correction applies only to completed jobs.' };
  }
  const note = String(payload.reason ?? payload.note ?? '').trim();
  if (note.length < 12) {
    return { ok: false, error: 'Enter a detailed reason (at least 12 characters) for this correction.' };
  }
  const atISO = normalizeIso(payload.atISO || nowIso());

  try {
    assertPeriodOpen(db, atISO, 'Production accessory correction date');
    const accPlan = planAccessoryCorrectionExcludingJob(db, job, jobId, payload);
    if (!accPlan.ok) return accPlan;
    const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
      plannedAccessoryLines: accPlan.plannedLines,
    });
    if (!paidRefundGate.ok) return paidRefundGate;

    const runBody = () => {
      const stockBranch = jobBranchId(job);
      const adjustStock = (db, pid, delta) => adjustProductStockTx(db, pid, delta, stockBranch);
      const quotationRef = String(job.quotation_ref ?? '').trim();
      const existing = db
        .prepare(
          `SELECT inventory_product_id AS inventoryProductId, supplied_qty AS suppliedQty, name
           FROM production_job_accessory_usage
           WHERE job_id = ?`
        )
        .all(jobId);
      for (const row of existing) {
        const pid = String(row.inventoryProductId || '').trim();
        const qty = safeNumber(row.suppliedQty);
        if (pid && qty > 0) {
          adjustProductStockTx(db, pid, qty, stockBranch);
          appendStockMovementTx(db, {
            atISO,
            type: 'ACCESSORY_ISSUE_ADJUSTMENT',
            ref: jobId,
            productID: pid,
            qty,
            branchId: stockBranch,
            detail: `Accessory correction (restore) · ${String(row.name || '').trim()} · ${jobId} · ${quotationRef}`,
            dateISO: atISO.slice(0, 10),
          });
        }
      }
      applyAccessoryCompletionTx(db, jobId, quotationRef, atISO, accPlan.plannedLines, adjustStock, appendStockMovementTx);
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.completion_accessory_correct',
        entityKind: 'production_job',
        entityId: jobId,
        note: note.length > 200 ? `${note.slice(0, 197)}…` : note,
        details: {
          reason: note,
          accessories: accPlan.plannedLines.map((l) => ({
            quoteLineId: l.quoteLineId,
            name: l.name,
            suppliedQty: l.suppliedQty,
            inventoryProductId: l.inventoryProductId || null,
          })),
        },
      });
    };
    if (opts.outerTransaction) runBody();
    else db.transaction(runBody)();

    return { ok: true, accessoryStockWarnings: accPlan.accessoryStockWarnings ?? [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function planStoneFlatsheetCorrectionExcludingJob(db, jobRow, jobId, payload = {}) {
  return planStoneFlatsheetFulfillment(db, jobRow, payload, { excludeJobId: jobId });
}

/**
 * After completion, restate stone flatsheet m² issued for the job (ordered vs supplied/deduction on quotation lines).
 * Same permission intent as post-completion accessory corrections; does not rewrite GL recognition.
 * @param {{ actor?: object, outerTransaction?: boolean }} [opts] When `outerTransaction` is true, skip `db.transaction`
 * (caller is already inside one — e.g. `handleWriteWithEditApproval` on MySQL SAVEPOINT stack).
 */
export function applyCompletedProductionStoneFlatsheetCorrections(db, jobID, payload = {}, opts = {}) {
  const jobId = String(jobID ?? '').trim();
  if (!jobId) return { ok: false, error: 'Job ID required.' };
  const job = productionJobRow(db, jobId);
  if (!job) return { ok: false, error: 'Production job not found.' };
  if (String(job.status ?? '') !== 'Completed') {
    return { ok: false, error: 'Stone flatsheet correction applies only to completed jobs.' };
  }
  const note = String(payload.reason ?? payload.note ?? '').trim();
  if (note.length < 12) {
    return { ok: false, error: 'Enter a detailed reason (at least 12 characters) for this correction.' };
  }
  const atISO = normalizeIso(payload.atISO || nowIso());

  try {
    assertPeriodOpen(db, atISO, 'Production stone flatsheet correction date');
    const sfPlan = planStoneFlatsheetCorrectionExcludingJob(db, job, jobId, payload);
    if (!sfPlan.ok) return sfPlan;
    const paidRefundGate = validateProductionEditAgainstPaidRefunds(db, job, {
      plannedStoneFlatsheetLines: sfPlan.plannedLines,
    });
    if (!paidRefundGate.ok) return paidRefundGate;

    const runBody = () => {
      const stockBranch = jobBranchId(job);
      const adjustStock = (db, pid, delta) => adjustProductStockTx(db, pid, delta, stockBranch);
      const quotationRef = String(job.quotation_ref ?? '').trim();
      const existing = db
        .prepare(
          `SELECT inventory_product_id AS inventoryProductId,
                  supplied_m2 AS suppliedM2,
                  deduction_m2 AS deductionM2,
                  name AS name
           FROM production_job_stone_flatsheet_usage WHERE job_id = ?`
        )
        .all(jobId);
      for (const row of existing) {
        const pid = String(row.inventoryProductId || '').trim();
        const restore = safeNumber(row.suppliedM2) + safeNumber(row.deductionM2);
        if (pid && restore > 0) {
          adjustProductStockTx(db, pid, restore, stockBranch);
          appendStockMovementTx(db, {
            atISO,
            type: 'STONE_FLATSHEET_ISSUE_ADJUSTMENT',
            ref: jobId,
            productID: pid,
            qty: restore,
            branchId: stockBranch,
            detail: `Stone flatsheet correction (restore) · ${String(row.name || '').trim()} · ${jobId} · ${quotationRef}`,
            dateISO: atISO.slice(0, 10),
          });
        }
      }
      applyStoneFlatsheetCompletionTx(
        db,
        jobId,
        quotationRef,
        atISO,
        sfPlan.plannedLines,
        adjustStock,
        appendStockMovementTx
      );
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'production.completion_stone_flatsheet_correct',
        entityKind: 'production_job',
        entityId: jobId,
        note: note.length > 200 ? `${note.slice(0, 197)}…` : note,
        details: {
          reason: note,
          stoneFlatsheet: sfPlan.plannedLines.map((l) => ({
            quoteLineId: l.quoteLineId,
            name: l.name,
            suppliedM2: l.suppliedM2,
            deductionM2: l.deductionM2,
            inventoryProductId: l.inventoryProductId || null,
          })),
        },
      });
    };
    if (opts.outerTransaction) runBody();
    else db.transaction(runBody)();

    return { ok: true, stoneFlatsheetStockWarnings: sfPlan.stoneFlatsheetStockWarnings ?? [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * All production_job_coils rows for a coil (any job status) — for traceability / orphan diagnosis.
 */
export function listCoilProductionHolders(db, coilNo) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return [];
  const rows = db
    .prepare(
      `SELECT pjc.id, pjc.job_id, pjc.coil_no, pjc.opening_weight_kg, pjc.closing_weight_kg,
        pjc.consumed_weight_kg, pjc.meters_produced, pjc.allocation_status, pjc.allocated_at_iso,
        pj.status AS job_status, pj.cutting_list_id, pj.quotation_ref,
        cl.customer_name AS cutting_list_customer,
        pcc.alert_state AS conversion_alert_state
       FROM production_job_coils pjc
       INNER JOIN production_jobs pj ON pj.job_id = pjc.job_id
       LEFT JOIN cutting_lists cl ON cl.id = pj.cutting_list_id
       LEFT JOIN production_conversion_checks pcc ON pcc.id = (
         SELECT id FROM production_conversion_checks
         WHERE job_id = pjc.job_id AND coil_no = pjc.coil_no
         ORDER BY checked_at_iso DESC, id DESC
         LIMIT 1
       )
       WHERE pjc.coil_no = ?
       ORDER BY pjc.allocated_at_iso DESC, pjc.sequence_no ASC, pjc.id ASC`
    )
    .all(cn);
  return rows.map((row) => ({
    id: row.id,
    jobID: row.job_id,
    coilNo: row.coil_no,
    openingWeightKg: safeNumber(row.opening_weight_kg),
    closingWeightKg: safeNumber(row.closing_weight_kg),
    consumedWeightKg: safeNumber(row.consumed_weight_kg),
    metersProduced: safeNumber(row.meters_produced),
    allocationStatus: row.allocation_status ?? '',
    allocatedAtISO: row.allocated_at_iso ?? '',
    jobStatus: row.job_status ?? '',
    cuttingListId: row.cutting_list_id ?? '',
    quotationRef: row.quotation_ref ?? '',
    customer: row.cutting_list_customer ?? '',
    conversionAlertState: row.conversion_alert_state ?? '',
  }));
}

function holderBookedKgUsed(h) {
  const consumed = clampNonNegative(h?.consumedWeightKg);
  if (consumed > 0) return consumed;
  const opening = safeNumber(h?.openingWeightKg);
  const closing = safeNumber(h?.closingWeightKg);
  if (opening > 0 && closing >= 0 && opening >= closing) return opening - closing;
  return 0;
}

/** Kg split off this parent into child coil lots (reduces parent on-hand, not in job consumed sum). */
function coilSplitOutKgFromChildren(db, coilNo) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(weight_kg, qty_received, 0)), 0) AS kg
       FROM coil_lots WHERE parent_coil_no = ?`
    )
    .get(cn);
  return clampNonNegative(row?.kg);
}

/**
 * Net kg change on this coil from scrap, returns, finish-roll tail, and master-data adjust
 * (not counted in production_job_coils consumed sum).
 */
function coilAncillaryKgNetDelta(db, coilNo) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return 0;
  let net = 0;
  const scrapReturn = db
    .prepare(
      `SELECT qty, detail FROM stock_movements WHERE ref = ? AND type IN ('COIL_SCRAP', 'COIL_RETURN')`
    )
    .all(cn);
  for (const m of scrapReturn) {
    if (String(m.detail || '').includes('Production book reconcile')) continue;
    net += safeNumber(m.qty);
  }
  const finishRoll = db
    .prepare(
      `SELECT qty FROM stock_movements
       WHERE type = 'COIL_CONSUMPTION' AND detail LIKE '%roll finished%' AND detail LIKE ?`
    )
    .all(`%${cn}%`);
  for (const m of finishRoll) net += safeNumber(m.qty);
  return net;
}

/** Align production_job_coils.consumed_weight_kg with opening − closing for rows on one coil. */
function syncProductionJobCoilConsumedWeightsForCoil(db, coilNo) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return { updatedLineCount: 0, touchedJobIds: [] };
  const rows = db
    .prepare(
      `SELECT id, job_id, opening_weight_kg, closing_weight_kg, consumed_weight_kg, meters_produced
       FROM production_job_coils WHERE coil_no = ?`
    )
    .all(cn);
  const upd = db.prepare(
    `UPDATE production_job_coils
     SET consumed_weight_kg = ?, actual_conversion_kg_per_m = ?
     WHERE id = ?`
  );
  const touchedJobs = new Set();
  let updatedLineCount = 0;
  for (const r of rows) {
    const opening = safeNumber(r.opening_weight_kg);
    const closing = safeNumber(r.closing_weight_kg);
    if (opening <= 0 || closing < 0 || closing > opening + 1e-6) continue;
    const nextConsumed = opening - closing;
    const prevConsumed = safeNumber(r.consumed_weight_kg);
    if (Math.abs(prevConsumed - nextConsumed) <= 0.0001) continue;
    const meters = safeNumber(r.meters_produced);
    const conv = meters > 0 ? nextConsumed / meters : null;
    upd.run(nextConsumed, conv, r.id);
    touchedJobs.add(String(r.job_id ?? '').trim());
    updatedLineCount += 1;
  }
  for (const jobId of touchedJobs) {
    if (!jobId) continue;
    const sum = db
      .prepare(`SELECT COALESCE(SUM(consumed_weight_kg), 0) AS kg FROM production_job_coils WHERE job_id = ?`)
      .get(jobId);
    db.prepare(`UPDATE production_jobs SET actual_weight_kg = ? WHERE job_id = ?`).run(
      clampNonNegative(sum?.kg),
      jobId
    );
  }
  return { updatedLineCount, touchedJobIds: [...touchedJobs] };
}

/**
 * Rebuild coil on-hand (kg used / remaining) from GRN received, summed job consumption,
 * coil splits, and non-production scrap/return/finish-roll movements.
 */
export function reconcileCoilBookFromProductionHolders(db, coilNo, opts = {}) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return { ok: false, error: 'Coil number is required.' };
  const coil = coilRow(db, cn);
  if (!coil) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(coil, opts.workspaceBranchId);
  if (!br.ok) return br;

  const syncResult = syncProductionJobCoilConsumedWeightsForCoil(db, cn);
  const holders = listCoilProductionHolders(db, cn);
  const received = clampNonNegative(coil.weight_kg ?? coil.qty_received);
  let jobsConsumedKg = 0;
  for (const h of holders) {
    jobsConsumedKg += holderBookedKgUsed(h);
  }
  const splitOutKg = coilSplitOutKgFromChildren(db, cn);
  const ancillaryNetKg = coilAncillaryKgNetDelta(db, cn);
  const expectedOnHand = clampNonNegative(received - jobsConsumedKg - splitOutKg + ancillaryNetKg);
  const beforeOnHand = clampNonNegative(coil.qty_remaining ?? coil.current_weight_kg);
  const delta = expectedOnHand - beforeOnHand;

  if (Math.abs(delta) <= 0.05) {
    updateCoilDerivedStateTx(db, cn);
    const bookRecalc = recalculateCoilLotBook(db, cn, { workspaceBranchId: opts.workspaceBranchId });
    if (!bookRecalc.ok) return bookRecalc;
    return {
      ok: true,
      coilNo: cn,
      unchanged: true,
      beforeOnHandKg: beforeOnHand,
      afterOnHandKg: beforeOnHand,
      onHandDeltaKg: 0,
      bookUsedKgBefore: Math.max(0, received - beforeOnHand),
      bookUsedKgAfter: Math.max(0, received - beforeOnHand),
      jobsConsumedKgSum: jobsConsumedKg,
      splitOutKg,
      ancillaryNetKg,
      syncResult,
      bookRecalc,
    };
  }

  const qtyRes = clampNonNegative(coil.qty_reserved);
  if (expectedOnHand + 1e-6 < qtyRes) {
    return {
      ok: false,
      error: `Reconciled on-hand would be ${expectedOnHand.toFixed(2)} kg, below reserved ${qtyRes.toFixed(2)} kg. Complete, cancel, or release active jobs first.`,
    };
  }

  db.prepare(`UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ? WHERE coil_no = ?`).run(
    expectedOnHand,
    expectedOnHand,
    cn
  );
  updateCoilDerivedStateTx(db, cn);
  const bookRecalc = recalculateCoilLotBook(db, cn, { workspaceBranchId: opts.workspaceBranchId });
  if (!bookRecalc.ok) return bookRecalc;

  return {
    ok: true,
    coilNo: cn,
    unchanged: false,
    beforeOnHandKg: beforeOnHand,
    afterOnHandKg: expectedOnHand,
    onHandDeltaKg: delta,
    bookUsedKgBefore: Math.max(0, received - beforeOnHand),
    bookUsedKgAfter: Math.max(0, received - expectedOnHand),
    jobsConsumedKgSum: jobsConsumedKg,
    splitOutKg,
    ancillaryNetKg,
    syncResult,
    bookRecalc,
  };
}

/** Sum job consumption vs coil book used for coil profile reconciliation. */
export function summarizeCoilProductionHoldersBook(db, coilNo, holders = null) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return null;
  const coil = coilRow(db, cn);
  if (!coil) return null;
  const rows = holders ?? listCoilProductionHolders(db, cn);
  const received = clampNonNegative(coil.weight_kg ?? coil.qty_received);
  const onHand = clampNonNegative(coil.qty_remaining ?? coil.current_weight_kg);
  const bookUsedKg = Math.max(0, received - onHand);
  let jobsConsumedKgSum = 0;
  let openingClosingKgSum = 0;
  for (const h of rows) {
    jobsConsumedKgSum += holderBookedKgUsed(h);
    const opening = safeNumber(h.openingWeightKg);
    const closing = safeNumber(h.closingWeightKg);
    if (opening > 0 && closing >= 0 && opening >= closing) {
      openingClosingKgSum += opening - closing;
    }
  }
  return {
    bookUsedKg,
    jobsConsumedKgSum,
    openingClosingKgSum,
    reconciliationGapKg: jobsConsumedKgSum - bookUsedKg,
    openingClosingGapKg: openingClosingKgSum - bookUsedKg,
  };
}

/**
 * Find coils where summed job consumption ≠ coil book used (and optional orphan reserved kg).
 * @param {{ workspaceBranchId?: string; minGapKg?: number; coilNoLike?: string; includeOrphanReservation?: boolean }} [opts]
 */
export function listCoilProductionBookReconciliationIssues(db, opts = {}) {
  const minGapKg = Math.max(0, safeNumber(opts.minGapKg, 0.05));
  const branchId = String(opts.workspaceBranchId ?? opts.branchId ?? '').trim();
  const coilLike = String(opts.coilNoLike ?? opts.search ?? '').trim();
  const includeOrphan = opts.includeOrphanReservation !== false;

  const args = [];
  let sql = `SELECT DISTINCT pjc.coil_no AS coil_no
    FROM production_job_coils pjc
    INNER JOIN coil_lots cl ON cl.coil_no = pjc.coil_no`;
  const where = [];
  if (branchId) {
    where.push('cl.branch_id = ?');
    args.push(branchId);
  }
  if (coilLike) {
    where.push('pjc.coil_no LIKE ?');
    args.push(`%${coilLike}%`);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY pjc.coil_no';

  const coilNos = db.prepare(sql).all(...args).map((r) => String(r.coil_no ?? '').trim()).filter(Boolean);

  const issues = [];
  for (const cn of coilNos) {
    const coil = coilRow(db, cn);
    if (!coil) continue;
    if (branchId) {
      const br = assertCoilInWorkspaceBranch(coil, branchId);
      if (!br.ok) continue;
    }
    const holders = listCoilProductionHolders(db, cn);
    if (!holders.length) continue;
    const summary = summarizeCoilProductionHoldersBook(db, cn, holders);
    if (!summary) continue;
    const gap = safeNumber(summary.reconciliationGapKg);
    const expectedReserved = expectedCoilReservedKgFromJobs(db, cn);
    const bookedReserved = clampNonNegative(coil.qty_reserved);
    const orphanReservedKg = Math.max(0, bookedReserved - expectedReserved);
    const hasGap = Math.abs(gap) > minGapKg;
    const hasOrphan = includeOrphan && orphanReservedKg > minGapKg;
    if (!hasGap && !hasOrphan) continue;

    const received = clampNonNegative(coil.weight_kg ?? coil.qty_received);
    const onHand = clampNonNegative(coil.qty_remaining ?? coil.current_weight_kg);
    issues.push({
      coilNo: cn,
      branchId: coil.branch_id ?? null,
      colour: coil.colour ?? '',
      gaugeLabel: coil.gauge_label ?? '',
      receivedKg: received,
      onHandKg: onHand,
      bookUsedKg: summary.bookUsedKg,
      jobsConsumedKgSum: summary.jobsConsumedKgSum,
      reconciliationGapKg: gap,
      openingClosingGapKg: summary.openingClosingGapKg,
      orphanReservedKg,
      bookedReservedKg: bookedReserved,
      expectedReservedKg: expectedReserved,
      jobLinkCount: holders.length,
      hasConsumptionGap: hasGap,
      hasOrphanReservation: hasOrphan,
    });
  }

  issues.sort((a, b) => {
    const ga = Math.abs(safeNumber(a.reconciliationGapKg));
    const gb = Math.abs(safeNumber(b.reconciliationGapKg));
    if (gb !== ga) return gb - ga;
    return String(a.coilNo).localeCompare(String(b.coilNo));
  });
  return issues;
}

/**
 * Recalculate coil book + reservations for every production job that allocated this coil.
 */
export function recalculateAllCoilProductionJobStock(db, coilNo, opts = {}) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return { ok: false, error: 'Coil number is required.' };
  const coil = coilRow(db, cn);
  if (!coil) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(coil, opts.workspaceBranchId);
  if (!br.ok) return br;

  const jobIds = [
    ...new Set(
      listCoilProductionHolders(db, cn)
        .map((h) => String(h.jobID || '').trim())
        .filter(Boolean)
    ),
  ];
  const jobResults = [];
  const errors = [];
  for (const jobId of jobIds) {
    const r = recalculateProductionJobCoilStock(db, jobId, opts);
    if (!r.ok) errors.push({ jobID: jobId, error: r.error });
    else jobResults.push(r);
  }

  const bookReconcile = reconcileCoilBookFromProductionHolders(db, cn, opts);
  if (!bookReconcile.ok) {
    return { ok: false, error: bookReconcile.error, jobResults, errors };
  }
  const reservation = reconcileCoilReservationFromProductionJobs(db, cn, opts);
  if (!reservation.ok) {
    return { ok: false, error: reservation.error, jobResults, errors, bookReconcile };
  }

  const summary = summarizeCoilProductionHoldersBook(db, cn);

  appendAuditLog(db, {
    actor: opts.actor,
    action: 'production.recalculate_coil_stock',
    entityKind: 'coil_lot',
    entityId: cn,
    note: `Production stock recalculated for ${jobIds.length} job(s) on ${cn}`,
    details: {
      jobIds,
      summary,
      bookReconcile,
      errors: errors.length ? errors : undefined,
    },
  });

  return {
    ok: true,
    coilNo: cn,
    recalculatedJobCount: jobResults.length,
    jobResults,
    bookReconcile,
    reservation,
    summary,
    errors: errors.length ? errors : undefined,
  };
}

/** Sum of opening_weight_kg on Planned + Running jobs for one coil. */
export function expectedCoilReservedKgFromJobs(db, coilNo) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pjc.opening_weight_kg), 0) AS kg
       FROM production_job_coils pjc
       INNER JOIN production_jobs pj ON pj.job_id = pjc.job_id
       WHERE pjc.coil_no = ? AND pj.status IN ('Planned', 'Running')`
    )
    .get(cn);
  return clampNonNegative(row?.kg);
}

/**
 * Reset coil_lots.qty_reserved to match active (Planned/Running) production allocations.
 * Fixes orphan reserved kg when no job holds the coil in the UI.
 */
export function reconcileCoilReservationFromProductionJobs(db, coilNo, opts = {}) {
  const cn = String(coilNo ?? '').trim();
  if (!cn) return { ok: false, error: 'Coil number is required.' };
  const coil = coilRow(db, cn);
  if (!coil) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(coil, opts.workspaceBranchId);
  if (!br.ok) return br;

  const expectedReserved = expectedCoilReservedKgFromJobs(db, cn);
  const beforeReserved = clampNonNegative(coil.qty_reserved);

  if (Math.abs(beforeReserved - expectedReserved) <= 0.0001) {
    return {
      ok: true,
      coilNo: cn,
      unchanged: true,
      qtyReservedBefore: beforeReserved,
      qtyReservedAfter: expectedReserved,
      expectedReserved,
      freedKg: 0,
    };
  }

  try {
    db.transaction(() => {
      db.prepare(`UPDATE coil_lots SET qty_reserved = ? WHERE coil_no = ?`).run(expectedReserved, cn);
      updateCoilDerivedStateTx(db, cn);
      appendAuditLog(db, {
        actor: opts.actor,
        action: 'coil.reconcile_reservation',
        entityKind: 'coil_lot',
        entityId: cn,
        note: `Reserved kg reconciled: ${beforeReserved.toFixed(2)} → ${expectedReserved.toFixed(2)} (planned/running jobs only)`,
        details: { coilNo: cn, qtyReservedBefore: beforeReserved, qtyReservedAfter: expectedReserved },
      });
    })();
    return {
      ok: true,
      coilNo: cn,
      unchanged: false,
      qtyReservedBefore: beforeReserved,
      qtyReservedAfter: expectedReserved,
      expectedReserved,
      freedKg: Math.max(0, beforeReserved - expectedReserved),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
