/**
 * MD customer intelligence — ranked customers with health segments.
 */
import { topCustomersByNetPayments } from '../shared/lib/businessIntelligence.js';
import { topCustomersByDebt } from './execDashboardOps.js';
import {
  listLedgerEntries,
  listProductionJobs,
  listQuotations,
  listRefunds,
  listSalesReceipts,
} from './readModel.js';

function segmentCustomer(row, championCutoffNgn) {
  const debt = Number(row.debtNgn) || 0;
  const paid = Number(row.netCollectedNgn) || 0;
  const band = String(row.primaryAgingBand || '').trim();
  const refunds = Number(row.refundCount) || 0;

  if (debt > 0 && (band === '61-90' || band === '90+' || band === '31-60')) {
    return debt >= 200_000 || band === '90+' ? 'risk' : 'watch';
  }
  if (paid > 0 && paid >= championCutoffNgn && refunds === 0 && debt <= paid * 0.15) {
    return 'champion';
  }
  if (paid > 0) return 'core';
  if (debt > 0) return 'watch';
  return 'inactive';
}

function segmentLabel(segment) {
  if (segment === 'champion') return 'Champion';
  if (segment === 'core') return 'Core';
  if (segment === 'watch') return 'Watch';
  if (segment === 'risk') return 'At risk';
  return 'Inactive';
}

export { segmentCustomer, segmentLabel };

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope: string; startISO: string; endISO: string; limit?: number }} opts
 */
export function buildMdCustomerIntelPack(db, opts) {
  const branchScope = String(opts?.branchScope || 'ALL').trim() || 'ALL';
  const startISO = String(opts?.startISO || '').slice(0, 10);
  const endISO = String(opts?.endISO || '').slice(0, 10);
  const limit = Math.min(Math.max(Number(opts?.limit) || 40, 5), 100);

  const receipts = listSalesReceipts(db, branchScope);
  const refunds = listRefunds(db, branchScope);
  const paidRows = topCustomersByNetPayments(receipts, refunds, startISO, endISO, limit * 2);

  const debtRows = topCustomersByDebt(db, branchScope, endISO, {
    quotations: listQuotations(db, branchScope),
    ledgerEntries: listLedgerEntries(db, branchScope),
    productionJobs: listProductionJobs(db, branchScope),
  });

  const debtById = new Map(debtRows.map((r) => [String(r.customerID || '').trim(), r]));
  const merged = new Map();

  for (const p of paidRows) {
    const cid = String(p.customerID || '').trim();
    if (!cid) continue;
    const debt = debtById.get(cid);
    merged.set(cid, {
      customerId: cid,
      customerName: String(p.customerName || cid).trim(),
      branchId: debt?.branchId || '',
      netCollectedNgn: Math.round(Number(p.netCollectedNgn) || 0),
      paymentsNgn: Math.round(Number(p.paymentsNgn) || 0),
      refundsNgn: Math.round(Number(p.refundsNgn) || 0),
      receiptCount: Number(p.receiptCount) || 0,
      refundCount: Number(p.refundCount) || 0,
      debtNgn: Math.round(Number(debt?.debtNgn) || 0),
      quotationCount: Number(debt?.quotationCount) || 0,
      primaryAgingBand: debt?.primaryAgingBand || '0-30',
      debtRiskLabel: debt?.debtRiskLabel || '',
    });
  }

  for (const d of debtRows) {
    const cid = String(d.customerID || '').trim();
    if (!cid || merged.has(cid)) continue;
    merged.set(cid, {
      customerId: cid,
      customerName: d.customerName,
      branchId: '',
      netCollectedNgn: 0,
      paymentsNgn: 0,
      refundsNgn: 0,
      receiptCount: 0,
      refundCount: 0,
      debtNgn: Math.round(Number(d.debtNgn) || 0),
      quotationCount: Number(d.quotationCount) || 0,
      primaryAgingBand: d.primaryAgingBand || '0-30',
      debtRiskLabel: d.debtRiskLabel || '',
    });
  }

  const rows = [...merged.values()].sort(
    (a, b) => b.netCollectedNgn - a.netCollectedNgn || b.debtNgn - a.debtNgn
  );
  const topPaid = rows[0]?.netCollectedNgn || 0;
  const championCutoff = topPaid > 0 ? Math.max(topPaid * 0.35, 500_000) : Infinity;

  const customers = rows.slice(0, limit).map((r) => {
    const segment = segmentCustomer(r, championCutoff);
    return {
      ...r,
      segment,
      segmentLabel: segmentLabel(segment),
    };
  });

  const summary = {
    champion: customers.filter((c) => c.segment === 'champion').length,
    core: customers.filter((c) => c.segment === 'core').length,
    watch: customers.filter((c) => c.segment === 'watch').length,
    risk: customers.filter((c) => c.segment === 'risk').length,
    total: customers.length,
  };

  const champion =
    customers.find((c) => c.segment === 'champion') ||
    (customers[0]?.netCollectedNgn > 0 ? customers[0] : null);

  return {
    ok: true,
    branchScope,
    period: { startISO, endISO },
    summary,
    champion,
    customers,
  };
}
