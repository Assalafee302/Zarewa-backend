import {
  listCustomers,
  listQuotations,
  listQuotationsForProductionContext,
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
  listProductionJobs,
  listProductionCompletionAdjustments,
  listProductionJobAccessoryUsage,
  listProductionJobStoneFlatsheetUsage,
  listAppUsers,
  listPeriodLocks,
  listApprovalActions,
  listAuditLog,
  computeProductionMetricsRollup,
  computeOperationsInventoryAttention,
  emptyOperationsInventoryAttention,
} from './readModel.js';
import { listMasterData } from './masterData.js';
import { listPriceListItems } from './pricingOps.js';
import { listMaterialPricingRowsForSnapshot } from './materialWorkbookQuotationPrice.js';
import { getPricingPolicyBundle } from './pricingPolicyOps.js';
import { listInTransitLoads } from './inTransitOps.js';
import { shouldShowPoInTransit } from '../shared/lib/inTransitVisibility.js';
import { runQuotationLifecycleMaintenance } from './quotationLifecycleOps.js';
import { listProductionConversionChecks, repairProductionJobCoilIntegrity } from './productionTraceability.js';
import { computePoolSummary, listMaterialIncidents } from './materialIncidentOps.js';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { SUGGESTED_ROLE_BY_DEPARTMENT, WORKSPACE_DEPARTMENT_IDS } from './departmentRoleTemplates.js';
import { userHasPermission } from './auth.js';
import { buildExpenseCategoryMonthlyAlert, buildExpenseCategoryBranchCoachAlert } from './expenseCategoryReportOps.js';
import {
  canListTreasuryAccounts,
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
  EMPTY_MASTER_DATA,
} from './workspaceAccess.js';
import {
  ensureWorkItemsForVisibleOfficeThreads,
  listMachines,
  listMaintenancePlans,
  listMaintenanceWorkOrders,
  listMaterialRequests,
  shouldSyncDerivedWorkItemsNow,
  syncDerivedWorkItems,
  listUnifiedWorkItems,
} from './workItems.js';
import { sanitizeWorkItemsForClient } from '../shared/lib/workspaceSanitize.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { normalizeOrgStoreRestock } from './orgStoreRestock.js';
import { listBankDepositsForDesk } from './bankDepositOps.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { listStaffRecoveriesDueForCashier } from './staffRecoveryCashierOps.js';
import {
  partnerWalletEnabled,
} from './finance/partnerWalletCredit.js';
import { listStaffRepayableObligationsForCashier, staffObligationTablesReady } from './staffObligationOps.js';
import { listRegisterSettlementsAwaitingPayment } from './accountingRegisterSettlementOps.js';
import { listGlJournalsForWorkspaceSearch } from './glOps.js';
import {
  financeHistoryListOpts,
  financeRegisterListOpts,
  productionHistoryListOpts,
  receiptsHistoryListOpts,
  rowListOpts,
  salesCustomersListOpts,
} from './listQueryOpts.js';

function userMayReceiveBranchExpenseCoachAlert(user) {
  if (!user) return false;
  const rk = String(user.roleKey || '').toLowerCase();
  return (
    rk === 'branch_manager' ||
    rk === 'admin' ||
    rk === 'md' ||
    rk === 'ceo' ||
    userHasPermission(user, 'finance.approve')
  );
}

function safeExpenseCategoryMonthlyAlert(db, opts) {
  try {
    return buildExpenseCategoryMonthlyAlert(db, opts).summary;
  } catch (e) {
    console.error('[bootstrap] expenseCategoryMonthlyAlert', e);
    return null;
  }
}

function safeExpenseCategoryBranchCoachAlert(db, opts) {
  try {
    return buildExpenseCategoryBranchCoachAlert(db, opts);
  } catch (e) {
    console.error('[bootstrap] expenseCategoryBranchCoachAlert', e);
    return null;
  }
}

/**
 * Full workspace snapshot for SPA bootstrap (single round-trip), filtered by the signed-in user.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   user?: object | null;
 *   session?: {authenticated: boolean, user?: object | null, permissions?: string[]};
 *   includeControls?: boolean;
 *   includeUsers?: boolean;
 *   includeRegisteredPasswords?: boolean;
 *   branchScope?: 'ALL' | string;
 *   skipSideEffects?: boolean;
 *   skipWorkItemSync?: boolean;
 *   listLimits?: Record<string, number | undefined>;
 *   omitDeskArrays?: Record<string, boolean>;
 * }} [opts]
 */
export function buildBootstrap(db, opts = {}) {
  const branchScope = opts.branchScope ?? 'ALL';
  const skipSideEffects = Boolean(opts.skipSideEffects);
  const skipWorkItemSync = Boolean(opts.skipWorkItemSync) || skipSideEffects;
  const omitDesk = opts.omitDeskArrays || {};
  const user = opts.user ?? opts.session?.user ?? null;
  const includeRegisteredPasswords = Boolean(opts.includeRegisteredPasswords);
  const session = opts.session ?? { authenticated: false, user: null, permissions: [] };
  const workScope = {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? DEFAULT_BRANCH_ID : String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
  };

  const salesOk = canReadSalesDomain(user);
  const procOk = canReadProcurementDomain(user);
  const poListOk = canReadPurchaseOrdersList(user);
  const opsOk = canReadOperationsDomain(user);
  const finOk = canReadFinanceDomain(user);
  const treasuryMovementsOk = canReadTreasuryMovements(user);
  const expensesSnapshotOk = finOk || userHasPermission(user, 'expenses.create');
  const ledgerOk = canReadLedgerRelated(user);
  const treasuryOk = canListTreasuryAccounts(user);
  const refundsOk = canSeeRefundsList(user);
  const payReqOk = canSeePaymentRequests(user);
  const coilReqOk = canSeeCoilRequests(user);
  const masterOk = canReadMasterData(user);
  const productsOk = canReadProductsCatalog(user);
  const prodRollupOk = canReadProductionSnapshot(user);
  const coilMovOk = canReadCoilAndMovements(user);
  const yardOk = canReadYardRegister(user);

  const productionOk = prodRollupOk && opsOk;
  const MAX_PROD_ROWS = Math.min(
    5000,
    Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || 400)
  );
  const MAX_LEDGER_ROWS = Math.min(
    10_000,
    Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_LEDGER_ROWS) || 500)
  );

  const customerDashboard = salesOk
    ? getJsonBlob(db, 'customer_dashboard') ?? { orders: [], interactions: [], salesTrendByCustomer: {} }
    : { orders: [], interactions: [], salesTrendByCustomer: {} };
  const availableStock = salesOk ? getJsonBlob(db, 'sales_available_stock') ?? [] : [];
  const orgManagerTargetsRaw = getJsonBlob(db, 'org.manager_targets.v1');
  const orgManagerTargets = (() => {
    if (!orgManagerTargetsRaw || typeof orgManagerTargetsRaw !== 'object') return null;
    const n = Number(orgManagerTargetsRaw.nairaTargetPerMonth);
    const m = Number(orgManagerTargetsRaw.meterTargetPerMonth);
    const o = {};
    if (Number.isFinite(n) && n > 0) o.nairaTargetPerMonth = n;
    if (Number.isFinite(m) && m > 0) o.meterTargetPerMonth = m;
    return Object.keys(o).length ? o : null;
  })();
  const orgStoreRestock = normalizeOrgStoreRestock(getJsonBlob(db, 'org.store_restock.v1'));
  const orgGovernanceLimitsSnapshot = user ? getOrgGovernanceLimits(db) : null;
  const ledgerRowLimit =
    opts.listLimits?.ledgerEntries != null
      ? Math.max(1, Number(opts.listLimits.ledgerEntries) || MAX_LEDGER_ROWS)
      : MAX_LEDGER_ROWS;
  const ledgerRows = ledgerOk ? listLedgerEntries(db, branchScope, { limit: ledgerRowLimit }) : [];

  if (!skipSideEffects) {
    const inlineQuoteMaintenance =
      process.env.NODE_ENV === 'test' ||
      String(process.env.ZAREWA_BOOTSTRAP_INLINE_MAINTENANCE || '').trim() === '1';
    if (salesOk && inlineQuoteMaintenance) {
      try {
        if (process.env.NODE_ENV !== 'test' || process.env.ZAREWA_TEST_QUOTE_LIFECYCLE === '1') {
          runQuotationLifecycleMaintenance(db, branchScope);
        }
      } catch (e) {
        console.error('[zarewa] quotation lifecycle maintenance failed', e);
      }
    }
    if (!skipWorkItemSync && user && shouldSyncDerivedWorkItemsNow(user.id, workScope.branchId)) {
      if (userHasPermission(user, 'office.use')) {
        ensureWorkItemsForVisibleOfficeThreads(db, workScope, user);
      }
      syncDerivedWorkItems(db, workScope, user);
    }
  }

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
  const DEFAULT_BOOTSTRAP_LIST_LIMIT = Math.min(
    5000,
    Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_LIST_LIMIT) || 300)
  );
  const listLimit = (key) =>
    opts.listLimits?.[key] != null
      ? Math.max(1, Number(opts.listLimits[key]) || DEFAULT_BOOTSTRAP_LIST_LIMIT)
      : DEFAULT_BOOTSTRAP_LIST_LIMIT;
  const listOpts = (key) => ({ limit: listLimit(key) });
  const poListOpts = { ...rowListOpts(opts, 'purchaseOrders'), skipSideEffects: skipSideEffects || true };
  const refunds = refundsOk ? listRefunds(db, branchScope, listOpts('refunds')) : [];
  const cuttingListHistoryOpts =
    opts.listLimits?.cuttingLists != null ? listOpts('cuttingLists') : productionHistoryListOpts();
  const productionJobsHistoryOpts =
    opts.listLimits?.productionJobs != null
      ? rowListOpts(opts, 'productionJobs')
      : productionHistoryListOpts();
  const expensesHistoryOpts =
    opts.listLimits?.expenses != null ? listOpts('expenses') : financeHistoryListOpts();
  const paymentRequestsHistoryOpts =
    opts.listLimits?.paymentRequests != null ? listOpts('paymentRequests') : financeHistoryListOpts();
  const treasuryMovementsHistoryOpts =
    opts.listLimits?.treasuryMovements != null
      ? listOpts('treasuryMovements')
      : financeHistoryListOpts();
  const customersHistoryOpts =
    opts.listLimits?.customers != null ? listOpts('customers') : salesCustomersListOpts();
  const receiptsHistoryOpts =
    opts.listLimits?.receipts != null ? listOpts('receipts') : receiptsHistoryListOpts();
  const productionJobsList = prodRollupOk
    ? listProductionJobs(db, branchScope, productionJobsHistoryOpts)
    : [];
  const productionJobIds = productionJobsList.map((j) => j.jobID).filter(Boolean);
  const productionJobCoilsList =
    prodRollupOk && !omitDesk.productionJobCoils
      ? repairProductionJobCoilIntegrity(
          db,
          productionJobsList,
          // Coils only for jobs in this snapshot — avoid full-table production_job_coils scan.
          []
        )
      : [];

  return {
    ok: true,
    session,
    permissions: [...(session.permissions || [])],
    workspaceBranches: listBranches(db),
    branchScope,
    customers: salesOk && !omitDesk.customers ? listCustomers(db, branchScope, customersHistoryOpts) : [],
    quotations: salesOk
      ? listQuotations(db, branchScope, { ...rowListOpts(opts, 'quotations'), includeLines: false })
      : prodRollupOk
        ? listQuotationsForProductionContext(db, branchScope)
        : [],
    ledgerEntries: ledgerRows,
    // FIFO open deposits load on sales/finance domain snapshots + GET /api/advance-deposits
    // (full history required — never LIMIT; defer from cold bootstrap).
    advanceInEvents: [],
    suppliers: procOk ? listSuppliers(db, branchScope) : [],
    transportAgents: procOk ? listTransportAgents(db, branchScope) : [],
    associatedStaff: procOk || salesOk ? listAssociatedStaff(db, branchScope) : [],
    associatedStaffPolicy: {
      enabled: /^(1|true|yes|on)$/i.test(String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0')),
    },
    products: productsOk ? listProducts(db, branchScope) : [],
    purchaseOrders: poListOk ? listPurchaseOrders(db, branchScope, poListOpts) : [],
    coilLots: coilMovOk && !omitDesk.coilLots ? listCoilLots(db, branchScope, { useDefaultLimit: true }) : [],
    coilControlEvents: coilMovOk ? listCoilControlEvents(db, branchScope, listOpts('coilControlEvents')) : [],
    materialIncidents: coilMovOk ? listMaterialIncidents(db, branchScope) : [],
    materialPoolSummary: coilMovOk ? computePoolSummary(db, branchScope) : null,
    movements: coilMovOk ? listStockMovements(db, branchScope, rowListOpts(opts, 'movements')) : [],
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    deliveries: opsOk ? listDeliveries(db, branchScope, listOpts('deliveries')) : [],
    receipts: salesOk || finOk || treasuryMovementsOk
      ? listSalesReceiptsForDesk(db, branchScope, ledgerRows, receiptsHistoryOpts)
      : [],
    cuttingLists: opsOk || salesOk ? listCuttingLists(db, branchScope, cuttingListHistoryOpts) : [],
    productionJobs: productionJobsList,
    productionJobAccessoryUsage: prodRollupOk
      ? listProductionJobAccessoryUsage(db, branchScope, { jobIds: productionJobIds })
      : [],
    productionJobStoneFlatsheetUsage: prodRollupOk
      ? listProductionJobStoneFlatsheetUsage(db, branchScope, { jobIds: productionJobIds })
      : [],
    productionMetrics,
    productionJobCoils: productionJobCoilsList,
    productionConversionChecks: prodRollupOk ? listProductionConversionChecks(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionCompletionAdjustments: prodRollupOk
      ? listProductionCompletionAdjustments(db, branchScope, productionJobsHistoryOpts)
      : [],
    operationsInventoryAttention,
    refunds,
    masterData: masterOk ? listMasterData(db, { branchId: branchScope }) : EMPTY_MASTER_DATA,
    /** Floor list (₦/m) synced from material pricing workbook — used by quotations UI for coil products. */
    priceListItems: salesOk ? listPriceListItems(db) : [],
    /** Material pricing workbook rows (floor + commission) — quotations auto-price roofing / flat sheet. */
    materialPricingRows: salesOk ? listMaterialPricingRowsForSnapshot(db, branchScope) : [],
    /** Ridge / flashing strip add-ons for trim auto-pricing on quotations. */
    pricingRidgeAddOns: salesOk ? getPricingPolicyBundle(db).ridgeAddOns : [],
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
    treasuryMovements: treasuryMovementsOk
      ? listTreasuryMovements(db, branchScope, treasuryMovementsHistoryOpts)
      : [],
    expenses: expensesSnapshotOk && !omitDesk.expenses ? listExpenses(db, branchScope, expensesHistoryOpts) : [],
    paymentRequests: payReqOk ? listPaymentRequests(db, branchScope, paymentRequestsHistoryOpts) : [],
    glJournalSearchSlice: finOk ? listGlJournalsForWorkspaceSearch(db, branchScope, { limit: 800 }) : [],
    accountsPayable: finOk ? listAccountsPayable(db, branchScope, financeRegisterListOpts()) : [],
    /** Haulage awaiting treasury — finance users need it on Accounts; procurement users need it to confirm Finance visibility after linking transport. */
    poTransportAwaitingTreasury:
      finOk || procOk ? listPoTransportAwaitingTreasury(db, branchScope) : [],
    /** Approved / in-transit POs still missing haulier or quoted transport fee — procurement action queue. */
    poTransportMissingLink: procOk ? listPoTransportMissingLink(db, branchScope) : [],
    /** Unified transport catch-up (includes Received) and orphan haulage treasury lines. */
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
    /** Lazy via GET /api/partner-wallets — keep bootstrap free of wallet balance scans. */
    partnerWalletsDue: [],
    registerSettlementsAwaitingPayment:
      payReqOk || userHasPermission(user, 'finance.pay')
        ? listRegisterSettlementsAwaitingPayment(db, branchScope)
        : [],
    expenseCategoryMonthlyAlert:
      finOk &&
      user &&
      (userHasPermission(user, 'finance.approve') ||
        userHasPermission(user, 'finance.post') ||
        userHasPermission(user, 'reports.view'))
        ? safeExpenseCategoryMonthlyAlert(db, { branchScope, orgLimits: orgGovernanceLimitsSnapshot })
        : null,
    expenseCategoryBranchCoachAlert:
      finOk &&
      user &&
      branchScope !== 'ALL' &&
      userMayReceiveBranchExpenseCoachAlert(user)
        ? safeExpenseCategoryBranchCoachAlert(db, {
            branchScope,
            orgLimits: orgGovernanceLimitsSnapshot,
          })
        : null,
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope, financeRegisterListOpts()) : [],
    bankDeposits:
      ledgerOk || finOk ? listBankDepositsForDesk(db, branchScope, financeHistoryListOpts()) : [],
    coilRequests: coilReqOk ? listCoilRequests(db, branchScope) : [],
    yardCoilRegister: yardOk ? listYardCoils(db, branchScope, { useDefaultLimit: true }) : [],
    procurementCatalog: procOk ? listProcurementCatalog(db) : [],
    salesAvailableStock: availableStock,
    customerDashboard,
    appUsers: opts.includeUsers
      ? listAppUsers(db, { revealRegisteredPasswords: includeRegisteredPasswords })
      : [],
    periodLocks: opts.includeControls ? listPeriodLocks(db) : [],
    approvalActions: opts.includeControls ? listApprovalActions(db) : [],
    auditLog: opts.includeControls ? listAuditLog(db) : [],
    dashboardPrefs:
      session?.user?.id != null
        ? getJsonBlob(db, `user_dashboard_prefs:${session.user.id}`) ?? {}
        : {},
    orgManagerTargets,
    orgStoreRestock,
    orgGovernanceLimits: orgGovernanceLimitsSnapshot,
    unifiedWorkItems: user
      ? sanitizeWorkItemsForClient(listUnifiedWorkItems(db, workScope, user, { limit: 200 }))
      : [],
    /** Lazy via GET /api/staff-purchase-credits/pending-count — not on bootstrap hot path. */
    staffPurchaseCreditPendingCount: 0,
    staffPurchaseCreditCrossBranch: null,
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    hrPerformanceReviews: [],
    workspaceDepartmentIds: [...WORKSPACE_DEPARTMENT_IDS],
    suggestedRoleByDepartment: { ...SUGGESTED_ROLE_BY_DEPARTMENT },
    /** Help prompts load on demand via help APIs — not on bootstrap hot path. */
    helpPersonalization: null,
    bootstrapMeta: {
      listLimitsApplied: {
        customers: customersHistoryOpts.unlimited
          ? 0
          : Number(customersHistoryOpts.limit) || listLimit('customers'),
        deliveries: listLimit('deliveries'),
        refunds: listLimit('refunds'),
        receipts: receiptsHistoryOpts.unlimited
          ? 0
          : Number(receiptsHistoryOpts.limit) || listLimit('receipts'),
        expenses: expensesHistoryOpts.unlimited
          ? 0
          : Number(expensesHistoryOpts.limit) || listLimit('expenses'),
        paymentRequests: paymentRequestsHistoryOpts.unlimited
          ? 0
          : Number(paymentRequestsHistoryOpts.limit) || listLimit('paymentRequests'),
        treasuryMovements: treasuryMovementsHistoryOpts.unlimited
          ? 0
          : Number(treasuryMovementsHistoryOpts.limit) || listLimit('treasuryMovements'),
        cuttingLists: cuttingListHistoryOpts.unlimited
          ? 0
          : Number(cuttingListHistoryOpts.limit) || listLimit('cuttingLists'),
        productionJobs: productionJobsHistoryOpts.unlimited
          ? 0
          : Number(productionJobsHistoryOpts.limit) || listLimit('productionJobs'),
        ledgerEntries: ledgerRowLimit,
      },
      truncated: {
        /** Only truncated when an explicit positive customers cap is configured — or deferred on dashboard shell. */
        customers: (salesOk && !customersHistoryOpts.unlimited) || Boolean(omitDesk.customers),
        deliveries: opsOk,
        refunds: refundsOk,
        receipts: (salesOk || finOk || treasuryMovementsOk) && !receiptsHistoryOpts.unlimited,
        /** Only truncated when an explicit positive finance history cap is configured — or deferred on dashboard shell. */
        expenses: (expensesSnapshotOk && !expensesHistoryOpts.unlimited) || Boolean(omitDesk.expenses),
        paymentRequests: payReqOk && !paymentRequestsHistoryOpts.unlimited,
        treasuryMovements: treasuryMovementsOk && !treasuryMovementsHistoryOpts.unlimited,
        /** Only truncated when an explicit positive history cap is configured. */
        cuttingLists: (opsOk || salesOk) && !cuttingListHistoryOpts.unlimited,
        productionJobs: prodRollupOk && !productionJobsHistoryOpts.unlimited,
        ledgerEntries: ledgerOk,
        advanceInEvents: ledgerOk,
        coilLots: coilMovOk || Boolean(omitDesk.coilLots),
        productionJobCoils: Boolean(omitDesk.productionJobCoils),
      },
      deferredDeskArrays: ledgerOk ? ['advanceInEvents'] : [],
    },
  };
}

function take(list, limit) {
  if (!Array.isArray(list)) return [];
  if (!limit || limit <= 0) return list;
  return list.slice(0, limit);
}

/**
 * Dashboard bootstrap previously trimmed cutting lists and production jobs independently.
 * Lists sort by different keys (`date_iso` vs `created_at_iso`), so joins could break when
 * either side was capped. Production history is now loaded uncapped by default; this repair
 * still merges missing pairs when an explicit history limit is configured.
 *
 * @param {Record<string, unknown>} full
 * @param {{ cuttingLists: unknown[]; productionJobs: unknown[]; productionJobCoils?: unknown[] }} partial
 */
export function repairDashboardProductionJoins(full, partial) {
  const fullCl = Array.isArray(full.cuttingLists) ? full.cuttingLists : [];
  const fullJobs = Array.isArray(full.productionJobs) ? full.productionJobs : [];
  const fullCoils = Array.isArray(full.productionJobCoils) ? full.productionJobCoils : [];

  const clByIdFull = new Map(fullCl.map((cl) => [cl.id, cl]));
  /** Newest job per cutting list (full list is ordered newest first). */
  const jobByClIdFull = new Map();
  for (const j of fullJobs) {
    const cid = String(j.cuttingListId || '').trim();
    if (!cid || jobByClIdFull.has(cid)) continue;
    jobByClIdFull.set(cid, j);
  }

  let cls = [...(Array.isArray(partial.cuttingLists) ? partial.cuttingLists : [])];
  let jobs = [...(Array.isArray(partial.productionJobs) ? partial.productionJobs : [])];
  let coils = [...(Array.isArray(partial.productionJobCoils) ? partial.productionJobCoils : [])];

  const clById = new Map(cls.map((cl) => [cl.id, cl]));
  const jobByClId = new Map();
  for (const j of jobs) {
    const cid = String(j.cuttingListId || '').trim();
    if (cid) jobByClId.set(cid, j);
  }
  for (const j of jobs) {
    const cid = String(j.cuttingListId || '').trim();
    if (!cid || clById.has(cid)) continue;
    const row = clByIdFull.get(cid);
    if (row) {
      cls.push(row);
      clById.set(cid, row);
    }
  }

  for (const cl of cls) {
    if (!cl.productionRegistered) continue;
    const cid = cl.id;
    if (!cid || jobByClId.has(cid)) continue;
    const j = jobByClIdFull.get(cid);
    if (j) {
      jobs.push(j);
      jobByClId.set(cid, j);
    }
  }

  const finalJobIds = new Set(jobs.map((j) => j.jobID).filter(Boolean));
  const seenCoilIds = new Set(coils.map((c) => c.id).filter((id) => id != null));
  for (const c of fullCoils) {
    if (!finalJobIds.has(c.jobID)) continue;
    if (seenCoilIds.has(c.id)) continue;
    coils.push(c);
    seenCoilIds.add(c.id);
  }

  partial.cuttingLists = cls;
  partial.productionJobs = jobs;
  partial.productionJobCoils = coils;
}

/**
 * Dashboard bootstrap trims purchaseOrders by recency. Re-merge any receivable PO that
 * fell outside the trim window so Operations → Stock Management can always GRN in-transit loads.
 *
 * @param {Record<string, unknown>} full
 * @param {{ purchaseOrders?: unknown[] }} partial
 */
export function repairDashboardReceivablePurchaseOrders(full, partial) {
  const fullPos = Array.isArray(full.purchaseOrders) ? full.purchaseOrders : [];
  const partialPos = Array.isArray(partial.purchaseOrders) ? partial.purchaseOrders : [];
  const seen = new Set(partialPos.map((p) => p.poID).filter(Boolean));
  const missing = fullPos.filter(
    (p) => p?.poID && !seen.has(p.poID) && shouldShowPoInTransit(p)
  );
  if (!missing.length) return;
  partial.purchaseOrders = [...partialPos, ...missing];
}

/**
 * Dashboard bootstrap is shell-first: same first-paint contract as `buildShellBootstrap`.
 * Desk registers hydrate via `/api/workspace/{domain}-snapshot` (and optional prefetch).
 * Avoids building a full desk dump then discarding rows (CPU + DB cost on slow links).
 */
export function buildDashboardBootstrap(db, opts = {}) {
  const limit = Math.min(5000, Math.max(200, Number(opts.limit) || 600));
  const shell = buildShellBootstrap(db, {
    ...opts,
    skipSideEffects: true,
    skipWorkItemSync: true,
  });
  return {
    ...shell,
    bootstrapMeta: {
      ...(shell.bootstrapMeta || {}),
      mode: 'dashboard',
      deferredDeskArrays: [...SHELL_DEFERRED_DESK_ARRAYS],
      listLimitsApplied: { dashboardCap: limit },
      truncated: Object.fromEntries(SHELL_DEFERRED_DESK_ARRAYS.map((k) => [k, true])),
    },
  };
}

/**
 * Desk register arrays deferred on the first-paint shell. Domains refill via
 * `/api/workspace/{domain}-snapshot` (and optional background prefetch).
 */
export const SHELL_DEFERRED_DESK_ARRAYS = [
  'customers',
  'quotations',
  'receipts',
  'refunds',
  'cuttingLists',
  'expenses',
  'paymentRequests',
  'treasuryMovements',
  'treasuryAccounts',
  'ledgerEntries',
  'purchaseOrders',
  'suppliers',
  'transportAgents',
  'associatedStaff',
  'products',
  'coilLots',
  'coilControlEvents',
  'materialIncidents',
  'movements',
  'deliveries',
  'productionJobs',
  'productionJobCoils',
  'productionJobAccessoryUsage',
  'productionJobStoneFlatsheetUsage',
  'productionConversionChecks',
  'productionCompletionAdjustments',
  'materialRequests',
  'inTransitLoads',
  'machines',
  'maintenancePlans',
  'maintenanceWorkOrders',
  'bankReconciliation',
  'bankDeposits',
  'coilRequests',
  'yardCoilRegister',
  'procurementCatalog',
  'accountsPayable',
  'advanceInEvents',
  'glJournalSearchSlice',
  'materialPricingRows',
  'priceListItems',
  // masterData stays on the shell — quotation / coil forms need gauges + material types
  // before domain snapshots merge, and the catalog is tiny vs desk registers.
  'salesAvailableStock',
  'registerSettlementsAwaitingPayment',
  'staffRecoveriesDue',
  'staffRepayableObligations',
  'partnerWalletBalancesDue',
  'poTransportAwaitingTreasury',
  'poTransportMissingLink',
  'poTransportCatchUp',
  'orphanHaulageTreasuryMovements',
  'refundCreditApplications',
  'hrPerformanceReviews',
];

/**
 * Minimal first-paint bootstrap: auth, branches, and inbox slice only.
 * Does not run the full desk list builder (avoids multi-thousand-row JSON on slow links).
 *
 * @param {import('./db.js').Database} db
 * @param {{
 *   user?: object | null;
 *   session?: {authenticated: boolean, user?: object | null, permissions?: string[]};
 *   branchScope?: 'ALL' | string;
 *   includeControls?: boolean;
 *   includeUsers?: boolean;
 *   includeRegisteredPasswords?: boolean;
 * }} [opts]
 */
export function buildShellBootstrap(db, opts = {}) {
  const branchScope = opts.branchScope ?? 'ALL';
  const user = opts.user ?? opts.session?.user ?? null;
  const session = opts.session ?? { authenticated: false, user: null, permissions: [] };
  const workScope = {
    viewAll: branchScope === 'ALL',
    branchId:
      branchScope === 'ALL'
        ? DEFAULT_BRANCH_ID
        : String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
  };

  const orgManagerTargetsRaw = getJsonBlob(db, 'org.manager_targets.v1');
  const orgManagerTargets = (() => {
    if (!orgManagerTargetsRaw || typeof orgManagerTargetsRaw !== 'object') return null;
    const n = Number(orgManagerTargetsRaw.nairaTargetPerMonth);
    const m = Number(orgManagerTargetsRaw.meterTargetPerMonth);
    const o = {};
    if (Number.isFinite(n) && n > 0) o.nairaTargetPerMonth = n;
    if (Number.isFinite(m) && m > 0) o.meterTargetPerMonth = m;
    return Object.keys(o).length ? o : null;
  })();

  const emptyDesk = Object.fromEntries(SHELL_DEFERRED_DESK_ARRAYS.map((k) => [k, []]));
  const truncated = Object.fromEntries(SHELL_DEFERRED_DESK_ARRAYS.map((k) => [k, true]));
  const masterOk = canReadMasterData(user);

  return {
    ok: true,
    session,
    permissions: session.permissions ?? [],
    workspaceBranches: listBranches(db),
    branchScope,
    ...emptyDesk,
    /** Setup gauges / material types / colours — required for quotation form on first paint. */
    masterData: masterOk ? listMasterData(db, { branchId: branchScope }) : EMPTY_MASTER_DATA,
    materialPoolSummary: null,
    wipByProduct: {},
    productionMetrics: {
      jobCount: 0,
      byStatus: {},
      totalPlannedMeters: 0,
      totalActualMeters: 0,
      completedActualMeters: 0,
    },
    operationsInventoryAttention: emptyOperationsInventoryAttention(),
    customerDashboard: { orders: [], interactions: [], salesTrendByCustomer: {} },
    pricingPolicyBundle: null,
    appUsers: opts.includeUsers
      ? listAppUsers(db, { revealRegisteredPasswords: Boolean(opts.includeRegisteredPasswords) })
      : [],
    periodLocks: opts.includeControls ? listPeriodLocks(db) : [],
    approvalActions: opts.includeControls ? listApprovalActions(db) : [],
    auditLog: opts.includeControls ? listAuditLog(db) : [],
    dashboardPrefs:
      session?.user?.id != null ? getJsonBlob(db, `user_dashboard_prefs:${session.user.id}`) ?? {} : {},
    orgManagerTargets,
    orgStoreRestock: normalizeOrgStoreRestock(getJsonBlob(db, 'org.store_restock.v1')),
    orgGovernanceLimits: user ? getOrgGovernanceLimits(db) : null,
    /** Small inbox slice for Workspace home — desks still load full queues via domain packs. */
    unifiedWorkItems: user
      ? sanitizeWorkItemsForClient(listUnifiedWorkItems(db, workScope, user, { limit: 40 }))
      : [],
    /** Lazy via GET /api/staff-purchase-credits/pending-count — shell stays free of credit scans. */
    staffPurchaseCreditPendingCount: 0,
    staffPurchaseCreditCrossBranch: null,
    workspaceDepartmentIds: [...WORKSPACE_DEPARTMENT_IDS],
    suggestedRoleByDepartment: { ...SUGGESTED_ROLE_BY_DEPARTMENT },
    helpPersonalization: null,
    bootstrapMeta: {
      mode: 'shell',
      deferredDeskArrays: [...SHELL_DEFERRED_DESK_ARRAYS],
      truncated,
      listLimitsApplied: {},
    },
  };
}
