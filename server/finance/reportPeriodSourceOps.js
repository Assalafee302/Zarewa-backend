/**
 * Full-period source rows for Reports print / Excel.
 * Desk bootstrap is recent-N; print must not inherit that cap.
 */
import {
  enrichSalesReceiptRowsWithCashFromLedger,
  listBankReconciliation,
  listCoilLots,
  listExpenses,
  listLedgerEntries,
  listPaymentRequests,
  listProductionJobAccessoryUsage,
  listProductionJobs,
  listProducts,
  listPurchaseOrders,
  listQuotations,
  listRefunds,
  listSalesReceipts,
  listStockMovementsForBranchPeriod,
  listTreasuryMovements,
} from '../readModel.js';
import {
  reportListOpts,
  reportPurchaseOrderListOpts,
  reportQuotationListOpts,
  reportTreasuryListOpts,
} from '../listQueryOpts.js';
import { listRefundCreditApplications } from '../refundCreditApplyOps.js';

/**
 * @param {string} value
 * @returns {string}
 */
function isoDay(value) {
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Treasury types the sales report Accrual section reads over the full history (customer balances). */
export const ACCRUAL_TREASURY_TYPES = [
  'RECEIPT_IN',
  'ADVANCE_IN',
  'RECEIPT_REVERSAL_OUT',
  'ADVANCE_REVERSAL_OUT',
  'REFUND_PAYOUT',
];

/**
 * Split quotation lines off the quotation rows into a light flat list
 * ({ quotationId, category, name, qty }) so the quotations payload stays the same size.
 * @param {object[]} quotations
 */
export function splitQuotationLines(quotations) {
  const quotationLines = [];
  const rows = (quotations || []).map((q) => {
    const { quotationLines: groups, ...rest } = q || {};
    if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
      for (const category of ['products', 'accessories', 'services']) {
        for (const line of groups[category] || []) {
          quotationLines.push({ quotationId: q.id, category, name: line?.name ?? '', qty: line?.qty ?? '' });
        }
      }
    }
    return rest;
  });
  return { quotations: rows, quotationLines };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ startDate?: string, endDate?: string, branchScope?: string }} [opts]
 */
export function loadReportPeriodSource(db, opts = {}) {
  const startDate = isoDay(opts.startDate);
  const endDate = isoDay(opts.endDate);
  if (!startDate || !endDate || startDate > endDate) {
    return { ok: false, error: 'Valid startDate and endDate are required.' };
  }
  const branchScope = opts.branchScope || 'ALL';
  const lists = reportListOpts();
  const ledgerEntries = listLedgerEntries(db, branchScope, lists);
  const { quotations, quotationLines } = splitQuotationLines(
    listQuotations(db, branchScope, { ...reportQuotationListOpts(), includeLines: true })
  );
  const receipts = enrichSalesReceiptRowsWithCashFromLedger(
    listSalesReceipts(db, branchScope, lists),
    ledgerEntries
  );
  return {
    ok: true,
    startDate,
    endDate,
    branchScope,
    receipts,
    refundCreditApplications: listRefundCreditApplications(
      db,
      '',
      branchScope === 'ALL' ? 'ALL' : branchScope,
      lists
    ),
    quotations,
    quotationLines,
    productionJobs: listProductionJobs(db, branchScope, lists),
    refunds: listRefunds(db, branchScope, lists),
    expenses: listExpenses(db, branchScope, lists),
    paymentRequests: listPaymentRequests(db, branchScope, lists),
    treasuryMovements: listTreasuryMovements(db, branchScope, reportTreasuryListOpts(startDate)),
    // Sales report Accrual: customer balances need cash/refund lines from the start, up to period end.
    accrualTreasuryMovements: listTreasuryMovements(db, branchScope, {
      unlimited: true,
      toISO: endDate,
      types: ACCRUAL_TREASURY_TYPES,
    }),
    ledgerEntries,
    purchaseOrders: listPurchaseOrders(db, branchScope, reportPurchaseOrderListOpts()),
    bankReconciliation: listBankReconciliation(db, branchScope, lists),
    accessoryUsage: listProductionJobAccessoryUsage(db, branchScope, lists),
    coilLots: listCoilLots(db, branchScope, lists),
    liveProducts: listProducts(db, branchScope, lists),
    movements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
  };
}
