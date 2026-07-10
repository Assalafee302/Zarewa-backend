import { branchPredicate } from './branchSql.js';
import {
  canReadFinanceDomain,
  canReadOperationsDomain,
  canReadProductionSnapshot,
  canReadProductsCatalog,
  canSeePaymentRequests,
  canSeeRefundsList,
} from './workspaceAccess.js';
import { userHasPermission } from './auth.js';
import { scoreWorkspaceSearchMatch } from '../shared/lib/workspaceSearchCore.js';

const SCHEMA_MIGRATION_FTS = 'workspace-search-fts-v1';
const INDEX_KIND_LIMIT = 2000;

/** @param {import('better-sqlite3').Database} db */
function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

/** @param {string} raw */
export function toFts5MatchQuery(raw) {
  const tokens = String(raw || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["'*?:\\]/g, '').trim())
    .filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/**
 * @param {import('express').Request['user']} user
 */
export function allowedWorkspaceSearchFtsKinds(user) {
  const perm = (p) => userHasPermission(user, '*') || userHasPermission(user, p);
  const kinds = [];
  if (perm('sales.view') || perm('customers.manage')) kinds.push('customer');
  if (perm('quotations.manage') || perm('sales.view')) kinds.push('quotation');
  if (perm('receipts.post') || perm('finance.view') || perm('sales.view')) kinds.push('receipt');
  if (perm('procurement.view') || perm('purchase_orders.manage')) {
    kinds.push('purchase_order', 'supplier');
  }
  if (perm('operations.view') || perm('production.manage')) {
    kinds.push('cutting_list', 'coil');
  }
  if (canReadProductionSnapshot(user)) kinds.push('production_job');
  if (canReadOperationsDomain(user)) kinds.push('delivery');
  if (canSeeRefundsList(user)) kinds.push('refund');
  if (canReadProductsCatalog(user)) kinds.push('product');
  if (canSeePaymentRequests(user)) kinds.push('payment_request');
  if (canReadFinanceDomain(user) || perm('expenses.create')) kinds.push('expense');
  if (
    userHasPermission(user, '*') ||
    userHasPermission(user, 'hr.directory.view') ||
    userHasPermission(user, 'hr.staff.manage')
  ) {
    kinds.push('hr_staff');
  }
  if (perm('finance.view')) kinds.push('gl_journal');
  return kinds;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function ensureWorkspaceSearchFtsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_search_misses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      context_path TEXT,
      user_id TEXT,
      branch_id TEXT,
      at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_search_misses_at ON workspace_search_misses(at_iso DESC);
  `);

  if (!tableExists(db, 'workspace_search_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE workspace_search_fts USING fts5(
        doc_id UNINDEXED,
        kind UNINDEXED,
        branch_id UNINDEXED,
        sublabel UNINDEXED,
        path UNINDEXED,
        state_json UNINDEXED,
        label,
        search_blob,
        tokenize='unicode61 remove_diacritics 1'
      );
    `);
  }
}

/** @param {import('better-sqlite3').Database} db */
export function workspaceSearchFtsReady(db) {
  try {
    if (!tableExists(db, 'workspace_search_fts')) return false;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM workspace_search_fts`).get();
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {string} branchId
 * @param {string} label
 * @param {string} sublabel
 * @param {string} path
 * @param {object | null | undefined} state
 * @param {string[]} searchFields
 */
function makeSearchDoc(kind, id, branchId, label, sublabel, path, state, searchFields) {
  return {
    doc_id: `${kind}:${id}`,
    kind,
    entity_id: id,
    branch_id: String(branchId || '').trim(),
    label: String(label || id),
    sublabel: String(sublabel || ''),
    path,
    state_json: state && Object.keys(state).length ? JSON.stringify(state) : '',
    search_blob: searchFields.map((f) => String(f ?? '').trim()).filter(Boolean).join(' '),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function collectWorkspaceSearchIndexDocs(db) {
  /** @type {ReturnType<typeof makeSearchDoc>[]} */
  const docs = [];

  if (tableExists(db, 'customers')) {
    const rows = db
      .prepare(
        `SELECT customer_id, name, phone_number, email, company_name, tier, crm_profile_notes, branch_id
         FROM customers ORDER BY name COLLATE NOCASE LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const c of rows) {
      docs.push(
        makeSearchDoc(
          'customer',
          c.customer_id,
          c.branch_id,
          c.name,
          c.customer_id,
          `/customers/${encodeURIComponent(c.customer_id)}`,
          null,
          [c.customer_id, c.name, c.phone_number, c.email, c.company_name, c.tier, c.crm_profile_notes]
        )
      );
    }
  }

  if (tableExists(db, 'quotations')) {
    const rows = db
      .prepare(
        `SELECT id, customer_name, customer_id, IFNULL(project_name,'') AS project_name, branch_id
         FROM quotations ORDER BY date_iso DESC, id DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'quotation',
          row.id,
          row.branch_id,
          row.id,
          row.customer_name,
          '/sales',
          { globalSearchQuery: row.id, focusSalesTab: 'quotations' },
          [row.id, row.customer_name, row.customer_id, row.project_name]
        )
      );
    }
  }

  if (tableExists(db, 'sales_receipts')) {
    const rows = db
      .prepare(
        `SELECT id, customer_name, customer_id, IFNULL(quotation_ref,'') AS quotation_ref, branch_id
         FROM sales_receipts ORDER BY date_iso DESC, id DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'receipt',
          row.id,
          row.branch_id,
          row.id,
          row.customer_name,
          '/sales',
          {
            globalSearchQuery: row.id,
            focusSalesTab: 'receipts',
            ...(row.quotation_ref ? { quotationRef: row.quotation_ref } : {}),
          },
          [row.id, row.customer_name, row.customer_id, row.quotation_ref]
        )
      );
    }
  }

  if (tableExists(db, 'purchase_orders')) {
    const rows = db
      .prepare(
        `SELECT po_id, supplier_name, supplier_id, branch_id FROM purchase_orders
         ORDER BY order_date_iso DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'purchase_order',
          row.po_id,
          row.branch_id,
          row.po_id,
          row.supplier_name,
          '/procurement',
          { focusTab: 'purchases' },
          [row.po_id, row.supplier_name, row.supplier_id]
        )
      );
    }
  }

  if (tableExists(db, 'suppliers')) {
    const rows = db
      .prepare(
        `SELECT supplier_id, name, IFNULL(city,'') AS city, IFNULL(supplier_profile_json,'') AS profile_json
         FROM suppliers ORDER BY name COLLATE NOCASE LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const s of rows) {
      docs.push(
        makeSearchDoc(
          'supplier',
          s.supplier_id,
          '',
          s.name,
          s.supplier_id,
          `/procurement/suppliers/${encodeURIComponent(s.supplier_id)}`,
          null,
          [s.supplier_id, s.name, s.city, s.profile_json]
        )
      );
    }
  }

  if (tableExists(db, 'cutting_lists')) {
    const rows = db
      .prepare(
        `SELECT id, IFNULL(customer_name,'') AS customer_name, IFNULL(customer_id,'') AS customer_id,
                IFNULL(quotation_ref,'') AS quotation_ref, branch_id
         FROM cutting_lists ORDER BY date_iso DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'cutting_list',
          row.id,
          row.branch_id,
          row.id,
          row.customer_name,
          '/operations',
          { focusOpsTab: 'production', highlightCuttingListId: row.id },
          [row.id, row.customer_name, row.customer_id, row.quotation_ref]
        )
      );
    }
  }

  if (tableExists(db, 'coil_lots')) {
    const rows = db
      .prepare(
        `SELECT coil_no, product_id, IFNULL(po_id,'') AS po_id, IFNULL(supplier_name,'') AS supplier_name,
                IFNULL(colour,'') AS colour, IFNULL(gauge_label,'') AS gauge_label, branch_id
         FROM coil_lots ORDER BY received_at_iso DESC, coil_no DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const lot of rows) {
      docs.push(
        makeSearchDoc(
          'coil',
          lot.coil_no,
          lot.branch_id,
          lot.coil_no,
          `${lot.colour || '—'} · ${lot.gauge_label || '—'} · ${lot.product_id || ''}`,
          `/operations/coils/${encodeURIComponent(lot.coil_no)}`,
          null,
          [lot.coil_no, lot.product_id, lot.po_id, lot.supplier_name, lot.colour, lot.gauge_label]
        )
      );
    }
  }

  if (tableExists(db, 'production_jobs')) {
    const rows = db
      .prepare(
        `SELECT job_id, IFNULL(customer_name,'') AS customer_name, IFNULL(quotation_ref,'') AS quotation_ref,
                IFNULL(product_name,'') AS product_name, branch_id
         FROM production_jobs ORDER BY created_at_iso DESC, job_id DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'production_job',
          row.job_id,
          row.branch_id,
          row.job_id,
          [row.customer_name, row.product_name].filter(Boolean).join(' · ') || row.quotation_ref,
          '/operations',
          { focusOpsTab: 'production', highlightProductionJobId: row.job_id },
          [row.job_id, row.customer_name, row.quotation_ref, row.product_name]
        )
      );
    }
  }

  if (tableExists(db, 'deliveries')) {
    const rows = db
      .prepare(
        `SELECT id, IFNULL(customer_name,'') AS customer_name, IFNULL(tracking_no,'') AS tracking_no,
                IFNULL(destination,'') AS destination, branch_id
         FROM deliveries ORDER BY id DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'delivery',
          row.id,
          row.branch_id,
          row.id,
          [row.customer_name, row.tracking_no || row.destination].filter(Boolean).join(' · '),
          '/operations',
          { focusOpsTab: 'deliveries', globalSearchQuery: row.id },
          [row.id, row.customer_name, row.tracking_no, row.destination]
        )
      );
    }
  }

  if (tableExists(db, 'customer_refunds')) {
    const rows = db
      .prepare(
        `SELECT refund_id, IFNULL(customer_name,'') AS customer_name, IFNULL(quotation_ref,'') AS quotation_ref, branch_id
         FROM customer_refunds ORDER BY requested_at_iso DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'refund',
          row.refund_id,
          row.branch_id,
          row.refund_id,
          row.customer_name,
          '/sales',
          { globalSearchQuery: row.refund_id, focusSalesTab: 'refund' },
          [row.refund_id, row.customer_name, row.quotation_ref]
        )
      );
    }
  }

  if (tableExists(db, 'products')) {
    const rows = db
      .prepare(`SELECT product_id, name, IFNULL(branch_id,'') AS branch_id FROM products ORDER BY name COLLATE NOCASE LIMIT ?`)
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'product',
          row.product_id,
          row.branch_id,
          row.name,
          row.product_id,
          '/operations',
          { focusOpsTab: 'inventory', opsInventorySkuQuery: row.product_id },
          [row.product_id, row.name]
        )
      );
    }
  }

  if (tableExists(db, 'payment_requests')) {
    const rows = db
      .prepare(
        `SELECT request_id, IFNULL(description,'') AS description, expense_id FROM payment_requests
         ORDER BY request_date DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'payment_request',
          row.request_id,
          '',
          row.request_id,
          row.description || row.expense_id,
          '/accounts',
          { accountsTab: 'payment-requests', highlightPaymentRequestId: row.request_id },
          [row.request_id, row.description, row.expense_id]
        )
      );
    }
  }

  if (tableExists(db, 'expenses')) {
    const rows = db
      .prepare(
        `SELECT expense_id, expense_type, category, reference, branch_id FROM expenses ORDER BY date DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'expense',
          row.expense_id,
          row.branch_id,
          row.expense_id,
          [row.category, row.expense_type].filter(Boolean).join(' · ') || row.reference,
          '/accounts',
          { accountsTab: 'expenses', highlightExpenseId: row.expense_id },
          [row.expense_id, row.expense_type, row.category, row.reference]
        )
      );
    }
  }

  if (tableExists(db, 'gl_journal_entries')) {
    const rows = db
      .prepare(
        `SELECT id, IFNULL(memo,'') AS memo, IFNULL(source_id,'') AS source_id, IFNULL(branch_id,'') AS branch_id
         FROM gl_journal_entries ORDER BY entry_date_iso DESC, id DESC LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'gl_journal',
          row.id,
          row.branch_id,
          row.id,
          row.memo || row.source_id || 'GL journal',
          '/accounts',
          { accountsTab: 'audit', highlightGlJournalId: row.id },
          [row.id, row.memo, row.source_id]
        )
      );
    }
  }

  if (tableExists(db, 'app_users')) {
    const rows = db
      .prepare(
        `SELECT u.id AS uid, u.display_name AS dn, u.username AS un, IFNULL(p.employee_no,'') AS eno,
                IFNULL(p.department,'') AS dept, IFNULL(p.job_title,'') AS title, IFNULL(p.branch_id,'') AS branch_id
         FROM app_users u
         LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.status = 'active'
         ORDER BY u.display_name COLLATE NOCASE LIMIT ?`
      )
      .all(INDEX_KIND_LIMIT);
    for (const row of rows) {
      docs.push(
        makeSearchDoc(
          'hr_staff',
          row.uid,
          row.branch_id,
          row.dn || row.un,
          row.eno || row.un,
          `/hr/staff/${encodeURIComponent(row.uid)}`,
          null,
          [row.dn, row.un, row.eno, row.dept, row.title]
        )
      );
    }
  }

  return docs;
}

/** @param {import('better-sqlite3').Database} db */
export function rebuildWorkspaceSearchFts(db) {
  ensureWorkspaceSearchFtsSchema(db);
  const docs = collectWorkspaceSearchIndexDocs(db);
  db.exec(`DELETE FROM workspace_search_fts`);
  const insert = db.prepare(
    `INSERT INTO workspace_search_fts(doc_id, kind, branch_id, sublabel, path, state_json, label, search_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const runBatch = db.transaction((rows) => {
    for (const d of rows) {
      insert.run(
        d.doc_id,
        d.kind,
        d.branch_id,
        d.sublabel,
        d.path,
        d.state_json,
        d.label,
        d.search_blob
      );
    }
  });
  runBatch(docs);
  return docs.length;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {string[]} allowedKinds
 * @param {string} rawQuery
 * @param {number} rowLimit
 */
export function queryWorkspaceSearchFts(db, branchScope, allowedKinds, rawQuery, rowLimit = 80) {
  const match = toFts5MatchQuery(rawQuery);
  if (!match || !allowedKinds.length) return [];

  const kinds = [...new Set(allowedKinds)];
  const kindPlaceholders = kinds.map(() => '?').join(', ');
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const branchSql =
    scope === 'ALL'
      ? ''
      : ` AND (branch_id IS NULL OR TRIM(branch_id) = '' OR branch_id = ?)`;
  const args = [match, ...kinds];
  if (scope !== 'ALL') args.push(scope);
  args.push(Math.min(200, Math.max(20, rowLimit)));

  const rows = db
    .prepare(
      `SELECT doc_id, kind, label, sublabel, path, state_json, search_blob, bm25(workspace_search_fts) AS fts_rank
       FROM workspace_search_fts
       WHERE workspace_search_fts MATCH ?
       AND kind IN (${kindPlaceholders})${branchSql}
       ORDER BY fts_rank
       LIMIT ?`
    )
    .all(...args);

  return rows.map((row) => {
    let state = null;
    if (row.state_json) {
      try {
        state = JSON.parse(row.state_json);
      } catch {
        state = null;
      }
    }
    const id = String(row.doc_id || '').split(':').slice(1).join(':') || row.label;
    const textScore = scoreWorkspaceSearchMatch(rawQuery, [row.label, row.search_blob, row.sublabel]);
    const ftsBoost = Math.max(0, 180 + Math.min(0, Number(row.fts_rank) || 0) * 8);
    return {
      kind: row.kind,
      id,
      label: row.label,
      sublabel: row.sublabel || undefined,
      path: row.path,
      state: state || undefined,
      _score: textScore + ftsBoost,
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ query: string, contextPath?: string, userId?: string, branchId?: string }} entry
 */
export function logWorkspaceSearchMiss(db, entry) {
  try {
    ensureWorkspaceSearchFtsSchema(db);
    db.prepare(
      `INSERT INTO workspace_search_misses (query, context_path, user_id, branch_id, at_iso) VALUES (?, ?, ?, ?, ?)`
    ).run(
      String(entry.query || '').slice(0, 200),
      String(entry.contextPath || '').slice(0, 120) || null,
      entry.userId || null,
      entry.branchId || null,
      new Date().toISOString()
    );
    db.prepare(
      `DELETE FROM workspace_search_misses WHERE id NOT IN (
         SELECT id FROM workspace_search_misses ORDER BY at_iso DESC LIMIT 5000
       )`
    ).run();
  } catch {
    /* non-fatal */
  }
}

export { SCHEMA_MIGRATION_FTS };
