import {
  listCustomers,
  listQuotations,
  listQuotationsForProductionContext,
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
import { listInTransitLoads } from './inTransitOps.js';
import { shouldShowPoInTransit } from '../shared/lib/inTransitVisibility.js';
import { runQuotationLifecycleMaintenance } from './quotationLifecycleOps.js';
import { listProductionConversionChecks, listProductionJobCoils } from './productionTraceability.js';
import { computePoolSummary, listMaterialIncidents } from './materialIncidentOps.js';
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
  syncDerivedWorkItems,
  listUnifiedWorkItems,
} from './workItems.js';
import { sanitizeWorkItemsForClient } from '../shared/lib/workspaceSanitize.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { buildHelpPersonalizationFromSnapshot } from './helpQueryOps.js';
import { listBankDeposits } from './bankDepositOps.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { listStaffRecoveriesDueForCashier } from './staffRecoveryCashierOps.js';

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
 * }} [opts]
 */
export function buildBootstrap(db, opts = {}) {
  const branchScope = opts.branchScope ?? 'ALL';
  const skipSideEffects = Boolean(opts.skipSideEffects);
  const skipWorkItemSync = Boolean(opts.skipWorkItemSync) || skipSideEffects;
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
    Math.max(200, Number(process.env.ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS) || 2000)
  );
  const MAX_LEDGER_ROWS = Math.min(
    10_000,
    Math.max(500, Number(process.env.ZAREWA_BOOTSTRAP_MAX_LEDGER_ROWS) || 3000)
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
  const ledgerRows = ledgerOk ? listLedgerEntries(db, branchScope, { limit: MAX_LEDGER_ROWS }) : [];

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
    if (!skipWorkItemSync && user && userHasPermission(user, 'office.use')) {
      ensureWorkItemsForVisibleOfficeThreads(db, workScope, user);
    }
    if (!skipWorkItemSync && user) {
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
  const refunds = refundsOk ? listRefunds(db, branchScope) : [];
  const helpSnapshotPartial = { productionMetrics, operationsInventoryAttention, refunds };

  return {
    ok: true,
    session,
    permissions: [...(session.permissions || [])],
    workspaceBranches: listBranches(db),
    branchScope,
    customers: salesOk ? listCustomers(db, branchScope) : [],
    quotations: salesOk
      ? listQuotations(db, branchScope)
      : prodRollupOk
        ? listQuotationsForProductionContext(db, branchScope)
        : [],
    ledgerEntries: ledgerRows,
    advanceInEvents: ledgerOk ? listAdvanceInEvents(db, branchScope) : [],
    suppliers: procOk ? listSuppliers(db, branchScope) : [],
    transportAgents: procOk ? listTransportAgents(db, branchScope) : [],
    products: productsOk ? listProducts(db, branchScope) : [],
    purchaseOrders: poListOk ? listPurchaseOrders(db, branchScope) : [],
    coilLots: coilMovOk ? listCoilLots(db, branchScope) : [],
    coilControlEvents: coilMovOk ? listCoilControlEvents(db, branchScope) : [],
    materialIncidents: coilMovOk ? listMaterialIncidents(db, branchScope) : [],
    materialPoolSummary: coilMovOk ? computePoolSummary(db, branchScope) : null,
    movements: coilMovOk ? listStockMovements(db, branchScope) : [],
    wipByProduct: opsOk ? getWipByProduct(db, branchScope) : {},
    deliveries: opsOk ? listDeliveries(db, branchScope) : [],
    receipts: salesOk
      ? enrichSalesReceiptRowsWithCashFromLedger(listSalesReceipts(db, branchScope), ledgerRows)
      : [],
    cuttingLists: opsOk || salesOk ? listCuttingLists(db, branchScope) : [],
    productionJobs: prodRollupOk ? listProductionJobs(db, branchScope) : [],
    productionJobAccessoryUsage: prodRollupOk ? listProductionJobAccessoryUsage(db, branchScope) : [],
    productionJobStoneFlatsheetUsage: prodRollupOk ? listProductionJobStoneFlatsheetUsage(db, branchScope) : [],
    productionMetrics,
    productionJobCoils: prodRollupOk ? listProductionJobCoils(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionConversionChecks: prodRollupOk ? listProductionConversionChecks(db, branchScope, { limit: MAX_PROD_ROWS }) : [],
    productionCompletionAdjustments: prodRollupOk ? listProductionCompletionAdjustments(db, branchScope) : [],
    operationsInventoryAttention,
    refunds,
    masterData: masterOk ? listMasterData(db) : EMPTY_MASTER_DATA,
    /** Floor list (₦/m) synced from material pricing workbook — used by quotations UI for coil products. */
    priceListItems: salesOk ? listPriceListItems(db) : [],
    /** Material pricing workbook rows (floor + commission) — quotations auto-price roofing / flat sheet. */
    materialPricingRows: salesOk ? listMaterialPricingRowsForSnapshot(db, branchScope) : [],
    treasuryAccounts: treasuryOk ? listTreasuryAccounts(db, branchScope) : [],
    treasuryMovements: treasuryMovementsOk ? listTreasuryMovements(db, branchScope) : [],
    expenses: expensesSnapshotOk ? listExpenses(db, branchScope) : [],
    paymentRequests: payReqOk ? listPaymentRequests(db, branchScope) : [],
    accountsPayable: finOk ? listAccountsPayable(db, branchScope) : [],
    /** Haulage awaiting treasury — finance users need it on Accounts; procurement users need it to confirm Finance visibility after linking transport. */
    poTransportAwaitingTreasury:
      finOk || procOk ? listPoTransportAwaitingTreasury(db, branchScope) : [],
    staffRecoveriesDue:
      finOk && recoverySchedulesTableReady(db)
        ? listStaffRecoveriesDueForCashier(db, branchScope)
        : [],
    bankReconciliation: finOk ? listBankReconciliation(db, branchScope) : [],
    bankDeposits:
      ledgerOk || finOk ? listBankDeposits(db, branchScope, { openOnly: false }) : [],
    coilRequests: coilReqOk ? listCoilRequests(db, branchScope) : [],
    yardCoilRegister: yardOk ? listYardCoils(db, branchScope) : [],
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
    orgGovernanceLimits: user ? getOrgGovernanceLimits(db) : null,
    unifiedWorkItems: user
      ? sanitizeWorkItemsForClient(listUnifiedWorkItems(db, workScope, user, { limit: 200 }))
      : [],
    materialRequests: user ? listMaterialRequests(db, workScope) : [],
    inTransitLoads: user ? listInTransitLoads(db, branchScope) : [],
    machines: user ? listMachines(db, workScope) : [],
    maintenancePlans: user ? listMaintenancePlans(db, workScope) : [],
    maintenanceWorkOrders: user ? listMaintenanceWorkOrders(db, workScope) : [],
    hrPerformanceReviews: [],
    workspaceDepartmentIds: [...WORKSPACE_DEPARTMENT_IDS],
    suggestedRoleByDepartment: { ...SUGGESTED_ROLE_BY_DEPARTMENT },
    helpPersonalization: user
      ? buildHelpPersonalizationFromSnapshot(db, helpSnapshotPartial, {
          userId: user.id,
          branchId: branchScope === 'ALL' ? DEFAULT_BRANCH_ID : branchScope,
          roleKey: user.roleKey,
          pathname: '/',
        })
      : null,
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
    /** Full coil register — trimming hides coils (e.g. CL-26-2043) from Stock Management. */
    coilLots: full.coilLots ?? [],
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
  repairDashboardReceivablePurchaseOrders(full, partial);
  return partial;
}
