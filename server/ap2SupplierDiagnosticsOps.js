/**
 * AP2a — read-only supplier / GRN / payables / inventory diagnostics (no AP or GL mutations).
 */
import { branchWhere } from './readModel.js';
import { coilLineReceiptEconomics } from './writeOps.js';

const DEFAULT_SAMPLE_CAP = 10;
const MAX_SAMPLE_CAP = 25;

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function tableExists(db, name) {
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

function hasColumn(db, table, col) {
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

function parsePeriodKey(periodKey) {
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

function lineUnitPriceNgn(line) {
  const upkg = roundMoney(line.unit_price_per_kg_ngn);
  const up = roundMoney(line.unit_price_ngn);
  if (up > 0) return up;
  if (upkg > 0 && Number(line.conversion_kg_per_m) > 0) {
    return roundMoney(upkg * Number(line.conversion_kg_per_m));
  }
  return upkg > 0 ? upkg : 0;
}

function orderedValueFromLines(lines) {
  let s = 0;
  for (const l of lines) {
    const qty = Number(l.qty_ordered) || 0;
    s += roundMoney(qty * lineUnitPriceNgn(l));
  }
  return s;
}

function estimatedReceivedFromLines(lines) {
  let s = 0;
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
    }
  }
  return s;
}

function coilLandedSumForPo(db, poId) {
  if (!tableExists(db, 'coil_lots')) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(landed_cost_ngn), 0) AS s
       FROM coil_lots WHERE po_id = ? AND COALESCE(landed_cost_ngn, 0) > 0`
    )
    .get(poId);
  return roundMoney(row?.s);
}

function treasuryPaidForPo(db, poId) {
  if (!tableExists(db, 'treasury_movements')) return null;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(amount_ngn)), 0) AS s
       FROM treasury_movements
       WHERE source_kind = 'PURCHASE_ORDER' AND source_id = ?
         AND UPPER(TRIM(COALESCE(type,''))) IN ('SUPPLIER_PAYMENT','PO_SUPPLIER_PAYMENT')`
    )
    .get(poId);
  return roundMoney(row?.s);
}

function detectMissingCost(db, poId, lines) {
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
    const up = lineUnitPriceNgn(l);
    if (up <= 0) issues.push({ kind: 'po_line', ref: `${poId}:${l.line_key}` });
  }
  return issues;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchId?: string | null;
 *   period?: string | null;
 *   supplierId?: string | null;
 *   status?: string | null;
 *   limitSamples?: number;
 * }} [opts]
 */
export function buildAp2SupplierDiagnosticsReport(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const period = opts.period ? parsePeriodKey(opts.period) : null;
  const supplierFilter = String(opts.supplierId || '').trim();
  const statusFilter = String(opts.status || '').trim().toLowerCase();
  const sampleCap = Math.min(
    MAX_SAMPLE_CAP,
    Math.max(1, Math.round(Number(opts.limitSamples) || DEFAULT_SAMPLE_CAP))
  );

  const notes = [
    'PO value is a procurement commitment, not supplier payable.',
    'Expected AP is based on received goods minus supplier payments.',
    'Head of Accounts should review before AP basis is changed.',
  ];

  if (!tableExists(db, 'purchase_orders')) {
    return emptyReport(branchScope, period, notes);
  }

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

  const pos = db.prepare(sql).all(...args);
  const lineStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`);
  const apStmt = tableExists(db, 'accounts_payable')
    ? db.prepare(
        `SELECT ap_id, amount_ngn, paid_ngn FROM accounts_payable WHERE po_ref = ? ORDER BY ap_id LIMIT 1`
      )
    : null;

  const poRows = [];
  const byBranchMap = new Map();
  const bySupplierMap = new Map();
  const samples = {
    overpaidSuppliers: [],
    payableWithoutGrn: [],
    grnWithoutPayable: [],
    missingCost: [],
  };

  const summary = {
    poOrderedValueNgn: 0,
    grnReceivedValueNgn: 0,
    supplierPaidNgn: 0,
    currentApNgn: 0,
    expectedApReceivedBasisNgn: 0,
    apDifferenceNgn: 0,
    receivedNotPaidNgn: 0,
    paidNotReceivedNgn: 0,
    orderedNotReceivedNgn: 0,
    overpaidSupplierCount: 0,
    payableWithoutGrnCount: 0,
    grnWithoutPayableCount: 0,
    missingCostCount: 0,
  };

  const overpaidSet = new Set();

  for (const po of pos) {
    const poId = po.po_id;
    const lines = lineStmt.all(poId);
    const orderedNgn = orderedValueFromLines(lines);
    const coilLanded = coilLandedSumForPo(db, poId);
    const estimatedRecv = estimatedReceivedFromLines(lines);
    const receivedNgn = coilLanded > 0 ? coilLanded : estimatedRecv;
    const receivedBasis = coilLanded > 0 ? 'coil_landed_cost' : 'estimated_po_line';

    const supplierPaidPo = roundMoney(po.supplier_paid_ngn);
    const treasuryPaid = treasuryPaidForPo(db, poId);
    const supplierPaidNgn = supplierPaidPo;
    const paidBasis =
      treasuryPaid != null && treasuryPaid !== supplierPaidPo
        ? 'purchase_orders.supplier_paid_ngn (treasury differs)'
        : 'purchase_orders.supplier_paid_ngn';

    const apRow = apStmt?.get(poId);
    const currentApNgn = roundMoney(apRow?.amount_ngn);
    const apPaidNgn = roundMoney(apRow?.paid_ngn);

    const expectedApNgn = Math.max(receivedNgn - supplierPaidNgn, 0);
    const paidNotReceivedNgn = Math.max(supplierPaidNgn - receivedNgn, 0);
    const receivedNotPaidNgn = Math.max(receivedNgn - supplierPaidNgn, 0);
    const orderedNotReceivedNgn = Math.max(orderedNgn - receivedNgn, 0);
    const apDifferenceNgn = currentApNgn - expectedApNgn;

    const branchId = hasColumn(db, 'purchase_orders', 'branch_id')
      ? String(po.branch_id || '').trim() || '(none)'
      : '(none)';
    const supplierId = String(po.supplier_id || '').trim();
    const supplierName = String(po.supplier_name || '').trim();

    const missingIssues = detectMissingCost(db, poId, lines);
    const isOverpaid = paidNotReceivedNgn > 0;
    const payableWithoutGrn =
      currentApNgn > 0 &&
      (receivedNgn === 0 || (receivedNgn > 0 && currentApNgn > receivedNgn * 1.25));
    const grnWithoutPayable = receivedNgn > 0 && expectedApNgn > 0 && currentApNgn === 0;

    summary.poOrderedValueNgn += orderedNgn;
    summary.grnReceivedValueNgn += receivedNgn;
    summary.supplierPaidNgn += supplierPaidNgn;
    summary.currentApNgn += currentApNgn;
    summary.expectedApReceivedBasisNgn += expectedApNgn;
    summary.receivedNotPaidNgn += receivedNotPaidNgn;
    summary.paidNotReceivedNgn += paidNotReceivedNgn;
    summary.orderedNotReceivedNgn += orderedNotReceivedNgn;
    if (isOverpaid) {
      overpaidSet.add(supplierId || supplierName || poId);
    }
    if (payableWithoutGrn) summary.payableWithoutGrnCount += 1;
    if (grnWithoutPayable) summary.grnWithoutPayableCount += 1;
    if (missingIssues.length) summary.missingCostCount += 1;

    const row = {
      poId,
      supplierId,
      supplierName,
      branchId,
      status: po.status,
      orderedValueNgn: orderedNgn,
      receivedValueNgn: receivedNgn,
      receivedBasis,
      supplierPaidNgn,
      paidBasis,
      treasuryPaidNgn: treasuryPaid,
      currentApNgn,
      apPaidNgn,
      expectedApNgn,
      apDifferenceNgn,
      paidNotReceivedNgn,
      receivedNotPaidNgn,
      orderedNotReceivedNgn,
      flags: {
        overpaid: isOverpaid,
        payableWithoutGrn,
        grnWithoutPayable,
        missingCost: missingIssues.length > 0,
      },
    };
    poRows.push(row);

    if (!byBranchMap.has(branchId)) {
      byBranchMap.set(branchId, {
        branchId,
        poCount: 0,
        orderedValueNgn: 0,
        receivedValueNgn: 0,
        supplierPaidNgn: 0,
        currentApNgn: 0,
        expectedApNgn: 0,
      });
    }
    const bb = byBranchMap.get(branchId);
    bb.poCount += 1;
    bb.orderedValueNgn += orderedNgn;
    bb.receivedValueNgn += receivedNgn;
    bb.supplierPaidNgn += supplierPaidNgn;
    bb.currentApNgn += currentApNgn;
    bb.expectedApNgn += expectedApNgn;

    const sk = supplierId || supplierName || 'unknown';
    if (!bySupplierMap.has(sk)) {
      bySupplierMap.set(sk, {
        supplierId,
        supplierName,
        poCount: 0,
        orderedValueNgn: 0,
        receivedValueNgn: 0,
        supplierPaidNgn: 0,
        currentApNgn: 0,
        expectedApNgn: 0,
        paidNotReceivedNgn: 0,
      });
    }
    const bs = bySupplierMap.get(sk);
    bs.poCount += 1;
    bs.orderedValueNgn += orderedNgn;
    bs.receivedValueNgn += receivedNgn;
    bs.supplierPaidNgn += supplierPaidNgn;
    bs.currentApNgn += currentApNgn;
    bs.expectedApNgn += expectedApNgn;
    bs.paidNotReceivedNgn += paidNotReceivedNgn;

    if (isOverpaid && samples.overpaidSuppliers.length < sampleCap) {
      samples.overpaidSuppliers.push({
        poId,
        supplierName,
        paidNotReceivedNgn,
        receivedValueNgn: receivedNgn,
        supplierPaidNgn,
      });
    }
    if (payableWithoutGrn && samples.payableWithoutGrn.length < sampleCap) {
      samples.payableWithoutGrn.push({
        poId,
        supplierName,
        currentApNgn,
        receivedValueNgn: receivedNgn,
      });
    }
    if (grnWithoutPayable && samples.grnWithoutPayable.length < sampleCap) {
      samples.grnWithoutPayable.push({
        poId,
        supplierName,
        receivedValueNgn: receivedNgn,
        expectedApNgn,
      });
    }
    if (missingIssues.length && samples.missingCost.length < sampleCap) {
      samples.missingCost.push({
        poId,
        supplierName,
        issueCount: missingIssues.length,
        sampleRef: missingIssues[0]?.ref,
      });
    }
  }

  summary.overpaidSupplierCount = overpaidSet.size;
  summary.apDifferenceNgn = poRows.reduce((s, r) => s + r.apDifferenceNgn, 0);

  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Supplier, GRN, Payables & Inventory Diagnostics',
    disclaimer: 'Read-only management diagnostic. No AP values were changed.',
    generatedAtISO: new Date().toISOString(),
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    summary,
    byBranch: [...byBranchMap.values()],
    bySupplier: [...bySupplierMap.values()].sort((a, b) => b.expectedApNgn - a.expectedApNgn),
    poRows: poRows.slice(0, 200),
    samples,
    notes,
    poRowCount: poRows.length,
  };
}

function emptyReport(branchScope, period, notes) {
  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Supplier, GRN, Payables & Inventory Diagnostics',
    disclaimer: 'Read-only management diagnostic. No AP values were changed.',
    generatedAtISO: new Date().toISOString(),
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    summary: {
      poOrderedValueNgn: 0,
      grnReceivedValueNgn: 0,
      supplierPaidNgn: 0,
      currentApNgn: 0,
      expectedApReceivedBasisNgn: 0,
      apDifferenceNgn: 0,
      receivedNotPaidNgn: 0,
      paidNotReceivedNgn: 0,
      orderedNotReceivedNgn: 0,
      overpaidSupplierCount: 0,
      payableWithoutGrnCount: 0,
      grnWithoutPayableCount: 0,
      missingCostCount: 0,
    },
    byBranch: [],
    bySupplier: [],
    poRows: [],
    samples: {
      overpaidSuppliers: [],
      payableWithoutGrn: [],
      grnWithoutPayable: [],
      missingCost: [],
    },
    notes,
    poRowCount: 0,
  };
}

/** Compact counts for trial exceptions / exec strip. */
export function buildAp2SupplierDiagnosticsTrialSummary(db, branchScope = 'ALL') {
  const r = buildAp2SupplierDiagnosticsReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
    limitSamples: 0,
  });
  return {
    available: true,
    ...r.summary,
    apDifferenceNgn: r.summary.apDifferenceNgn,
  };
}
