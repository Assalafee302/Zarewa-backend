/**
 * AP2c — supplier advance / prepayment reports (read-only).
 */
import {
  computePoReceivedBasisEconomics,
  listPurchaseOrdersForAp2Scope,
  parsePeriodKey,
  tableExists,
} from './ap2ReceivedBasisOps.js';
import { classifyPoSettlement } from './ap2SettlementClassification.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { describeSupplierAdvanceGlCapability } from './ap2SupplierAdvanceGl.js';

function daysSince(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function lastSupplierPaymentDate(db, poId) {
  if (!tableExists(db, 'treasury_movements')) return null;
  const row = db
    .prepare(
      `SELECT MAX(substr(COALESCE(occurred_at_iso, date_iso, ''),1,10)) AS d
       FROM treasury_movements
       WHERE source_kind = 'PURCHASE_ORDER' AND source_id = ?
         AND UPPER(TRIM(COALESCE(type,''))) IN ('SUPPLIER_PAYMENT','PO_SUPPLIER_PAYMENT')`
    )
    .get(poId);
  return row?.d || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; period?: string | null; supplierId?: string | null; status?: string | null }} [opts]
 */
export function buildSupplierAdvanceReport(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const period = opts.period ? parsePeriodKey(opts.period) : null;
  const flags = readFinanceFeatureFlags();
  const includeGlCapability = opts.includeGlCapability !== false;

  const emptyReport = {
    ok: true,
    status: 'diagnostics_only',
    label: 'Supplier advance & prepayment report',
    disclaimer: 'Management diagnostic. No GL posted unless SUPPLIER_ADVANCE_ACCOUNTING_ENABLED=1.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    generatedAtISO: new Date().toISOString(),
    flags: {
      supplierAdvanceAccountingEnabled: flags.supplierAdvanceAccountingEnabled,
      inventoryValuationReportsEnabled: flags.inventoryValuationReportsEnabled,
      apGlAlignmentDiagnosticsEnabled: flags.apGlAlignmentDiagnosticsEnabled,
    },
    supplierAdvanceGl: includeGlCapability
      ? describeSupplierAdvanceGlCapability(db)
      : { postingEnabled: flags.supplierAdvanceAccountingEnabled, accountConfigured: false },
    summary: {
      totalSupplierAdvanceNgn: 0,
      totalPayableOutstandingNgn: 0,
      totalReceivedNotPaidNgn: 0,
      totalOrderedNotReceivedNgn: 0,
      paidNotReceivedCount: 0,
      advanceAppliedCount: 0,
      supplierWithAdvanceCount: 0,
    },
    supplierAdvanceSummary: [],
    paidNotReceived: [],
    advanceApplied: [],
    supplierExposure: [],
    notes: [],
  };

  if (!tableExists(db, 'purchase_orders')) {
    return emptyReport;
  }

  const lineStmt = tableExists(db, 'purchase_order_lines')
    ? db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`)
    : null;
  const apStmt = tableExists(db, 'accounts_payable')
    ? db.prepare(`SELECT ap_id, amount_ngn, paid_ngn FROM accounts_payable WHERE po_ref = ? ORDER BY ap_id LIMIT 1`)
    : null;

  const advanceSummary = [];
  const paidNotReceived = [];
  const advanceApplied = [];
  const bySupplier = new Map();

  const summary = {
    totalSupplierAdvanceNgn: 0,
    totalPayableOutstandingNgn: 0,
    totalReceivedNotPaidNgn: 0,
    totalOrderedNotReceivedNgn: 0,
    paidNotReceivedCount: 0,
    advanceAppliedCount: 0,
    supplierWithAdvanceCount: 0,
  };

  for (const po of listPurchaseOrdersForAp2Scope(db, opts)) {
    const poId = po.po_id;
    const lines = lineStmt ? lineStmt.all(poId) : [];
    const apRow = apStmt?.get(poId) ?? null;
    const econ = computePoReceivedBasisEconomics(db, po, lines, { apRow });
    const cls = classifyPoSettlement(econ);
    const payDate = lastSupplierPaymentDate(db, poId) || String(po.order_date_iso || '').slice(0, 10);
    const ageDays = daysSince(payDate);

    const row = {
      poId,
      supplierId: econ.supplierId,
      supplierName: econ.supplierName,
      branchId: econ.branchId,
      status: po.status,
      classification: cls.classification,
      labels: cls.labels,
      receivedValueNgn: econ.receivedValueNgn,
      supplierPaidNgn: econ.supplierPaidNgn,
      payableOutstandingNgn: cls.payableOutstandingNgn,
      supplierAdvanceNgn: cls.supplierAdvanceNgn,
      orderedNotReceivedNgn: econ.orderedNotReceivedNgn,
      receivedNotPaidNgn: econ.receivedNotPaidNgn,
      lastPaymentDateISO: payDate || null,
      ageDays,
      estimated: econ.estimated,
    };

    if (cls.supplierAdvanceNgn > 0) {
      summary.totalSupplierAdvanceNgn += cls.supplierAdvanceNgn;
      advanceSummary.push(row);
      const sk = econ.supplierId || econ.supplierName || poId;
      if (!bySupplier.has(sk)) {
        bySupplier.set(sk, {
          supplierId: econ.supplierId,
          supplierName: econ.supplierName,
          advanceNgn: 0,
          payableOutstandingNgn: 0,
          poCount: 0,
        });
      }
      const bs = bySupplier.get(sk);
      bs.advanceNgn += cls.supplierAdvanceNgn;
      bs.payableOutstandingNgn += cls.payableOutstandingNgn;
      bs.poCount += 1;
    }

    summary.totalPayableOutstandingNgn += cls.payableOutstandingNgn;
    summary.totalReceivedNotPaidNgn += econ.receivedNotPaidNgn;
    summary.totalOrderedNotReceivedNgn += econ.orderedNotReceivedNgn;

    if (econ.receivedValueNgn === 0 && econ.supplierPaidNgn > 0) {
      summary.paidNotReceivedCount += 1;
      paidNotReceived.push(row);
    }

    if (econ.supplierPaidNgn > 0 && econ.receivedValueNgn > 0 && cls.supplierAdvanceNgn > 0) {
      const appliedNgn = Math.min(cls.supplierAdvanceNgn, econ.receivedValueNgn);
      summary.advanceAppliedCount += 1;
      advanceApplied.push({
        ...row,
        advanceAppliedNgn: appliedNgn,
        remainingAdvanceNgn: cls.supplierAdvanceNgn,
      });
    }
  }

  summary.supplierWithAdvanceCount = bySupplier.size;

  const exposureBySupplier = [...bySupplier.values()]
    .sort((a, b) => b.advanceNgn - a.advanceNgn)
    .slice(0, 50);

  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Supplier advance & prepayment report',
    disclaimer: 'Management diagnostic. No GL posted unless SUPPLIER_ADVANCE_ACCOUNTING_ENABLED=1.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    generatedAtISO: new Date().toISOString(),
    flags: {
      supplierAdvanceAccountingEnabled: flags.supplierAdvanceAccountingEnabled,
      inventoryValuationReportsEnabled: flags.inventoryValuationReportsEnabled,
      apGlAlignmentDiagnosticsEnabled: flags.apGlAlignmentDiagnosticsEnabled,
    },
    supplierAdvanceGl: includeGlCapability
      ? describeSupplierAdvanceGlCapability(db)
      : { postingEnabled: flags.supplierAdvanceAccountingEnabled, accountConfigured: false },
    summary,
    supplierAdvanceSummary: advanceSummary.slice(0, 200),
    paidNotReceived: paidNotReceived.slice(0, 100),
    advanceApplied: advanceApplied.slice(0, 100),
    supplierExposure: exposureBySupplier,
    notes: [
      'Supplier payment before GRN is prepayment, not normal AP settlement.',
      'Payable outstanding is based on received goods minus supplier payments.',
      'GL posting for supplier advances remains off unless explicitly enabled.',
    ],
  };
}

/** Compact strip for executive / trial API. */
export function buildSupplierAdvanceTrialSummary(db, branchScope = 'ALL') {
  const r = buildSupplierAdvanceReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
  });
  return {
    available: true,
    totalSupplierAdvanceNgn: r.summary.totalSupplierAdvanceNgn,
    paidNotReceivedCount: r.summary.paidNotReceivedCount,
    supplierWithAdvanceCount: r.summary.supplierWithAdvanceCount,
    totalPayableOutstandingNgn: r.summary.totalPayableOutstandingNgn,
    totalReceivedNotPaidNgn: r.summary.totalReceivedNotPaidNgn,
  };
}
