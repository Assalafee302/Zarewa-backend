/**
 * Paginated desk lists (customers, expenses, coil lots).
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
  countExpenses,
  listCoilLots,
  listCustomers,
  listExpenses,
} from '../readModel.js';
import {
  FINANCE_DOMAIN_PERMS,
  OPERATIONS_DOMAIN_PERMS,
  PROCUREMENT_DOMAIN_PERMS,
  SALES_DOMAIN_PERMS,
} from '../workspaceAccess.js';

const EXPENSE_LIST_PERMS = [...FINANCE_DOMAIN_PERMS, 'expenses.create'];
const COIL_LIST_PERMS = [...OPERATIONS_DOMAIN_PERMS, ...PROCUREMENT_DOMAIN_PERMS, 'sales.manage'];

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
}
