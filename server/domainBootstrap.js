import {
  listCustomers,
  listQuotations,
  listLedgerEntries,
  listSuppliers,
  listTransportAgents,
  listAssociatedStaff,
  listProducts,
  listPurchaseOrders,
  listCoilLotsForDesk,
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
import { listPurchasePaymentCashierAcksPending } from './finance/purchasePaymentCashierAckOps.js';
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
  coilDeskListOpts,
  buildBackgroundHydrateMeta,
  deskPageListOpts,
  financeHistoryListOpts,
  financeRegisterListOpts,
  productionHistoryListOpts,
  receiptsHistoryListOpts,
  salesCustomersListOpts,
} from './listQueryOpts.js';

/** Escape hatches for consumed/finished coils omitted from active desk packs. */
const COIL_DESK_RECOVERY = {
  page: '/api/coil-lots',
  search: '/api/coil-lots/search',
  eligibleProduction: '/api/production/eligible-coils',
};

function deskPageLimit() {
  const opts = deskPageListOpts();
  return opts.unlimited ? 0 : Number(opts.limit) || 150;
}

/** Snapshot ledger / conversion checks stay on the same recent-first page budget. */
const MAX_PROD_ROWS = Math.min(
  5000,
  Math.max(50, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || deskPageLimit() || 150)
);
const MAX_LEDGER_ROWS = Math.min(
  10_000,
  Math.max(50, Number(process.env.ZAREWA_BOOTSTRAP_MAX_LEDGER_ROWS) || deskPageLimit() || 150)
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
  const customerOpts = { ...salesCustomersListOpts(), sort: 'recent' };
  const quoteOpts = { ...productionHistoryListOpts(), includeLines: true };
  const receiptOpts = receiptsHistoryListOpts();
  const refundOpts = financeHistoryListOpts();
  const cuttingOpts = productionHistoryListOpts();
  const customers = salesOk ? listCustomers(db, branchScope, customerOpts) : [];
  const quotations = salesOk ? listQuotations(db, branchScope, quoteOpts) : [];
  const receipts = salesOk
    ? listSalesReceiptsForDesk(db, branchScope, ledgerRows, receiptOpts)
    : [];
  const refunds = refundsOk ? listRefunds(db, branchScope, refundOpts) : [];
  const cuttingLists = salesOk ? listCuttingLists(db, branchScope, cuttingOpts) : [];
  const pageSize = deskPageLimit();
  const lim = (optsObj) => (optsObj.unlimited ? 0 : Number(optsObj.limit) || pageSize);
  return {
    ok: true,
    domain: 'sales',
    customers,
    quotations,
    receipts,
    refunds,
    cuttingLists,
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
    bootstrapMeta: {
      deferredDeskArrays: [],
      sort: { customers: 'recent', quotations: 'date_iso_desc', receipts: 'date_iso_desc' },
      listLimitsApplied: {
        customers: lim(customerOpts),
        quotations: lim(quoteOpts),
        receipts: lim(receiptOpts),
        refunds: lim(refundOpts),
        cuttingLists: lim(cuttingOpts),
        ledgerEntries: MAX_LEDGER_ROWS,
      },
      truncated: {
        customers: salesOk && lim(customerOpts) > 0 && customers.length >= lim(customerOpts),
        quotations: salesOk && lim(quoteOpts) > 0 && quotations.length >= lim(quoteOpts),
        receipts: salesOk && lim(receiptOpts) > 0 && receipts.length >= lim(receiptOpts),
        refunds: refundsOk && lim(refundOpts) > 0 && refunds.length >= lim(refundOpts),
        cuttingLists: salesOk && lim(cuttingOpts) > 0 && cuttingLists.length >= lim(cuttingOpts),
        ledgerEntries: ledgerOk && ledgerRows.length >= MAX_LEDGER_ROWS,
      },
      // SPA should keep fetching older pages while the user works — no wait for search.
      backgroundHydrate: buildBackgroundHydrateMeta(
        [
          {
            key: 'customers',
            path: '/api/customers',
            limit: lim(customerOpts),
            loaded: customers.length,
            querySuffix: '&sort=recent',
          },
          {
            key: 'quotations',
            path: '/api/quotations',
            limit: lim(quoteOpts),
            loaded: quotations.length,
          },
          {
            key: 'receipts',
            path: '/api/receipts',
            limit: lim(receiptOpts),
            loaded: receipts.length,
          },
          {
            key: 'refunds',
            path: '/api/refunds',
            limit: lim(refundOpts),
            loaded: refunds.length,
          },
          {
            key: 'cuttingLists',
            path: '/api/cutting-lists',
            limit: lim(cuttingOpts),
            loaded: cuttingLists.length,
          },
          {
            key: 'ledgerEntries',
            path: '/api/ledger',
            limit: MAX_LEDGER_ROWS,
            loaded: ledgerRows.length,
          },
        ],
        { pageSize }
      ),
    },
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
  const coilDesk = coilMovOk
    ? listCoilLotsForDesk(db, branchScope, coilDeskListOpts())
    : { coilLots: [], truncated: false, mode: 'active' };
  const historyLim = historyOpts.unlimited ? 0 : Number(historyOpts.limit) || deskPageLimit();
  const cuttingLists = opsOk ? listCuttingLists(db, branchScope, historyOpts) : [];
  const deliveries = opsOk ? listDeliveries(db, branchScope, historyOpts) : [];
  const movements = coilMovOk ? listStockMovements(db, branchScope, historyOpts) : [];
  const coilControlEvents = coilMovOk ? listCoilControlEvents(db, branchScope, historyOpts) : [];
  const pageSize = deskPageLimit();
  return {
    ok: true,
    domain: 'operations',
    cuttingLists,
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
    deliveries,
    // Complete on-hand register (not recent-N). Production allocate: /api/production/eligible-coils.
    coilLots: coilDesk.coilLots,
    coilControlEvents,
    materialIncidents: coilMovOk ? listMaterialIncidents(db, branchScope) : [],
    materialPoolSummary: coilMovOk ? computePoolSummary(db, branchScope) : null,
    movements,
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    yardCoilRegister: yardOk ? listYardCoils(db, branchScope) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    coilRequests: f.coilReqOk ? listCoilRequests(db, branchScope) : [],
    bootstrapMeta: {
      deferredDeskArrays: [],
      sort: {
        cuttingLists: 'date_iso_desc',
        productionJobs: 'created_at_iso_desc',
        movements: 'at_iso_desc',
      },
      listLimitsApplied: {
        ...(historyLim ? { cuttingLists: historyLim, productionJobs: historyLim, movements: historyLim } : {}),
        ...(coilMovOk ? { coilLots: coilDesk.mode } : {}),
      },
      coilLotsRecovery: coilMovOk ? COIL_DESK_RECOVERY : undefined,
      truncated: {
        ...(opsOk
          ? {
              cuttingLists: historyLim > 0 && cuttingLists.length >= historyLim,
              deliveries: historyLim > 0 && deliveries.length >= historyLim,
            }
          : {}),
        ...(prodRollupOk
          ? {
              productionJobs: historyLim > 0 && productionJobsList.length >= historyLim,
              productionConversionChecks: true,
              productionCompletionAdjustments: historyLim > 0,
            }
          : {}),
        ...(coilMovOk
          ? {
              coilLots: coilDesk.truncated,
              coilControlEvents: historyLim > 0 && coilControlEvents.length >= historyLim,
              movements: historyLim > 0 && movements.length >= historyLim,
            }
          : {}),
        ...(yardOk ? { yardCoilRegister: true } : {}),
      },
      backgroundHydrate: buildBackgroundHydrateMeta(
        [
          {
            key: 'cuttingLists',
            path: '/api/cutting-lists',
            limit: historyLim,
            loaded: cuttingLists.length,
          },
          {
            key: 'productionJobs',
            path: '/api/production-jobs',
            limit: historyLim,
            loaded: productionJobsList.length,
          },
          {
            key: 'movements',
            path: '/api/stock-movements',
            limit: historyLim,
            loaded: movements.length,
          },
        ],
        { pageSize }
      ),
    },
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
  const historyOpts = financeHistoryListOpts();
  const receiptOpts = receiptsHistoryListOpts();
  const cuttingOpts = productionHistoryListOpts();
  const receipts =
    salesOk || finOk || treasuryMovementsOk
      ? listSalesReceiptsForDesk(db, branchScope, ledgerRows, receiptOpts)
      : [];
  const cuttingLists =
    salesOk || finOk || treasuryMovementsOk ? listCuttingLists(db, branchScope, cuttingOpts) : [];
  const treasuryMovements = treasuryMovementsOk
    ? listTreasuryMovements(db, branchScope, historyOpts)
    : [];
  const expenses = expensesSnapshotOk ? listExpenses(db, branchScope, historyOpts) : [];
  const paymentRequests = payReqOk ? listPaymentRequests(db, branchScope, historyOpts) : [];
  const refunds = refundsOk ? listRefunds(db, branchScope, historyOpts) : [];
  const pageSize = deskPageLimit();
  const lim = (o) => (o.unlimited ? 0 : Number(o.limit) || pageSize);
  return {
    ok: true,
    domain: 'finance',
    ...accountingRegisters,
    ledgerEntries: ledgerOk ? ledgerRows : [],
    receipts,
    cuttingLists,
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
    treasuryMovements,
    expenses,
    paymentRequests,
    accountsPayable: finOk ? listAccountsPayable(db, branchScope, registerOpts) : [],
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope, registerOpts) : [],
    refunds,
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
    purchasePaymentCashierAcksPending:
      finOk ||
      userHasPermission(user, 'finance.pay') ||
      userHasPermission(user, 'cashier.receipts.confirm') ||
      userHasPermission(user, 'cashier.desk.view')
        ? listPurchasePaymentCashierAcksPending(db, branchScope)
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
    bootstrapMeta: {
      deferredDeskArrays: [],
      sort: {
        expenses: 'date_iso_desc',
        treasuryMovements: 'posted_at_iso_desc',
        receipts: 'date_iso_desc',
        ledgerEntries: 'at_iso_desc',
      },
      listLimitsApplied: {
        expenses: lim(historyOpts),
        treasuryMovements: lim(historyOpts),
        paymentRequests: lim(historyOpts),
        receipts: lim(receiptOpts),
        refunds: lim(historyOpts),
        ledgerEntries: MAX_LEDGER_ROWS,
      },
      truncated: {
        expenses: expensesSnapshotOk && lim(historyOpts) > 0 && expenses.length >= lim(historyOpts),
        treasuryMovements:
          treasuryMovementsOk && lim(historyOpts) > 0 && treasuryMovements.length >= lim(historyOpts),
        paymentRequests: payReqOk && lim(historyOpts) > 0 && paymentRequests.length >= lim(historyOpts),
        receipts:
          (salesOk || finOk || treasuryMovementsOk) &&
          lim(receiptOpts) > 0 &&
          receipts.length >= lim(receiptOpts),
        refunds: refundsOk && lim(historyOpts) > 0 && refunds.length >= lim(historyOpts),
        ledgerEntries: ledgerOk && ledgerRows.length >= MAX_LEDGER_ROWS,
      },
      backgroundHydrate: buildBackgroundHydrateMeta(
        [
          {
            key: 'expenses',
            path: '/api/expenses',
            limit: lim(historyOpts),
            loaded: expenses.length,
          },
          {
            key: 'receipts',
            path: '/api/receipts',
            limit: lim(receiptOpts),
            loaded: receipts.length,
          },
          {
            key: 'refunds',
            path: '/api/refunds',
            limit: lim(historyOpts),
            loaded: refunds.length,
          },
          {
            key: 'ledgerEntries',
            path: '/api/ledger',
            limit: MAX_LEDGER_ROWS,
            loaded: ledgerRows.length,
          },
          {
            key: 'cuttingLists',
            path: '/api/cutting-lists',
            limit: lim(cuttingOpts),
            loaded: cuttingLists.length,
          },
        ],
        { pageSize }
      ),
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ user?: object | null; branchScope?: 'ALL' | string }} opts
 */
export function buildProcurementDomainSnapshot(db, opts = {}) {
  const f = domainFlags(db, opts);
  const { branchScope, procOk, poListOk, productsOk, finOk, coilMovOk } = f;
  const coilDesk = coilMovOk
    ? listCoilLotsForDesk(db, branchScope, coilDeskListOpts())
    : { coilLots: [], truncated: false, mode: 'active' };
  const historyOpts = productionHistoryListOpts();
  const historyLim = historyOpts.unlimited ? 0 : Number(historyOpts.limit) || deskPageLimit();
  const movements = coilMovOk ? listStockMovements(db, branchScope, historyOpts) : [];
  const purchaseOrders = poListOk
    ? listPurchaseOrders(db, branchScope, { ...deskPageListOpts(), skipSideEffects: true })
    : [];
  const pageSize = deskPageLimit();
  return {
    ok: true,
    domain: 'procurement',
    suppliers: procOk ? listSuppliers(db, branchScope) : [],
    transportAgents: procOk ? listTransportAgents(db, branchScope) : [],
    associatedStaff: procOk ? listAssociatedStaff(db, branchScope) : [],
    associatedStaffPolicy: {
      enabled: /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0')),
    },
    purchaseOrders,
    procurementCatalog: procOk ? listProcurementCatalog(db) : [],
    products: productsOk ? listProducts(db, branchScope) : [],
    coilLots: coilDesk.coilLots,
    movements,
    inTransitLoads: f.user ? listInTransitLoads(db, branchScope) : [],
    poTransportAwaitingTreasury:
      finOk || procOk ? listPoTransportAwaitingTreasury(db, branchScope) : [],
    poTransportMissingLink: procOk ? listPoTransportMissingLink(db, branchScope) : [],
    poTransportCatchUp: procOk || finOk ? listPoTransportCatchUp(db, branchScope) : [],
    orphanHaulageTreasuryMovements:
      finOk || procOk ? listOrphanHaulageTreasuryMovements(db, branchScope) : [],
    bootstrapMeta: {
      deferredDeskArrays: [],
      sort: { purchaseOrders: 'order_date_iso_desc', movements: 'at_iso_desc' },
      listLimitsApplied: {
        ...(historyLim ? { movements: historyLim, purchaseOrders: historyLim } : {}),
        ...(coilMovOk ? { coilLots: coilDesk.mode } : {}),
      },
      coilLotsRecovery: coilMovOk ? COIL_DESK_RECOVERY : undefined,
      truncated: {
        ...(poListOk ? { purchaseOrders: historyLim > 0 && purchaseOrders.length >= historyLim } : {}),
        ...(coilMovOk
          ? {
              coilLots: coilDesk.truncated,
              movements: historyLim > 0 && movements.length >= historyLim,
            }
          : {}),
      },
      backgroundHydrate: buildBackgroundHydrateMeta(
        [
          {
            key: 'movements',
            path: '/api/stock-movements',
            limit: historyLim,
            loaded: movements.length,
          },
        ],
        { pageSize }
      ),
    },
  };
}

/** @type {Record<string, (db: import('better-sqlite3').Database, opts: object) => object>} */
export const DOMAIN_SNAPSHOT_BUILDERS = {
  sales: buildSalesDomainSnapshot,
  operations: buildOperationsDomainSnapshot,
  finance: buildFinanceDomainSnapshot,
  procurement: buildProcurementDomainSnapshot,
};
