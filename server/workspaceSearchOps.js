import { userHasPermission } from './auth.js';
import { resolveBootstrapBranchScope } from './branchScope.js';
import { branchPredicate } from './branchSql.js';
import {
  canReadProductsCatalog,
  canSeeRefundsList,
} from './workspaceAccess.js';
import { hrListScope, hrTablesReady } from './hrOps.js';

/** @param {string} s */
export function escapeSqlLikePattern(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Permission-aware workspace quick search with SQL LIMIT (avoids loading full lists).
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} rawQuery
 * @param {number} limit
 */
export function workspaceQuickSearch(db, req, rawQuery, limit) {
  const raw = String(rawQuery ?? '').trim();
  const cap = Math.min(40, Math.max(1, limit || 20));
  if (raw.length < 2) return [];

  const likeArg = `%${escapeSqlLikePattern(raw)}%`;
  const branchScope = resolveBootstrapBranchScope(req);
  const user = req.user;
  const perm = (p) => userHasPermission(user, '*') || userHasPermission(user, p);

  const results = [];
  const push = (row) => {
    if (results.length < cap) results.push(row);
  };
  const room = () => cap - results.length;

  if (perm('sales.view') || perm('customers.manage')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'customers', branchScope);
      const rows = db
        .prepare(
          `SELECT customer_id, name, phone_number, email, company_name FROM customers WHERE 1=1${bp.sql}
           AND (customer_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR IFNULL(phone_number,'') LIKE ? ESCAPE '\\'
                OR IFNULL(email,'') LIKE ? ESCAPE '\\' OR IFNULL(company_name,'') LIKE ? ESCAPE '\\')
           ORDER BY name COLLATE NOCASE LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, n);
      for (const c of rows) {
        push({
          kind: 'customer',
          id: c.customer_id,
          label: c.name,
          sublabel: c.customer_id,
          path: `/customers/${encodeURIComponent(c.customer_id)}`,
        });
      }
    }
  }

  if (perm('quotations.manage') || perm('sales.view')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'quotations', branchScope);
      const rows = db
        .prepare(
          `SELECT id, customer_name, customer_id, IFNULL(project_name,'') AS project_name FROM quotations WHERE 1=1${bp.sql}
           AND (id LIKE ? ESCAPE '\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\'
                OR IFNULL(project_name,'') LIKE ? ESCAPE '\\')
           ORDER BY date_iso DESC, id DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'quotation',
          id: row.id,
          label: row.id,
          sublabel: row.customer_name,
          path: '/sales',
          state: { globalSearchQuery: row.id, focusSalesTab: 'quotations' },
        });
      }
    }
  }

  if (perm('receipts.post') || perm('finance.view') || perm('sales.view')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'sales_receipts', branchScope);
      const rows = db
        .prepare(
          `SELECT id, customer_name, customer_id, IFNULL(quotation_ref,'') AS quotation_ref FROM sales_receipts WHERE 1=1${bp.sql}
           AND (id LIKE ? ESCAPE '\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\'
                OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\')
           ORDER BY date_iso DESC, id DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'receipt',
          id: row.id,
          label: row.id,
          sublabel: row.customer_name,
          path: '/sales',
          state: { globalSearchQuery: row.id, focusSalesTab: 'receipts' },
        });
      }
    }
  }

  if (perm('procurement.view') || perm('purchase_orders.manage')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'purchase_orders', branchScope);
      const rows = db
        .prepare(
          `SELECT po_id, supplier_name, supplier_id FROM purchase_orders WHERE 1=1${bp.sql}
           AND (po_id LIKE ? ESCAPE '\\' OR IFNULL(supplier_name,'') LIKE ? ESCAPE '\\' OR IFNULL(supplier_id,'') LIKE ? ESCAPE '\\')
           ORDER BY order_date_iso DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'purchase_order',
          id: row.po_id,
          label: row.po_id,
          sublabel: row.supplier_name,
          path: '/procurement',
          state: { focusTab: 'purchases' },
        });
      }
    }
  }

  if (perm('procurement.view') || perm('purchase_orders.manage')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'suppliers', branchScope);
      const rows = db
        .prepare(
          `SELECT supplier_id, name, IFNULL(city,'') AS city FROM suppliers WHERE 1=1${bp.sql}
           AND (supplier_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR IFNULL(city,'') LIKE ? ESCAPE '\\')
           ORDER BY name COLLATE NOCASE LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, n);
      for (const s of rows) {
        push({
          kind: 'supplier',
          id: s.supplier_id,
          label: s.name,
          sublabel: s.supplier_id,
          path: `/procurement/suppliers/${encodeURIComponent(s.supplier_id)}`,
        });
      }
    }
  }

  if (perm('operations.view') || perm('production.manage')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'cutting_lists', branchScope);
      const rows = db
        .prepare(
          `SELECT id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id, IFNULL(quotation_ref,'') AS quotation_ref
           FROM cutting_lists WHERE 1=1${bp.sql}
           AND (id LIKE ? ESCAPE '\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\'
                OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\')
           ORDER BY date_iso DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'cutting_list',
          id: row.id,
          label: row.id,
          sublabel: row.customer_name,
          path: '/operations',
          state: { focusOpsTab: 'production', highlightCuttingListId: row.id },
        });
      }
    }
  }

  if (perm('operations.view') || perm('production.manage')) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'coil_lots', branchScope);
      const rows = db
        .prepare(
          `SELECT coil_no, product_id, IFNULL(po_id,'') AS po_id, IFNULL(supplier_name,'') AS supplier_name,
                  IFNULL(colour,'') AS colour, IFNULL(gauge_label,'') AS gauge_label
           FROM coil_lots WHERE 1=1${bp.sql}
           AND (coil_no LIKE ? ESCAPE '\\' OR product_id LIKE ? ESCAPE '\\' OR IFNULL(po_id,'') LIKE ? ESCAPE '\\'
                OR IFNULL(supplier_name,'') LIKE ? ESCAPE '\\' OR IFNULL(colour,'') LIKE ? ESCAPE '\\' OR IFNULL(gauge_label,'') LIKE ? ESCAPE '\\')
           ORDER BY received_at_iso DESC, coil_no DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'coil',
          id: row.coil_no,
          label: row.coil_no,
          sublabel: `${row.colour || '—'} · ${row.gauge_label || '—'} · ${row.product_id || ''}`,
          path: `/operations/coils/${encodeURIComponent(row.coil_no)}`,
        });
      }
    }
  }

  if (canSeeRefundsList(user)) {
    const n = room();
    if (n > 0) {
      const bp = branchPredicate(db, 'customer_refunds', branchScope);
      const rows = db
        .prepare(
          `SELECT refund_id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id,
                  IFNULL(quotation_ref,'') AS quotation_ref, IFNULL(product,'') AS product, IFNULL(reason_category,'') AS reason_category
           FROM customer_refunds WHERE 1=1${bp.sql}
           AND (refund_id LIKE ? ESCAPE '\\' OR IFNULL(customer_name,'') LIKE ? ESCAPE '\\' OR IFNULL(customer_id,'') LIKE ? ESCAPE '\\'
                OR IFNULL(quotation_ref,'') LIKE ? ESCAPE '\\' OR IFNULL(product,'') LIKE ? ESCAPE '\\' OR IFNULL(reason_category,'') LIKE ? ESCAPE '\\')
           ORDER BY requested_at_iso DESC LIMIT ?`
        )
        .all(...bp.args, likeArg, likeArg, likeArg, likeArg, likeArg, likeArg, n);
      for (const row of rows) {
        push({
          kind: 'refund',
          id: row.refund_id,
          label: row.refund_id,
          sublabel: row.customer_name,
          path: '/sales',
          state: { globalSearchQuery: row.refund_id, focusSalesTab: 'refund' },
        });
      }
    }
  }

  if (canReadProductsCatalog(user)) {
    const n = room();
    if (n > 0) {
      let rows;
      const cols = db.prepare(`PRAGMA table_info(products)`).all();
      const hasPb = cols.some((c) => c.name === 'branch_id');
      if (!hasPb || branchScope === 'ALL' || !branchScope) {
        const bp = branchPredicate(db, 'products', branchScope);
        rows = db
          .prepare(
            `SELECT product_id, name FROM products WHERE 1=1${bp.sql}
             AND (product_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
             ORDER BY name COLLATE NOCASE LIMIT ?`
          )
          .all(...bp.args, likeArg, likeArg, n);
      } else {
        rows = db
          .prepare(
            `SELECT product_id, name FROM products
             WHERE (branch_id = ? OR branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '')
             AND (product_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
             ORDER BY name COLLATE NOCASE LIMIT ?`
          )
          .all(branchScope, likeArg, likeArg, n);
      }
      for (const row of rows) {
        push({
          kind: 'product',
          id: row.product_id,
          label: row.name,
          sublabel: row.product_id,
          path: '/operations',
          state: { focusOpsTab: 'inventory', opsInventorySkuQuery: row.product_id },
        });
      }
    }
  }

  if (
    hrTablesReady(db) &&
    (userHasPermission(user, '*') ||
      userHasPermission(user, 'hr.directory.view') ||
      userHasPermission(user, 'hr.staff.manage'))
  ) {
    const n = room();
    if (n > 0) {
      const scope = hrListScope(req);
      const { viewAll, branchId } = scope;
      let sql = `
        SELECT u.id AS uid, u.display_name AS dn, u.username AS un, IFNULL(p.employee_no,'') AS eno
        FROM app_users u
        LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
        WHERE u.status = 'active'
        AND (
          u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR IFNULL(p.employee_no,'') LIKE ? ESCAPE '\\'
          OR IFNULL(p.department,'') LIKE ? ESCAPE '\\' OR IFNULL(p.job_title,'') LIKE ? ESCAPE '\\'
        )
      `;
      const args = [likeArg, likeArg, likeArg, likeArg, likeArg];
      if (!viewAll) {
        sql += ` AND p.branch_id = ?`;
        args.push(branchId);
      }
      sql += ` ORDER BY u.display_name COLLATE NOCASE LIMIT ?`;
      args.push(n);
      const rows = db.prepare(sql).all(...args);
      for (const row of rows) {
        push({
          kind: 'hr_staff',
          id: row.uid,
          label: row.dn || row.un,
          sublabel: row.eno || row.un,
          path: `/hr/staff/${encodeURIComponent(row.uid)}`,
        });
      }
    }
  }

  return results;
}
