import {
  listCustomers,
  listQuotations,
  listLedgerEntries,
  listSuppliers,
  listTransportAgents,
  listProducts,
  listPurchaseOrders,
  listCoilLots,
  listCoilControlEvents,
  listStockMovements,
  getWipByProduct,
  listDeliveries,
  listSalesReceipts,
  enrichSalesReceiptRowsWithCashFromLedger,
  listCuttingLists,
  listRefunds,
  listTreasuryAccounts,
  listTreasuryMovements,
  listExpenses,
  listPaymentRequests,
  listAccountsPayable,
  listPoTransportAwaitingTreasury,
  listPoTransportMissingLink,
  listPoTransportCatchUp,
  listOrphanHaulageTreasuryMovements,
  listBankReconciliation,
  listCoilRequests,
  listYardCoils,
  listProcurementCatalog,
  getJsonBlob,
  listAdvanceInEvents,
  listProductionJobs,
  listProductionCompletionAdjustments,
  listProductionJobAccessoryUsage,
  listProductionJobStoneFlatsheetUsage,
  computeProductionMetricsRollup,
  computeOperationsInventoryAttention,
  emptyOperationsInventoryAttention,
} from './readModel.js';
import { listPriceListItems } from './pricingOps.js';
import { listMaterialPricingRowsForSnapshot } from './materialWorkbookQuotationPrice.js';
import { listInTransitLoads } from './inTransitOps.js';
import { listProductionConversionChecks, listProductionJobCoils } from './productionTraceability.js';
import { computePoolSummary, listMaterialIncidents } from './materialIncidentOps.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { listStaffRecoveriesDueForCashier } from './staffRecoveryCashierOps.js';
import { listStaffRepayableObligationsForCashier, staffObligationTablesReady } from './staffObligationOps.js';
import { listRegisterSettlementsAwaitingPayment } from './accountingRegisterSettlementOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { userHasPermission } from './auth.js';
import { buildExpenseCategoryMonthlyAlert, buildExpenseCategoryBranchCoachAlert } from './expenseCategoryReportOps.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import {
  canReadCoilAndMovements,
  canReadFinanceDomain,
  canReadLedgerRelated,
  canReadOperationsDomain,
  canReadProcurementDomain,
  canReadPurchaseOrdersList,
  canReadProductionSnapshot,
  canReadProductsCatalog,
  canReadSalesDomain,
  canReadTreasuryMovements,
  canSeeCoilRequests,
  canSeePaymentRequests,
  canSeeRefundsList,
  canReadYardRegister,
  canListTreasuryAccounts,
} from './workspaceAccess.js';
import {
  listMachines,
  listMaintenancePlans,
  listMaintenanceWorkOrders,
  listMaterialRequests,
} from './workItems.js';

const MAX_PROD_ROWS = Math.min(
  5000,
  Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || 2000)
);
const MAX_LEDGER_ROWS = Math.min(
  10_000,
  Math.max(500, Number(process.env.ZAREWA_BOOTSTRAP_MAX_LEDGER_ROWS) || 3000)
);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
function domainFlags(db, opts = {}) {
  const user = opts.user ?? null;
  const branchScope = opts.branchScope ?? 'ALL';
  const ledgerOk = canReadLedgerRelated(user);
  const ledgerRows = ledgerOk ? listLedgerEntries(db, branchScope, { limit: MAX_LEDGER_ROWS }) : [];
  return {
    user,
    branchScope,
    salesOk: canReadSalesDomain(user),
    procOk: canReadProcurementDomain(user),
    poListOk: canReadPurchaseOrdersList(user),
    opsOk: canReadOperationsDomain(user),
    finOk: canReadFinanceDomain(user),
    treasuryMovementsOk: canReadTreasuryMovements(user),
    expensesSnapshotOk: canReadFinanceDomain(user) || userHasPermission(user, 'expenses.create'),
    ledgerOk,
    ledgerRows,
    treasuryOk: canListTreasuryAccounts(user),
    refundsOk: canSeeRefundsList(user),
    payReqOk: canSeePaymentRequests(user),
    coilReqOk: canSeeCoilRequests(user),
    productsOk: canReadProductsCatalog(user),
    prodRollupOk: canReadProductionSnapshot(user),
    coilMovOk: canReadCoilAndMovements(user),
    yardOk: canReadYardRegister(user),
    productionOk: canReadProductionSnapshot(user) && canReadOperationsDomain(user),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildSalesDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, salesOk, ledgerOk, ledgerRows, refundsOk } = f;
  const availableStock = salesOk ? getJsonBlob(db, 'sales_available_stock') ?? [] : [];
  const customerDashboard = salesOk
    ? getJsonBlob(db, 'customer_dashboard') ?? { orders: [], interactions: [], salesTrendByCustomer: {} }
    : { orders: [], interactions: [], salesTrendByCustomer: {} };
  return {
    ok: true,
    domain: 'sales',
    customers: salesOk ? listCustomers(db, branchScope) : [],
    quotations: salesOk ? listQuotations(db, branchScope) : [],
    receipts: salesOk
      ? enrichSalesReceiptRowsWithCashFromLedger(listSalesReceipts(db, branchScope), ledgerRows)
      : [],
    refunds: refundsOk ? listRefunds(db, branchScope) : [],
    cuttingLists: salesOk ? listCuttingLists(db, branchScope) : [],
    priceListItems: salesOk ? listPriceListItems(db) : [],
    materialPricingRows: salesOk ? listMaterialPricingRowsForSnapshot(db, branchScope) : [],
    salesAvailableStock: availableStock,
    customerDashboard,
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    ledgerEntries: ledgerOk ? ledgerRows : [],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildOperationsDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, opsOk, prodRollupOk, coilMovOk, yardOk, productionOk, user } = f;
  const productionMetrics = productionOk
    ? computeProductionMetricsRollup(db, branchScope)
    : {
        jobCount: 0,
        byStatus: {},
        totalPlannedMeters: 0,
        totalActualMeters: 0,
        completedActualMeters: 0,
      };
  const operationsInventoryAttention = productionOk
    ? computeOperationsInventoryAttention(db, branchScope)
    : emptyOperationsInventoryAttention();
  const workScope = {
    viewAll: branchScope === 'ALL',
    branchId:
      branchScope === 'ALL' ? DEFAULT_BRANCH_ID : String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
  };
  return {
    ok: true,
    domain: 'operations',
    cuttingLists: opsOk ? listCuttingLists(db, branchScope) : [],
    productionJobs: prodRollupOk ? listProductionJobs(db, branchScope) : [],
    productionJobAccessoryUsage: prodRollupOk ? listProductionJobAccessoryUsage(db, branchScope) : [],
    productionJobStoneFlatsheetUsage: prodRollupOk ? listProductionJobStoneFlatsheetUsage(db, branchScope) : [],
    productionMetrics,
    productionJobCoils: prodRollupOk ? listProductionJobCoils(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionConversionChecks: prodRollupOk
      ? listProductionConversionChecks(db, branchScope, { limit: MAX_PROD_ROWS })
      : [],
    productionCompletionAdjustments: prodRollupOk
      ? listProductionCompletionAdjustments(db, branchScope)
      : [],
    operationsInventoryAttention,
    deliveries: opsOk ? listDeliveries(db, branchScope) : [],
    coilLots: coilMovOk ? listCoilLots(db, branchScope) : [],
    coilControlEvents: coilMovOk ? listCoilControlEvents(db, branchScope) : [],
    materialIncidents: coilMovOk ? listMaterialIncidents(db, branchScope) : [],
    materialPoolSummary: coilMovOk ? computePoolSummary(db, branchScope) : null,
    movements: coilMovOk ? listStockMovements(db, branchScope) : [],
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    yardCoilRegister: yardOk ? listYardCoils(db, branchScope) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    coilRequests: f.coilReqOk ? listCoilRequests(db, branchScope) : [],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildFinanceDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, finOk, treasuryMovementsOk, ledgerOk, ledgerRows, treasuryOk, refundsOk, payReqOk, procOk } =
    f;
  const expensesSnapshotOk = f.expensesSnapshotOk;
  const user = opts.user ?? null;
  const canSeeCategoryAlert =
    user &&
    (userHasPermission(user, 'finance.approve') ||
      userHasPermission(user, 'finance.post') ||
      userHasPermission(user, 'reports.view'));
  const orgLimits = user ? getOrgGovernanceLimits(db) : null;
  return {
    ok: true,
    domain: 'finance',
    ledgerEntries: ledgerOk ? ledgerRows : [],
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
    treasuryMovements: treasuryMovementsOk ? listTreasuryMovements(db, branchScope) : [],
    expenses: expensesSnapshotOk ? listExpenses(db, branchScope) : [],
    paymentRequests: payReqOk ? listPaymentRequests(db, branchScope) : [],
    accountsPayable: finOk ? listAccountsPayable(db, branchScope) : [],
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope) : [],
    refunds: refundsOk ? listRefunds(db, branchScope) : [],
    poTransportAwaitingTreasury:
      finOk || procOk ? listPoTransportAwaitingTreasury(db, branchScope) : [],
    poTransportCatchUp: procOk || finOk ? listPoTransportCatchUp(db, branchScope) : [],
    orphanHaulageTreasuryMovements:
      finOk || procOk ? listOrphanHaulageTreasuryMovements(db, branchScope) : [],
    staffRecoveriesDue:
      finOk && recoverySchedulesTableReady(db)
        ? listStaffRecoveriesDueForCashier(db, branchScope)
        : [],
    staffObligationsDue:
      finOk && staffObligationTablesReady(db)
        ? listStaffRepayableObligationsForCashier(db, branchScope)
        : [],
    registerSettlementsAwaitingPayment:
      payReqOk || userHasPermission(user, 'finance.pay')
        ? listRegisterSettlementsAwaitingPayment(db, branchScope)
        : [],
    expenseCategoryMonthlyAlert:
      canSeeCategoryAlert && finOk
        ? (() => {
            try {
              return buildExpenseCategoryMonthlyAlert(db, { branchScope, orgLimits }).summary;
            } catch (e) {
              console.error('[domainBootstrap] expenseCategoryMonthlyAlert', e);
              return null;
            }
          })()
        : null,
    expenseCategoryBranchCoachAlert:
      finOk &&
      user &&
      branchScope !== 'ALL' &&
      String(user.roleKey || '').toLowerCase() === 'branch_manager'
        ? (() => {
            try {
              return buildExpenseCategoryBranchCoachAlert(db, { branchScope, orgLimits });
            } catch (e) {
              console.error('[domainBootstrap] expenseCategoryBranchCoachAlert', e);
              return null;
            }
          })()
        : null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildProcurementDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, procOk, poListOk, productsOk, finOk, coilMovOk } = f;
  return {
    ok: true,
    domain: 'procurement',
    suppliers: procOk ? listSuppliers(db, branchScope) : [],
    transportAgents: procOk ? listTransportAgents(db, branchScope) : [],
    purchaseOrders: poListOk ? listPurchaseOrders(db, branchScope) : [],
    procurementCatalog: procOk ? listProcurementCatalog(db) : [],
    products: productsOk ? listProducts(db, branchScope) : [],
    coilLots: coilMovOk ? listCoilLots(db, branchScope) : [],
    movements: coilMovOk ? listStockMovements(db, branchScope) : [],
    inTransitLoads: f.user ? listInTransitLoads(db, branchScope) : [],
    poTransportAwaitingTreasury:
      finOk || procOk ? listPoTransportAwaitingTreasury(db, branchScope) : [],
    poTransportMissingLink: procOk ? listPoTransportMissingLink(db, branchScope) : [],
    poTransportCatchUp: procOk || finOk ? listPoTransportCatchUp(db, branchScope) : [],
    orphanHaulageTreasuryMovements:
      finOk || procOk ? listOrphanHaulageTreasuryMovements(db, branchScope) : [],
  };
}

/** @type {Record<string, (db: import('better-sqlite3').Database, opts: object) => object>} */
export const DOMAIN_SNAPSHOT_BUILDERS = {
  sales: buildSalesDomainSnapshot,
  operations: buildOperationsDomainSnapshot,
  finance: buildFinanceDomainSnapshot,
  procurement: buildProcurementDomainSnapshot,
};
