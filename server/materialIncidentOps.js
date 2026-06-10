/**
 * Material exception & offcut control — incidents, approvals, pool balances, stock posting.
 */
import { randomUUID } from 'node:crypto';
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';
import {
  coilDamagePreview,
  isCoilDamageIncident,
  validateCoilDamagePayload,
} from '../shared/lib/coilDamageRecordCore.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { actorId, actorName, userHasPermission } from './auth.js';
import { isBranchManagerApprovalAuthority } from '../shared/workspaceGovernance.js';
import { appendAuditLog, assertPeriodOpen, insertRefundRequest } from './controlOps.js';
import { nextMaterialIncidentHumanId } from './humanId.js';
import { adjustProductStockTx, appendStockMovementTx } from './productionTraceability.js';
import { upsertWorkItemBySource } from './workItems.js';
import {
  insertProductionOffcutPoolIssueTx,
  postCoilScrap,
  postOffcutPoolReturnInward,
  postSupplierCoilDefect,
} from './writeOps.js';

const INCIDENT_TYPES = new Set([
  'coil_stain',
  'supplier_defect',
  'production_error',
  'customer_return',
  'yard_offcut',
]);

const DISPOSITIONS = new Set(['offcut_pool', 'sellable_fg', 'scrap', 'supplier_return']);

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_B64 = 4_500_000;

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function lineId() {
  return `MEXL-${randomUUID().slice(0, 8)}`;
}

function linkId() {
  return `MEXK-${randomUUID().slice(0, 8)}`;
}

function issueId() {
  return `MEXI-${randomUUID().slice(0, 8)}`;
}

function auditId() {
  return `MEXA-${randomUUID().slice(0, 8)}`;
}

function clampNonNegative(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

function sumLines(lines) {
  let t = 0;
  for (const ln of lines || []) {
    const len = Number(ln.length_m ?? ln.lengthM);
    const qty = Number(ln.quantity ?? 1);
    if (Number.isFinite(len) && len > 0 && Number.isFinite(qty) && qty > 0) {
      t += len * qty;
    }
  }
  return t;
}

function normalizeLines(raw) {
  const out = [];
  let i = 0;
  for (const ln of Array.isArray(raw) ? raw : []) {
    const lengthM = Number(ln.length_m ?? ln.lengthM);
    const quantity = Number(ln.quantity ?? 1);
    if (!Number.isFinite(lengthM) || lengthM <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const totalM = lengthM * quantity;
    out.push({
      id: String(ln.id || '').trim() || lineId(),
      length_m: lengthM,
      quantity,
      total_m: totalM,
      condition_note: String(ln.condition_note ?? ln.conditionNote ?? '').trim() || null,
      sort_order: i++,
    });
  }
  return out;
}

function normalizeAttachments(raw) {
  const out = [];
  for (const a of Array.isArray(raw) ? raw.slice(0, MAX_ATTACHMENTS) : []) {
    const name = String(a.fileName ?? a.name ?? 'file').trim() || 'file';
    const mime = String(a.mimeType ?? a.mime ?? 'application/octet-stream').trim();
    const dataBase64 = String(a.dataBase64 ?? a.data_b64 ?? '').trim();
    if (!dataBase64 || dataBase64.length > MAX_ATTACHMENT_B64) continue;
    out.push({ file_name: name, mime_type: mime, data_b64: dataBase64 });
  }
  return out;
}

function mapIncidentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    branchId: row.branch_id ?? '',
    incidentType: row.incident_type ?? '',
    materialFamily: row.material_family ?? 'aluminium',
    productId: row.product_id ?? '',
    gaugeLabel: row.gauge_label ?? '',
    colour: row.colour ?? '',
    profileLabel: row.profile_label ?? '',
    coilNo: row.coil_no ?? '',
    quotationRef: row.quotation_ref ?? '',
    cuttingListRef: row.cutting_list_ref ?? '',
    productionJobId: row.production_job_id ?? '',
    deliveryId: row.delivery_id ?? '',
    customerId: row.customer_id ?? '',
    customerLabel: row.customer_label ?? '',
    supplierId: row.supplier_id ?? '',
    beforeKg: row.before_kg != null ? Number(row.before_kg) : null,
    afterKg: row.after_kg != null ? Number(row.after_kg) : null,
    kgDeducted: row.kg_deducted != null ? Number(row.kg_deducted) : null,
    totalMeters: Number(row.total_meters) || 0,
    conversionKgPerM: roundConv2(row.conversion_kg_per_m),
    conversionSource: row.conversion_source ?? '',
    returnDisposition: row.return_disposition ?? '',
    storekeeperUserId: row.storekeeper_user_id ?? '',
    storekeeperDisplay: row.storekeeper_display ?? '',
    operatorDisplay: row.operator_display ?? '',
    createdByUserId: row.created_by_user_id ?? '',
    approvedByUserId: row.approved_by_user_id ?? '',
    approvedAtIso: row.approved_at_iso ?? '',
    postedAtIso: row.posted_at_iso ?? '',
    storekeeperRemark: row.storekeeper_remark ?? '',
    managerRemark: row.manager_remark ?? '',
    reasonCode: row.reason_code ?? '',
    reasonText: row.reason_text ?? '',
    status: row.status ?? 'draft',
    bookRef: row.book_ref ?? '',
    metersAvailable: Number(row.meters_available) || 0,
    customerRefundId: row.customer_refund_id ?? '',
    dateISO: row.date_iso ?? '',
    createdAtIso: row.created_at_iso ?? '',
    updatedAtIso: row.updated_at_iso ?? '',
    voidReason: row.void_reason ?? '',
    editUnlockedByUserId: row.edit_unlocked_by_user_id ?? '',
  };
}

export function materialIncidentsTableReady(db) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_incidents'`).get());
}

function getIncidentRow(db, id) {
  return db.prepare(`SELECT * FROM material_incidents WHERE id = ?`).get(String(id || '').trim());
}

function loadIncidentDetail(db, id) {
  const header = mapIncidentRow(getIncidentRow(db, id));
  if (!header) return null;
  const lines = db
    .prepare(`SELECT * FROM material_incident_lines WHERE incident_id = ? ORDER BY sort_order, id`)
    .all(id)
    .map((r) => ({
      id: r.id,
      lengthM: Number(r.length_m),
      quantity: Number(r.quantity),
      totalM: Number(r.total_m),
      conditionNote: r.condition_note ?? '',
      sortOrder: r.sort_order,
    }));
  const attachments = db
    .prepare(
      `SELECT id, file_name, mime_type, uploaded_at_iso, uploaded_by_user_id FROM material_incident_attachments WHERE incident_id = ?`
    )
    .all(id)
    .map((r) => ({
      id: r.id,
      fileName: r.file_name,
      mimeType: r.mime_type,
      uploadedAtIso: r.uploaded_at_iso,
      uploadedByUserId: r.uploaded_by_user_id ?? '',
    }));
  const issues = db
    .prepare(`SELECT * FROM material_incident_issues WHERE incident_id = ? ORDER BY issued_at_iso DESC`)
    .all(id)
    .map((r) => ({
      id: r.id,
      meters: Number(r.meters),
      issuedAtIso: r.issued_at_iso,
      targetKind: r.target_kind,
      targetRef: r.target_ref ?? '',
      managerPriceNgnPerM: r.manager_price_ngn_per_m != null ? Number(r.manager_price_ngn_per_m) : null,
      managerPriceNgnTotal: r.manager_price_ngn_total != null ? Number(r.manager_price_ngn_total) : null,
      note: r.note ?? '',
    }));
  const stockLinks = db
    .prepare(`SELECT * FROM material_incident_stock_links WHERE incident_id = ? ORDER BY created_at_iso`)
    .all(id);
  return { ...header, lines, attachments, issues, stockLinks };
}

function canApproveMaterialIncident(actor) {
  return (
    userHasPermission(actor, 'material_incidents.approve') ||
    userHasPermission(actor, '*') ||
    isBranchManagerApprovalAuthority(actor?.roleKey ?? actor?.role_key ?? actor?.role)
  );
}

function validateDraftPayload(payload, incidentType) {
  const type = String(payload.incidentType ?? payload.incident_type ?? incidentType ?? '').trim();
  if (!INCIDENT_TYPES.has(type)) return { ok: false, error: 'Invalid incident type.' };
  const gauge = String(payload.gaugeLabel ?? payload.gauge_label ?? '').trim();
  const colour = String(payload.colour ?? '').trim();
  const productId = String(payload.productId ?? payload.product_id ?? '').trim();
  if (type !== 'customer_return' || String(payload.returnDisposition ?? payload.return_disposition) !== 'sellable_fg') {
    if (!gauge || !colour) return { ok: false, error: 'Gauge and colour are required.' };
  }
  if (!productId && type !== 'yard_offcut') {
    return { ok: false, error: 'Product / SKU is required.' };
  }
  if (type === 'production_error' && !String(payload.productionJobId ?? payload.production_job_id ?? '').trim()) {
    return { ok: false, error: 'Production job is required for production error incidents.' };
  }
  if (type === 'customer_return') {
    const disp = String(payload.returnDisposition ?? payload.return_disposition ?? 'offcut_pool').trim();
    if (!DISPOSITIONS.has(disp)) return { ok: false, error: 'Invalid return disposition.' };
  }
  return { ok: true, type };
}

function insertStockLinkTx(db, incidentId, role, coilEventId, movementId) {
  db.prepare(
    `INSERT INTO material_incident_stock_links (id, incident_id, coil_control_event_id, stock_movement_id, link_role, created_at_iso)
     VALUES (?,?,?,?,?,?)`
  ).run(linkId(), incidentId, coilEventId || null, movementId || null, role, nowIso());
}

function replaceLinesTx(db, incidentId, lines) {
  db.prepare(`DELETE FROM material_incident_lines WHERE incident_id = ?`).run(incidentId);
  for (const ln of lines) {
    db.prepare(
      `INSERT INTO material_incident_lines (id, incident_id, length_m, quantity, total_m, condition_note, sort_order)
       VALUES (?,?,?,?,?,?,?)`
    ).run(ln.id, incidentId, ln.length_m, ln.quantity, ln.total_m, ln.condition_note, ln.sort_order);
  }
}

function replaceAttachmentsTx(db, incidentId, attachments, actor) {
  db.prepare(`DELETE FROM material_incident_attachments WHERE incident_id = ?`).run(incidentId);
  const at = nowIso();
  const uid = actorId(actor);
  for (const a of attachments) {
    db.prepare(
      `INSERT INTO material_incident_attachments (id, incident_id, file_name, mime_type, data_b64, uploaded_at_iso, uploaded_by_user_id)
       VALUES (?,?,?,?,?,?,?)`
    ).run(randomUUID(), incidentId, a.file_name, a.mime_type, a.data_b64, at, uid || null);
  }
}

function resolveConversion(db, payload, coilNo) {
  const manual = roundConv2(payload.conversionKgPerM ?? payload.conversion_kg_per_m);
  if (manual != null) {
    return { conversion: manual, source: String(payload.conversionSource ?? payload.conversion_source ?? 'manual_approved') };
  }
  if (coilNo) {
    const coil = db.prepare(`SELECT supplier_conversion_kg_per_m FROM coil_lots WHERE coil_no = ?`).get(coilNo);
    const c = roundConv2(coil?.supplier_conversion_kg_per_m);
    if (c != null) return { conversion: c, source: 'supplier' };
  }
  return { conversion: null, source: '' };
}

export function listMaterialIncidents(db, branchScope, filters = {}) {
  if (!materialIncidentsTableReady(db)) return [];
  const branchId = String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const status = String(filters.status || '').trim();
  const type = String(filters.incidentType || filters.type || '').trim();
  const gauge = String(filters.gaugeLabel || filters.gauge || '').trim();
  const colour = String(filters.colour || '').trim();
  const minMeters = Number(filters.minMeters);
  let sql = `SELECT * FROM material_incidents WHERE branch_id = ?`;
  const args = [branchId];
  if (status) {
    sql += ` AND status = ?`;
    args.push(status);
  }
  if (type) {
    sql += ` AND incident_type = ?`;
    args.push(type);
  }
  if (gauge) {
    sql += ` AND gauge_label = ?`;
    args.push(gauge);
  }
  if (colour) {
    sql += ` AND colour = ?`;
    args.push(colour);
  }
  if (Number.isFinite(minMeters) && minMeters > 0) {
    sql += ` AND meters_available >= ? AND status = 'posted'`;
    args.push(minMeters);
  }
  sql += ` ORDER BY date_iso DESC, created_at_iso DESC LIMIT 500`;
  return db.prepare(sql).all(...args).map(mapIncidentRow);
}

export function computePoolSummary(db, branchScope) {
  const branchId = String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const incidents = db
    .prepare(
      `SELECT id, material_family, gauge_label, colour, profile_label, meters_available, incident_type, status, date_iso
       FROM material_incidents WHERE branch_id = ? AND status = 'posted' AND meters_available > 0.001
       ORDER BY date_iso DESC`
    )
    .all(branchId);

  const bySpec = new Map();
  for (const row of incidents) {
    const key = `${row.material_family}|${row.gauge_label}|${row.colour}|${row.profile_label || ''}`;
    const prev = bySpec.get(key) || {
      materialFamily: row.material_family,
      gaugeLabel: row.gauge_label,
      colour: row.colour,
      profileLabel: row.profile_label || '',
      metersAvailable: 0,
      incidentCount: 0,
    };
    prev.metersAvailable += Number(row.meters_available) || 0;
    prev.incidentCount += 1;
    bySpec.set(key, prev);
  }

  let legacyIn = 0;
  let legacyIssue = 0;
  let legacyOut = 0;
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_control_events'`).get()) {
    const hasMex = db.prepare(`PRAGMA table_info(coil_control_events)`).all().some((c) => c.name === 'material_incident_id');
    const legSql = hasMex
      ? `SELECT event_kind, meters FROM coil_control_events WHERE branch_id = ? AND (material_incident_id IS NULL OR material_incident_id = '')`
      : `SELECT event_kind, meters FROM coil_control_events WHERE branch_id = ?`;
    for (const e of db.prepare(legSql).all(branchId)) {
      const m = Number(e.meters) || 0;
      if (e.event_kind === 'return_inward_pool') legacyIn += m;
      else if (e.event_kind === 'pool_issue_production') legacyIssue += m;
      else if (e.event_kind === 'return_outward') legacyOut += m;
    }
  }

  const incidentMeters = incidents.reduce((s, r) => s + (Number(r.meters_available) || 0), 0);
  const legacyAvailable = Math.max(0, legacyIn - legacyIssue - legacyOut);

  return {
    branchId,
    incidentMetersAvailable: incidentMeters,
    legacyPoolMetersAvailable: legacyAvailable,
    totalMetersAvailable: incidentMeters + legacyAvailable,
    bySpec: [...bySpec.values()],
    incidents: incidents.map((r) => ({
      id: r.id,
      incidentType: r.incident_type,
      materialFamily: r.material_family,
      gaugeLabel: r.gauge_label,
      colour: r.colour,
      profileLabel: r.profile_label || '',
      metersAvailable: Number(r.meters_available) || 0,
      dateISO: r.date_iso,
    })),
  };
}

/**
 * Production-style coil damage record: before/after kg, damaged metres, conversion on approval.
 * Creates a material incident (coil_stain or production_error) and optionally submits for manager approval.
 */
export function listPendingCoilDamageIncidents(db, branchScope) {
  return listMaterialIncidents(db, branchScope, { status: 'submitted' })
    .filter(isCoilDamageIncident)
    .map((row) => {
      let supplierConv = row.conversionKgPerM;
      const coilNo = String(row.coilNo || '').trim();
      if ((!supplierConv || supplierConv <= 0) && coilNo) {
        const coil = db.prepare(`SELECT supplier_conversion_kg_per_m FROM coil_lots WHERE coil_no = ?`).get(coilNo);
        supplierConv = coil?.supplier_conversion_kg_per_m;
      }
      const preview = coilDamagePreview({
        beforeKg: row.beforeKg,
        afterKg: row.afterKg,
        meters: row.totalMeters,
        supplierConversionKgPerM: supplierConv,
      });
      return { ...row, preview };
    });
}

export function createCoilDamageMaterialIncident(db, payload = {}, opts = {}) {
  if (!materialIncidentsTableReady(db)) return { ok: false, error: 'Material incidents module is not migrated.' };

  const coilNo = String(payload.coilNo ?? payload.coil_no ?? '').trim();
  const beforeKg = Number(payload.beforeKg ?? payload.before_kg);
  const afterKg = Number(payload.afterKg ?? payload.after_kg);
  const meters = Number(payload.meters ?? payload.metersDamaged ?? payload.meters_damaged);
  const productionJobId = String(payload.productionJobId ?? payload.production_job_id ?? '').trim();
  const note = String(payload.note ?? payload.storekeeperRemark ?? payload.storekeeper_remark ?? '').trim();
  const returnDisposition = String(payload.returnDisposition ?? payload.return_disposition ?? 'offcut_pool').trim();
  const submit = payload.submit !== false;

  const coil = coilNo ? db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo) : null;
  if (!coil) return { ok: false, error: 'Coil not found.' };
  const branchId = String(opts.workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const coilBranch = String(coil.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (coilBranch !== branchId) {
    return { ok: false, error: 'Coil is not in your current workspace branch.' };
  }

  const qtyRem = Math.max(0, Number(coil.qty_remaining) || Number(coil.current_weight_kg) || 0);
  const qtyRes = Math.max(0, Number(coil.qty_reserved) || 0);
  const maxRemove = qtyRem - qtyRes;
  const validated = validateCoilDamagePayload(
    { coilNo, beforeKg, afterKg, meters, note, returnDisposition },
    {
      maxRemoveKg: maxRemove,
      supplierConversionKgPerM: coil.supplier_conversion_kg_per_m,
    }
  );
  if (!validated.ok) return validated;

  const kgDeducted = validated.kgDeducted;
  if (productionJobId) {
    const job = db.prepare(`SELECT job_id FROM production_jobs WHERE job_id = ?`).get(productionJobId);
    if (!job) return { ok: false, error: `Production job ${productionJobId} not found.` };
  }

  const incidentType = productionJobId ? 'production_error' : 'coil_stain';
  const draftPayload = {
    incidentType,
    materialFamily: String(payload.materialFamily ?? payload.material_family ?? 'aluminium').trim() || 'aluminium',
    productId: String(payload.productId ?? payload.product_id ?? coil.product_id ?? '').trim(),
    gaugeLabel: String(payload.gaugeLabel ?? payload.gauge_label ?? coil.gauge_label ?? '').trim(),
    colour: String(payload.colour ?? coil.colour ?? '').trim(),
    coilNo,
    productionJobId: productionJobId || undefined,
    quotationRef: String(payload.quotationRef ?? payload.quotation_ref ?? '').trim() || undefined,
    cuttingListRef: String(payload.cuttingListRef ?? payload.cutting_list_ref ?? '').trim() || undefined,
    bookRef: String(payload.bookRef ?? payload.book_ref ?? '').trim() || undefined,
    beforeKg,
    afterKg,
    returnDisposition,
    storekeeperDisplay: String(payload.storekeeperDisplay ?? payload.storekeeper_display ?? '').trim() || undefined,
    operatorDisplay: String(payload.operatorDisplay ?? payload.operator_display ?? '').trim() || undefined,
    storekeeperRemark: note,
    reasonText: String(payload.reasonText ?? payload.reason_text ?? '').trim() || undefined,
    dateISO: String(payload.dateISO ?? payload.date_iso ?? new Date().toISOString().slice(0, 10)).trim(),
    lines: [
      {
        lengthM: meters,
        quantity: 1,
        conditionNote: String(payload.conditionNote ?? payload.condition_note ?? 'Damaged section').trim() || 'Damaged section',
      },
    ],
  };

  const created = createMaterialIncidentDraft(db, draftPayload, opts);
  if (!created.ok) return created;

  if (!submit) {
    return { ok: true, id: created.id, status: 'draft', incident: created.incident };
  }

  const submitted = submitMaterialIncident(db, created.id, opts);
  if (!submitted.ok) {
    return {
      ok: true,
      id: created.id,
      status: 'draft',
      incident: created.incident,
      submitted: false,
      submitError: submitted.error,
    };
  }

  return {
    ok: true,
    id: created.id,
    status: 'submitted',
    incident: loadIncidentDetail(db, created.id),
    kgDeducted,
    meters,
  };
}

export function createMaterialIncidentDraft(db, payload, opts = {}) {
  if (!materialIncidentsTableReady(db)) return { ok: false, error: 'Material incidents module is not migrated.' };
  const branchId = String(opts.workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const v = validateDraftPayload(payload);
  if (!v.ok) return v;
  const dateISO = String(payload.dateISO ?? payload.date_iso ?? new Date().toISOString().slice(0, 10)).trim();
  try {
    assertPeriodOpen(db, dateISO, 'Incident date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const lines = normalizeLines(payload.lines);
  const totalMeters = sumLines(lines);
  const id = nextMaterialIncidentHumanId(db, branchId);
  const at = nowIso();
  const bookRef = String(payload.bookRef ?? payload.book_ref ?? '').trim() || id;
  const beforeKg = payload.beforeKg != null || payload.before_kg != null ? Number(payload.beforeKg ?? payload.before_kg) : null;
  const afterKg = payload.afterKg != null || payload.after_kg != null ? Number(payload.afterKg ?? payload.after_kg) : null;
  let kgDeducted = null;
  if (Number.isFinite(beforeKg) && Number.isFinite(afterKg)) kgDeducted = Math.max(0, beforeKg - afterKg);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO material_incidents (
        id, branch_id, incident_type, material_family, product_id, gauge_label, colour, profile_label,
        coil_no, quotation_ref, cutting_list_ref, production_job_id, delivery_id, customer_id, customer_label, supplier_id,
        before_kg, after_kg, kg_deducted, total_meters, conversion_kg_per_m, conversion_source, return_disposition,
        storekeeper_user_id, storekeeper_display, operator_display, created_by_user_id,
        storekeeper_remark, manager_remark, reason_code, reason_text, status, book_ref, meters_available,
        date_iso, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      branchId,
      v.type,
      String(payload.materialFamily ?? payload.material_family ?? 'aluminium').trim() || 'aluminium',
      String(payload.productId ?? payload.product_id ?? '').trim() || null,
      String(payload.gaugeLabel ?? payload.gauge_label ?? '').trim() || null,
      String(payload.colour ?? '').trim() || null,
      String(payload.profileLabel ?? payload.profile_label ?? '').trim() || null,
      String(payload.coilNo ?? payload.coil_no ?? '').trim() || null,
      String(payload.quotationRef ?? payload.quotation_ref ?? '').trim() || null,
      String(payload.cuttingListRef ?? payload.cutting_list_ref ?? '').trim() || null,
      String(payload.productionJobId ?? payload.production_job_id ?? '').trim() || null,
      String(payload.deliveryId ?? payload.delivery_id ?? '').trim() || null,
      String(payload.customerId ?? payload.customer_id ?? '').trim() || null,
      String(payload.customerLabel ?? payload.customer_label ?? '').trim() || null,
      String(payload.supplierId ?? payload.supplier_id ?? '').trim() || null,
      Number.isFinite(beforeKg) ? beforeKg : null,
      Number.isFinite(afterKg) ? afterKg : null,
      Number.isFinite(kgDeducted) ? kgDeducted : null,
      totalMeters,
      null,
      null,
      String(payload.returnDisposition ?? payload.return_disposition ?? '').trim() || null,
      String(payload.storekeeperUserId ?? payload.storekeeper_user_id ?? actorId(opts.actor) ?? '').trim() || null,
      String(payload.storekeeperDisplay ?? payload.storekeeper_display ?? '').trim() || null,
      String(payload.operatorDisplay ?? payload.operator_display ?? '').trim() || null,
      actorId(opts.actor) || null,
      String(payload.storekeeperRemark ?? payload.storekeeper_remark ?? '').trim() || null,
      '',
      String(payload.reasonCode ?? payload.reason_code ?? '').trim() || null,
      String(payload.reasonText ?? payload.reason_text ?? '').trim() || null,
      'draft',
      bookRef,
      0,
      dateISO,
      at,
      at
    );
    replaceLinesTx(db, id, lines);
    replaceAttachmentsTx(db, id, normalizeAttachments(payload.attachments), opts.actor);
  })();

  return { ok: true, id, incident: loadIncidentDetail(db, id) };
}

export function updateMaterialIncidentDraft(db, incidentId, payload, opts = {}) {
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  const st = String(row.status);
  if (st === 'posted' || st === 'voided') {
    if (!row.edit_unlocked_by_user_id) {
      return { ok: false, error: 'Posted incidents require manager unlock to edit.' };
    }
    if (!canApproveMaterialIncident(opts.actor)) {
      return { ok: false, error: 'Only a branch manager can edit unlocked incidents.' };
    }
  } else if (st !== 'draft' && st !== 'rejected' && st !== 'submitted') {
    return { ok: false, error: `Cannot edit incident in status ${st}.` };
  }

  const v = validateDraftPayload(payload, row.incident_type);
  if (!v.ok) return v;
  const lines = normalizeLines(payload.lines ?? []);
  const totalMeters = sumLines(lines);
  const at = nowIso();
  const beforeKg =
    payload.beforeKg != null || payload.before_kg != null
      ? Number(payload.beforeKg ?? payload.before_kg)
      : row.before_kg;
  const afterKg =
    payload.afterKg != null || payload.after_kg != null ? Number(payload.afterKg ?? payload.after_kg) : row.after_kg;
  let kgDeducted = row.kg_deducted;
  if (Number.isFinite(beforeKg) && Number.isFinite(afterKg)) kgDeducted = Math.max(0, beforeKg - afterKg);

  db.transaction(() => {
    db.prepare(
      `UPDATE material_incidents SET
        incident_type = ?, material_family = ?, product_id = ?, gauge_label = ?, colour = ?, profile_label = ?,
        coil_no = ?, quotation_ref = ?, cutting_list_ref = ?, production_job_id = ?, delivery_id = ?,
        customer_id = ?, customer_label = ?, supplier_id = ?,
        before_kg = ?, after_kg = ?, kg_deducted = ?, total_meters = ?, return_disposition = ?,
        storekeeper_user_id = ?, storekeeper_display = ?, operator_display = ?,
        storekeeper_remark = ?, reason_code = ?, reason_text = ?, book_ref = ?, date_iso = ?, updated_at_iso = ?
       WHERE id = ?`
    ).run(
      v.type,
      String(payload.materialFamily ?? row.material_family).trim(),
      String(payload.productId ?? row.product_id ?? '').trim() || null,
      String(payload.gaugeLabel ?? row.gauge_label ?? '').trim() || null,
      String(payload.colour ?? row.colour ?? '').trim() || null,
      String(payload.profileLabel ?? row.profile_label ?? '').trim() || null,
      String(payload.coilNo ?? row.coil_no ?? '').trim() || null,
      String(payload.quotationRef ?? row.quotation_ref ?? '').trim() || null,
      String(payload.cuttingListRef ?? row.cutting_list_ref ?? '').trim() || null,
      String(payload.productionJobId ?? row.production_job_id ?? '').trim() || null,
      String(payload.deliveryId ?? row.delivery_id ?? '').trim() || null,
      String(payload.customerId ?? row.customer_id ?? '').trim() || null,
      String(payload.customerLabel ?? row.customer_label ?? '').trim() || null,
      String(payload.supplierId ?? row.supplier_id ?? '').trim() || null,
      Number.isFinite(beforeKg) ? beforeKg : null,
      Number.isFinite(afterKg) ? afterKg : null,
      Number.isFinite(kgDeducted) ? kgDeducted : null,
      totalMeters,
      String(payload.returnDisposition ?? row.return_disposition ?? '').trim() || null,
      String(payload.storekeeperUserId ?? row.storekeeper_user_id ?? '').trim() || null,
      String(payload.storekeeperDisplay ?? row.storekeeper_display ?? '').trim() || null,
      String(payload.operatorDisplay ?? row.operator_display ?? '').trim() || null,
      String(payload.storekeeperRemark ?? row.storekeeper_remark ?? '').trim() || null,
      String(payload.reasonCode ?? row.reason_code ?? '').trim() || null,
      String(payload.reasonText ?? row.reason_text ?? '').trim() || null,
      String(payload.bookRef ?? row.book_ref ?? '').trim() || incidentId,
      String(payload.dateISO ?? row.date_iso).trim(),
      at,
      incidentId
    );
    replaceLinesTx(db, incidentId, lines);
    if (payload.attachments) replaceAttachmentsTx(db, incidentId, normalizeAttachments(payload.attachments), opts.actor);
  })();

  return { ok: true, id: incidentId, incident: loadIncidentDetail(db, incidentId) };
}

export function submitMaterialIncident(db, incidentId, opts = {}) {
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.status) !== 'draft' && String(row.status) !== 'rejected') {
    return { ok: false, error: 'Only draft or rejected incidents can be submitted.' };
  }
  const lines = db.prepare(`SELECT COUNT(*) AS c FROM material_incident_lines WHERE incident_id = ?`).get(incidentId);
  const totalM = Number(row.total_meters) || 0;
  const disp = String(row.return_disposition || '');
  if (totalM <= 0 && disp !== 'sellable_fg' && String(row.incident_type) !== 'yard_offcut') {
    if (!lines?.c) return { ok: false, error: 'Add at least one quantity line with metres.' };
  }
  const at = nowIso();
  db.prepare(`UPDATE material_incidents SET status = 'submitted', updated_at_iso = ? WHERE id = ?`).run(at, incidentId);
  upsertWorkItemBySource(
    db,
    {
      sourceKind: 'material_incident',
      sourceId: incidentId,
      branchId: row.branch_id,
      officeKey: 'branch_manager',
      responsibleOfficeKey: 'branch_manager',
      documentClass: 'approval',
      documentType: 'material_incident',
      status: 'pending_review',
      title: `Material incident ${incidentId}`,
      summary: `${row.incident_type} · ${totalM.toFixed(2)} m · ${row.gauge_label || ''} ${row.colour || ''}`.trim(),
      routePath: '/operations/material-exceptions',
      updatedAtIso: at,
    },
    { actor: opts.actor }
  );
  return { ok: true, id: incidentId, status: 'submitted' };
}

function postIncidentStockEffects(db, row, opts) {
  const incidentId = row.id;
  const branchId = row.branch_id;
  const type = String(row.incident_type);
  const disp = String(row.return_disposition || 'offcut_pool');
  const totalM = Number(row.total_meters) || 0;
  const coilNo = String(row.coil_no || '').trim();
  const kg =
    Number(row.kg_deducted) > 0
      ? Number(row.kg_deducted)
      : Number(row.before_kg) > 0 && Number(row.after_kg) >= 0
        ? Number(row.before_kg) - Number(row.after_kg)
        : 0;
  const conv = resolveConversion(db, row, coilNo);
  const dateISO = row.date_iso;

  if (type === 'customer_return' && disp === 'sellable_fg') {
    const productId = String(row.product_id || '').trim();
    if (!productId) throw new Error('Product is required for sellable return.');
    const delta = totalM > 0 ? totalM : 0;
    if (delta <= 0) throw new Error('Enter metres for sellable return.');
    adjustProductStockTx(db, productId, delta);
    appendStockMovementTx(db, {
      atISO: nowIso(),
      type: 'MATERIAL_INCIDENT_FG_RETURN',
      ref: incidentId,
      productID: productId,
      qty: delta,
      detail: `Customer return ${incidentId}`,
      dateISO,
    });
    return;
  }

  if (type === 'supplier_defect' && coilNo) {
    if (kg > 0) {
      const scr = postSupplierCoilDefect(
        db,
        {
          coilNo,
          kgRemove: kg,
          supplierID: row.supplier_id,
          supplierResolution: row.reason_code || 'logged_pending',
          defectMFrom: 0,
          defectMTo: totalM,
          note: row.storekeeper_remark,
          dateISO,
          bookRef: incidentId,
        },
        opts
      );
      if (!scr.ok) throw new Error(scr.error || 'Supplier defect post failed.');
    }
  } else if (kg > 0 && coilNo && (type === 'coil_stain' || type === 'production_error')) {
    const creditScrap = disp === 'scrap';
    const scr = postCoilScrap(
      db,
      {
        coilNo,
        kg,
        meters: totalM,
        reason: type === 'production_error' ? 'Production error / trim' : 'Coil stain / damage',
        note: row.storekeeper_remark,
        dateISO,
        bookRef: incidentId,
        quotationRef: row.quotation_ref,
        cuttingListRef: row.cutting_list_ref,
        creditScrapInventory: creditScrap,
        scrapProductID: creditScrap ? 'SCRAP-COIL' : undefined,
        controlEventKind: 'scrap_offcut',
      },
      opts
    );
    if (!scr.ok) throw new Error(scr.error || 'Coil scrap failed.');
    const ev = db
      .prepare(
        `SELECT id FROM coil_control_events WHERE book_ref = ? AND event_kind = 'scrap_offcut' ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get(incidentId);
    if (ev?.id) {
      db.prepare(`UPDATE coil_control_events SET material_incident_id = ? WHERE id = ?`).run(incidentId, ev.id);
      insertStockLinkTx(db, incidentId, 'coil_kg_deduct', ev.id, null);
    }
  }

  const poolM =
    type === 'coil_stain' || type === 'production_error'
      ? disp === 'offcut_pool'
        ? totalM
        : 0
      : disp === 'offcut_pool' || type === 'yard_offcut'
        ? totalM
        : type === 'customer_return' && disp === 'offcut_pool'
          ? totalM
          : 0;

  if (poolM > 0) {
    const inward = postOffcutPoolReturnInward(
      db,
      {
        productID: row.product_id,
        gaugeLabel: row.gauge_label,
        colour: row.colour,
        meters: poolM,
        kgBook: kg > 0 ? kg : null,
        bookRef: row.book_ref || incidentId,
        cuttingListRef: row.cutting_list_ref,
        quotationRef: row.quotation_ref,
        customerLabel: row.customer_label,
        coilNo: coilNo || undefined,
        note: `Material incident ${incidentId}`,
        dateISO,
        materialIncidentId: incidentId,
      },
      opts
    );
    if (!inward.ok) throw new Error(inward.error || 'Offcut pool inward failed.');
    insertStockLinkTx(db, incidentId, 'pool_inward', inward.id, null);
  }

  db.prepare(
    `UPDATE material_incidents SET conversion_kg_per_m = ?, conversion_source = ?, kg_deducted = ?, meters_available = ? WHERE id = ?`
  ).run(conv.conversion, conv.source, kg > 0 ? kg : row.kg_deducted, poolM > 0 ? poolM : 0, incidentId);
}

export function approveMaterialIncident(db, incidentId, payload, opts = {}) {
  if (!canApproveMaterialIncident(opts.actor)) {
    return { ok: false, error: 'Only a branch manager (or material_incidents.approve) can approve.' };
  }
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.status) !== 'submitted') {
    return { ok: false, error: 'Incident is not awaiting approval.' };
  }
  const managerRemark = String(payload.managerRemark ?? payload.manager_remark ?? '').trim();
  const at = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE material_incidents SET status = 'approved', manager_remark = ?, approved_by_user_id = ?, approved_at_iso = ?, updated_at_iso = ? WHERE id = ?`
      ).run(managerRemark, actorId(opts.actor), at, at, incidentId);
      const fresh = getIncidentRow(db, incidentId);
      postIncidentStockEffects(db, fresh, opts);
      db.prepare(
        `UPDATE material_incidents SET status = 'posted', posted_at_iso = ?, updated_at_iso = ? WHERE id = ?`
      ).run(at, at, incidentId);
      upsertWorkItemBySource(
        db,
        {
          sourceKind: 'material_incident',
          sourceId: incidentId,
          status: 'completed',
          updatedAtIso: at,
        },
        { actor: opts.actor }
      );
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  appendAuditLog(db, {
    actor: opts.actor,
    action: 'material_incident.approve_post',
    entityKind: 'material_incident',
    entityId: incidentId,
    status: 'success',
    note: managerRemark,
  });
  return { ok: true, id: incidentId, incident: loadIncidentDetail(db, incidentId) };
}

export function rejectMaterialIncident(db, incidentId, payload, opts = {}) {
  if (!canApproveMaterialIncident(opts.actor)) {
    return { ok: false, error: 'Only a branch manager can reject.' };
  }
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.status) !== 'submitted') return { ok: false, error: 'Incident is not awaiting approval.' };
  const remark = String(payload.managerRemark ?? payload.manager_remark ?? '').trim();
  if (remark.length < 3) return { ok: false, error: 'Enter a rejection reason (manager remark).' };
  const at = nowIso();
  db.prepare(
    `UPDATE material_incidents SET status = 'rejected', manager_remark = ?, updated_at_iso = ? WHERE id = ?`
  ).run(remark, at, incidentId);
  upsertWorkItemBySource(db, { sourceKind: 'material_incident', sourceId: incidentId, status: 'rejected', updatedAtIso: at }, { actor: opts.actor });
  return { ok: true, id: incidentId, status: 'rejected' };
}

export function unlockMaterialIncidentEdit(db, incidentId, opts = {}) {
  if (!canApproveMaterialIncident(opts.actor)) {
    return { ok: false, error: 'Only a branch manager can unlock edits.' };
  }
  const at = nowIso();
  db.prepare(
    `UPDATE material_incidents SET edit_unlocked_by_user_id = ?, edit_unlocked_at_iso = ?, updated_at_iso = ? WHERE id = ?`
  ).run(actorId(opts.actor), at, at, incidentId);
  return { ok: true, id: incidentId };
}

export function voidMaterialIncident(db, incidentId, payload, opts = {}) {
  if (!canApproveMaterialIncident(opts.actor)) {
    return { ok: false, error: 'Only a branch manager can void.' };
  }
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.status) === 'voided') return { ok: false, error: 'Already voided.' };
  const reason = String(payload.reason ?? payload.voidReason ?? '').trim();
  if (reason.length < 5) return { ok: false, error: 'Void reason required (min 5 characters).' };
  const at = nowIso();
  db.prepare(
    `UPDATE material_incidents SET status = 'voided', void_reason = ?, voided_by_user_id = ?, voided_at_iso = ?, updated_at_iso = ? WHERE id = ?`
  ).run(reason, actorId(opts.actor), at, at, incidentId);
  return { ok: true, id: incidentId };
}

export function issueMaterialIncidentMeters(db, incidentId, payload, opts = {}) {
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.status) !== 'posted') return { ok: false, error: 'Incident must be posted before issuing metres.' };
  const meters = Number(payload.meters);
  if (!Number.isFinite(meters) || meters <= 0) return { ok: false, error: 'Meters must be positive.' };
  const targetKind = String(payload.targetKind ?? payload.target_kind ?? 'production_job').trim();
  const targetRef = String(payload.targetRef ?? payload.target_ref ?? '').trim();
  if (!targetRef) return { ok: false, error: 'Target reference is required.' };

  const pricePerM = Number(payload.managerPriceNgnPerM ?? payload.manager_price_ngn_per_m);
  const priceTotal = Number(payload.managerPriceNgnTotal ?? payload.manager_price_ngn_total);
  if (targetKind === 'customer_sale') {
    if (!Number.isFinite(pricePerM) && !Number.isFinite(priceTotal)) {
      return { ok: false, error: 'Manager price is required for customer sale issues.' };
    }
  }

  const iid = issueId();
  const at = nowIso();
  let coilEventId = null;
  try {
    db.transaction(() => {
      if (targetKind === 'production_job') {
        const job = db.prepare(`SELECT * FROM production_jobs WHERE job_id = ?`).get(targetRef);
        if (!job) throw new Error('Production job not found.');
        coilEventId = insertProductionOffcutPoolIssueTx(
          db,
          {
            branchId: row.branch_id,
            jobID: targetRef,
            quotationRef: job.quotation_ref,
            cuttingListId: job.cutting_list_id,
            productId: row.product_id,
            gaugeLabel: row.gauge_label,
            colour: row.colour,
            meters,
            dateIso: at.slice(0, 10),
            materialIncidentId: incidentId,
            materialIncidentIssueId: iid,
            note: `From incident ${incidentId}`,
          },
          opts.actor
        );
      } else {
        coilEventId = insertProductionOffcutPoolIssueTx(
          db,
          {
            branchId: row.branch_id,
            jobID: targetRef || incidentId,
            productId: row.product_id,
            gaugeLabel: row.gauge_label,
            colour: row.colour,
            meters,
            dateIso: at.slice(0, 10),
            materialIncidentId: incidentId,
            materialIncidentIssueId: iid,
            note: payload.note || `Issue from ${incidentId}`,
          },
          opts.actor
        );
      }
      db.prepare(
        `INSERT INTO material_incident_issues (
          id, incident_id, meters, issued_at_iso, issued_by_user_id, target_kind, target_ref,
          manager_price_ngn_per_m, manager_price_ngn_total, priced_by_user_id, priced_at_iso, coil_control_event_id, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        iid,
        incidentId,
        meters,
        at,
        actorId(opts.actor),
        targetKind,
        targetRef,
        Number.isFinite(pricePerM) ? pricePerM : null,
        Number.isFinite(priceTotal) ? priceTotal : null,
        targetKind === 'customer_sale' ? actorId(opts.actor) : null,
        targetKind === 'customer_sale' ? at : null,
        coilEventId,
        String(payload.note ?? '').trim() || null
      );
      insertStockLinkTx(db, incidentId, 'pool_issue', coilEventId, null);
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return { ok: true, issueId: iid, incident: loadIncidentDetail(db, incidentId) };
}

export function createRefundFromMaterialIncident(db, incidentId, payload, opts = {}) {
  const row = getIncidentRow(db, incidentId);
  if (!row) return { ok: false, error: 'Incident not found.' };
  if (String(row.incident_type) !== 'customer_return') {
    return { ok: false, error: 'Refund can only be created from customer return incidents.' };
  }
  const customerID = String(payload.customerID ?? payload.customer_id ?? row.customer_id ?? '').trim();
  if (!customerID) return { ok: false, error: 'Customer is required for refund.' };
  const amountNgn = Number(payload.amountNgn ?? payload.amount_ngn);
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    return { ok: false, error: 'Refund amount must be positive.' };
  }
  const r = insertRefundRequest(
    db,
    {
      customerID,
      quotationRef: row.quotation_ref,
      amountNgn,
      reasonCategory: payload.reasonCategory || ['Product return'],
      product: payload.product || 'Material return',
      payeeName: payload.payeeName,
      payeeAccountNo: payload.payeeAccountNo,
      payeeBankName: payload.payeeBankName,
      note: `Linked to material incident ${incidentId}`,
      requestedAtISO: row.date_iso,
    },
    opts.actor,
    row.branch_id
  );
  if (!r.ok) return r;
  db.prepare(`UPDATE material_incidents SET customer_refund_id = ?, updated_at_iso = ? WHERE id = ?`).run(
    r.refundID,
    nowIso(),
    incidentId
  );
  return { ok: true, refundID: r.refundID, incident: loadIncidentDetail(db, incidentId) };
}

export function getMaterialIncidentPrintPayload(db, incidentId) {
  const detail = loadIncidentDetail(db, incidentId);
  if (!detail) return null;
  const branch = db.prepare(`SELECT name FROM branches WHERE branch_id = ?`).get(detail.branchId);
  return {
    ...detail,
    branchName: branch?.name ?? detail.branchId,
    watermark: detail.status === 'posted' ? 'OFFICIAL' : 'DRAFT',
  };
}

export function getMaterialIncidentAttachment(db, incidentId, attachmentId) {
  const row = db
    .prepare(`SELECT * FROM material_incident_attachments WHERE incident_id = ? AND id = ?`)
    .get(incidentId, attachmentId);
  if (!row) return null;
  return {
    fileName: row.file_name,
    mimeType: row.mime_type,
    dataBase64: row.data_b64,
  };
}

export function getMaterialIncident(db, incidentId) {
  return loadIncidentDetail(db, incidentId);
}

/**
 * Issue metres from one or more material incidents on production complete.
 * @param {import('better-sqlite3').Database} db
 * @param {{ materialIncidentId: string, meters: number }[]} issues
 */
export function issueOffcutSupplyForProductionTx(db, job, issues, actor) {
  const jobID = String(job.job_id || job.jobID || '').trim();
  const supply = [];
  for (const row of issues || []) {
    const incidentId = String(row.materialIncidentId ?? row.incidentId ?? '').trim();
    const meters = Number(row.meters);
    if (!incidentId || !Number.isFinite(meters) || meters <= 0) continue;
    const inc = getIncidentRow(db, incidentId);
    if (!inc) throw new Error(`Offcut incident ${incidentId} not found.`);
    const iid = issueId();
    const coilEventId = insertProductionOffcutPoolIssueTx(
      db,
      {
        branchId: inc.branch_id,
        jobID,
        quotationRef: job.quotation_ref,
        cuttingListId: job.cutting_list_id,
        productId: inc.product_id,
        gaugeLabel: inc.gauge_label,
        colour: inc.colour,
        meters,
        dateIso: new Date().toISOString().slice(0, 10),
        materialIncidentId: incidentId,
        materialIncidentIssueId: iid,
        note: `Production ${jobID} offcut supply`,
      },
      actor
    );
    db.prepare(
      `INSERT INTO material_incident_issues (
        id, incident_id, meters, issued_at_iso, issued_by_user_id, target_kind, target_ref, coil_control_event_id, note
      ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      iid,
      incidentId,
      meters,
      nowIso(),
      actorId(actor),
      'production_job',
      jobID,
      coilEventId,
      `Production complete ${jobID}`
    );
    insertStockLinkTx(db, incidentId, 'pool_issue', coilEventId, null);
    supply.push({ materialIncidentId: incidentId, meters, issueId: iid });
  }
  return supply;
}

export function materialIncidentLossReport(db, branchScope) {
  const branchId = String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const rows = db
    .prepare(
      `SELECT incident_type, reason_code, SUM(COALESCE(kg_deducted,0)) AS kg, SUM(total_meters) AS m, COUNT(*) AS c
       FROM material_incidents WHERE branch_id = ? AND status = 'posted'
       GROUP BY incident_type, reason_code`
    )
    .all(branchId);
  return rows.map((r) => ({
    incidentType: r.incident_type,
    reasonCode: r.reason_code || '',
    kgDeducted: Number(r.kg) || 0,
    totalMeters: Number(r.m) || 0,
    count: Number(r.c) || 0,
  }));
}

/** Incidents with pool balance and age in days (for aging / slow-moving offcut report). */
export function materialIncidentAgingReport(db, branchScope) {
  const branchId = String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const today = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT id, incident_type, gauge_label, colour, profile_label, material_family,
              meters_available, total_meters, date_iso, posted_at_iso
       FROM material_incidents
       WHERE branch_id = ? AND status = 'posted' AND meters_available > 0.001
       ORDER BY date_iso ASC`
    )
    .all(branchId);
  return rows.map((r) => {
    const ref = String(r.posted_at_iso || r.date_iso || today).slice(0, 10);
    const ageDays = Math.max(
      0,
      Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${ref}T12:00:00Z`)) / 86_400_000)
    );
    return {
      id: r.id,
      incidentType: r.incident_type,
      materialFamily: r.material_family,
      gaugeLabel: r.gauge_label || '',
      colour: r.colour || '',
      profileLabel: r.profile_label || '',
      metersAvailable: Number(r.meters_available) || 0,
      totalMeters: Number(r.total_meters) || 0,
      dateISO: r.date_iso,
      ageDays,
    };
  });
}

/** Pool reconciliation snapshot (incident balances + legacy unallocated bucket). */
export function materialIncidentPoolReconciliationReport(db, branchScope) {
  const summary = computePoolSummary(db, branchScope);
  return {
    incidentMetersAvailable: summary.incidentMetersAvailable,
    legacyPoolMetersAvailable: summary.legacyPoolMetersAvailable,
    totalMetersAvailable: summary.totalMetersAvailable,
    bySpec: summary.bySpec,
    openIncidentCount: (summary.incidents || []).length,
  };
}
