import {
  buildPurchaseReport,
  buildPurchaseReportLegacy,
  PURCHASE_REGISTER_SUPPLIER_PAYMENT_TYPES,
} from '../../shared/lib/purchaseReportCore.js';
import { getBranch } from '../branches.js';
import { reportListOpts, reportPurchaseOrderListOpts, reportTreasuryListOpts } from '../listQueryOpts.js';
import { listMasterData } from '../masterData.js';
import {
  listCoilLots,
  listGrnStockMovementsForBranch,
  listProducts,
  listPurchaseOrders,
  listStockMovementsForBranchPeriod,
  listTreasuryMovements,
} from '../readModel.js';

/**
 * Read-only inputs for the purchase register (v2). Supplier payments are loaded from the beginning of time
 * through `endDate` so supplier positions can be stated as at period end.
 * @param {object} db
 * @param {{ branchScope: string, startDate: string, endDate: string }} p
 */
export function loadPurchaseRegisterSource(db, { branchScope, startDate, endDate }) {
  const branchRow = branchScope && branchScope !== 'ALL' ? getBranch(db, branchScope) : null;
  return {
    purchaseOrders: listPurchaseOrders(db, branchScope, reportPurchaseOrderListOpts()),
    coilLots: listCoilLots(db, branchScope),
    stockMovements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
    grnMovements: listGrnStockMovementsForBranch(db, branchScope),
    supplierPaymentMovements: listTreasuryMovements(db, branchScope, {
      ...reportListOpts(),
      toISO: endDate,
      types: PURCHASE_REGISTER_SUPPLIER_PAYMENT_TYPES,
    }),
    products: listProducts(db, branchScope, reportListOpts()),
    masterData: listMasterData(db),
    branch: branchRow
      ? { id: branchRow.id, name: branchRow.name || branchRow.id }
      : { id: String(branchScope || 'ALL'), name: branchScope === 'ALL' ? 'All branches' : String(branchScope || '') },
    startDate,
    endDate,
  };
}

/** Pre-Phase-1 inputs (treasury from `startDate` only). Kept for `?legacy=1`. */
export function loadPurchaseRegisterSourceLegacy(db, { branchScope, startDate, endDate }) {
  return {
    purchaseOrders: listPurchaseOrders(db, branchScope, reportPurchaseOrderListOpts()),
    coilLots: listCoilLots(db, branchScope),
    stockMovements: listStockMovementsForBranchPeriod(db, branchScope, startDate, endDate),
    treasuryMovements: listTreasuryMovements(db, branchScope, reportTreasuryListOpts(startDate)),
    products: listProducts(db, branchScope, reportListOpts()),
    masterData: listMasterData(db),
    startDate,
    endDate,
  };
}

/**
 * @param {object} db
 * @param {{ branchScope: string, startDate: string, endDate: string, legacy?: boolean }} p
 */
export function buildPurchaseRegisterReport(db, p) {
  if (p.legacy) return buildPurchaseReportLegacy(loadPurchaseRegisterSourceLegacy(db, p));
  return buildPurchaseReport(loadPurchaseRegisterSource(db, p));
}
