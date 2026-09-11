import {
  listCustomers,
  listQuotations,
  listLedgerEntries,
  listSuppliers,
  listTransportAgents,
  listAssociatedStaff,
  listProducts,
  listPurchaseOrders,
  listCoilLots,
  listCoilControlEvents,
  listStockMovements,
  getWipByProduct,
  listDeliveries,
  listSalesReceiptsForDesk,
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
import { getPricingPolicyBundle } from './pricingPolicyOps.js';
import { listInTransitLoads } from './inTransitOps.js';
import { listProductionConversionChecks, repairProductionJobCoilIntegrity } from './productionTraceability.js';
import { computePoolSummary, listMaterialIncidents } from './materialIncidentOps.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { listStaffRecoveriesDueForCashier } from './staffRecoveryCashierOps.js';
import {
  partnerWalletEnabled,
} from './finance/partnerWalletCredit.js';
import { listStaffRepayableObligationsForCashier, staffObligationTablesReady } from './staffObligationOps.js';
import { listRegisterSettlementsAwaitingPayment } from './accountingRegisterSettlementOps.js';
import { listFixedAssets } from './accountingPhase2Ops.js';
import { userMayViewAccountingSubledger } from './financeDeskAccess.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { userHasPermission } from './auth.js';
import { buildExpenseCategoryMonthlyAlert, buildExpenseCategoryBranchCoachAlert } from './expenseCategoryReportOps.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { listRefundCreditApplications } from './refundCreditApplyOps.js';
import {
  canReadCoilAndMovements,
  canReadFinanceDomain,
  canReadLedgerRelated,
  canReadMasterData,
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
  EMPTY_MASTER_DATA,
} from './workspaceAccess.js';
import { listMasterData } from './masterData.js';
import {
  listMachines,
  listMaintenancePlans,
  listMaintenanceWorkOrders,
  listMaterialRequests,
} from './workItems.js';
import {
  financeHistoryListOpts,
  financeRegisterListOpts,
  productionHistoryListOpts,
  receiptsHistoryListOpts,
  salesCustomersListOpts,
} from './listQueryOpts.js';

const MAX_PROD_ROWS = Math.min(
  5000,
  Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || 400)
);
const MAX_LEDGER_ROWS = Math.min(
  10_000,
  Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_LEDGER_ROWS) || 500)
);

/**
 * Permission flags for domain snapshots. Does **not** load ledger rows — callers that need
 * receipts cash enrichment (sales/finance) load ledger themselves.
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
function domainFlags(db, opts = {}) {
  const user = opts.user ?? null;
  const branchScope = opts.branchScope ?? 'ALL';
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
    ledgerOk: canReadLedgerRelated(user),
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

function loadLedgerRows(db, f) {
  return f.ledgerOk ? listLedgerEntries(db, f.branchScope, { limit: MAX_LEDGER_ROWS }) : [];
}

function snapshotRefundCreditApplications(db, f) {
  if (!(f.refundsOk || f.ledgerOk)) return [];
  try {
    return listRefundCreditApplications(db, '', f.branchScope === 'ALL' ? 'ALL' : f.branchScope, financeHistoryListOpts());
  } catch (e) {
    console.error('[domainBootstrap] refundCreditApplications', e);
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildSalesDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, salesOk, ledgerOk, refundsOk, user } = f;
  const ledgerRows = loadLedgerRows(db, f);
  const availableStock = salesOk ? getJsonBlob(db, 'sales_available_stock') ?? [] : [];
  const customerDashboard = salesOk
    ? getJsonBlob(db, 'customer_dashboard') ?? { orders: [], interactions: [], salesTrendByCustomer: {} }
    : { orders: [], interactions: [], salesTrendByCustomer: {} };
  const masterOk = canReadMasterData(user);
  return {
    ok: true,
    domain: 'sales',
    customers: salesOk ? listCustomers(db, branchScope, salesCustomersListOpts()) : [],
    quotations: salesOk
      ? listQuotations(db, branchScope, { ...productionHistoryListOpts(), includeLines: false })
      : [],
    receipts: salesOk
      ? listSalesReceiptsForDesk(db, branchScope, ledgerRows, receiptsHistoryListOpts())
      : [],
    refunds: refundsOk
      ? listRefunds(db, branchScope, { ...financeHistoryListOpts(), includePreviewSnapshot: false })
      : [],
    cuttingLists: salesOk ? listCuttingLists(db, branchScope, productionHistoryListOpts()) : [],
    priceListItems: salesOk ? listPriceListItems(db) : [],
    materialPricingRows: salesOk ? listMaterialPricingRowsForSnapshot(db, branchScope) : [],
    pricingRidgeAddOns: salesOk ? getPricingPolicyBundle(db).ridgeAddOns : [],
    /** Quotation form material type / gauge / colour options (shell may also include this). */
    masterData: masterOk ? listMasterData(db, { branchId: branchScope }) : EMPTY_MASTER_DATA,
    salesAvailableStock: availableStock,
    customerDashboard,
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    ledgerEntries: ledgerOk ? ledgerRows : [],
    refundCreditApplications: snapshotRefundCreditApplications(db, f),
    // Refund payout allocation (transport/install/claiming staff) reads this on the sales desk.
    associatedStaff: salesOk || refundsOk ? listAssociatedStaff(db, branchScope) : [],
    associatedStaffPolicy: {
      enabled: /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0')),
    },
    partnerWalletPolicy: { enabled: partnerWalletEnabled() },
    // Receipt / advance account pickers — keep on sales so cashiers do not wait on finance pack.
    treasuryAccounts: f.treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
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
  const historyOpts = productionHistoryListOpts();
  const productionJobsList = prodRollupOk ? listProductionJobs(db, branchScope, historyOpts) : [];
  const productionJobIds = productionJobsList.map((j) => j.jobID).filter(Boolean);
  const productionJobCoilsList = prodRollupOk
    ? repairProductionJobCoilIntegrity(
        db,
        productionJobsList,
        // Coils only for jobs in this snapshot — avoid full-table production_job_coils scan.
        []
      )
    : [];
  return {
    ok: true,
    domain: 'operations',
    cuttingLists: opsOk ? listCuttingLists(db, branchScope, historyOpts) : [],
    productionJobs: productionJobsList,
    productionJobAccessoryUsage: prodRollupOk
      ? listProductionJobAccessoryUsage(db, branchScope, { jobIds: productionJobIds })
      : [],
    productionJobStoneFlatsheetUsage: prodRollupOk
      ? listProductionJobStoneFlatsheetUsage(db, branchScope, { jobIds: productionJobIds })
      : [],
    productionMetrics,
    productionJobCoils: productionJobCoilsList,
    productionConversionChecks: prodRollupOk
      ? listProductionConversionChecks(db, branchScope, { limit: MAX_PROD_ROWS })
      : [],
    productionCompletionAdjustments: prodRollupOk
      ? listProductionCompletionAdjustments(db, branchScope, historyOpts)
      : [],
    operationsInventoryAttention,
    deliveries: opsOk ? listDeliveries(db, branchScope, historyOpts) : [],
    // Coil register for production selectors — capped; search API covers older lots.
    coilLots: coilMovOk
      ? listCoilLots(db, branchScope, {
          limit: Math.min(2000, Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_COIL_LOTS_LIMIT) || 500)),
        })
      : [],
    coilControlEvents: coilMovOk ? listCoilControlEvents(db, branchScope, historyOpts) : [],
    materialIncidents: coilMovOk ? listMaterialIncidents(db, branchScope) : [],
    materialPoolSummary: coilMovOk ? computePoolSummary(db, branchScope) : null,
    movements: coilMovOk ? listStockMovements(db, branchScope, historyOpts) : [],
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    yardCoilRegister: yardOk ? listYardCoils(db, branchScope, { useDefaultLimit: true }) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    coilRequests: f.coilReqOk ? listCoilRequests(db, branchScope) : [],
  };
}

/**
 * Accounting snapshot fields for finance domain bootstrap.
 * Creditors/debtors registers are expensive (full subledger rebuild) — loaded on demand via
 * `/api/accounting/creditors|debtors` when the Accounting tab opens (see useAccountingSubledger).
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} user
 * @param {'ALL' | string} branchScope
 */
function buildAccountingRegisterSnapshotFields(db, user, branchScope) {
  if (!userMayViewAccountingSubledger(user)) {
    return {
      accountingCreditors: null,
      accountingDebtors: null,
      accountingAssets: null,
    };
  }
  let accountingAssets = null;
  try {
    accountingAssets = listFixedAssets(db, branchScope);
  } catch (e) {
    console.error('[domainBootstrap] accountingAssets', e);
  }
  return { accountingCreditors: null, accountingDebtors: null, accountingAssets };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildFinanceDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const {
    branchScope,
    salesOk,
    finOk,
    treasuryMovementsOk,
    ledgerOk,
    treasuryOk,
    refundsOk,
    payReqOk,
    procOk,
  } = f;
  const ledgerRows = loadLedgerRows(db, f);
  const expensesSnapshotOk = f.expensesSnapshotOk;
  const user = opts.user ?? null;
  const canSeeCategoryAlert =
    user &&
    (userHasPermission(user, 'finance.approve') ||
      userHasPermission(user, 'finance.post') ||
      userHasPermission(user, 'reports.view'));
  const orgLimits = user ? getOrgGovernanceLimits(db) : null;
  const accountingRegisters = buildAccountingRegisterSnapshotFields(db, user, branchScope);
  const registerOpts = financeRegisterListOpts();
  return {
    ok: true,
    domain: 'finance',
    ...accountingRegisters,
    ledgerEntries: ledgerOk ? ledgerRows : [],
    receipts:
      salesOk || finOk || treasuryMovementsOk
        ? listSalesReceiptsForDesk(db, branchScope, ledgerRows, receiptsHistoryListOpts())
        : [],
    cuttingLists:
      salesOk || finOk || treasuryMovementsOk
        ? listCuttingLists(db, branchScope, productionHistoryListOpts())
        : [],
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
    treasuryMovements: treasuryMovementsOk
      ? listTreasuryMovements(db, branchScope, financeHistoryListOpts())
      : [],
    expenses: expensesSnapshotOk ? listExpenses(db, branchScope, financeHistoryListOpts()) : [],
    paymentRequests: payReqOk ? listPaymentRequests(db, branchScope, financeHistoryListOpts()) : [],
    accountsPayable: finOk ? listAccountsPayable(db, branchScope, registerOpts) : [],
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope, registerOpts) : [],
    refunds: refundsOk
      ? listRefunds(db, branchScope, { ...financeHistoryListOpts(), includePreviewSnapshot: false })
      : [],
    refundCreditApplications: snapshotRefundCreditApplications(db, f),
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
    partnerWalletPolicy: { enabled: partnerWalletEnabled() },
    /** Lazy via GET /api/partner-wallets — finance desk fetches when the queue is shown. */
    partnerWalletsDue: [],
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
    associatedStaff: procOk ? listAssociatedStaff(db, branchScope) : [],
    associatedStaffPolicy: {
      enabled: /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0')),
    },
    purchaseOrders: poListOk ? listPurchaseOrders(db, branchScope, { skipSideEffects: true }) : [],
    procurementCatalog: procOk ? listProcurementCatalog(db) : [],
    products: productsOk ? listProducts(db, branchScope) : [],
    coilLots: coilMovOk ? listCoilLots(db, branchScope, { useDefaultLimit: true }) : [],
    movements: coilMovOk ? listStockMovements(db, branchScope, productionHistoryListOpts()) : [],
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
