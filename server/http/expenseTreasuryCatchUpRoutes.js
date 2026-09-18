/**
 * Catch-up HTTP for imported expenses that never hit till/bank (or GL cash).
 */
import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { withWriteDelta } from '../workspaceWriteDelta.js';
import { listTreasuryAccounts } from '../readModel.js';
import {
  attachTreasuryToImportedExpenses,
  clearExpensesForReimport,
  listExpensesClearableForReimport,
  listExpensesMissingBankPosting,
  voidUnpostedImportedExpenses,
} from '../finance/expenseTreasuryCatchUpOps.js';

const IMPORT_PERMS = ['finance.post', 'expenses.create'];

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerExpenseTreasuryCatchUpRoutes(app, db) {
  app.get(
    '/api/expenses/import/unposted',
    requirePermission(IMPORT_PERMS),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const rows = listExpensesMissingBankPosting(db, branchScope, {
          category: req.query?.category,
          limit: req.query?.limit,
          offset: req.query?.offset,
        });
        return res.json({
          ok: true,
          rows,
          missingTreasuryCount: rows.filter((r) => r.missingTreasury).length,
          missingGlCount: rows.filter((r) => r.missingGl).length,
        });
      } catch (e) {
        console.error('[expenses-import-unposted]', e);
        return apiError(res, {
          status: 500,
          code: 'EXPENSE_IMPORT_UNPOSTED_FAILED',
          error: 'Could not list imported expenses missing bank posting.',
        });
      }
    }
  );

  app.post(
    '/api/expenses/import/attach-treasury',
    requirePermission(IMPORT_PERMS),
    (req, res) => {
      try {
        const body = req.body || {};
        const expenseIds = Array.isArray(body.expenseIds)
          ? body.expenseIds
          : body.expenseId
            ? [body.expenseId]
            : [];
        const r = attachTreasuryToImportedExpenses(
          db,
          expenseIds,
          {
            treasuryAccountId: body.treasuryAccountId,
            accountKey: body.accountKey,
            workspaceBranchId: req.workspaceBranchId,
            workspaceViewAll: Boolean(req.workspaceViewAll),
          },
          req.user
        );
        if (!r.ok) {
          return res.status(400).json(r);
        }
        const branchScope = resolveBootstrapBranchScope(req);
        const accounts = listTreasuryAccounts(db, branchScope);
        const touchedIds = new Set(r.posted.map((p) => Number(p.treasuryAccountId)).filter(Boolean));
        return res.status(201).json(
          withWriteDelta(r, {
            treasuryAccounts: accounts.filter((a) => touchedIds.has(Number(a.id))),
          })
        );
      } catch (e) {
        console.error('[expenses-import-attach-treasury]', e);
        return apiError(res, {
          status: 400,
          code: 'EXPENSE_IMPORT_ATTACH_TREASURY_FAILED',
          error: 'Could not post imported expenses to the bank account.',
        });
      }
    }
  );

  app.post(
    '/api/expenses/import/void-unposted',
    requirePermission(IMPORT_PERMS),
    (req, res) => {
      try {
        const body = req.body || {};
        const expenseIds = Array.isArray(body.expenseIds)
          ? body.expenseIds
          : body.expenseId
            ? [body.expenseId]
            : [];
        const r = voidUnpostedImportedExpenses(db, expenseIds, req.user, {
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        return res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error('[expenses-import-void-unposted]', e);
        return apiError(res, {
          status: 400,
          code: 'EXPENSE_IMPORT_VOID_FAILED',
          error: 'Could not undo imported expenses.',
        });
      }
    }
  );

  app.get(
    '/api/expenses/import/clear-preview',
    requirePermission(IMPORT_PERMS),
    (req, res) => {
      try {
        if (req.workspaceViewAll) {
          return res.status(403).json({
            ok: false,
            error: 'Turn off all-branches view. Preview one branch at a time.',
          });
        }
        const r = listExpensesClearableForReimport(db, req.workspaceBranchId);
        return res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error('[expenses-import-clear-preview]', e);
        return apiError(res, {
          status: 500,
          code: 'EXPENSE_IMPORT_CLEAR_PREVIEW_FAILED',
          error: 'Could not preview expense clear for re-import.',
        });
      }
    }
  );

  app.post(
    '/api/expenses/import/clear-for-reimport',
    requirePermission(IMPORT_PERMS),
    (req, res) => {
      try {
        const r = clearExpensesForReimport(db, req.user, {
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
          confirmPhrase: req.body?.confirmPhrase,
        });
        if (!r.ok) return res.status(400).json(r);
        const branchScope = resolveBootstrapBranchScope(req);
        return res.json(
          withWriteDelta(r, {
            treasuryAccounts: listTreasuryAccounts(db, branchScope),
          })
        );
      } catch (e) {
        console.error('[expenses-import-clear-for-reimport]', e);
        return apiError(res, {
          status: 400,
          code: 'EXPENSE_IMPORT_CLEAR_FAILED',
          error: 'Could not clear expenses for re-import.',
        });
      }
    }
  );
}
