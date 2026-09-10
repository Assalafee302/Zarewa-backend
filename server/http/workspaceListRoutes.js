/**
 * Paginated desk lists (customers, expenses, coil lots, jobs, movements, cutting lists).
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
  countCoilLots,
  countCustomers,
  countCuttingLists,
  countExpenses,
  countProductionJobs,
  countSalesReceipts,
  countStockMovements,
  listCoilLots,
  listCustomers,
  listCuttingLists,
  listExpenses,
  listProductionJobs,
  listSalesReceipts,
  listStockMovements,
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

function listOptsFromQuery(parsed) {
  if (parsed.unlimited) return { unlimited: true };
  return { limit: parsed.limit, offset: parsed.offset, useDefaultLimit: true };
}

export function registerWorkspaceListRoutes(app, db) {
  app.get('/api/customers', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req);
      const items = listCustomers(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countCustomers(db, branchScope);
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
      const parsed = parseListQuery(req, { defaultLimit: 500, maxLimit: 5000 });
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
      const parsed = parseListQuery(req, { defaultLimit: 500, maxLimit: 5000 });
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

  app.get('/api/production-jobs', requirePermission(PRODUCTION_JOBS_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 200, maxLimit: 5000 });
      const items = listProductionJobs(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countProductionJobs(db, branchScope);
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

  app.get('/api/stock-movements', requirePermission(MOVEMENTS_LIST_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 500, maxLimit: 5000 });
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
      const parsed = parseListQuery(req, { defaultLimit: 200, maxLimit: 5000 });
      const items = listCuttingLists(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countCuttingLists(db, branchScope);
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

  app.get('/api/sales-receipts', requirePermission(SALES_DOMAIN_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const parsed = parseListQuery(req, { defaultLimit: 200, maxLimit: 5000 });
      const items = listSalesReceipts(db, branchScope, listOptsFromQuery(parsed));
      const total = parsed.unlimited ? items.length : countSalesReceipts(db, branchScope);
      return sendPaginatedList(res, {
        items,
        total,
        limit: parsed.unlimited ? 0 : parsed.limit,
        offset: parsed.offset,
        key: 'receipts',
      });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'LOAD_FAILED', error: 'Failed to load sales receipts.' });
    }
  });
}
