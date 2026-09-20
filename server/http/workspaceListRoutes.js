/**
 * Paginated desk lists (customers, expenses, coil lots, jobs, movements, cutting lists,
 * purchase orders, accounts payable).
 * Dashboard bootstrap omits these arrays; desks refill via domain snapshots
 * or these GET endpoints. SQL LIMIT/OFFSET — do not load-all-then-slice.
 *
 * @param {import('express').Express} app
 * @param {object} db
 */
import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { parseListQuery, sendPaginatedList } from '../listPagination.js';
import {
  countAccountsPayable,
  countCoilLots,
  countCustomers,
  countCuttingLists,
  countExpenses,
  countProductionJobs,
  countPurchaseOrders,
  countStockMovements,
  listAccountsPayable,
  listOpenSupplierPayablesForDesk,
  listCoilLots,
  listCustomers,
  listCuttingLists,
  listExpenses,
  listEligibleCuttingListQuotations,
  listEligibleProductionCoils,
  listProductionJobs,
  listPurchaseOrders,
  listStockMovements,
  searchCuttingLists,
  searchProductionJobs,
} from '../readModel.js';
import {
  FINANCE_DOMAIN_PERMS,
  OPERATIONS_DOMAIN_PERMS,
  PROCUREMENT_DOMAIN_PERMS,
  SALES_DOMAIN_PERMS,
} from '../workspaceAccess.js';

const EXPENSE_LIST_PERMS = [...FINANCE_DOMAIN_PERMS, 'expenses.create'];
const COIL_LIST_PERMS = [...OPERATIONS_DOMAIN_PERMS, ...PROCUREMENT_DOMAIN_PERMS, 'sales.manage'];
const CUTTING_LIST_PERMS = [...OPERATIONS_DOMAIN_PERMS, ...SALES_DOMAIN_PERMS];
const MOVEMENTS_LIST_PERMS = [...OPERATIONS_DOMAIN_PERMS, ...PROCUREMENT_DOMAIN_PERMS];
const PRODUCTION_JOBS_PERMS = [...OPERATIONS_DOMAIN_PERMS, 'production.manage'];
const PO_LIST_PERMS = [...PROCUREMENT_DOMAIN_PERMS, 'inventory.receive'];
const AP_LIST_PERMS = [...FINANCE_DOMAIN_PERMS, ...PROCUREMENT_DOMAIN_PERMS];

function listOptsFromQuery(parsed) {
  if (parsed.unlimited) return { unlimited: true };
  return { limit: parsed.limit, offset: parsed.offset, useDefaultLimit: true };
}

export function registerWorkspaceListRoutes(app, db) {
  app.get('/api/customers', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const sort = String(req.query?.sort || '').trim().toLowerCase();
      const q = String(req.query?.q || '').trim();
      const items = listCustomers(db, branchScope, {
        ...listOptsFromQuery(parsed),
        q: q || undefined,
        sort: sort === 'name' ? 'name' : 'recent',
      });
      const total = parsed.unlimited ? items.length : countCustomers(db, branchScope, { q: q || undefined });
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'customers',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load customers.' });
    }
  });

  app.get('/api/expenses', requirePermission(EXPENSE_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const items = listExpenses(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countExpenses(db, branchScope);
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'expenses',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load expenses.' });
    }
  });

  app.get('/api/coil-lots', requirePermission(COIL_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const items = listCoilLots(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countCoilLots(db, branchScope);
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'coilLots',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load coil lots.' });
    }
  });

  app.get('/api/production/eligible-coils', requirePermission(PRODUCTION_JOBS_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const jobId = String(req.query?.jobId || '').trim();
      const items = listEligibleProductionCoils(db, branchScope, jobId);
      // This is an active workflow queue, intentionally complete rather than a history page.
      return res.json({
        ok: true,
        branchId: branchScope,
        jobId,
        coilLots: items,
        total: items.length,
        complete: true,
      });
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 500,
        code: 'LOAD_FAILED',
        error: 'Failed to load eligible production coils.',
      });
    }
  });

  app.get('/api/production-jobs', requirePermission(PRODUCTION_JOBS_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const q = String(req.query?.q || '').trim();
      const items = listProductionJobs(db, branchScope, {
        ...listOptsFromQuery(parsed),
        q: q || undefined,
      });
      const total = parsed.unlimited
        ? items.length
        : countProductionJobs(db, branchScope, { q: q || undefined });
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'productionJobs',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load production jobs.' });
    }
  });

  app.get('/api/production-jobs/search', requirePermission(PRODUCTION_JOBS_PERMS), (req, res) => {
    try {
      const q = String(req.query?.q ?? '').trim();
      const lim = req.query?.limit != null ? Number(req.query.limit) : 80;
      const branchScope = resolveBootstrapBranchScope(req);
      const productionJobs = searchProductionJobs(db, branchScope, q, lim);
      return res.json({ ok: true, productionJobs });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'SEARCH_FAILED', error: 'Failed to search production jobs.' });
    }
  });

  app.get('/api/stock-movements', requirePermission(MOVEMENTS_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const items = listStockMovements(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countStockMovements(db, branchScope);
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'movements',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load stock movements.' });
    }
  });

  app.get('/api/cutting-lists', requirePermission(CUTTING_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const q = String(req.query?.q || '').trim();
      const items = listCuttingLists(db, branchScope, {
        ...listOptsFromQuery(parsed),
        q: q || undefined,
      });
      const total = parsed.unlimited
        ? items.length
        : countCuttingLists(db, branchScope, { q: q || undefined });
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'cuttingLists',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load cutting lists.' });
    }
  });

  /** Typeahead when a cutting list is outside the recent desk page (production register / Sales). */
  app.get('/api/cutting-lists/search', requirePermission(CUTTING_LIST_PERMS), (req, res) => {
    try {
      const q = String(req.query?.q ?? '').trim();
      const lim = req.query?.limit != null ? Number(req.query.limit) : 80;
      const branchScope = resolveBootstrapBranchScope(req);
      const cuttingLists = searchCuttingLists(db, branchScope, q, lim);
      return res.json({ ok: true, cuttingLists });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'SEARCH_FAILED', error: 'Failed to search cutting lists.' });
    }
  });

  app.get('/api/purchase-orders', requirePermission(PO_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const outstandingOnly =
        /^(1|true|yes|on)$/i.test(String(req.query?.outstanding || '')) ||
        /^(1|true|yes|on)$/i.test(String(req.query?.open || ''));
      const listOpts = { ...listOptsFromQuery(parsed), skipSideEffects: true, outstandingOnly };
      const items = listPurchaseOrders(db, branchScope, listOpts);
      const total = parsed.unlimited
        ? items.length
        : countPurchaseOrders(db, branchScope, { outstandingOnly });
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'purchaseOrders',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load purchase orders.' });
    }
  });

  app.get('/api/accounts-payable', requirePermission(AP_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 150, maxLimit: 5000 });
      const openOnly =
        /^(1|true|yes|on)$/i.test(String(req.query?.open || '')) ||
        /^(1|true|yes|on)$/i.test(String(req.query?.openOnly || ''));
      const listOpts = { ...listOptsFromQuery(parsed), openOnly, includeLines: true };
      const items = openOnly
        ? listOpenSupplierPayablesForDesk(db, branchScope, listOpts)
        : listAccountsPayable(db, branchScope, listOpts);
      const total = parsed.unlimited
        ? items.length
        : Math.max(countAccountsPayable(db, branchScope, { openOnly }), items.length);
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'accountsPayable',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 500,
        code: 'LOAD_FAILED',
        error: 'Failed to load outstanding supplier payments.',
      });
    }
  });

  app.get(
    '/api/cutting-lists/eligible-quotations',
    requirePermission(CUTTING_LIST_PERMS),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const items = listEligibleCuttingListQuotations(db, branchScope);
        return res.json({
          ok: true,
          branchId: branchScope,
          quotations: items.map((item) => ({ ...item, serverCuttingListEligible: true })),
          total: items.length,
          complete: true,
        });
      } catch (e) {
        console.error(e);
        return apiError(res, {
          status: 500,
          code: 'LOAD_FAILED',
          error: 'Failed to load eligible cutting-list quotations.',
        });
      }
    }
  );
}
