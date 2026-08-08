/**
 * HTTP routes for branch overtime (OT) pay requests (`/api/ot/*`).
 * Domain logic lives in otOps.js — this file is auth + branch scope + status visibility.
 */
import {
  DEFAULT_BRANCH_ID,
} from './branches.js';
import {
  requireAuth,
  requirePermission,
  userHasPermission,
} from './auth.js';
import {
  OT_CASHIER_VISIBLE_STATUSES,
  OT_STATUS,
  approveOtRequest,
  createOtRequest,
  deleteOtRequest,
  getOtRequest,
  listOtRequests,
  payOtRequest,
  rejectOtRequest,
  submitOtRequest,
  updateOtRequest,
} from './otOps.js';

const OT_ANY_PERM = ['ot.request', 'ot.approve', 'ot.pay', 'ot.view_branch'];
const OT_LOOKUP_PERM = ['ot.request', 'ot.approve'];
const OT_REQUEST_PERM = 'ot.request';
const OT_APPROVE_PERM = 'ot.approve';
const OT_PAY_PERM = 'ot.pay';

/**
 * Which statuses a user may list/view for their branch.
 * Cashier (pay-only) is restricted to approved + paid — never drafts / pending BM.
 * Returns null = no status filter (all for branch).
 * Returns [] = no access.
 * @param {object | null | undefined} user
 * @returns {string[] | null}
 */
export function otVisibleStatusesForUser(user) {
  if (!user) return [];
  if (userHasPermission(user, '*')) return null;
  const canRequest = userHasPermission(user, OT_REQUEST_PERM);
  const canApprove = userHasPermission(user, OT_APPROVE_PERM);
  const canPay = userHasPermission(user, OT_PAY_PERM);
  const canView = userHasPermission(user, 'ot.view_branch');
  if (!canRequest && !canApprove && !canPay && !canView) return [];
  // Pay-only desks: hide drafts / pending BM / rejects from queue endpoints.
  if (canPay && !canRequest && !canApprove) {
    return [...OT_CASHIER_VISIBLE_STATUSES];
  }
  return null;
}

/**
 * @param {object | null | undefined} user
 * @param {string} status
 */
export function userMayViewOtStatus(user, status) {
  const allowed = otVisibleStatusesForUser(user);
  if (allowed === null) return true;
  if (allowed.length === 0) return false;
  return allowed.includes(String(status || ''));
}

function workspaceBranch(req) {
  return String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
}

function otActor(req) {
  return req.user;
}

function branchOpts(req) {
  return { branchId: workspaceBranch(req) };
}

function httpStatusForOtResult(r) {
  if (!r || r.ok) return 200;
  const code = String(r.code || '');
  if (code === 'OT_NOT_FOUND') return 404;
  if (code === 'OT_BRANCH_SCOPE' || code === 'OT_DELETE_OWNER' || code === 'OT_EDIT_OWNER' || code === 'OT_SUBMIT_OWNER') {
    return 403;
  }
  if (code === 'OT_NOT_READY') return 503;
  if (code === 'OT_DUPLICATE') return 409;
  return 400;
}

function sendOtResult(res, r, { created = false } = {}) {
  if (r?.ok) {
    return res.status(created ? 201 : 200).json(r);
  }
  return res.status(httpStatusForOtResult(r)).json(r || { ok: false, error: 'Unknown OT error.' });
}

/**
 * Branch-scoped quotation picker for OT production links.
 */
function lookupQuotations(db, branchId, q, limit = 40) {
  const needle = String(q || '').trim();
  const lim = Math.min(80, Math.max(1, Math.round(Number(limit) || 40)));
  try {
    if (needle) {
      const like = `%${needle.replace(/%/g, '')}%`;
      return db
        .prepare(
          `SELECT id, customer_name AS customerName, status, total_ngn AS totalNgn, date_iso AS dateIso, branch_id AS branchId
           FROM quotations
           WHERE branch_id = ? AND (id LIKE ? OR customer_name LIKE ?)
           ORDER BY date_iso DESC
           LIMIT ${lim}`
        )
        .all(branchId, like, like);
    }
    return db
      .prepare(
        `SELECT id, customer_name AS customerName, status, total_ngn AS totalNgn, date_iso AS dateIso, branch_id AS branchId
         FROM quotations
         WHERE branch_id = ?
         ORDER BY date_iso DESC
         LIMIT ${lim}`
      )
      .all(branchId);
  } catch {
    return [];
  }
}

function lookupPurchaseOrders(db, branchId, q, limit = 40) {
  const needle = String(q || '').trim();
  const lim = Math.min(80, Math.max(1, Math.round(Number(limit) || 40)));
  try {
    if (needle) {
      const like = `%${needle.replace(/%/g, '')}%`;
      return db
        .prepare(
          `SELECT po_id AS poId, supplier_name AS supplierName, status, branch_id AS branchId
           FROM purchase_orders
           WHERE branch_id = ? AND (po_id LIKE ? OR supplier_name LIKE ?)
           ORDER BY po_id DESC
           LIMIT ${lim}`
        )
        .all(branchId, like, like);
    }
    return db
      .prepare(
        `SELECT po_id AS poId, supplier_name AS supplierName, status, branch_id AS branchId
         FROM purchase_orders
         WHERE branch_id = ?
         ORDER BY po_id DESC
         LIMIT ${lim}`
      )
      .all(branchId);
  } catch {
    return [];
  }
}

function lookupProductionJobs(db, branchId, { q, quotationRef, limit = 40 } = {}) {
  const needle = String(q || '').trim();
  const quote = String(quotationRef || '').trim();
  const lim = Math.min(80, Math.max(1, Math.round(Number(limit) || 40)));
  try {
    const args = [];
    // production_jobs has no branch_id — scope via quotation when possible.
    let sql = `SELECT j.job_id AS id, j.job_id AS jobId, j.quotation_ref AS quotationRef, j.status,
                      j.customer_name AS customerName, q.branch_id AS branchId
               FROM production_jobs j
               LEFT JOIN quotations q ON q.id = j.quotation_ref
               WHERE 1 = 1`;
    if (branchId) {
      sql += ` AND (q.branch_id = ? OR (j.quotation_ref IS NULL OR j.quotation_ref = ''))`;
      args.push(branchId);
    }
    if (quote) {
      sql += ` AND j.quotation_ref = ?`;
      args.push(quote);
    }
    if (needle) {
      const like = `%${needle.replace(/%/g, '')}%`;
      sql += ` AND (j.job_id LIKE ? OR j.quotation_ref LIKE ? OR j.customer_name LIKE ?)`;
      args.push(like, like, like);
    }
    sql += ` ORDER BY j.job_id DESC LIMIT ${lim}`;
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}

/**
 * Roster staff for OT staff lines — branch-scoped app_users with optional HR profile.
 */
function lookupRosterStaff(db, branchId, q, limit = 40) {
  const needle = String(q || '').trim();
  const lim = Math.min(80, Math.max(1, Math.round(Number(limit) || 40)));
  try {
    if (needle) {
      const like = `%${needle.replace(/%/g, '')}%`;
      return db
        .prepare(
          `SELECT u.id, u.display_name AS displayName, u.username, u.role_key AS roleKey,
                  p.job_title AS jobTitle, p.employment_type AS employmentType
           FROM app_users u
           LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE COALESCE(NULLIF(TRIM(p.branch_id), ''), u.workspace_branch_id, ?) = ?
             AND (u.display_name LIKE ? OR u.username LIKE ? OR u.id LIKE ?)
             AND COALESCE(u.status, 'active') = 'active'
           ORDER BY u.display_name ASC
           LIMIT ${lim}`
        )
        .all(branchId, branchId, like, like, like);
    }
    return db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.username, u.role_key AS roleKey,
                p.job_title AS jobTitle, p.employment_type AS employmentType
         FROM app_users u
         LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE COALESCE(NULLIF(TRIM(p.branch_id), ''), u.workspace_branch_id, ?) = ?
           AND COALESCE(u.status, 'active') = 'active'
         ORDER BY u.display_name ASC
         LIMIT ${lim}`
      )
      .all(branchId, branchId);
  } catch {
    try {
      // Fallback without workspace_branch_id column.
      if (needle) {
        const like = `%${needle.replace(/%/g, '')}%`;
        return db
          .prepare(
            `SELECT u.id, u.display_name AS displayName, u.username, u.role_key AS roleKey,
                    p.job_title AS jobTitle, p.employment_type AS employmentType
             FROM app_users u
             LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
             WHERE (p.branch_id = ? OR p.branch_id IS NULL)
               AND (u.display_name LIKE ? OR u.username LIKE ? OR u.id LIKE ?)
               AND COALESCE(u.status, 'active') = 'active'
             ORDER BY u.display_name ASC
             LIMIT ${lim}`
          )
          .all(branchId, like, like, like);
      }
      return db
        .prepare(
          `SELECT u.id, u.display_name AS displayName, u.username, u.role_key AS roleKey,
                  p.job_title AS jobTitle, p.employment_type AS employmentType
           FROM app_users u
           LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE (p.branch_id = ? OR p.branch_id IS NULL)
             AND COALESCE(u.status, 'active') = 'active'
           ORDER BY u.display_name ASC
           LIMIT ${lim}`
        )
        .all(branchId);
    } catch {
      return [];
    }
  }
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerOtApi(app, db) {
  app.get('/api/ot/requests', requireAuth, requirePermission(OT_ANY_PERM), (req, res) => {
    try {
      const branchId = workspaceBranch(req);
      const statusFilter = otVisibleStatusesForUser(req.user);
      if (Array.isArray(statusFilter) && statusFilter.length === 0) {
        return res.status(403).json({ ok: false, error: 'No OT visibility for this account.', code: 'OT_FORBIDDEN' });
      }

      let statusOpt = req.query.status;
      if (statusFilter) {
        if (statusOpt) {
          const asked = (Array.isArray(statusOpt) ? statusOpt : String(statusOpt).split(','))
            .map((s) => String(s || '').trim())
            .filter(Boolean);
          const allowed = asked.filter((s) => statusFilter.includes(s));
          statusOpt = allowed.length ? allowed : statusFilter;
        } else {
          statusOpt = statusFilter;
        }
      } else if (statusOpt != null && String(statusOpt).includes(',')) {
        statusOpt = String(statusOpt)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const rows = listOtRequests(db, {
        branchId,
        status: statusOpt,
        from: req.query.from,
        to: req.query.to,
        createdByUserId: req.query.createdByUserId || req.query.createdBy,
        limit: req.query.limit,
      });
      res.json({ ok: true, rows, branchId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/ot/requests/:id', requireAuth, requirePermission(OT_ANY_PERM), (req, res) => {
    try {
      const r = getOtRequest(db, req.params.id);
      if (!r.ok) return sendOtResult(res, r);
      const branchId = workspaceBranch(req);
      if (r.request.branchId !== branchId && !userHasPermission(req.user, '*')) {
        return res.status(403).json({
          ok: false,
          error: 'OT request is outside your branch scope.',
          code: 'OT_BRANCH_SCOPE',
        });
      }
      if (!userMayViewOtStatus(req.user, r.request.status)) {
        return res.status(403).json({
          ok: false,
          error: 'This OT request is not visible for your role.',
          code: 'OT_STATUS_SCOPE',
        });
      }
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/ot/requests', requireAuth, requirePermission(OT_REQUEST_PERM), (req, res) => {
    try {
      const body = { ...(req.body || {}), branchId: workspaceBranch(req) };
      const r = createOtRequest(db, otActor(req), body);
      sendOtResult(res, r, { created: true });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.put('/api/ot/requests/:id', requireAuth, requirePermission(OT_REQUEST_PERM), (req, res) => {
    try {
      const body = { ...(req.body || {}), branchId: workspaceBranch(req) };
      const r = updateOtRequest(db, otActor(req), req.params.id, body);
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.delete('/api/ot/requests/:id', requireAuth, requirePermission(OT_REQUEST_PERM), (req, res) => {
    try {
      const r = deleteOtRequest(db, otActor(req), req.params.id, branchOpts(req));
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/ot/requests/:id/submit', requireAuth, requirePermission(OT_REQUEST_PERM), (req, res) => {
    try {
      const r = submitOtRequest(db, otActor(req), req.params.id, branchOpts(req));
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/ot/requests/:id/approve', requireAuth, requirePermission(OT_APPROVE_PERM), (req, res) => {
    try {
      const r = approveOtRequest(db, otActor(req), req.params.id, req.body || {}, branchOpts(req));
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/ot/requests/:id/reject', requireAuth, requirePermission(OT_APPROVE_PERM), (req, res) => {
    try {
      const r = rejectOtRequest(db, otActor(req), req.params.id, req.body || {}, branchOpts(req));
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post('/api/ot/requests/:id/pay', requireAuth, requirePermission(OT_PAY_PERM), (req, res) => {
    try {
      // Mark-paid only — domain layer ignores payable overrides from body.
      const r = payOtRequest(db, otActor(req), req.params.id, req.body || {}, branchOpts(req));
      sendOtResult(res, r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/ot/lookups/quotations', requireAuth, requirePermission(OT_LOOKUP_PERM), (req, res) => {
    try {
      const rows = lookupQuotations(db, workspaceBranch(req), req.query.q || req.query.query, req.query.limit);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/ot/lookups/purchase-orders', requireAuth, requirePermission(OT_LOOKUP_PERM), (req, res) => {
    try {
      const rows = lookupPurchaseOrders(db, workspaceBranch(req), req.query.q || req.query.query, req.query.limit);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/ot/lookups/production-jobs', requireAuth, requirePermission(OT_LOOKUP_PERM), (req, res) => {
    try {
      const rows = lookupProductionJobs(db, workspaceBranch(req), {
        q: req.query.q || req.query.query,
        quotationRef: req.query.quotationRef || req.query.quotation_ref,
        limit: req.query.limit,
      });
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/api/ot/lookups/staff', requireAuth, requirePermission(OT_LOOKUP_PERM), (req, res) => {
    try {
      const rows = lookupRosterStaff(db, workspaceBranch(req), req.query.q || req.query.query, req.query.limit);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // Self-document statuses for clients.
  app.get('/api/ot/meta', requireAuth, requirePermission(OT_ANY_PERM), (req, res) => {
    res.json({
      ok: true,
      statuses: Object.values(OT_STATUS),
      visibleStatuses: otVisibleStatusesForUser(req.user),
      permissions: {
        request: userHasPermission(req.user, OT_REQUEST_PERM) || userHasPermission(req.user, '*'),
        approve: userHasPermission(req.user, OT_APPROVE_PERM) || userHasPermission(req.user, '*'),
        pay: userHasPermission(req.user, OT_PAY_PERM) || userHasPermission(req.user, '*'),
      },
    });
  });
}
