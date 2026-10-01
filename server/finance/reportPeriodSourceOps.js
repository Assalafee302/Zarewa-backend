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

/**
 * @param {string} value
 * @returns {string}
 */
function isoDay(value) {
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
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
    quotations: listQuotations(db, branchScope, reportQuotationListOpts()),
    productionJobs: listProductionJobs(db, branchScope, lists),
    refunds: listRefunds(db, branchScope, lists),
    expenses: listExpenses(db, branchScope, lists),
    paymentRequests: listPaymentRequests(db, branchScope, lists),
    treasuryMovements: listTreasuryMovements(db, branchScope, reportTreasuryListOpts(startDate)),
    ledgerEntries,
    purchaseOrders: listPurchaseOrders(db, branchScope, reportPurchaseOrderListOpts()),
    bankReconciliation: listBankReconciliation(db, branchScope, lists),
    accessoryUsage: listProductionJobAccessoryUsage(db, branchScope, lists),
    coilLots: listCoilLots(db, branchScope, lists),
    liveProducts: listProducts(db, branchScope, lists),
    movements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
  };
}
