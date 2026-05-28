/**
 * Load ERP slices and build business intelligence packs for API + Zare.
 */
import { buildBusinessIntelligencePack } from '../shared/lib/businessIntelligence.js';
import {
  listCoilLots,
  listCuttingLists,
  listExpenses,
  listLedgerEntries,
  listPaymentRequests,
  listProductionJobs,
  listProducts,
  listPurchaseOrders,
  listQuotations,
  listRefunds,
  listSalesReceipts,
  listStockMovements,
  listTreasuryAccounts,
  listTreasuryMovements,
} from './readModel.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ periodKey?: string; asOfISO?: string }} [opts]
 */
export function loadBusinessIntelligencePack(db, branchScope = 'ALL', opts = {}) {
  const data = {
    quotations: listQuotations(db, branchScope),
    productionJobs: listProductionJobs(db, branchScope),
    cuttingLists: listCuttingLists(db, branchScope),
    receipts: listSalesReceipts(db, branchScope),
    ledgerEntries: listLedgerEntries(db, branchScope),
    refunds: listRefunds(db, branchScope),
    coilLots: listCoilLots(db, branchScope),
    products: listProducts(db, branchScope),
    stockMovements: listStockMovements(db, branchScope),
    purchaseOrders: listPurchaseOrders(db, branchScope),
    expenses: listExpenses(db, branchScope),
    treasuryMovements: listTreasuryMovements(db, branchScope),
    paymentRequests: listPaymentRequests(db, branchScope),
    treasuryAccounts: listTreasuryAccounts(db, branchScope),
  };

  return buildBusinessIntelligencePack(data, {
    periodKey: opts.periodKey || 'month',
    asOfISO: opts.asOfISO,
    branchScope,
  });
}
