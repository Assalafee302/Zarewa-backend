/**
 * AP2 — shared received-basis PO economics (diagnostics, preview, sync, rebuild).
 */
import { createHash } from 'node:crypto';
import { branchWhere } from './readModel.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

/** PO line pricing → landed NGN (shared with GRN; kept here to avoid writeOps circular import). */
function coilLineReceiptEconomics(line, qtyReceived, effectiveWeightKg, supplierExpectedMeters) {
  const upkg = Math.round(Number(line.unit_price_per_kg_ngn ?? line.unitPricePerKgNgn) || 0);
  const up = Math.round(Number(line.unit_price_ngn ?? line.unitPriceNgn) || 0);
  const w = Number(effectiveWeightKg) || 0;
  const q = Number(qtyReceived) || 0;
  const meters = Number(supplierExpectedMeters);
  let landed = 0;
  if (upkg > 0 && w > 0) landed = Math.round(w * upkg);
  else if (up > 0 && Number.isFinite(meters) && meters > 0) landed = Math.round(meters * up);
  else if (up > 0 && q > 0) landed = Math.round(q * up);
  const baseKg = w > 0 ? w : q > 0 ? q : 0;
  const unitCost = landed > 0 && baseKg > 0 ? Math.round(landed / baseKg) : null;
  return { landedCostNgn: landed > 0 ? landed : null, unitCostNgnPerKg: unitCost };
}

export function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

export function tableExists(db, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
      )
      .get(n);
    if (row) return true;
  } catch {
    /* sqlite */
  }
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n));
  } catch {
    return false;
  }
}

export function hasColumn(db, table, col) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => String(c.name) === col);
  } catch {
    try {
      const row = db
        .prepare(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`
        )
        .get(table, col);
      return Boolean(row);
    } catch {
      return false;
    }
  }
}

export function parsePeriodKey(periodKey) {
  const key = String(periodKey || '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return null;
  const startISO = `${y}-${String(mo).padStart(2, '0')}-01`;
  const lastDay = new Date(y, mo, 0).getDate();
  const endISO = `${y}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { key, startISO, endISO };
}

export function lineUnitPriceNgn(line) {
  const upkg = roundMoney(line.unit_price_per_kg_ngn);
  const up = roundMoney(line.unit_price_ngn);
  if (up > 0) return up;
  if (upkg > 0 && Number(line.conversion_kg_per_m) > 0) {
    return roundMoney(upkg * Number(line.conversion_kg_per_m));
  }
  return upkg > 0 ? upkg : 0;
}

export function orderedValueFromLines(lines) {
  let s = 0;
  for (const l of lines) {
    const qty = Number(l.qty_ordered) || 0;
    s += roundMoney(qty * lineUnitPriceNgn(l));
  }
  return s;
}

export function estimatedReceivedFromLines(lines) {
  let s = 0;
  let anyEstimated = false;
  for (const l of lines) {
    const qty = Number(l.qty_received) || 0;
    if (qty <= 0) continue;
    const w = Number(l.weight_kg) || 0;
    const meters = Number(l.meters_offered);
    const econ = coilLineReceiptEconomics(l, qty, w, meters);
    if (econ.landedCostNgn != null && econ.landedCostNgn > 0) {
      s += econ.landedCostNgn;
    } else {
      s += roundMoney(qty * lineUnitPriceNgn(l));
      anyEstimated = true;
    }
  }
  return { valueNgn: s, estimated: anyEstimated };
}

export function coilLandedSumForPo(db, poId) {
  if (!tableExists(db, 'coil_lots')) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(landed_cost_ngn), 0) AS s
       FROM coil_lots WHERE po_id = ? AND COALESCE(landed_cost_ngn, 0) > 0`
    )
    .get(poId);
  return roundMoney(row?.s);
}

export function detectMissingCost(db, poId, lines) {
  const issues = [];
  if (tableExists(db, 'coil_lots')) {
    const badCoils = db
      .prepare(
        `SELECT coil_no FROM coil_lots
         WHERE po_id = ? AND COALESCE(qty_received, 0) > 0
           AND (landed_cost_ngn IS NULL OR landed_cost_ngn <= 0
                OR unit_cost_ngn_per_kg IS NULL OR unit_cost_ngn_per_kg <= 0)`
      )
      .all(poId);
    for (const c of badCoils) {
      issues.push({ kind: 'coil_lot', ref: c.coil_no });
    }
  }
  for (const l of lines) {
    const rec = Number(l.qty_received) || 0;
    if (rec <= 0) continue;
    if (lineUnitPriceNgn(l) <= 0) issues.push({ kind: 'po_line', ref: `${poId}:${l.line_key}` });
  }
  return issues;
}

/** AP row id pattern safe for received-basis rebuild. */
export function isAutoManagedApId(apId) {
  return String(apId || '').trim().startsWith('AP-PO-');
}

/**
 * Amount_ngn to store on AP when using received-goods basis (gross received; zero on advance).
 */
export function proposedApAmountNgn(receivedValueNgn, supplierPaidNgn) {
  const received = roundMoney(receivedValueNgn);
  const paid = roundMoney(supplierPaidNgn);
  if (received <= 0) return 0;
  if (paid > received) return 0;
  return received;
}

/** Outstanding payable = max(received − paid, 0). */
export function expectedOutstandingApNgn(receivedValueNgn, supplierPaidNgn) {
  return Math.max(roundMoney(receivedValueNgn) - roundMoney(supplierPaidNgn), 0);
}

export function supplierAdvanceNgn(receivedValueNgn, supplierPaidNgn) {
  return Math.max(roundMoney(supplierPaidNgn) - roundMoney(receivedValueNgn), 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} po
 * @param {object[]} lines
 * @param {{ apRow?: { ap_id?: string, amount_ngn?: number, paid_ngn?: number } | null }} [ctx]
 */
export function computePoReceivedBasisEconomics(db, po, lines, ctx = {}) {
  const poId = po.po_id;
  const orderedValueNgn = orderedValueFromLines(lines);
  const coilLanded = coilLandedSumForPo(db, poId);
  const estRecv = estimatedReceivedFromLines(lines);
  const receivedValueNgn = coilLanded > 0 ? coilLanded : estRecv.valueNgn;
  const estimated = coilLanded <= 0 && (estRecv.estimated || estRecv.valueNgn > 0);
  const receivedBasis = coilLanded > 0 ? 'coil_landed_cost' : 'estimated_po_line';

  const supplierPaidNgn = roundMoney(po.supplier_paid_ngn);
  const apRow = ctx.apRow;
  const currentApNgn = roundMoney(apRow?.amount_ngn);
  const apPaidNgn = roundMoney(apRow?.paid_ngn);
  const autoManaged = apRow ? isAutoManagedApId(apRow.ap_id) : true;

  const expectedApNgn = expectedOutstandingApNgn(receivedValueNgn, supplierPaidNgn);
  const proposedApNgn = proposedApAmountNgn(receivedValueNgn, supplierPaidNgn);
  const advanceNgn = supplierAdvanceNgn(receivedValueNgn, supplierPaidNgn);
  const paidNotReceivedNgn = advanceNgn;
  const receivedNotPaidNgn = expectedApNgn;
  const orderedNotReceivedNgn = Math.max(orderedValueNgn - receivedValueNgn, 0);
  const amountDeltaNgn = currentApNgn - proposedApNgn;
  /** Diagnostics: current AP amount vs expected outstanding (AP2a). */
  const apDifferenceNgn = currentApNgn - expectedApNgn;

  const missingIssues = detectMissingCost(db, poId, lines);
  const riskFlags = [];
  if (advanceNgn > 0) riskFlags.push('supplier_advance');
  if (estimated) riskFlags.push('estimated_received');
  if (missingIssues.length) riskFlags.push('missing_cost');
  if (currentApNgn > 0 && receivedValueNgn === 0) riskFlags.push('payable_without_grn');
  if (receivedValueNgn > 0 && expectedApNgn > 0 && currentApNgn === 0) riskFlags.push('grn_without_payable');
  if (!autoManaged && apRow) riskFlags.push('manual_ap_skipped');

  const branchId = hasColumn(db, 'purchase_orders', 'branch_id')
    ? String(po.branch_id || '').trim() || '(none)'
    : '(none)';

  return {
    poId,
    supplierId: String(po.supplier_id || '').trim(),
    supplierName: String(po.supplier_name || '').trim(),
    supplierRef: String(po.supplier_id || po.supplier_name || '').trim(),
    branchId,
    status: po.status,
    orderedValueNgn,
    receivedValueNgn,
    receivedBasis,
    estimated,
    supplierPaidNgn,
    currentApNgn,
    apPaidNgn,
    expectedApNgn,
    proposedApNgn,
    supplierAdvanceNgn: advanceNgn,
    apDifferenceNgn,
    amountDeltaNgn,
    paidNotReceivedNgn,
    receivedNotPaidNgn,
    orderedNotReceivedNgn,
    autoManaged,
    apId: apRow?.ap_id ?? null,
    missingCostCount: missingIssues.length,
    riskFlags,
    rebuildEligible: autoManaged && String(po.status || '').trim() !== 'Rejected',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchId?: string | null;
 *   period?: string | null;
 *   supplierId?: string | null;
 *   status?: string | null;
 * }} [opts]
 */
export function listPurchaseOrdersForAp2Scope(db, opts = {}) {
  if (!tableExists(db, 'purchase_orders')) return [];
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const period = opts.period ? parsePeriodKey(opts.period) : null;
  const supplierFilter = String(opts.supplierId || '').trim();
  const statusFilter = String(opts.status || '').trim().toLowerCase();

  const b = branchWhere(db, 'purchase_orders', branchScope);
  let sql = `SELECT * FROM purchase_orders WHERE 1=1${b.sql}`;
  const args = [...b.args];
  if (supplierFilter) {
    sql += ` AND supplier_id = ?`;
    args.push(supplierFilter);
  }
  if (statusFilter) {
    sql += ` AND LOWER(TRIM(COALESCE(status,''))) = ?`;
    args.push(statusFilter);
  }
  if (period) {
    sql += ` AND substr(COALESCE(order_date_iso,''),1,10) >= ? AND substr(COALESCE(order_date_iso,''),1,10) <= ?`;
    args.push(period.startISO, period.endISO);
  }
  sql += ` ORDER BY order_date_iso DESC`;
  return db.prepare(sql).all(...args);
}

/**
 * Received amount for syncAccountsPayableFromPurchaseOrder when flag on.
 */
export function receivedBasisAmountForPoSync(db, poID) {
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return 0;
  const lines = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(poID);
  const econ = computePoReceivedBasisEconomics(db, row, lines, { apRow: null });
  return proposedApAmountNgn(econ.receivedValueNgn, econ.supplierPaidNgn);
}

export function apReceivedBasisEnabled() {
  return readFinanceFeatureFlags().apReceivedBasisEnabled;
}

export function apReceivedBasisRebuildEnabled() {
  return readFinanceFeatureFlags().apReceivedBasisRebuildEnabled;
}

/** @param {object[]} rows */
export function hashAp2RebuildPreview(rows, scope = {}) {
  const payload = {
    v: 1,
    branchId: scope.branchId ?? 'ALL',
    period: scope.period ?? null,
    supplierId: scope.supplierId ?? null,
    status: scope.status ?? null,
    rows: rows
      .filter((r) => r.rebuildEligible)
      .map((r) => ({
        poId: r.poId,
        currentApNgn: r.currentApNgn,
        proposedApNgn: r.proposedApNgn,
      }))
      .sort((a, b) => String(a.poId).localeCompare(String(b.poId))),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function readLastApReceivedBasisRebuild(db) {
  if (!tableExists(db, 'audit_log')) return null;
  const row = db
    .prepare(
      `SELECT occurred_at_iso, actor_name, note, details_json
       FROM audit_log
       WHERE action = 'ap.received_basis.rebuilt'
       ORDER BY occurred_at_iso DESC
       LIMIT 1`
    )
    .get();
  if (!row) return null;
  let details = null;
  try {
    details = row.details_json ? JSON.parse(row.details_json) : null;
  } catch {
    details = null;
  }
  return {
    atISO: row.occurred_at_iso,
    actorName: row.actor_name,
    note: row.note,
    details,
  };
}

export function resolveApBasisLabel(flags = readFinanceFeatureFlags()) {
  if (!flags.apReceivedBasisEnabled) return 'ordered';
  return 'received_goods';
}
