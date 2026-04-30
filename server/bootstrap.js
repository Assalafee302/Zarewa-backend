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
  listBankReconciliation,
  listCoilRequests,
  listYardCoils,
  listProcurementCatalog,
  getJsonBlob,
  listAdvanceInEvents,
  listProductionJobs,
  listProductionCompletionAdjustments,
  listProductionJobAccessoryUsage,
  listAppUsers,
  listPeriodLocks,
  listApprovalActions,
  listAuditLog,
  computeProductionMetricsRollup,
  computeOperationsInventoryAttention,
  emptyOperationsInventoryAttention,
} from './readModel.js';
import { listMasterData } from './masterData.js';
import { listInTransitLoads } from './inTransitOps.js';
import { runQuotationLifecycleMaintenance } from './quotationLifecycleOps.js';
import { listProductionConversionChecks, listProductionJobCoils } from './productionTraceability.js';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { SUGGESTED_ROLE_BY_DEPARTMENT, WORKSPACE_DEPARTMENT_IDS } from './departmentRoleTemplates.js';
import { userHasPermission } from './auth.js';
import {
  canListTreasuryAccounts,
  canReadCoilAndMovements,
  canReadFinanceDomain,
  canReadLedgerRelated,
  canReadMasterData,
  canReadOperationsDomain,
  canReadProcurementDomain,
  canReadProductionSnapshot,
  canReadProductsCatalog,
  canReadSalesDomain,
  canSeeCoilRequests,
  canSeePaymentRequests,
  canSeeRefundsList,
  canReadYardRegister,
  EMPTY_MASTER_DATA,
} from './workspaceAccess.js';
import {
  ensureWorkItemsForVisibleOfficeThreads,
  listHrPerformanceReviews,
  listMachines,
  listMaintenancePlans,
  listMaintenanceWorkOrders,
  listMaterialRequests,
  syncDerivedWorkItems,
  listUnifiedWorkItems,
} from './workItems.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';

/**
 * Full workspace snapshot for SPA bootstrap (single round-trip), filtered by the signed-in user.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   user?: object | null;
 *   session?: {authenticated: boolean, user?: object | null, permissions?: string[]};
 *   includeControls?: boolean;
 *   includeUsers?: boolean;
 *   branchScope?: 'ALL' | string;
 * }} [opts]
 */
export function buildBootstrap(db, opts = {}) {
  const branchScope = opts.branchScope ?? 'ALL';
  const user = opts.user ?? opts.session?.user ?? null;
  const session = opts.session ?? { authenticated: false, user: null, permissions: [] };
  const workScope = {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? DEFAULT_BRANCH_ID : String(branchScope || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
  };

  const salesOk = canReadSalesDomain(user);
  const procOk = canReadProcurementDomain(user);
  const opsOk = canReadOperationsDomain(user);
  const finOk = canReadFinanceDomain(user);
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
    Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || 2000)
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
  const ledgerRows = ledgerOk ? listLedgerEntries(db, branchScope) : [];

  if (salesOk) {
    try {
      // Vitest and other in-memory API tests use fixed historical quote dates; real "today" would
      // auto-expire them on every bootstrap and break PATCH/payment flows. Opt in with
      // ZAREWA_TEST_QUOTE_LIFECYCLE=1 when a test needs expiry-on-bootstrap (rare).
      if (process.env.NODE_ENV !== 'test' || process.env.ZAREWA_TEST_QUOTE_LIFECYCLE === '1') {
        runQuotationLifecycleMaintenance(db, branchScope);
      }
    } catch (e) {
      console.error('[zarewa] quotation lifecycle maintenance failed', e);
    }
  }
  if (user && userHasPermission(user, 'office.use')) {
    ensureWorkItemsForVisibleOfficeThreads(db, workScope, user);
  }
  if (user) {
    syncDerivedWorkItems(db, workScope, user);
  }

  return {
    ok: true,
    session,
    permissions: [...(session.permissions || [])],
    workspaceBranches: listBranches(db),
    branchScope,
    customers: salesOk ? listCustomers(db, branchScope) : [],
    quotations: salesOk ? listQuotations(db, branchScope) : [],
    ledgerEntries: ledgerRows,
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db) : [],
    suppliers: procOk ? listSuppliers(db, branchScope) : [],
    transportAgents: procOk ? listTransportAgents(db, branchScope) : [],
    products: productsOk ? listProducts(db, branchScope) : [],
    purchaseOrders: procOk ? listPurchaseOrders(db, branchScope) : [],
    coilLots: coilMovOk ? listCoilLots(db, branchScope) : [],
    coilControlEvents: coilMovOk ? listCoilControlEvents(db, branchScope) : [],
    movements: coilMovOk ? listStockMovements(db, branchScope) : [],
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    deliveries: opsOk ? listDeliveries(db, branchScope) : [],
    receipts: salesOk
      ? enrichSalesReceiptRowsWithCashFromLedger(listSalesReceipts(db, branchScope), ledgerRows)
      : [],
    cuttingLists: opsOk || salesOk ? listCuttingLists(db, branchScope) : [],
    productionJobs: prodRollupOk ? listProductionJobs(db, branchScope) : [],
    productionJobAccessoryUsage: prodRollupOk ? listProductionJobAccessoryUsage(db, branchScope) : [],
    productionMetrics: productionOk
      ? computeProductionMetricsRollup(db, branchScope)
      : {
          jobCount: 0,
          byStatus: {},
          totalPlannedMeters: 0,
          totalActualMeters: 0,
          completedActualMeters: 0,
        },
    productionJobCoils: prodRollupOk ? listProductionJobCoils(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionConversionChecks: prodRollupOk ? listProductionConversionChecks(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionCompletionAdjustments: prodRollupOk ? listProductionCompletionAdjustments(db, branchScope) : [],
    operationsInventoryAttention: productionOk
      ? computeOperationsInventoryAttention(db, branchScope)
      : emptyOperationsInventoryAttention(),
    refunds: refundsOk ? listRefunds(db, branchScope) : [],
    masterData: masterOk ? listMasterData(db) : EMPTY_MASTER_DATA,
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db) : [],
    treasuryMovements: finOk ? listTreasuryMovements(db) : [],
    expenses: finOk ? listExpenses(db, branchScope) : [],
    paymentRequests: payReqOk ? listPaymentRequests(db, branchScope) : [],
    accountsPayable: finOk ? listAccountsPayable(db, branchScope) : [],
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope) : [],
    coilRequests: coilReqOk ? listCoilRequests(db) : [],
    yardCoilRegister: yardOk ? listYardCoils(db) : [],
    procurementCatalog: procOk ? listProcurementCatalog(db) : [],
    salesAvailableStock: availableStock,
    customerDashboard,
    appUsers: opts.includeUsers ? listAppUsers(db) : [],
    periodLocks: opts.includeControls ? listPeriodLocks(db) : [],
    approvalActions: opts.includeControls ? listApprovalActions(db) : [],
    auditLog: opts.includeControls ? listAuditLog(db) : [],
    dashboardPrefs:
      session?.user?.id != null
        ? getJsonBlob(db, `user_dashboard_prefs:${session.user.id}`) ?? {}
        : {},
    orgManagerTargets,
    orgGovernanceLimits: user ? getOrgGovernanceLimits(db) : null,
    unifiedWorkItems: user ? listUnifiedWorkItems(db, workScope, user, { limit: 200 }) : [],
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    hrPerformanceReviews: user ? listHrPerformanceReviews(db, workScope) : [],
    workspaceDepartmentIds: [...WORKSPACE_DEPARTMENT_IDS],
    suggestedRoleByDepartment: { ...SUGGESTED_ROLE_BY_DEPARTMENT },
  };
}

function take(list, limit) {
  if (!Array.isArray(list)) return [];
  if (!limit || limit <= 0) return list;
  return list.slice(0, limit);
}

/**
 * Dashboard bootstrap trims cutting lists and production jobs independently. Lists sort by
 * different keys (cutting list `date_iso` vs job `created_at_iso`), so a newly registered job
 * can appear in the trimmed job slice while its cutting list is dropped (or the reverse).
 * Merge missing pairs so Operations → Production queue stays consistent.
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
 * Dashboard-focused snapshot: same shape as bootstrap, but trims heavy arrays.
 * Intended to make the initial dashboard render fast; the app can refresh full bootstrap later.
 */
export function buildDashboardBootstrap(db, opts = {}) {
  const limit = Math.min(5000, Math.max(200, Number(opts.limit) || 600));
  const full = buildBootstrap(db, opts);
  const partial = {
    ...full,
    // Heavy arrays trimmed for dashboard charts/KPIs
    customers: take(full.customers, limit),
    quotations: take(full.quotations, limit),
    receipts: take(full.receipts, limit),
    cuttingLists: take(full.cuttingLists, limit),
    purchaseOrders: take(full.purchaseOrders, limit),
    deliveries: take(full.deliveries, limit),
    refunds: take(full.refunds, limit),
    expenses: take(full.expenses, limit),
    paymentRequests: take(full.paymentRequests, limit),
    treasuryMovements: take(full.treasuryMovements, limit),
    movements: take(full.movements, limit),
    coilLots: take(full.coilLots, limit),
    coilControlEvents: take(full.coilControlEvents ?? [], limit),
    productionJobs: take(full.productionJobs, limit),
    productionJobCoils: take(full.productionJobCoils, limit),
    productionConversionChecks: take(full.productionConversionChecks, limit),
    productionCompletionAdjustments: take(full.productionCompletionAdjustments, limit),
    unifiedWorkItems: take(full.unifiedWorkItems, Math.min(limit, 180)),
    materialRequests: take(full.materialRequests, Math.min(limit, 120)),
    inTransitLoads: take(full.inTransitLoads, Math.min(limit, 120)),
    machines: take(full.machines, Math.min(limit, 120)),
    maintenancePlans: take(full.maintenancePlans, Math.min(limit, 120)),
    maintenanceWorkOrders: take(full.maintenanceWorkOrders, Math.min(limit, 120)),
    hrPerformanceReviews: take(full.hrPerformanceReviews, Math.min(limit, 120)),
    // Ledger entries can be extremely large; dashboard doesn't need the full list.
    ledgerEntries: take(full.ledgerEntries, Math.min(limit, 300)),
  };
  repairDashboardProductionJoins(full, partial);
  return partial;
}
