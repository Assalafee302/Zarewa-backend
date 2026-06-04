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
 */
function listPaymentRequestsMinimal(db, branchScope) {
  const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
  const scopeSql = useScope ? ` AND e.branch_id = ?` : '';
  const scopeArgs = useScope ? [branchScope] : [];
  const rows = db
    .prepare(
      `SELECT pr.request_id, pr.amount_requested_ngn, pr.paid_amount_ngn, pr.approval_status
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE 1=1${scopeSql}`
    )
    .all(...scopeArgs);
  return rows.map((row) => ({
    requestID: row.request_id,
    amountRequestedNgn: row.amount_requested_ngn,
    paidAmountNgn: row.paid_amount_ngn ?? 0,
    approvalStatus: row.approval_status,
  }));
}

/**
 * @param {string} label
 * @param {() => unknown} fn
 * @param {unknown} fallback
 */
function safeSlice(label, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.error(`[business-intelligence] ${label} failed:`, e?.message || e);
    return fallback;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ periodKey?: string; asOfISO?: string }} [opts]
 */
export function loadBusinessIntelligencePack(db, branchScope = 'ALL', opts = {}) {
  const scope = branchScope || 'ALL';

  const paymentRequests = safeSlice(
    'paymentRequests',
    () => {
      try {
        return listPaymentRequests(db, scope);
      } catch {
        return listPaymentRequestsMinimal(db, scope);
      }
    },
    []
  );

  const data = {
    quotations: safeSlice('quotations', () => listQuotations(db, scope), []),
    productionJobs: safeSlice('productionJobs', () => listProductionJobs(db, scope), []),
    cuttingLists: safeSlice('cuttingLists', () => listCuttingLists(db, scope), []),
    receipts: safeSlice('receipts', () => listSalesReceipts(db, scope), []),
    ledgerEntries: safeSlice('ledgerEntries', () => listLedgerEntries(db, scope), []),
    refunds: safeSlice('refunds', () => listRefunds(db, scope), []),
    coilLots: safeSlice('coilLots', () => listCoilLots(db, scope), []),
    products: safeSlice('products', () => listProducts(db, scope), []),
    stockMovements: safeSlice('stockMovements', () => listStockMovements(db, scope), []),
    purchaseOrders: safeSlice('purchaseOrders', () => listPurchaseOrders(db, scope), []),
    expenses: safeSlice('expenses', () => listExpenses(db, scope), []),
    treasuryMovements: safeSlice('treasuryMovements', () => listTreasuryMovements(db, scope), []),
    paymentRequests,
    treasuryAccounts: safeSlice('treasuryAccounts', () => listTreasuryAccounts(db, scope), []),
  };

  return buildBusinessIntelligencePack(data, {
    periodKey: opts.periodKey || 'month',
    asOfISO: opts.asOfISO,
    periodStartISO: opts.periodStartISO,
    periodEndISO: opts.periodEndISO,
    branchScope: scope,
  });
}
