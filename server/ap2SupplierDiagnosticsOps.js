/**
 * AP2a — read-only supplier / GRN / payables / inventory diagnostics (no AP or GL mutations).
 */
import {
  computePoReceivedBasisEconomics,
  listPurchaseOrdersForAp2Scope,
  parsePeriodKey,
  readLastApReceivedBasisRebuild,
  resolveApBasisLabel,
  tableExists,
} from './ap2ReceivedBasisOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

const DEFAULT_SAMPLE_CAP = 10;
const MAX_SAMPLE_CAP = 25;

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
  const sampleCap = Math.min(
    MAX_SAMPLE_CAP,
    Math.max(1, Math.round(Number(opts.limitSamples) || DEFAULT_SAMPLE_CAP))
  );

  const flags = readFinanceFeatureFlags();
  const lastRebuild = readLastApReceivedBasisRebuild(db);
  const apBasis = resolveApBasisLabel(flags);

  const notes = [
    'PO value is a procurement commitment, not supplier payable.',
    'Expected AP is based on received goods minus supplier payments.',
    flags.apReceivedBasisEnabled
      ? 'AP sync uses received-goods basis (flag on).'
      : 'Current AP may still be ordered-basis until rebuild is approved.',
    'Head of Accounts should review before AP basis is changed.',
  ];

  if (!tableExists(db, 'purchase_orders')) {
    return emptyReport(branchScope, period, notes, apBasis, lastRebuild);
  }

  const lineStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`);
  const apStmt = tableExists(db, 'accounts_payable')
    ? db.prepare(
        `SELECT ap_id, amount_ngn, paid_ngn FROM accounts_payable WHERE po_ref = ? ORDER BY ap_id LIMIT 1`
      )
    : null;

  const pos = listPurchaseOrdersForAp2Scope(db, opts);
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
    const apRow = apStmt?.get(poId) ?? null;
    const econ = computePoReceivedBasisEconomics(db, po, lines, { apRow });

    const isOverpaid = econ.paidNotReceivedNgn > 0;
    const payableWithoutGrn = econ.riskFlags.includes('payable_without_grn');
    const grnWithoutPayable = econ.riskFlags.includes('grn_without_payable');

    summary.poOrderedValueNgn += econ.orderedValueNgn;
    summary.grnReceivedValueNgn += econ.receivedValueNgn;
    summary.supplierPaidNgn += econ.supplierPaidNgn;
    summary.currentApNgn += econ.currentApNgn;
    summary.expectedApReceivedBasisNgn += econ.expectedApNgn;
    summary.receivedNotPaidNgn += econ.receivedNotPaidNgn;
    summary.paidNotReceivedNgn += econ.paidNotReceivedNgn;
    summary.orderedNotReceivedNgn += econ.orderedNotReceivedNgn;
    if (isOverpaid) overpaidSet.add(econ.supplierId || econ.supplierName || poId);
    if (payableWithoutGrn) summary.payableWithoutGrnCount += 1;
    if (grnWithoutPayable) summary.grnWithoutPayableCount += 1;
    if (econ.missingCostCount) summary.missingCostCount += 1;

    const row = {
      poId: econ.poId,
      supplierId: econ.supplierId,
      supplierName: econ.supplierName,
      branchId: econ.branchId,
      status: econ.status,
      orderedValueNgn: econ.orderedValueNgn,
      receivedValueNgn: econ.receivedValueNgn,
      receivedBasis: econ.receivedBasis,
      supplierPaidNgn: econ.supplierPaidNgn,
      paidBasis: 'purchase_orders.supplier_paid_ngn',
      currentApNgn: econ.currentApNgn,
      apPaidNgn: econ.apPaidNgn,
      expectedApNgn: econ.expectedApNgn,
      apDifferenceNgn: econ.apDifferenceNgn,
      paidNotReceivedNgn: econ.paidNotReceivedNgn,
      receivedNotPaidNgn: econ.receivedNotPaidNgn,
      orderedNotReceivedNgn: econ.orderedNotReceivedNgn,
      estimated: econ.estimated,
      flags: {
        overpaid: isOverpaid,
        payableWithoutGrn,
        grnWithoutPayable,
        missingCost: econ.missingCostCount > 0,
      },
    };
    poRows.push(row);

    if (!byBranchMap.has(econ.branchId)) {
      byBranchMap.set(econ.branchId, {
        branchId: econ.branchId,
        poCount: 0,
        orderedValueNgn: 0,
        receivedValueNgn: 0,
        supplierPaidNgn: 0,
        currentApNgn: 0,
        expectedApNgn: 0,
      });
    }
    const bb = byBranchMap.get(econ.branchId);
    bb.poCount += 1;
    bb.orderedValueNgn += econ.orderedValueNgn;
    bb.receivedValueNgn += econ.receivedValueNgn;
    bb.supplierPaidNgn += econ.supplierPaidNgn;
    bb.currentApNgn += econ.currentApNgn;
    bb.expectedApNgn += econ.expectedApNgn;

    const sk = econ.supplierId || econ.supplierName || 'unknown';
    if (!bySupplierMap.has(sk)) {
      bySupplierMap.set(sk, {
        supplierId: econ.supplierId,
        supplierName: econ.supplierName,
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
    bs.orderedValueNgn += econ.orderedValueNgn;
    bs.receivedValueNgn += econ.receivedValueNgn;
    bs.supplierPaidNgn += econ.supplierPaidNgn;
    bs.currentApNgn += econ.currentApNgn;
    bs.expectedApNgn += econ.expectedApNgn;
    bs.paidNotReceivedNgn += econ.paidNotReceivedNgn;

    if (isOverpaid && samples.overpaidSuppliers.length < sampleCap) {
      samples.overpaidSuppliers.push({
        poId,
        supplierName: econ.supplierName,
        paidNotReceivedNgn: econ.paidNotReceivedNgn,
        receivedValueNgn: econ.receivedValueNgn,
        supplierPaidNgn: econ.supplierPaidNgn,
      });
    }
    if (payableWithoutGrn && samples.payableWithoutGrn.length < sampleCap) {
      samples.payableWithoutGrn.push({
        poId,
        supplierName: econ.supplierName,
        currentApNgn: econ.currentApNgn,
        receivedValueNgn: econ.receivedValueNgn,
      });
    }
    if (grnWithoutPayable && samples.grnWithoutPayable.length < sampleCap) {
      samples.grnWithoutPayable.push({
        poId,
        supplierName: econ.supplierName,
        receivedValueNgn: econ.receivedValueNgn,
        expectedApNgn: econ.expectedApNgn,
      });
    }
    if (econ.missingCostCount && samples.missingCost.length < sampleCap) {
      samples.missingCost.push({
        poId,
        supplierName: econ.supplierName,
        issueCount: econ.missingCostCount,
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
    apBasis,
    lastRebuild,
    summary,
    byBranch: [...byBranchMap.values()],
    bySupplier: [...bySupplierMap.values()].sort((a, b) => b.expectedApNgn - a.expectedApNgn),
    poRows: poRows.slice(0, 200),
    samples,
    notes,
    poRowCount: poRows.length,
    flags: {
      apReceivedBasisEnabled: flags.apReceivedBasisEnabled,
      apReceivedBasisRebuildEnabled: flags.apReceivedBasisRebuildEnabled,
    },
  };
}

function emptyReport(branchScope, period, notes, apBasis, lastRebuild) {
  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Supplier, GRN, Payables & Inventory Diagnostics',
    disclaimer: 'Read-only management diagnostic. No AP values were changed.',
    generatedAtISO: new Date().toISOString(),
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    apBasis,
    lastRebuild,
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
    apBasis: r.apBasis,
    lastRebuild: r.lastRebuild,
    ...r.summary,
    apDifferenceNgn: r.summary.apDifferenceNgn,
  };
}
