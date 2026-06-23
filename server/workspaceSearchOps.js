import { userHasPermission } from './auth.js';
import { resolveBootstrapBranchScope } from './branchScope.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { branchPredicate } from './branchSql.js';
import {
  canReadFinanceDomain,
  canReadOperationsDomain,
  canReadProductionSnapshot,
  canReadProductsCatalog,
  canSeePaymentRequests,
  canSeeRefundsList,
} from './workspaceAccess.js';
import { hrListScope, hrTablesReady } from './hrOps.js';
import { userCanSeePersistedWorkItem } from './workItems.js';
import { isConfidentialLevel } from '../shared/lib/workspaceConfidentialAccess.js';
import { canAccessModuleWithPermissions } from '../shared/lib/moduleAccess.js';
import {
  filterNavSearchCommands,
  mergeWorkspaceSearchResults,
  applyContextBoostToByKind,
  scoreWorkspaceSearchMatch,
} from '../shared/lib/workspaceSearchCore.js';
import { searchCoilLots } from './readModel.js';
import {
  allowedWorkspaceSearchFtsKinds,
  queryWorkspaceSearchFts,
  workspaceSearchFtsReady,
} from './workspaceSearchFts.js';

/** @param {string} s */
export function escapeSqlLikePattern(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Permission-aware workspace quick search with per-category quotas and relevance scoring.
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} rawQuery
 * @param {number} limit
 * @param {{ contextPath?: string }} [opts]
 */
export function workspaceQuickSearch(db, req, rawQuery, limit, opts = {}) {
  if (workspaceSearchFtsReady(db)) {
    try {
      return workspaceQuickSearchWithFts(db, req, rawQuery, limit, opts);
    } catch (e) {
      console.warn('[zarewa] workspace FTS search failed, using SQL fallback', e?.message || e);
    }
  }
  return workspaceQuickSearchWithSql(db, req, rawQuery, limit, opts);
}

/**
 * FTS-backed search (work items still use SQL for confidentiality rules).
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} rawQuery
 * @param {number} limit
 * @param {{ contextPath?: string }} [opts]
 */
function workspaceQuickSearchWithFts(db, req, rawQuery, limit, opts = {}) {
  const raw = String(rawQuery ?? '').trim();
  const cap = Math.min(40, Math.max(1, limit || 20));
  if (raw.length < 2) return [];

  const branchScope = resolveBootstrapBranchScope(req);
  const user = req.user;
  const permissions = user?.permissions || [];
  const perm = (p) => userHasPermission(user, '*') || userHasPermission(user, p);
  const canModule = (moduleKey) => canAccessModuleWithPermissions(permissions, moduleKey);
  const perKindCap = Math.min(12, Math.max(4, Math.ceil(cap / 2)));

  /** @type {Record<string, import('../shared/lib/workspaceSearchCore.js').WorkspaceSearchHit[]>} */
  const byKind = {};

  byKind.nav = filterNavSearchCommands(raw, perm, canModule, {
    roleKey: user?.roleKey,
    limit: 4,
  });

  const ftsKinds = allowedWorkspaceSearchFtsKinds(user);
  const ftsHits = queryWorkspaceSearchFts(db, branchScope, ftsKinds, raw, cap * 5);
  for (const hit of ftsHits) {
    if (!byKind[hit.kind]) byKind[hit.kind] = [];
    if (byKind[hit.kind].length < perKindCap) byKind[hit.kind].push(hit);
  }

  if (perm('office.use') || perm('*')) {
    const likeArg = `%${escapeSqlLikePattern(raw)}%`;
    const bp = branchPredicate(db, 'work_items', branchScope, 'w');
    const rows = db
      .prepare(
        `SELECT w.id, w.reference_no, w.title, w.document_type, w.status, w.branch_id, w.confidentiality,
                w.sender_user_id, w.responsible_user_id, w.responsible_office_key, w.office_key
         FROM work_items w WHERE 1=1${bp.sql}
         AND (w.reference_no LIKE ? ESCAPE '\\\\' OR w.title LIKE ? ESCAPE '\\\\' OR w.document_type LIKE ? ESCAPE '\\\\')
         ORDER BY w.updated_at_iso DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, Math.min(perKindCap * 3, 36));
    const searchScope = {
      viewAll: branchScope === 'ALL',
      branchId:
        branchScope === 'ALL'
          ? String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID
          : branchScope,
    };
    const workHits = [];
    for (const row of rows) {
      if (!userCanSeePersistedWorkItem(db, searchScope, user, row)) continue;
      const confidential = isConfidentialLevel(row.confidentiality);
      workHits.push({
        kind: 'work_item',
        id: row.id,
        label: row.title || row.reference_no || 'Work item',
        sublabel: confidential
          ? `${row.reference_no} · Confidential · ${row.status}`
          : `${row.reference_no} · ${row.document_type} · ${row.status}`,
        path: '/',
        state: { workItemId: row.id },
        _score: scoreWorkspaceSearchMatch(raw, [row.title, row.reference_no, row.document_type]),
      });
      if (workHits.length >= perKindCap) break;
    }
    byKind.work_item = workHits;
  }

  return mergeWorkspaceSearchResults(applyContextBoostToByKind(byKind, opts.contextPath), {
    totalCap: cap,
    minPerKind: 2,
  });
}

/**
 * SQL LIKE fallback when FTS is unavailable.
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} rawQuery
 * @param {number} limit
 * @param {{ contextPath?: string }} [opts]
 */
function workspaceQuickSearchWithSql(db, req, rawQuery, limit, opts = {}) {
  const raw = String(rawQuery ?? '').trim();
  const cap = Math.min(40, Math.max(1, limit || 20));
  if (raw.length < 2) return [];

  const likeArg = `%${escapeSqlLikePattern(raw)}%`;
  const branchScope = resolveBootstrapBranchScope(req);
  const user = req.user;
  const permissions = user?.permissions || [];
  const perm = (p) => userHasPermission(user, '*') || userHasPermission(user, p);
  const perKindCap = Math.min(12, Math.max(4, Math.ceil(cap / 2)));
  const canModule = (moduleKey) => canAccessModuleWithPermissions(permissions, moduleKey);

  /** @type {Record<string, import('../shared/lib/workspaceSearchCore.js').WorkspaceSearchHit[]>} */
  const byKind = {};

  byKind.nav = filterNavSearchCommands(raw, perm, canModule, {
    roleKey: user?.roleKey,
    limit: 4,
  });

  if (perm('sales.view') || perm('customers.manage')) {
    const bp = branchPredicate(db, 'customers', branchScope);
    const rows = db
      .prepare(
        `SELECT customer_id, name, phone_number, email, company_name, tier, crm_profile_notes FROM customers WHERE 1=1${bp.sql}
         AND (customer_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\' OR IFNULL(phone_number,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(email,'') LIKE ? ESCAPE '\\\\' OR IFNULL(company_name,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(tier,'') LIKE ? ESCAPE '\\\\' OR IFNULL(crm_profile_notes,'') LIKE ? ESCAPE '\\\\')
         ORDER BY name COLLATE NOCASE LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.customer = rows.map((c) => ({
      kind: 'customer',
      id: c.customer_id,
      label: c.name,
      sublabel: c.customer_id,
      path: `/customers/${encodeURIComponent(c.customer_id)}`,
      _score: scoreWorkspaceSearchMatch(raw, [
        c.customer_id,
        c.name,
        c.phone_number,
        c.email,
        c.company_name,
        c.tier,
        c.crm_profile_notes,
      ]),
    }));
  }

  if (perm('quotations.manage') || perm('sales.view')) {
    const bp = branchPredicate(db, 'quotations', branchScope);
    const rows = db
      .prepare(
        `SELECT id, customer_name, customer_id, IFNULL(project_name,'') AS project_name FROM quotations WHERE 1=1${bp.sql}
         AND (id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(project_name,'') LIKE ? ESCAPE '\\\\')
         ORDER BY date_iso DESC, id DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.quotation = rows.map((row) => ({
      kind: 'quotation',
      id: row.id,
      label: row.id,
      sublabel: row.customer_name,
      path: '/sales',
      state: { globalSearchQuery: row.id, focusSalesTab: 'quotations' },
      _score: scoreWorkspaceSearchMatch(raw, [row.id, row.customer_name, row.customer_id, row.project_name]),
    }));
  }

  if (perm('receipts.post') || perm('finance.view') || perm('sales.view')) {
    const bp = branchPredicate(db, 'sales_receipts', branchScope);
    const rows = db
      .prepare(
        `SELECT id, customer_name, customer_id, IFNULL(quotation_ref,'') AS quotation_ref FROM sales_receipts WHERE 1=1${bp.sql}
         AND (id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\\\')
         ORDER BY date_iso DESC, id DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.receipt = rows.map((row) => ({
      kind: 'receipt',
      id: row.id,
      label: row.id,
      sublabel: row.customer_name,
      path: '/sales',
      state: { globalSearchQuery: row.id, focusSalesTab: 'receipts' },
      _score: scoreWorkspaceSearchMatch(raw, [row.id, row.customer_name, row.customer_id, row.quotation_ref]),
    }));
  }

  if (perm('procurement.view') || perm('purchase_orders.manage')) {
    const bp = branchPredicate(db, 'purchase_orders', branchScope);
    const rows = db
      .prepare(
        `SELECT po_id, supplier_name, supplier_id FROM purchase_orders WHERE 1=1${bp.sql}
         AND (po_id LIKE ? ESCAPE '\\\\' OR IFNULL(supplier_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(supplier_id,'') LIKE ? ESCAPE '\\\\')
         ORDER BY order_date_iso DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, perKindCap);
    byKind.purchase_order = rows.map((row) => ({
      kind: 'purchase_order',
      id: row.po_id,
      label: row.po_id,
      sublabel: row.supplier_name,
      path: '/procurement',
      state: { focusTab: 'purchases' },
      _score: scoreWorkspaceSearchMatch(raw, [row.po_id, row.supplier_name, row.supplier_id]),
    }));
  }

  if (perm('procurement.view') || perm('purchase_orders.manage')) {
    const rows = db
      .prepare(
        `SELECT supplier_id, name, IFNULL(city,'') AS city, IFNULL(supplier_profile_json,'') AS supplier_profile_json FROM suppliers
         WHERE (supplier_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\' OR IFNULL(city,'') LIKE ? ESCAPE '\\\\'
                OR IFNULL(supplier_profile_json,'') LIKE ? ESCAPE '\\\\')
         ORDER BY name COLLATE NOCASE LIMIT ?`
      )
      .all(likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.supplier = rows.map((s) => ({
      kind: 'supplier',
      id: s.supplier_id,
      label: s.name,
      sublabel: s.supplier_id,
      path: `/procurement/suppliers/${encodeURIComponent(s.supplier_id)}`,
      _score: scoreWorkspaceSearchMatch(raw, [s.supplier_id, s.name, s.city, s.supplier_profile_json]),
    }));
  }

  if (perm('operations.view') || perm('production.manage')) {
    const bp = branchPredicate(db, 'cutting_lists', branchScope);
    const rows = db
      .prepare(
        `SELECT id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id, IFNULL(quotation_ref,'') AS quotation_ref
         FROM cutting_lists WHERE 1=1${bp.sql}
         AND (id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\\\')
         ORDER BY date_iso DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.cutting_list = rows.map((row) => ({
      kind: 'cutting_list',
      id: row.id,
      label: row.id,
      sublabel: row.customer_name,
      path: '/operations',
      state: { focusOpsTab: 'production', highlightCuttingListId: row.id },
      _score: scoreWorkspaceSearchMatch(raw, [row.id, row.customer_name, row.customer_id, row.quotation_ref]),
    }));
  }

  if (perm('operations.view') || perm('production.manage')) {
    const coilRows = searchCoilLots(db, branchScope, raw, perKindCap);
    byKind.coil = coilRows.map((lot) => ({
      kind: 'coil',
      id: lot.coilNo,
      label: lot.coilNo,
      sublabel: `${lot.colour || '—'} · ${lot.gaugeLabel || '—'} · ${lot.productID || ''}`,
      path: `/operations/coils/${encodeURIComponent(lot.coilNo)}`,
      _score: scoreWorkspaceSearchMatch(raw, [
        lot.coilNo,
        lot.productID,
        lot.poID,
        lot.supplierName,
        lot.colour,
        lot.gaugeLabel,
      ]),
    }));
  }

  if (canReadProductionSnapshot(user)) {
    const bp = branchPredicate(db, 'production_jobs', branchScope);
    const rows = db
      .prepare(
        `SELECT job_id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id,
                IFNULL(quotation_ref,'') AS quotation_ref, IFNULL(product_name,'') AS product_name,
                IFNULL(cutting_list_id,'') AS cutting_list_id, IFNULL(product_id,'') AS product_id
         FROM production_jobs WHERE 1=1${bp.sql}
         AND (job_id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\\\' OR IFNULL(product_name,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(cutting_list_id,'') LIKE ? ESCAPE '\\\\' OR IFNULL(product_id,'') LIKE ? ESCAPE '\\\\')
         ORDER BY created_at_iso DESC, job_id DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.production_job = rows.map((row) => ({
      kind: 'production_job',
      id: row.job_id,
      label: row.job_id,
      sublabel: [row.customer_name, row.product_name].filter(Boolean).join(' · ') || row.quotation_ref,
      path: '/operations',
      state: { focusOpsTab: 'production', highlightProductionJobId: row.job_id },
      _score: scoreWorkspaceSearchMatch(raw, [
        row.job_id,
        row.customer_name,
        row.customer_id,
        row.quotation_ref,
        row.product_name,
        row.cutting_list_id,
        row.product_id,
      ]),
    }));
  }

  if (canReadOperationsDomain(user)) {
    const bp = branchPredicate(db, 'deliveries', branchScope);
    const rows = db
      .prepare(
        `SELECT id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id,
                IFNULL(quotation_ref,'') AS quotation_ref, IFNULL(tracking_no,'') AS tracking_no,
                IFNULL(destination,'') AS destination
         FROM deliveries WHERE 1=1${bp.sql}
         AND (id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\\\' OR IFNULL(tracking_no,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(destination,'') LIKE ? ESCAPE '\\\\')
         ORDER BY id DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.delivery = rows.map((row) => ({
      kind: 'delivery',
      id: row.id,
      label: row.id,
      sublabel: [row.customer_name, row.tracking_no || row.destination].filter(Boolean).join(' · '),
      path: '/operations',
      state: { focusOpsTab: 'deliveries', globalSearchQuery: row.id },
      _score: scoreWorkspaceSearchMatch(raw, [
        row.id,
        row.customer_name,
        row.customer_id,
        row.quotation_ref,
        row.tracking_no,
        row.destination,
      ]),
    }));
  }

  if (canSeeRefundsList(user)) {
    const bp = branchPredicate(db, 'customer_refunds', branchScope);
    const rows = db
      .prepare(
        `SELECT refund_id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id,
                IFNULL(quotation_ref,'') AS quotation_ref, IFNULL(product,'') AS product, IFNULL(reason_category,'') AS reason_category
         FROM customer_refunds WHERE 1=1${bp.sql}
         AND (refund_id LIKE ? ESCAPE '\\\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\\\' OR IFNULL(product,'') LIKE ? ESCAPE '\\\\' OR IFNULL(reason_category,'') LIKE ? ESCAPE '\\\\')
         ORDER BY requested_at_iso DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.refund = rows.map((row) => ({
      kind: 'refund',
      id: row.refund_id,
      label: row.refund_id,
      sublabel: row.customer_name,
      path: '/sales',
      state: { globalSearchQuery: row.refund_id, focusSalesTab: 'refund' },
      _score: scoreWorkspaceSearchMatch(raw, [
        row.refund_id,
        row.customer_name,
        row.customer_id,
        row.quotation_ref,
        row.product,
        row.reason_category,
      ]),
    }));
  }

  if (canReadProductsCatalog(user)) {
    let rows;
    const cols = db.prepare(`PRAGMA table_info(products)`).all();
    const hasPb = cols.some((c) => c.name === 'branch_id');
    if (!hasPb || branchScope === 'ALL' || !branchScope) {
      const bp = branchPredicate(db, 'products', branchScope);
      rows = db
        .prepare(
          `SELECT product_id, name FROM products WHERE 1=1${bp.sql}
           AND (product_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\')
           ORDER BY name COLLATE NOCASE LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, perKindCap);
    } else {
      rows = db
        .prepare(
          `SELECT product_id, name FROM products
           WHERE (branch_id = ? OR branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '')
           AND (product_id LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\')
           ORDER BY name COLLATE NOCASE LIMIT ?`
        )
        .all(branchScope, likeArg, likeArg, perKindCap);
    }
    byKind.product = rows.map((row) => ({
      kind: 'product',
      id: row.product_id,
      label: row.name,
      sublabel: row.product_id,
      path: '/operations',
      state: { focusOpsTab: 'inventory', opsInventorySkuQuery: row.product_id },
      _score: scoreWorkspaceSearchMatch(raw, [row.product_id, row.name]),
    }));
  }

  if (canSeePaymentRequests(user)) {
    const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
    const scopeSql = useScope ? ` AND e.branch_id = ?` : '';
    const scopeArgs = useScope ? [branchScope] : [];
    const rows = db
      .prepare(
        `SELECT pr.request_id, pr.description, pr.expense_id, IFNULL(e.reference,'') AS expense_reference
         FROM payment_requests pr
         LEFT JOIN expenses e ON e.expense_id = pr.expense_id
         WHERE 1=1${scopeSql}
         AND (pr.request_id LIKE ? ESCAPE '\\\\' OR IFNULL(pr.description,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(pr.expense_id,'') LIKE ? ESCAPE '\\\\' OR IFNULL(e.reference,'') LIKE ? ESCAPE '\\\\')
         ORDER BY pr.request_date DESC LIMIT ?`
      )
      .all(...scopeArgs, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.payment_request = rows.map((row) => ({
      kind: 'payment_request',
      id: row.request_id,
      label: row.request_id,
      sublabel: row.description || row.expense_id,
      path: '/accounts',
      state: { accountsTab: 'payment-requests', highlightPaymentRequestId: row.request_id },
      _score: scoreWorkspaceSearchMatch(raw, [row.request_id, row.description, row.expense_id, row.expense_reference]),
    }));
  }

  if (canReadFinanceDomain(user) || perm('expenses.create')) {
    const bp = branchPredicate(db, 'expenses', branchScope);
    const rows = db
      .prepare(
        `SELECT expense_id, expense_type, category, reference FROM expenses WHERE 1=1${bp.sql}
         AND (expense_id LIKE ? ESCAPE '\\\\' OR IFNULL(expense_type,'') LIKE ? ESCAPE '\\\\'
              OR IFNULL(category,'') LIKE ? ESCAPE '\\\\' OR IFNULL(reference,'') LIKE ? ESCAPE '\\\\')
         ORDER BY date DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, likeArg, perKindCap);
    byKind.expense = rows.map((row) => ({
      kind: 'expense',
      id: row.expense_id,
      label: row.expense_id,
      sublabel: [row.category, row.expense_type].filter(Boolean).join(' · ') || row.reference,
      path: '/accounts',
      state: { accountsTab: 'expenses', highlightExpenseId: row.expense_id },
      _score: scoreWorkspaceSearchMatch(raw, [row.expense_id, row.expense_type, row.category, row.reference]),
    }));
  }

  if (
    hrTablesReady(db) &&
    (userHasPermission(user, '*') ||
      userHasPermission(user, 'hr.directory.view') ||
      userHasPermission(user, 'hr.staff.manage'))
  ) {
    const scope = hrListScope(req);
    const { viewAll, branchId } = scope;
    let sql = `
      SELECT u.id AS uid, u.display_name AS dn, u.username AS un, IFNULL(p.employee_no,'') AS eno,
             IFNULL(p.department,'') AS dept, IFNULL(p.job_title,'') AS title
      FROM app_users u
      LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
      WHERE u.status = 'active'
      AND (
        u.display_name LIKE ? ESCAPE '\\\\' OR u.username LIKE ? ESCAPE '\\\\' OR IFNULL(p.employee_no,'') LIKE ? ESCAPE '\\\\'
        OR IFNULL(p.department,'') LIKE ? ESCAPE '\\\\' OR IFNULL(p.job_title,'') LIKE ? ESCAPE '\\\\'
      )
    `;
    const args = [likeArg, likeArg, likeArg, likeArg, likeArg];
    if (!viewAll) {
      sql += ` AND p.branch_id = ?`;
      args.push(branchId);
    }
    sql += ` ORDER BY u.display_name COLLATE NOCASE LIMIT ?`;
    args.push(perKindCap);
    const rows = db.prepare(sql).all(...args);
    byKind.hr_staff = rows.map((row) => ({
      kind: 'hr_staff',
      id: row.uid,
      label: row.dn || row.un,
      sublabel: row.eno || row.un,
      path: `/hr/staff/${encodeURIComponent(row.uid)}`,
      _score: scoreWorkspaceSearchMatch(raw, [row.dn, row.un, row.eno, row.dept, row.title]),
    }));
  }

  if (perm('finance.view')) {
    const bp = branchPredicate(db, 'gl_journal_entries', branchScope, 'j');
    const rows = db
      .prepare(
        `SELECT j.id, j.entry_date_iso, IFNULL(j.memo,'') AS memo, IFNULL(j.source_id,'') AS source_id
         FROM gl_journal_entries j WHERE 1=1${bp.sql}
         AND (j.id LIKE ? ESCAPE '\\\\' OR IFNULL(j.memo,'') LIKE ? ESCAPE '\\\\' OR IFNULL(j.source_id,'') LIKE ? ESCAPE '\\\\')
         ORDER BY j.entry_date_iso DESC, j.id DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, perKindCap);
    byKind.gl_journal = rows.map((row) => ({
      kind: 'gl_journal',
      id: row.id,
      label: row.id,
      sublabel: [row.entry_date_iso, row.memo || row.source_id].filter(Boolean).join(' · ') || 'GL journal',
      path: '/accounts',
      state: { accountsTab: 'audit', highlightGlJournalId: row.id },
      _score: scoreWorkspaceSearchMatch(raw, [row.id, row.memo, row.source_id]),
    }));
  }

  if (perm('office.use') || perm('*')) {
    const bp = branchPredicate(db, 'work_items', branchScope, 'w');
    const rows = db
      .prepare(
        `SELECT w.id, w.reference_no, w.title, w.document_type, w.status, w.branch_id, w.confidentiality,
                w.sender_user_id, w.responsible_user_id, w.responsible_office_key, w.office_key
         FROM work_items w WHERE 1=1${bp.sql}
         AND (w.reference_no LIKE ? ESCAPE '\\\\' OR w.title LIKE ? ESCAPE '\\\\' OR w.document_type LIKE ? ESCAPE '\\\\')
         ORDER BY w.updated_at_iso DESC LIMIT ?`
      )
      .all(...bp.args, likeArg, likeArg, likeArg, Math.min(perKindCap * 3, 36));
    const searchScope = {
      viewAll: branchScope === 'ALL',
      branchId:
        branchScope === 'ALL'
          ? String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID
          : branchScope,
    };
    const workHits = [];
    for (const row of rows) {
      if (!userCanSeePersistedWorkItem(db, searchScope, user, row)) continue;
      const confidential = isConfidentialLevel(row.confidentiality);
      workHits.push({
        kind: 'work_item',
        id: row.id,
        label: row.title || row.reference_no || 'Work item',
        sublabel: confidential
          ? `${row.reference_no} · Confidential · ${row.status}`
          : `${row.reference_no} · ${row.document_type} · ${row.status}`,
        path: '/',
        state: { workItemId: row.id },
        _score: scoreWorkspaceSearchMatch(raw, [row.title, row.reference_no, row.document_type]),
      });
      if (workHits.length >= perKindCap) break;
    }
    byKind.work_item = workHits;
  }

  return mergeWorkspaceSearchResults(applyContextBoostToByKind(byKind, opts.contextPath), {
    totalCap: cap,
    minPerKind: 2,
  });
}
