import { mapLegacyExpenseCategoryToCanonical, isAllowedExpenseCategory } from '../shared/expenseCategories.js';
import { ensureEditApprovalTable } from './editApproval.js';
import { seedDefaultGlAccounts } from './glOps.js';
import { migrateGlReceiptPolicyMeta } from './receiptPolicyMetaOps.js';
import { migrateCreditExceptions } from './creditExceptionOps.js';
import { migrateTimestampStyleDocumentIds } from './migrateTimestampDocIds.js';
import { deriveProcurementKindFromPoLines, inferLineTypeFromProduct } from '../shared/lib/poLineTypes.js';
import { migrateMergeDuplicateSetupColours } from './colourDedupeMigrate.js';
import { migrateMergeDuplicateSuppliersOnBoot } from './supplierDedupeMigrate.js';
import { migrateMergeDuplicateHrStaffOnBoot } from './hrStaffDuplicateCleanupMigrate.js';
import { debugBootLog } from './debugBootLog.js';
import { migrateProductsBranchCompositeInventory } from './productBranchInventory.js';
import { migrateStockMovementsBranchId } from './stockMovementOps.js';
import { withMigrationLock } from './migrationLock.js';
import { migrateRepairCoilProductionBookDrift2026 } from './coilProductionBookMigrate.js';
import { seedZarewaOrgStandard } from './hrOrgSeed.js';
import { backfillStaffObligationsFromLoans } from './staffObligationOps.js';
import { backfillRecoveryObligationsFromSchedules } from './staffRecoveryObligationOps.js';
import { backfillStaffSalesCustomerNames } from './staffPurchaseCreditOps.js';
import { getHrPolicyPayload, updateHrPolicyPayload } from './hrBusinessRules.js';
import { recomputeAllStaffRoleCompliance } from './hrRoleComplianceOps.js';
import {
  SCHEMA_MIGRATION_FTS,
  ensureWorkspaceSearchFtsSchema,
  rebuildWorkspaceSearchFts,
} from './workspaceSearchFts.js';

const SCHEMA_MIGRATION_PO_LINE_TYPE = 'po-line-type-migrate-v4';
const SCHEMA_MIGRATION_PROCUREMENT_KIND = 'procurement-order-kind-v2';
const MIGRATION_RUN_BATCH = 400;

/** @param {import('better-sqlite3').Database} db */
function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS zarewa_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at_iso TEXT NOT NULL
    );
  `);
}

/** @param {import('better-sqlite3').Database} db */
function schemaMigrationDone(db, migrationId) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM zarewa_schema_migrations WHERE migration_id = ?`).get(migrationId)
    );
  } catch {
    return false;
  }
}

/** @param {import('better-sqlite3').Database} db */
function markSchemaMigrationDone(db, migrationId) {
  db.prepare(`REPLACE INTO zarewa_schema_migrations (migration_id, applied_at_iso) VALUES (?, ?)`).run(
    migrationId,
    new Date().toISOString()
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ sql: string; args?: unknown[] }[]} statements
 */
function runManyInBatches(db, statements, batchSize = MIGRATION_RUN_BATCH) {
  if (!statements.length) return;
  if (typeof db.runMany === 'function') {
    for (let i = 0; i < statements.length; i += batchSize) {
      db.runMany(statements.slice(i, i + batchSize));
    }
    return;
  }
  for (const stmt of statements) {
    db.prepare(stmt.sql).run(...(stmt.args || []));
  }
}

/** Fast SQL backfill for common PO line type patterns (avoids per-row synckit round trips). */
function bulkBackfillPurchaseOrderLineTypesSql(db) {
  const empty = `(line_type IS NULL OR TRIM(line_type) = '')`;
  db.exec(`UPDATE purchase_order_lines SET line_type = 'service' WHERE ${empty} AND product_id LIKE 'SVC-%'`);
  db.exec(`UPDATE purchase_order_lines SET line_type = 'accessory' WHERE ${empty} AND product_id LIKE 'ACC-%'`);
  db.exec(
    `UPDATE purchase_order_lines SET line_type = 'stone_flatsheet' WHERE ${empty} AND product_id LIKE 'STONE-FS-%'`
  );
  db.exec(
    `UPDATE purchase_order_lines SET line_type = 'stone_meter' WHERE ${empty} AND product_id LIKE 'STONE-%' AND product_id NOT LIKE 'STONE-FS-%'`
  );
  db.exec(`
    UPDATE purchase_order_lines SET line_type = 'coil_meter'
    WHERE ${empty}
      AND product_id IN ('COIL-ALU', 'PRD-102')
      AND (unit_price_per_kg_ngn IS NULL OR unit_price_per_kg_ngn <= 0)
      AND meters_offered IS NOT NULL AND meters_offered > 0
      AND qty_ordered IS NOT NULL AND ABS(qty_ordered - meters_offered) <= 0.001
  `);
  db.exec(`
    UPDATE purchase_order_lines SET line_type = 'coil_kg'
    WHERE ${empty} AND product_id IN ('COIL-ALU', 'PRD-102')
  `);
  db.exec(`UPDATE purchase_order_lines SET line_type = 'coil_kg' WHERE ${empty}`);
}

/**
 * Idempotent SQLite migrations for existing DB files (CREATE IF NOT EXISTS misses new columns).
 * @param {import('better-sqlite3').Database} db
 */
/** Drop broken/legacy material_incident indexes (shared hosting MariaDB). */
function repairMaterialIncidentIndexesMysql(db) {
  let hasTable = false;
  try {
    hasTable = db.prepare(`PRAGMA table_info(material_incidents)`).all().length > 0;
  } catch {
    return;
  }
  if (!hasTable) return;
  for (const idx of ['idx_material_incidents_pool', 'idx_material_incidents_branch_status']) {
    try {
      db.exec(`ALTER TABLE material_incidents DROP INDEX ${idx}`);
    } catch {
      try {
        db.exec(`DROP INDEX ${idx} ON material_incidents`);
      } catch {
        /* index missing or wrong table */
      }
    }
  }
  try {
    db.exec(`ALTER TABLE material_incident_lines DROP INDEX idx_material_incident_lines_incident`);
  } catch {
    try {
      db.exec(`DROP INDEX idx_material_incident_lines_incident ON material_incident_lines`);
    } catch {
      /* ignore */
    }
  }
}

export function runMigrations(db) {
  return withMigrationLock(db, () => runMigrationsUnlocked(db));
}

/** @param {import('better-sqlite3').Database} db */
function runMigrationsUnlocked(db) {
  repairMaterialIncidentIndexesMysql(db);
  ensureSchemaMigrationsTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS help_query_log (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      user_id TEXT,
      branch_id TEXT,
      role_key TEXT,
      pathname TEXT,
      query_text TEXT NOT NULL,
      matched_article_ids_json TEXT,
      source TEXT NOT NULL,
      top_score REAL NOT NULL DEFAULT 0,
      response_chars INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_help_query_log_occurred ON help_query_log(occurred_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_help_query_log_branch ON help_query_log(branch_id, occurred_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_help_query_log_user ON help_query_log(user_id, occurred_at_iso DESC);
  `);
  ensureEditApprovalTable(db);
  const tableCols = (name) => {
    try {
      const rows = db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ?`
        )
        .all(name);
      if (rows.length) {
        return new Set(
          rows
            .map((c) => String(c.column_name ?? c.COLUMN_NAME ?? c.Column_name ?? '').toLowerCase())
            .filter(Boolean)
        );
      }
    } catch {
      // SQLite development databases do not expose information_schema.
    }
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS help_rag_chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_json TEXT,
      embedding_model TEXT,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_help_rag_source ON help_rag_chunks(source_type, source_id);

    CREATE TABLE IF NOT EXISTS help_article_weights (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      article_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'aggregate',
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_help_article_weights_scope ON help_article_weights(scope_type, scope_id, article_id);

    CREATE TABLE IF NOT EXISTS help_user_memory (
      user_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      PRIMARY KEY (user_id, memory_key)
    );

    CREATE TABLE IF NOT EXISTS help_branch_memory (
      branch_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      PRIMARY KEY (branch_id, memory_key)
    );

    CREATE TABLE IF NOT EXISTS help_workflow_events (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      branch_id TEXT,
      event_type TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      payload_json TEXT,
      weight REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_help_workflow_events_branch ON help_workflow_events(branch_id, occurred_at_iso DESC);

    CREATE TABLE IF NOT EXISTS help_knowledge_gaps (
      id TEXT PRIMARY KEY,
      query_fingerprint TEXT NOT NULL,
      query_text TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      not_helpful_count INTEGER NOT NULL DEFAULT 0,
      branch_id TEXT,
      last_at_iso TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_help_knowledge_gaps_fp ON help_knowledge_gaps(query_fingerprint, branch_id);

    CREATE TABLE IF NOT EXISTS help_suggested_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      reason TEXT,
      branch_id TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS help_ai_observations (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      user_id TEXT,
      branch_id TEXT,
      route TEXT,
      query_text TEXT,
      source TEXT,
      response_ms INTEGER,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_help_ai_observations_time ON help_ai_observations(occurred_at_iso DESC);
  `);

  const hqlLogCols = tableCols('help_query_log');
  if (hqlLogCols.size) {
    if (!hqlLogCols.has('response_ms')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN response_ms INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hqlLogCols.has('client_draft_ms')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN client_draft_ms INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hqlLogCols.has('session_turn')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN session_turn INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hqlLogCols.has('read_ms')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN read_ms INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hqlLogCols.has('feedback')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN feedback TEXT`);
    }
    if (!hqlLogCols.has('follow_up')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hqlLogCols.has('link_clicked')) {
      db.exec(`ALTER TABLE help_query_log ADD COLUMN link_clicked INTEGER NOT NULL DEFAULT 0`);
    }
  }

  const hsaCols = tableCols('help_suggested_articles');
  if (hsaCols.size) {
    if (!hsaCols.has('reviewed_at_iso')) {
      db.exec(`ALTER TABLE help_suggested_articles ADD COLUMN reviewed_at_iso TEXT`);
    }
    if (!hsaCols.has('reviewed_by_user_id')) {
      db.exec(`ALTER TABLE help_suggested_articles ADD COLUMN reviewed_by_user_id TEXT`);
    }
  }

  const taCols = tableCols('treasury_accounts');
  if (taCols.size) {
    if (!taCols.has('account_officer_name')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN account_officer_name TEXT`);
    }
    if (!taCols.has('account_officer_phone')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN account_officer_phone TEXT`);
    }
    if (!taCols.has('bank_branch')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN bank_branch TEXT`);
    }
    if (!taCols.has('sort_code_or_swift')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN sort_code_or_swift TEXT`);
    }
    if (!taCols.has('notes')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN notes TEXT`);
    }
    if (!taCols.has('opening_balance_ngn')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN opening_balance_ngn INTEGER NOT NULL DEFAULT 0`);
      const accounts = db.prepare(`SELECT id, balance FROM treasury_accounts`).all();
      const sumStmt = db.prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`
      );
      const upd = db.prepare(`UPDATE treasury_accounts SET opening_balance_ngn = ? WHERE id = ?`);
      for (const a of accounts) {
        const mv = Number(sumStmt.get(a.id)?.s) || 0;
        const implied = Math.round(Number(a.balance) || 0) - mv;
        upd.run(Math.max(0, implied), a.id);
      }
    }
    if (!taCols.has('branch_id')) {
      db.exec(`ALTER TABLE treasury_accounts ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'BR-KD'`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_treasury_accounts_branch ON treasury_accounts(branch_id)`
      );
    }
  }

  const q = tableCols('quotations');
  if (!q.has('project_name')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN project_name TEXT`);
  }
  if (!q.has('lines_json')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN lines_json TEXT`);
  }
  if (!q.has('manager_cleared_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_cleared_at_iso TEXT`);
  }
  if (!q.has('manager_flagged_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_flagged_at_iso TEXT`);
  }
  if (!q.has('manager_flag_reason')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_flag_reason TEXT`);
  }
  if (!q.has('manager_production_approved_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_approved_at_iso TEXT`);
  }
  if (!q.has('manager_production_approved_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_approved_by_user_id TEXT`);
  }
  if (!q.has('manager_production_approved_by_name')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_approved_by_name TEXT`);
  }
  if (!q.has('manager_production_approval_note')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_approval_note TEXT`);
  }
  if (!q.has('manager_production_paid_fraction_at_approval')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_paid_fraction_at_approval REAL`);
  }
  if (!q.has('manager_production_approval_level')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN manager_production_approval_level TEXT`);
  }
  if (!q.has('md_price_exception_approved_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN md_price_exception_approved_at_iso TEXT`);
  }
  if (!q.has('md_price_exception_approved_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN md_price_exception_approved_by_user_id TEXT`);
  }
  if (!q.has('bm_price_exception_approved_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN bm_price_exception_approved_at_iso TEXT`);
  }
  if (!q.has('bm_price_exception_approved_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN bm_price_exception_approved_by_user_id TEXT`);
  }
  if (!q.has('price_exception_md_review_required')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN price_exception_md_review_required INTEGER NOT NULL DEFAULT 0`);
  }
  if (!q.has('payment_gate_basis_total_ngn')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_gate_basis_total_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (!q.has('price_exception_md_confirmed_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN price_exception_md_confirmed_at_iso TEXT`);
  }
  if (!q.has('price_exception_md_confirmed_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN price_exception_md_confirmed_by_user_id TEXT`);
  }
  if (!q.has('md_price_exception_snapshot_json')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN md_price_exception_snapshot_json TEXT`);
  }
  if (q.has('md_price_exception_approved_at_iso') && q.has('bm_price_exception_approved_at_iso')) {
    db.exec(`
      UPDATE quotations
      SET bm_price_exception_approved_at_iso = md_price_exception_approved_at_iso,
          bm_price_exception_approved_by_user_id = md_price_exception_approved_by_user_id,
          price_exception_md_confirmed_at_iso = COALESCE(price_exception_md_confirmed_at_iso, md_price_exception_approved_at_iso),
          price_exception_md_confirmed_by_user_id = COALESCE(price_exception_md_confirmed_by_user_id, md_price_exception_approved_by_user_id)
      WHERE TRIM(COALESCE(md_price_exception_approved_at_iso, '')) != ''
        AND TRIM(COALESCE(bm_price_exception_approved_at_iso, '')) = ''
    `);
  }
  if (!q.has('archived')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!q.has('quotation_lifecycle_note')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN quotation_lifecycle_note TEXT`);
  }
  if (!q.has('payment_balance_waived_ngn')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_balance_waived_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (!q.has('payment_balance_waived_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_balance_waived_at_iso TEXT`);
  }
  if (!q.has('payment_balance_waived_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_balance_waived_by_user_id TEXT`);
  }
  if (!q.has('payment_balance_waived_by_name')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_balance_waived_by_name TEXT`);
  }
  if (!q.has('payment_balance_waive_note')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN payment_balance_waive_note TEXT`);
  }
  if (!q.has('refunds_blocked_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN refunds_blocked_at_iso TEXT`);
  }
  if (!q.has('refunds_blocked_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN refunds_blocked_by_user_id TEXT`);
  }
  if (!q.has('refunds_blocked_by_name')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN refunds_blocked_by_name TEXT`);
  }
  if (!q.has('refunds_blocked_reason')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN refunds_blocked_reason TEXT`);
  }

  const r = tableCols('sales_receipts');
  if (!r.has('ledger_entry_id')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN ledger_entry_id TEXT`);
  }
  if (r.size && !r.has('bank_confirmed_at_iso')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN bank_confirmed_at_iso TEXT`);
  }
  if (r.size && !r.has('bank_confirmed_by_user_id')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN bank_confirmed_by_user_id TEXT`);
  }
  if (r.size && !r.has('bank_received_amount_ngn')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN bank_received_amount_ngn INTEGER`);
  }
  if (r.size && !r.has('finance_delivery_cleared_at_iso')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN finance_delivery_cleared_at_iso TEXT`);
  }
  if (r.size && !r.has('finance_delivery_cleared_by_user_id')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN finance_delivery_cleared_by_user_id TEXT`);
  }
  if (r.size && !r.has('finance_reconciliation_saved_at_iso')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN finance_reconciliation_saved_at_iso TEXT`);
  }
  if (r.size && !r.has('finance_reconciliation_saved_by_user_id')) {
    db.exec(`ALTER TABLE sales_receipts ADD COLUMN finance_reconciliation_saved_by_user_id TEXT`);
  }

  // Backfill receipt registrar from the ledger posting actor (legacy rows stored handled_by as '—').
  if (r.size && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'`).get()) {
    try {
      db.exec(
        `UPDATE sales_receipts
         SET handled_by = (
           SELECT TRIM(le.created_by_name)
           FROM ledger_entries le
           WHERE le.id = COALESCE(NULLIF(TRIM(sales_receipts.ledger_entry_id), ''), sales_receipts.id)
             AND TRIM(COALESCE(le.created_by_name, '')) != ''
           LIMIT 1
         )
         WHERE TRIM(COALESCE(handled_by, '')) IN ('', '—')
           AND EXISTS (
             SELECT 1 FROM ledger_entries le
             WHERE le.id = COALESCE(NULLIF(TRIM(sales_receipts.ledger_entry_id), ''), sales_receipts.id)
               AND TRIM(COALESCE(le.created_by_name, '')) != ''
           )`
      );
    } catch {
      /* best-effort */
    }
  }

  if (r.size) {
    db.exec(
      `UPDATE sales_receipts SET status = 'Cleared'
       WHERE finance_reconciliation_saved_at_iso IS NOT NULL
         AND TRIM(finance_reconciliation_saved_at_iso) != ''
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed', 'cleared'))`
    );
    // Legacy Confirmed = finance already signed off before Pending clearance / Cleared existed.
    db.exec(
      `UPDATE sales_receipts SET status = 'Cleared'
       WHERE TRIM(LOWER(COALESCE(status, ''))) = 'confirmed'`
    );
    db.exec(
      `UPDATE sales_receipts SET status = 'Pending clearance'
       WHERE (finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '')
         AND (status IS NULL OR TRIM(LOWER(status)) IN ('posted', ''))
         AND TRIM(LOWER(COALESCE(status, ''))) NOT IN ('reversed')`
    );
  }

  const ledger = tableCols('ledger_entries');
  if (!ledger.has('created_by_user_id')) {
    db.exec(`ALTER TABLE ledger_entries ADD COLUMN created_by_user_id TEXT`);
  }
  if (!ledger.has('created_by_name')) {
    db.exec(`ALTER TABLE ledger_entries ADD COLUMN created_by_name TEXT`);
  }

  const payReq = tableCols('payment_requests');
  if (!payReq.has('approved_by')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN approved_by TEXT`);
  }
  if (!payReq.has('approved_at_iso')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN approved_at_iso TEXT`);
  }
  if (!payReq.has('approval_note')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN approval_note TEXT`);
  }
  if (!payReq.has('paid_amount_ngn')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN paid_amount_ngn INTEGER DEFAULT 0`);
  }
  if (!payReq.has('paid_at_iso')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN paid_at_iso TEXT`);
  }
  if (!payReq.has('paid_by')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN paid_by TEXT`);
  }
  if (!payReq.has('payment_note')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN payment_note TEXT`);
  }
  if (!payReq.has('request_reference')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN request_reference TEXT`);
  }
  if (!payReq.has('line_items_json')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN line_items_json TEXT`);
  }
  if (!payReq.has('attachment_name')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN attachment_name TEXT`);
  }
  if (!payReq.has('attachment_mime')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN attachment_mime TEXT`);
  }
  if (!payReq.has('attachment_data_b64')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN attachment_data_b64 TEXT`);
  }
  if (!payReq.has('category_justification')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN category_justification TEXT`);
  }
  if (!payReq.has('payee_name')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN payee_name TEXT`);
  }
  if (!payReq.has('payee_account_no')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN payee_account_no TEXT`);
  }
  if (!payReq.has('payee_bank_name')) {
    db.exec(`ALTER TABLE payment_requests ADD COLUMN payee_bank_name TEXT`);
  }

  const expenses = tableCols('expenses');
  if (expenses.size && !expenses.has('category_lane')) {
    db.exec(`ALTER TABLE expenses ADD COLUMN category_lane TEXT`);
  }
  if (expenses.size) {
    db.prepare(`UPDATE expenses SET category = 'Others' WHERE TRIM(category) = 'Miscellaneous'`).run();
  }

  const deliveries = tableCols('deliveries');
  if (deliveries.size) {
    if (!deliveries.has('customer_id')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN customer_id TEXT`);
    }
    if (!deliveries.has('cutting_list_id')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN cutting_list_id TEXT`);
    }
    if (!deliveries.has('fulfillment_posted')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN fulfillment_posted INTEGER DEFAULT 0`);
    }
    if (!deliveries.has('satisfaction_score')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN satisfaction_score INTEGER`);
    }
    if (!deliveries.has('pod_confirmed_by_user_id')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN pod_confirmed_by_user_id TEXT`);
    }
    if (!deliveries.has('pod_confirmed_by_name')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN pod_confirmed_by_name TEXT`);
    }
    if (!deliveries.has('pod_collected_by_role')) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN pod_collected_by_role TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_shift_notes (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      note TEXT NOT NULL,
      note_kind TEXT DEFAULT 'night',
      gates_ok INTEGER DEFAULT 0,
      cctv_ok INTEGER DEFAULT 0,
      cash_ok INTEGER DEFAULT 0,
      keys_ok INTEGER DEFAULT 0,
      incident_code TEXT,
      attachment_ref TEXT,
      author_user_id TEXT,
      author_name TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_shift_notes_branch_date
      ON branch_shift_notes(branch_id, shift_date DESC);
  `);
  const shiftNotes = tableCols('branch_shift_notes');
  for (const [name, ddl] of [
    ['note_kind', `ALTER TABLE branch_shift_notes ADD COLUMN note_kind TEXT DEFAULT 'night'`],
    ['gates_ok', `ALTER TABLE branch_shift_notes ADD COLUMN gates_ok INTEGER DEFAULT 0`],
    ['cctv_ok', `ALTER TABLE branch_shift_notes ADD COLUMN cctv_ok INTEGER DEFAULT 0`],
    ['cash_ok', `ALTER TABLE branch_shift_notes ADD COLUMN cash_ok INTEGER DEFAULT 0`],
    ['keys_ok', `ALTER TABLE branch_shift_notes ADD COLUMN keys_ok INTEGER DEFAULT 0`],
    ['incident_code', `ALTER TABLE branch_shift_notes ADD COLUMN incident_code TEXT`],
    ['attachment_ref', `ALTER TABLE branch_shift_notes ADD COLUMN attachment_ref TEXT`],
  ]) {
    if (shiftNotes.size && !shiftNotes.has(name)) db.exec(ddl);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS checklist_events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      day_iso TEXT NOT NULL,
      item_id TEXT NOT NULL,
      note TEXT,
      author_user_id TEXT,
      author_name TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checklist_events_branch_day
      ON checklist_events(branch_id, day_iso DESC);
  `);

  const cutting = tableCols('cutting_lists');
  if (cutting.size) {
    if (!cutting.has('product_id')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN product_id TEXT`);
    }
    if (!cutting.has('product_name')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN product_name TEXT`);
    }
    if (!cutting.has('sheets_to_cut')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN sheets_to_cut REAL DEFAULT 0`);
    }
    if (!cutting.has('total_meters')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN total_meters REAL DEFAULT 0`);
    }
    if (!cutting.has('machine_name')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN machine_name TEXT`);
    }
    if (!cutting.has('operator_name')) {
      db.exec(`ALTER TABLE cutting_lists ADD COLUMN operator_name TEXT`);
    }
  }

  const clLines = tableCols('cutting_list_lines');
  if (clLines.size > 0 && !clLines.has('line_type')) {
    db.exec(`ALTER TABLE cutting_list_lines ADD COLUMN line_type TEXT`);
  }

  const prodJobs = tableCols('production_jobs');
  if (prodJobs.size > 0 && !prodJobs.has('operator_name')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN operator_name TEXT`);
  }

  const purchaseOrders = tableCols('purchase_orders');
  if (!purchaseOrders.has('transport_reference')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_reference TEXT`);
  }
  if (!purchaseOrders.has('transport_note')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_note TEXT`);
  }
  if (!purchaseOrders.has('transport_treasury_movement_id')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_treasury_movement_id TEXT`);
  }
  if (!purchaseOrders.has('transport_amount_ngn')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_amount_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (purchaseOrders.size > 0 && !purchaseOrders.has('transport_finance_advice')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_finance_advice TEXT`);
  }
  if (purchaseOrders.size > 0 && !purchaseOrders.has('transport_advance_ngn')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_advance_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (purchaseOrders.size > 0 && !purchaseOrders.has('transport_paid_ngn')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN transport_paid_ngn INTEGER NOT NULL DEFAULT 0`);
  }

  const coilLots = tableCols('coil_lots');
  if (!coilLots.has('colour')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN colour TEXT`);
  }
  if (!coilLots.has('gauge_label')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN gauge_label TEXT`);
  }
  if (!coilLots.has('material_type_name')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN material_type_name TEXT`);
  }
  if (!coilLots.has('supplier_expected_meters')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN supplier_expected_meters REAL`);
  }
  if (!coilLots.has('supplier_conversion_kg_per_m')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN supplier_conversion_kg_per_m REAL`);
  }
  if (!coilLots.has('qty_remaining')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN qty_remaining REAL NOT NULL DEFAULT 0`);
  }
  if (!coilLots.has('qty_reserved')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN qty_reserved REAL NOT NULL DEFAULT 0`);
  }
  if (!coilLots.has('current_weight_kg')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN current_weight_kg REAL NOT NULL DEFAULT 0`);
  }
  if (!coilLots.has('current_status')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN current_status TEXT NOT NULL DEFAULT 'Available'`);
  }
  db.exec(`
    UPDATE coil_lots
    SET qty_remaining = CASE
      WHEN qty_remaining IS NULL OR qty_remaining = 0 THEN COALESCE(weight_kg, qty_received, 0)
      ELSE qty_remaining
    END,
        current_weight_kg = CASE
          WHEN current_weight_kg IS NULL OR current_weight_kg = 0 THEN COALESCE(weight_kg, qty_received, 0)
          ELSE current_weight_kg
        END,
        qty_reserved = COALESCE(qty_reserved, 0),
        current_status = CASE
          WHEN COALESCE(qty_remaining, COALESCE(weight_kg, qty_received, 0)) <= 0 THEN 'Consumed'
          WHEN COALESCE(qty_reserved, 0) >= COALESCE(qty_remaining, COALESCE(weight_kg, qty_received, 0)) AND COALESCE(qty_reserved, 0) > 0 THEN 'Reserved'
          ELSE COALESCE(current_status, 'Available')
        END
  `);

  const productionJobs = tableCols('production_jobs');
  if (!productionJobs.has('actual_meters')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN actual_meters REAL NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('actual_weight_kg')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN actual_weight_kg REAL NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('conversion_alert_state')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN conversion_alert_state TEXT NOT NULL DEFAULT 'Pending'`);
  }
  if (!productionJobs.has('manager_review_required')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN manager_review_required INTEGER NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('manager_review_signed_at_iso')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN manager_review_signed_at_iso TEXT`);
  }
  if (!productionJobs.has('manager_review_signed_by_user_id')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN manager_review_signed_by_user_id TEXT`);
  }
  if (!productionJobs.has('manager_review_signed_by_name')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN manager_review_signed_by_name TEXT`);
  }
  if (!productionJobs.has('manager_review_remark')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN manager_review_remark TEXT`);
  }
  if (!productionJobs.has('conversion_variance_reason_code')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN conversion_variance_reason_code TEXT`);
  }
  if (!productionJobs.has('conversion_variance_reason_text')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN conversion_variance_reason_text TEXT`);
  }
  if (!productionJobs.has('conversion_variance_band')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN conversion_variance_band TEXT`);
  }
  if (!productionJobs.has('coil_spec_mismatch_pending')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN coil_spec_mismatch_pending INTEGER NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('offcut_inventory_meters')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN offcut_inventory_meters REAL NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('planned_roof_m')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN planned_roof_m REAL NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('planned_cladding_m')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN planned_cladding_m REAL NOT NULL DEFAULT 0`);
  }
  if (!productionJobs.has('planned_flatsheet_m')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN planned_flatsheet_m REAL NOT NULL DEFAULT 0`);
  }
  if (productionJobs.has('planned_roof_m')) {
    try {
      db.exec(`
        UPDATE production_jobs pj
        SET
          planned_roof_m = COALESCE((
            SELECT ROUND(SUM(CASE WHEN line_type = 'Roof' THEN total_m ELSE 0 END), 2)
            FROM cutting_list_lines WHERE cutting_list_id = pj.cutting_list_id
          ), 0),
          planned_cladding_m = COALESCE((
            SELECT ROUND(SUM(CASE WHEN line_type = 'Cladding' THEN total_m ELSE 0 END), 2)
            FROM cutting_list_lines WHERE cutting_list_id = pj.cutting_list_id
          ), 0),
          planned_flatsheet_m = COALESCE((
            SELECT ROUND(SUM(CASE WHEN line_type = 'Flatsheet' THEN total_m ELSE 0 END), 2)
            FROM cutting_list_lines WHERE cutting_list_id = pj.cutting_list_id
          ), 0)
        WHERE TRIM(COALESCE(pj.cutting_list_id, '')) != ''
          AND (COALESCE(pj.planned_roof_m, 0) = 0
            AND COALESCE(pj.planned_cladding_m, 0) = 0
            AND COALESCE(pj.planned_flatsheet_m, 0) = 0)
      `);
    } catch {
      /* best-effort backfill for legacy jobs */
    }
  }

  const pjc = tableCols('production_job_coils');
  if (pjc.size > 0 && !pjc.has('spec_mismatch')) {
    db.exec(`ALTER TABLE production_job_coils ADD COLUMN spec_mismatch INTEGER NOT NULL DEFAULT 0`);
  }

  /** Allow swapping coil numbers between lines on the same job during post-completion correction (app still enforces unique coils). */
  const hasPjcJobCoilUniq = db
    .prepare(
      'SELECT 1 AS `1` FROM information_schema.statistics ' +
        "WHERE table_schema = DATABASE() AND table_name = 'production_job_coils' AND index_name = ? LIMIT 1"
    )
    .get('idx_production_job_coils_job_coil');
  if (hasPjcJobCoilUniq) {
    try {
      db.exec(`ALTER TABLE production_job_coils DROP INDEX idx_production_job_coils_job_coil`);
    } catch {
      /* ignore */
    }
  }

  const refunds = tableCols('customer_refunds');
  // Legacy DBs: refunds table existed before workflow status column (listManagementItems filters on it).
  if (refunds.size > 0 && !refunds.has('status')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN status TEXT`);
  }
  if (!refunds.has('suggested_lines_json')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN suggested_lines_json TEXT`);
  }
  if (!refunds.has('approved_amount_ngn')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN approved_amount_ngn INTEGER`);
  }
  if (!refunds.has('paid_amount_ngn')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN paid_amount_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (!refunds.has('payment_note')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN payment_note TEXT`);
  }
  if (!refunds.has('requested_by_user_id')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN requested_by_user_id TEXT`);
  }
  if (!refunds.has('approved_by_user_id')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN approved_by_user_id TEXT`);
  }
  if (!refunds.has('paid_by_user_id')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN paid_by_user_id TEXT`);
  }
  if (!refunds.has('preview_snapshot_json')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN preview_snapshot_json TEXT`);
  }
  if (!refunds.has('payee_name')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN payee_name TEXT`);
  }
  if (!refunds.has('payee_account_no')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN payee_account_no TEXT`);
  }
  if (!refunds.has('payee_bank_name')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN payee_bank_name TEXT`);
  }
  if (refunds.size > 0 && !refunds.has('branch_id')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN branch_id TEXT`);
  }
  if (refunds.size > 0 && !refunds.has('production_alignment_ack_json')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN production_alignment_ack_json TEXT`);
  }
  if (refunds.size > 0 && !refunds.has('credit_applied_ngn')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN credit_applied_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  if (refunds.size > 0 && !refunds.has('credit_applied_to_quotation_ref')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN credit_applied_to_quotation_ref TEXT`);
  }
  if (refunds.size > 0 && !refunds.has('credit_confirmation_status')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN credit_confirmation_status TEXT`);
  }
  // Legacy index blocked multiple refund requests per quotation (product defaulted to "—").
  const hasRefundPendingIdx = db
    .prepare(
      'SELECT 1 AS `1` FROM information_schema.statistics ' +
        "WHERE table_schema = DATABASE() AND table_name = 'customer_refunds' AND index_name = ? LIMIT 1"
    )
    .get('idx_customer_refunds_single_pending');
  if (hasRefundPendingIdx) {
    db.exec(`ALTER TABLE customer_refunds DROP INDEX idx_customer_refunds_single_pending`);
  }
  db.exec(`
    UPDATE customer_refunds
    SET suggested_lines_json = CASE
      WHEN suggested_lines_json IS NULL OR suggested_lines_json = '' THEN calculation_lines_json
      ELSE suggested_lines_json
    END,
        approved_amount_ngn = CASE
          WHEN status IN ('Approved', 'Paid') AND (approved_amount_ngn IS NULL OR approved_amount_ngn = 0) THEN amount_ngn
          ELSE approved_amount_ngn
        END,
        paid_amount_ngn = CASE
          WHEN status = 'Paid' AND COALESCE(paid_amount_ngn, 0) = 0 THEN amount_ngn
          ELSE COALESCE(paid_amount_ngn, 0)
        END
  `);

  const brl = tableCols('bank_reconciliation_lines');
  if (brl.size > 0) {
    if (!brl.has('settled_amount_ngn')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN settled_amount_ngn INTEGER`);
    }
    if (!brl.has('matched_system_amount_ngn')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN matched_system_amount_ngn INTEGER`);
    }
    if (!brl.has('variance_ngn')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN variance_ngn INTEGER`);
    }
    if (!brl.has('variance_percent')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN variance_percent REAL`);
    }
    if (!brl.has('treasury_account_id')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN treasury_account_id INTEGER`);
    }
    if (!brl.has('treasury_adjustment_movement_id')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN treasury_adjustment_movement_id TEXT`);
    }
    if (!brl.has('manager_cleared_at_iso')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN manager_cleared_at_iso TEXT`);
    }
    if (!brl.has('manager_cleared_by_user_id')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN manager_cleared_by_user_id TEXT`);
    }
    if (!brl.has('manager_cleared_by_name')) {
      db.exec(`ALTER TABLE bank_reconciliation_lines ADD COLUMN manager_cleared_by_name TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_deposits (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      bank_date_iso TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      allocated_ngn INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      bank_reference TEXT,
      treasury_account_id INTEGER NOT NULL,
      treasury_movement_id TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      reserved_at_iso TEXT,
      reserved_by_user_id TEXT,
      reserved_by_name TEXT,
      reserved_until_iso TEXT,
      registered_at_iso TEXT NOT NULL,
      registered_by_user_id TEXT,
      registered_by_name TEXT,
      note TEXT,
      bank_recon_line_id TEXT,
      reversed_at_iso TEXT,
      reversed_by_user_id TEXT,
      reversed_by_name TEXT,
      reclass_kind TEXT,
      reclass_note TEXT,
      reclassified_at_iso TEXT,
      reclassified_by_user_id TEXT,
      reclassified_by_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bank_deposits_branch_status ON bank_deposits(branch_id, status);

    CREATE TABLE IF NOT EXISTS bank_deposit_allocations (
      id TEXT PRIMARY KEY,
      bank_deposit_id TEXT NOT NULL,
      allocated_to_kind TEXT NOT NULL,
      allocated_to_id TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      allocated_at_iso TEXT NOT NULL,
      allocated_by_user_id TEXT,
      allocated_by_name TEXT,
      FOREIGN KEY (bank_deposit_id) REFERENCES bank_deposits(id)
    );
    CREATE INDEX IF NOT EXISTS idx_bank_deposit_alloc_deposit ON bank_deposit_allocations(bank_deposit_id);
  `);

  const bankDeposits = tableCols('bank_deposits');
  if (bankDeposits.size > 0) {
    if (!bankDeposits.has('reversed_by_name')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reversed_by_name TEXT`);
    }
    if (!bankDeposits.has('reclass_kind')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reclass_kind TEXT`);
    }
    if (!bankDeposits.has('reclass_note')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reclass_note TEXT`);
    }
    if (!bankDeposits.has('reclassified_at_iso')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reclassified_at_iso TEXT`);
    }
    if (!bankDeposits.has('reclassified_by_user_id')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reclassified_by_user_id TEXT`);
    }
    if (!bankDeposits.has('reclassified_by_name')) {
      db.exec(`ALTER TABLE bank_deposits ADD COLUMN reclassified_by_name TEXT`);
    }
  }

  const customers = tableCols('customers');
  if (!customers.has('company_name')) {
    db.exec(`ALTER TABLE customers ADD COLUMN company_name TEXT`);
  }
  if (!customers.has('lead_source')) {
    db.exec(`ALTER TABLE customers ADD COLUMN lead_source TEXT`);
  }
  if (!customers.has('preferred_contact')) {
    db.exec(`ALTER TABLE customers ADD COLUMN preferred_contact TEXT`);
  }
  if (!customers.has('follow_up_iso')) {
    db.exec(`ALTER TABLE customers ADD COLUMN follow_up_iso TEXT`);
  }
  if (!customers.has('crm_tags_json')) {
    db.exec(`ALTER TABLE customers ADD COLUMN crm_tags_json TEXT`);
  }
  if (!customers.has('crm_profile_notes')) {
    db.exec(`ALTER TABLE customers ADD COLUMN crm_profile_notes TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_crm_interactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      at_iso TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT,
      detail TEXT NOT NULL,
      created_by_name TEXT,
      branch_id TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crm_interactions_customer ON customer_crm_interactions(customer_id, at_iso DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_complaints (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'low',
      description TEXT NOT NULL,
      linked_order_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to_user_id TEXT,
      opened_by_user_id TEXT,
      opened_by_name TEXT,
      opened_at_iso TEXT NOT NULL,
      resolution_note TEXT,
      resolved_at_iso TEXT,
      resolved_by_user_id TEXT,
      related_refund_id TEXT,
      related_payment_request_id TEXT,
      updated_at_iso TEXT,
      data_json TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_customer_complaints_branch_status
      ON customer_complaints(branch_id, status, opened_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_complaints_customer
      ON customer_complaints(customer_id, opened_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_complaints_assignee
      ON customer_complaints(assigned_to_user_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_movements (
      id TEXT PRIMARY KEY,
      posted_at_iso TEXT NOT NULL,
      type TEXT NOT NULL,
      treasury_account_id INTEGER NOT NULL,
      amount_ngn INTEGER NOT NULL,
      reference TEXT,
      counterparty_kind TEXT,
      counterparty_id TEXT,
      counterparty_name TEXT,
      source_kind TEXT,
      source_id TEXT,
      note TEXT,
      created_by TEXT,
      reverses_movement_id TEXT,
      batch_id TEXT,
      FOREIGN KEY (treasury_account_id) REFERENCES treasury_accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_treasury_movements_account ON treasury_movements(treasury_account_id);
    CREATE INDEX IF NOT EXISTS idx_treasury_movements_source ON treasury_movements(source_kind, source_id);

    CREATE TABLE IF NOT EXISTS cutting_list_lines (
      cutting_list_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      sheets REAL NOT NULL DEFAULT 0,
      length_m REAL NOT NULL DEFAULT 0,
      total_m REAL NOT NULL DEFAULT 0,
      line_type TEXT,
      PRIMARY KEY (cutting_list_id, sort_order),
      FOREIGN KEY (cutting_list_id) REFERENCES cutting_lists(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS production_jobs (
      job_id TEXT PRIMARY KEY,
      cutting_list_id TEXT,
      quotation_ref TEXT,
      customer_id TEXT,
      customer_name TEXT,
      product_id TEXT,
      product_name TEXT,
      planned_meters REAL DEFAULT 0,
      planned_sheets REAL DEFAULT 0,
      planned_roof_m REAL NOT NULL DEFAULT 0,
      planned_cladding_m REAL NOT NULL DEFAULT 0,
      planned_flatsheet_m REAL NOT NULL DEFAULT 0,
      machine_name TEXT,
      start_date_iso TEXT,
      end_date_iso TEXT,
      materials_note TEXT,
      operator_name TEXT,
      status TEXT NOT NULL DEFAULT 'Planned',
      created_at_iso TEXT NOT NULL,
      completed_at_iso TEXT,
      actual_meters REAL NOT NULL DEFAULT 0,
      actual_weight_kg REAL NOT NULL DEFAULT 0,
      conversion_alert_state TEXT NOT NULL DEFAULT 'Pending',
      manager_review_required INTEGER NOT NULL DEFAULT 0,
      manager_review_signed_at_iso TEXT,
      manager_review_signed_by_user_id TEXT,
      manager_review_signed_by_name TEXT,
      manager_review_remark TEXT,
      conversion_variance_reason_code TEXT,
      conversion_variance_reason_text TEXT,
      conversion_variance_band TEXT,
      coil_spec_mismatch_pending INTEGER NOT NULL DEFAULT 0,
      offcut_inventory_meters REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (cutting_list_id) REFERENCES cutting_lists(id)
    );

    CREATE TABLE IF NOT EXISTS production_job_coils (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      coil_no TEXT NOT NULL,
      product_id TEXT,
      colour TEXT,
      gauge_label TEXT,
      opening_weight_kg REAL NOT NULL DEFAULT 0,
      closing_weight_kg REAL NOT NULL DEFAULT 0,
      consumed_weight_kg REAL NOT NULL DEFAULT 0,
      meters_produced REAL NOT NULL DEFAULT 0,
      actual_conversion_kg_per_m REAL,
      allocation_status TEXT NOT NULL DEFAULT 'Allocated',
      spec_mismatch INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      allocated_at_iso TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES production_jobs(job_id) ON DELETE CASCADE,
      FOREIGN KEY (coil_no) REFERENCES coil_lots(coil_no)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_production_job_coils_job_coil
      ON production_job_coils(job_id, coil_no);

    CREATE TABLE IF NOT EXISTS production_conversion_checks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      coil_no TEXT NOT NULL,
      gauge_label TEXT,
      material_type_name TEXT,
      actual_conversion_kg_per_m REAL,
      standard_conversion_kg_per_m REAL,
      supplier_conversion_kg_per_m REAL,
      gauge_history_avg_kg_per_m REAL,
      coil_history_avg_kg_per_m REAL,
      alert_state TEXT NOT NULL DEFAULT 'OK',
      manager_review_required INTEGER NOT NULL DEFAULT 0,
      variance_summary_json TEXT,
      checked_at_iso TEXT NOT NULL,
      note TEXT,
      FOREIGN KEY (job_id) REFERENCES production_jobs(job_id) ON DELETE CASCADE,
      FOREIGN KEY (coil_no) REFERENCES coil_lots(coil_no)
    );

    CREATE INDEX IF NOT EXISTS idx_production_conversion_checks_job
      ON production_conversion_checks(job_id, checked_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_production_conversion_checks_gauge
      ON production_conversion_checks(gauge_label, checked_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_production_conversion_checks_coil
      ON production_conversion_checks(coil_no, checked_at_iso DESC);

    CREATE TABLE IF NOT EXISTS setup_quote_items (
      item_id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unit',
      default_unit_price_ngn INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      inventory_product_id TEXT
    );

    CREATE TABLE IF NOT EXISTS setup_colours (
      colour_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      abbreviation TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS setup_gauges (
      gauge_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      gauge_mm REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS setup_material_types (
      material_type_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      density_kg_per_m3 REAL NOT NULL DEFAULT 0,
      width_m REAL NOT NULL DEFAULT 1.2,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      inventory_model TEXT NOT NULL DEFAULT 'coil_kg'
    );

    CREATE TABLE IF NOT EXISTS setup_profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      material_type_id TEXT
    );

    CREATE TABLE IF NOT EXISTS setup_price_lists (
      price_id TEXT PRIMARY KEY,
      quote_item_id TEXT,
      item_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unit',
      unit_price_ngn INTEGER NOT NULL DEFAULT 0,
      gauge_id TEXT,
      colour_id TEXT,
      material_type_id TEXT,
      profile_id TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (quote_item_id) REFERENCES setup_quote_items(item_id)
    );

    CREATE TABLE IF NOT EXISTS setup_expense_categories (
      category_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS delivery_lines (
      delivery_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT,
      qty REAL NOT NULL DEFAULT 0,
      unit TEXT,
      cutting_list_line_no INTEGER,
      PRIMARY KEY (delivery_id, sort_order),
      FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_key TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at_iso TEXT,
      created_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      last_seen_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at_iso);

    CREATE TABLE IF NOT EXISTS accounting_period_locks (
      period_key TEXT PRIMARY KEY,
      locked_from_iso TEXT NOT NULL,
      locked_at_iso TEXT NOT NULL,
      locked_by_user_id TEXT,
      locked_by_name TEXT,
      reason TEXT,
      FOREIGN KEY (locked_by_user_id) REFERENCES app_users(id)
    );

    CREATE TABLE IF NOT EXISTS approval_actions (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      acted_at_iso TEXT NOT NULL,
      acted_by_user_id TEXT,
      acted_by_name TEXT,
      FOREIGN KEY (acted_by_user_id) REFERENCES app_users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_actions_entity
      ON approval_actions(entity_kind, entity_id, acted_at_iso DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      actor_user_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      entity_kind TEXT,
      entity_id TEXT,
      status TEXT NOT NULL,
      note TEXT,
      details_json TEXT,
      FOREIGN KEY (actor_user_id) REFERENCES app_users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(occurred_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, occurred_at_iso DESC);
  `);

  migrateBranches(db);
  migrateCanonicalBranchIds(db);
  migrateTimestampStyleDocumentIds(db);
  migrateCoilMaterialOps(db);
  migrateCoilControlEvents(db);
  migrateWorkflowExtensions(db);
  migrateWipBalancesBranchComposite(db);
  migratePrd101ToCoilAlu(db);
  migrateMaterialTypeLabels(db);
  migrateProcurementCoilMaterials(db);
  migrateCoilSkuProductsBranchGlobal(db);
  migrateProductsBranchCompositeInventory(db);
  migrateMaterialPricingWorkbook(db);
  migratePricingPolicy2026(db);
  migrateLedgerPerformanceIndexes(db);
  migrateRefundCreditApplications(db);
  migrateUserProfileAndPasswordReset(db);
  migrateRepairMustChangePasswordLoop2026(db);
  migrateLoginSecurityPhase12(db);
  migrateOrganisationRoles2026(db);
  migrateHrStaffProfileColumns(db);
  migrateAccountingLayer(db);
  migrateGlReceiptPolicyMeta(db);
  migrateCreditExceptions(db);
  migrateExpenseCategoriesToCanonical(db);
  migrateAccessoryOperations(db);
  migratePriceListAndPayrollMd(db);
  migrateProductionCompletionAdjustments(db);
  migrateQuotationLineCatalog2026(db);
  migrateLinkUnpricedQuoteItems2026(db);
  migrateCoilAluzincColours2026(db);
  migrateMergeDuplicateSetupColours(db);
  migrateMergeDuplicateSuppliersOnBoot(db);
  migrateMergeDuplicateHrStaffOnBoot(db);
  migrateStoneCoatedAndPricingArch(db);
  migrateStoneFlatsheetLength15To14(db);
  migrateRoofingProfileCatalog2026(db);
  migrateEnsureQuotationMaterialTypes(db);
  migratePurchaseOrderLineType(db);
  migrateProcurementOrderKind(db);
  migrateHrExcellence2026(db);
  migrateWorkspaceSearchIndexes(db);
  migrateWorkspaceSearchFts2026(db);
  migrateInterBranchLoans(db);
  migrateOfficeDesk(db);
  migrateOfficeThreadFiling(db);
  migrateUnifiedWorkspaceRegistry(db);
  migrateOperationsMaintenanceWorkspace(db);
  migrateOfficeOperations2026(db);
  migrateWorkspaceCommandCenter2026(db);
  migrateOnlineOfficeDesk2026(db);
  migrateIntegrationApiKeys(db);
  migrateInventoryCoilSnapshots(db);
  migrateStockRegister2026(db);
  migrateStockMovementsBranchId(db);
  try {
    debugBootLog({ hypothesisId: 'A', location: 'migrate.js', message: 'migrateMaterialIncidents start' });
    migrateMaterialIncidents(db);
    debugBootLog({ hypothesisId: 'A', location: 'migrate.js', message: 'migrateMaterialIncidents ok' });
  } catch (e) {
    debugBootLog({
      hypothesisId: 'A',
      location: 'migrate.js',
      message: 'migrateMaterialIncidents failed',
      data: { err: String(e?.message || e), code: e?.code, errno: e?.errno },
    });
    throw e;
  }
  migrateHrAccountability2026(db);
  migrateStaffObligationLedger2026(db);
  migrateStaffPurchaseCredit2026(db);
  migrateStaffRecoveryObligation2026(db);
  migrateStaffObligationPause2026(db);
  migrateHrStaffDirectoryViews2026(db);
  migratePayrollPeriodUnique2026(db);
  try {
    migrateRepairCoilProductionBookDrift2026(db);
  } catch (e) {
    console.warn('[migrate] coil production book repair skipped:', e?.message || e);
  }
  migrateAiKnowledgeCenter(db);
  migrateAiIntelligenceRouter(db);
  migrateAiAutomationEngine(db);
  migrateWorkspaceV3Rooms(db);
  try {
    seedZarewaOrgStandard(db);
  } catch (e) {
    console.warn('[migrate] seedZarewaOrgStandard skipped:', e?.message || e);
  }
  migrateMobileAuth2026(db);
  migrateMaintenanceRegistry2026(db);
  migrateOtModule2026(db);
  migrateHrRoleComplianceLifecycle2026(db);
}

/**
 * Branch OT pay requests (storekeeper → BM → cashier).
 * Additive — does not touch hr_daily_roll_calls / attendance OT board.
 */
function migrateOtModule2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ot_requests (
      id TEXT PRIMARY KEY,
      day_iso TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      work_type TEXT NOT NULL,
      reason TEXT,
      quotation_ref TEXT,
      production_job_id TEXT,
      po_id TEXT,
      coil_lot_ref TEXT,
      approval_before_start INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by_user_id TEXT,
      created_by_name TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      submitted_at_iso TEXT,
      approved_by_user_id TEXT,
      approved_by_name TEXT,
      approved_at_iso TEXT,
      rejected_by_user_id TEXT,
      rejected_by_name TEXT,
      rejected_at_iso TEXT,
      rejection_reason TEXT,
      paid_by_user_id TEXT,
      paid_by_name TEXT,
      paid_at_iso TEXT,
      payment_note TEXT,
      payment_method TEXT,
      total_payable_ngn INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ot_requests_branch_status
      ON ot_requests(branch_id, status, day_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ot_requests_branch_day
      ON ot_requests(branch_id, day_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ot_requests_quotation_ref
      ON ot_requests(quotation_ref);
    CREATE INDEX IF NOT EXISTS idx_ot_requests_po_id
      ON ot_requests(po_id);

    CREATE TABLE IF NOT EXISTS ot_staff_lines (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      staff_user_id TEXT NOT NULL,
      role_label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES ot_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (staff_user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ot_staff_lines_request
      ON ot_staff_lines(request_id, sort_order);

    CREATE TABLE IF NOT EXISTS ot_work_details (
      request_id TEXT PRIMARY KEY,
      material_type TEXT,
      work_done TEXT,
      quantity REAL,
      quantity_unit TEXT,
      machine_area TEXT,
      actual_completion_time TEXT,
      factory_locked_by TEXT,
      FOREIGN KEY (request_id) REFERENCES ot_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ot_payment_line (
      request_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      rate_requested INTEGER NOT NULL DEFAULT 0,
      rate_approved INTEGER,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      remarks TEXT,
      variance_reason TEXT,
      FOREIGN KEY (request_id) REFERENCES ot_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ot_status_history (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_user_id TEXT,
      actor_name TEXT,
      actor_role TEXT,
      note TEXT,
      details_json TEXT,
      at_iso TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES ot_requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ot_status_history_request
      ON ot_status_history(request_id, at_iso ASC);
  `);
}

/** Maintenance vendors registry + technician flags on staff profiles. */
function migrateMaintenanceRegistry2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_vendors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      specialty TEXT NOT NULL DEFAULT 'general',
      branches_served_json TEXT NOT NULL DEFAULT '[]',
      bank_details_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_vendors_status_name
      ON maintenance_vendors(status, name);
  `);

  const woCols = db.prepare(`PRAGMA table_info(maintenance_work_orders)`).all().map((c) => c.name);
  if (!woCols.includes('vendor_id')) {
    db.exec(`ALTER TABLE maintenance_work_orders ADD COLUMN vendor_id TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_maintenance_work_orders_vendor
       ON maintenance_work_orders(vendor_id)`
    );
  }

  const hrCols = db.prepare(`PRAGMA table_info(hr_staff_profiles)`).all().map((c) => c.name);
  if (!hrCols.includes('is_technician')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN is_technician INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hrCols.includes('technician_specialty')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN technician_specialty TEXT`);
  }

  try {
    // Inline seed — avoid circular import; designation ids match shared/maintenanceRegistry.js
    const iso = new Date().toISOString();
    const designationIds = ['desig_mtech', 'desig_amtech', 'desig_msup'];
    const placeholders = designationIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE hr_staff_profiles
       SET is_technician = 1,
           technician_specialty = COALESCE(NULLIF(TRIM(technician_specialty), ''), 'general'),
           updated_at_iso = ?
       WHERE designation_id IN (${placeholders})
         AND COALESCE(is_technician, 0) = 0`
    ).run(iso, ...designationIds);
  } catch (e) {
    console.warn('[migrate] technician seed skipped:', e?.message || e);
  }
}

/** Zarewa mobile companion — bearer tokens + device registry (push later). */
function migrateMobileAuth2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL,
      device_id TEXT,
      device_name TEXT,
      platform TEXT,
      created_at_iso TEXT NOT NULL,
      last_seen_at_iso TEXT NOT NULL,
      access_expires_at_iso TEXT NOT NULL,
      refresh_expires_at_iso TEXT NOT NULL,
      revoked_at_iso TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_auth_access_hash ON mobile_auth_sessions(access_token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_auth_refresh_hash ON mobile_auth_sessions(refresh_token_hash);
    CREATE INDEX IF NOT EXISTS idx_mobile_auth_user ON mobile_auth_sessions(user_id, revoked_at_iso);

    CREATE TABLE IF NOT EXISTS mobile_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      platform TEXT,
      fcm_token TEXT,
      registered_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_devices_user_device ON mobile_devices(user_id, device_id);
  `);
}

/** Workspace V3 — rooms, activity, presence (Teams-style Online Office). */
function migrateWorkspaceV3Rooms(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_rooms (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      branch_id TEXT,
      department_key TEXT,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_rooms_branch_slug ON workspace_rooms(branch_id, slug);
    CREATE INDEX IF NOT EXISTS idx_workspace_rooms_scope ON workspace_rooms(scope_kind, updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS workspace_room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at_iso TEXT NOT NULL,
      muted_until_iso TEXT,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES workspace_rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_room_threads (
      room_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_at_iso TEXT,
      PRIMARY KEY (room_id, thread_id),
      FOREIGN KEY (room_id) REFERENCES workspace_rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES office_threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_activity_events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      actor_user_id TEXT,
      event_kind TEXT NOT NULL,
      target_kind TEXT,
      target_id TEXT,
      summary_text TEXT NOT NULL,
      payload_json TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_activity_branch ON workspace_activity_events(branch_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS workspace_activity_reads (
      user_id TEXT PRIMARY KEY,
      last_read_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_mentions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      mentioned_user_id TEXT,
      mentioned_role_key TEXT,
      room_id TEXT,
      thread_id TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_mentions_user ON workspace_mentions(mentioned_user_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS workspace_presence (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'offline',
      branch_id TEXT,
      desk_key TEXT,
      last_seen_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
  `);

  const threadCols = new Set(db.prepare(`PRAGMA table_info(office_threads)`).all().map((c) => c.name));
  if (!threadCols.has('conversation_mode')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'memo'`);
  }
  if (!threadCols.has('room_id')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN room_id TEXT`);
  }
  if (!threadCols.has('is_pinned')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!threadCols.has('pinned_work_item_id')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN pinned_work_item_id TEXT`);
  }

  const memberCols = new Set(
    db.prepare(`PRAGMA table_info(workspace_room_members)`).all().map((c) => c.name)
  );
  if (!memberCols.has('muted_until_iso')) {
    db.exec(`ALTER TABLE workspace_room_members ADD COLUMN muted_until_iso TEXT`);
  }

  const msgCols = new Set(db.prepare(`PRAGMA table_info(office_messages)`).all().map((c) => c.name));
  if (!msgCols.has('parent_message_id')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN parent_message_id TEXT`);
  }
  if (!msgCols.has('mentions_json')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN mentions_json TEXT`);
  }
  if (!msgCols.has('attachments_json')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN attachments_json TEXT`);
  }
  if (!msgCols.has('work_card_json')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN work_card_json TEXT`);
  }
  if (!msgCols.has('edited_at_iso')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN edited_at_iso TEXT`);
  }
  if (!msgCols.has('deleted_at_iso')) {
    db.exec(`ALTER TABLE office_messages ADD COLUMN deleted_at_iso TEXT`);
  }

  try {
    const wiCols = new Set(db.prepare(`PRAGMA table_info(work_items)`).all().map((c) => c.name));
    if (!wiCols.has('origin_room_id')) {
      db.exec(`ALTER TABLE work_items ADD COLUMN origin_room_id TEXT`);
    }
    if (!wiCols.has('origin_message_id')) {
      db.exec(`ALTER TABLE work_items ADD COLUMN origin_message_id TEXT`);
    }
  } catch {
    /* work_items may not exist in some test DBs */
  }

  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_rooms_scope_slug_unique
       ON workspace_rooms(scope_kind, IFNULL(branch_id, ''), slug)`
    );
  } catch {
    /* index may already exist with different definition on some hosts */
  }

  const activityCols = new Set(
    db.prepare(`PRAGMA table_info(workspace_activity_events)`).all().map((c) => c.name)
  );
  if (!activityCols.has('target_user_id')) {
    try {
      db.exec(`ALTER TABLE workspace_activity_events ADD COLUMN target_user_id TEXT`);
    } catch {
      /* column may exist on MySQL via different migration path */
    }
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_workspace_activity_target_user ON workspace_activity_events(target_user_id, created_at_iso DESC)`
    );
  } catch {
    /* optional */
  }
}

/** AI Knowledge Center — centralized knowledge store for future Zare AI improvements. */
function migrateAiKnowledgeCenter(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aic_knowledge_records (
      id TEXT PRIMARY KEY,
      knowledge_type TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      tags_json TEXT NOT NULL DEFAULT '[]',
      module TEXT NOT NULL DEFAULT 'general',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      content_json TEXT NOT NULL DEFAULT '{}',
      body_text TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT,
      created_by_name TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_type ON aic_knowledge_records(knowledge_type);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_status ON aic_knowledge_records(status);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_module ON aic_knowledge_records(module);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_category ON aic_knowledge_records(category);
    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_updated ON aic_knowledge_records(updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS aic_knowledge_versions (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      change_note TEXT,
      changed_by_user_id TEXT,
      changed_by_name TEXT,
      changed_at_iso TEXT NOT NULL,
      FOREIGN KEY (record_id) REFERENCES aic_knowledge_records(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_aic_knowledge_versions_record
      ON aic_knowledge_versions(record_id, version DESC);

    CREATE TABLE IF NOT EXISTS aic_knowledge_embeddings (
      record_id TEXT PRIMARY KEY,
      embedding_model TEXT,
      embedding_json TEXT,
      dimensions INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      indexed_at_iso TEXT,
      error_message TEXT,
      FOREIGN KEY (record_id) REFERENCES aic_knowledge_records(id) ON DELETE CASCADE
    );
  `);
  const embCols = new Set(
    db.prepare(`PRAGMA table_info(aic_knowledge_embeddings)`).all().map((c) => c.name)
  );
  if (!embCols.has('content_hash')) {
    db.exec(`ALTER TABLE aic_knowledge_embeddings ADD COLUMN content_hash TEXT`);
  }
}

/** AI Intelligence Router — query analytics log. */
function migrateAiIntelligenceRouter(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_router_query_log (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      user_id TEXT,
      query_text TEXT NOT NULL,
      intent TEXT NOT NULL,
      route_used TEXT NOT NULL,
      mode TEXT NOT NULL,
      confidence REAL,
      intent_confidence REAL,
      search_confidence REAL,
      result_count INTEGER NOT NULL DEFAULT 0,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      module TEXT,
      response_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_router_log_time ON ai_router_query_log(occurred_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_router_log_intent ON ai_router_query_log(intent, occurred_at_iso DESC);
  `);
}

/** AI Automation Engine — structured action proposals (Phase 5). */
function migrateAiAutomationEngine(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_action_proposals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      confidence_score REAL,
      risk_level TEXT NOT NULL DEFAULT 'low',
      required_approval_level TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      linked_entity_type TEXT,
      linked_entity_id TEXT,
      created_by TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      approved_by TEXT,
      approved_at_iso TEXT,
      rejected_by TEXT,
      rejected_at_iso TEXT,
      rejection_reason TEXT,
      executed_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_proposals_status ON ai_action_proposals(status, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_proposals_type ON ai_action_proposals(type, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_proposals_creator ON ai_action_proposals(created_by, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_proposals_linked ON ai_action_proposals(linked_entity_type, linked_entity_id);
  `);
}

/** Read-only integration API keys (Bearer auth for automation). */
function migrateIntegrationApiKeys(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      secret_suffix TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      last_used_at_iso TEXT,
      revoked_at_iso TEXT
    );
  `);
}

/** Point-in-time coil balances for month-end stock reports (optional capture). */
function migrateInventoryCoilSnapshots(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_coil_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_at_iso TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT '',
      coil_no TEXT NOT NULL,
      current_weight_kg REAL NOT NULL DEFAULT 0,
      colour TEXT,
      gauge_label TEXT,
      material_type_name TEXT,
      product_id TEXT,
      po_id TEXT,
      supplier_name TEXT,
      unit_cost_ngn_per_kg INTEGER,
      captured_at_iso TEXT NOT NULL,
      UNIQUE(as_at_iso, branch_id, coil_no)
    );
    CREATE INDEX IF NOT EXISTS idx_inv_coil_snap_as_at ON inventory_coil_snapshots(as_at_iso DESC, branch_id);
  `);
}

/** Month-end stock register workflow + coil roll flag. */
function migrateStockRegister2026(db) {
  const coilCols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
  if (!coilCols.some((c) => c.name === 'stock_form')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN stock_form TEXT NOT NULL DEFAULT 'coil'`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_register_periods (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      period_end_iso TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      register_json TEXT,
      print_snapshot_json TEXT,
      printed_at_iso TEXT,
      printed_by_user_id TEXT,
      store_confirmed_at_iso TEXT,
      store_confirmed_by_user_id TEXT,
      store_confirmed_by_name TEXT,
      bm_approved_at_iso TEXT,
      bm_approved_by_user_id TEXT,
      bm_approved_by_name TEXT,
      md_approved_at_iso TEXT,
      md_approved_by_user_id TEXT,
      md_approved_by_name TEXT,
      locked_at_iso TEXT,
      count_notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      UNIQUE(branch_id, period_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_register_branch_period
      ON stock_register_periods(branch_id, period_key DESC);
  `);
  const srCols = db.prepare(`PRAGMA table_info(stock_register_periods)`).all();
  const ensureSrCol = (name, ddl) => {
    if (!srCols.some((c) => c.name === name)) db.exec(ddl);
  };
  ensureSrCol('bm_adjustments_json', `ALTER TABLE stock_register_periods ADD COLUMN bm_adjustments_json TEXT`);
  ensureSrCol('procurement_pricing_json', `ALTER TABLE stock_register_periods ADD COLUMN procurement_pricing_json TEXT`);
  ensureSrCol('procurement_costed_at_iso', `ALTER TABLE stock_register_periods ADD COLUMN procurement_costed_at_iso TEXT`);
  ensureSrCol('procurement_costed_by_user_id', `ALTER TABLE stock_register_periods ADD COLUMN procurement_costed_by_user_id TEXT`);
  ensureSrCol('procurement_costed_by_name', `ALTER TABLE stock_register_periods ADD COLUMN procurement_costed_by_name TEXT`);
  ensureSrCol('forwarded_to_manager_at_iso', `ALTER TABLE stock_register_periods ADD COLUMN forwarded_to_manager_at_iso TEXT`);
  ensureSrCol('line_clearance_json', `ALTER TABLE stock_register_periods ADD COLUMN line_clearance_json TEXT`);
  ensureSrCol('store_checklist_json', `ALTER TABLE stock_register_periods ADD COLUMN store_checklist_json TEXT`);
  ensureSrCol('count_cutoff_iso', `ALTER TABLE stock_register_periods ADD COLUMN count_cutoff_iso TEXT`);
  ensureSrCol('print_version', `ALTER TABLE stock_register_periods ADD COLUMN print_version INTEGER NOT NULL DEFAULT 1`);
  const coilLotCols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
  const ensureCoilCol = (name, ddl) => {
    if (!coilLotCols.some((c) => c.name === name)) db.exec(ddl);
  };
  ensureCoilCol('production_blocked', `ALTER TABLE coil_lots ADD COLUMN production_blocked INTEGER NOT NULL DEFAULT 0`);
  ensureCoilCol('production_block_reason', `ALTER TABLE coil_lots ADD COLUMN production_block_reason TEXT`);
  ensureCoilCol('production_block_set_at_iso', `ALTER TABLE coil_lots ADD COLUMN production_block_set_at_iso TEXT`);
  const pjCols = db.prepare(`PRAGMA table_info(production_jobs)`).all();
  if (!pjCols.some((c) => c.name === 'production_date_iso')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN production_date_iso TEXT`);
  }
  const snapCols = db.prepare(`PRAGMA table_info(inventory_coil_snapshots)`).all();
  const ensureSnapCol = (name, ddl) => {
    if (!snapCols.some((c) => c.name === name)) db.exec(ddl);
  };
  ensureSnapCol('opening_kg', `ALTER TABLE inventory_coil_snapshots ADD COLUMN opening_kg REAL`);
  ensureSnapCol('received_kg', `ALTER TABLE inventory_coil_snapshots ADD COLUMN received_kg REAL`);
  ensureSnapCol('used_kg', `ALTER TABLE inventory_coil_snapshots ADD COLUMN used_kg REAL`);
  ensureSnapCol('stock_form', `ALTER TABLE inventory_coil_snapshots ADD COLUMN stock_form TEXT`);
  ensureSnapCol('is_finished', `ALTER TABLE inventory_coil_snapshots ADD COLUMN is_finished INTEGER NOT NULL DEFAULT 0`);
  ensureSnapCol('remark', `ALTER TABLE inventory_coil_snapshots ADD COLUMN remark TEXT`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_product_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_at_iso TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      section_kind TEXT NOT NULL,
      stock_level REAL NOT NULL DEFAULT 0,
      captured_at_iso TEXT NOT NULL,
      UNIQUE(as_at_iso, branch_id, product_id, section_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_inv_prod_snap_as_at ON inventory_product_snapshots(as_at_iso DESC, branch_id);
  `);
}

/** Org governance limits, filing references, dossiers, inter-branch office requests. */
function migrateOfficeOperations2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_policy_kv (
      policy_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      updated_by_user_id TEXT,
      updated_by_display TEXT
    );
    CREATE TABLE IF NOT EXISTS org_policy_audit (
      id TEXT PRIMARY KEY,
      policy_key TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT,
      actor_user_id TEXT,
      actor_display TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_policy_audit_key_time ON org_policy_audit(policy_key, created_at_iso DESC);
    CREATE TABLE IF NOT EXISTS reference_counters (
      scope_key TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at_iso TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS office_dossiers (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      dossier_type TEXT NOT NULL,
      dossier_key TEXT NOT NULL,
      title TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      UNIQUE(branch_id, dossier_type, dossier_key)
    );
    CREATE INDEX IF NOT EXISTS idx_office_dossiers_branch ON office_dossiers(branch_id, updated_at_iso DESC);
    CREATE TABLE IF NOT EXISTS office_dossier_links (
      dossier_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      linked_at_iso TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (dossier_id, entity_kind, entity_id),
      FOREIGN KEY (dossier_id) REFERENCES office_dossiers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS office_inter_branch_requests (
      id TEXT PRIMARY KEY,
      from_branch_id TEXT NOT NULL,
      to_branch_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by_user_id TEXT NOT NULL,
      created_by_role_key TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      resolved_at_iso TEXT,
      resolved_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inter_branch_from ON office_inter_branch_requests(from_branch_id, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_inter_branch_to ON office_inter_branch_requests(to_branch_id, created_at_iso DESC);
  `);
}

/** Internal Office Desk threads and messages. */
function migrateOfficeDesk(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_threads (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'memo',
      status TEXT NOT NULL DEFAULT 'open',
      document_class TEXT NOT NULL DEFAULT 'correspondence',
      office_key TEXT NOT NULL DEFAULT 'office_admin',
      subject TEXT NOT NULL,
      body TEXT,
      to_user_ids_json TEXT,
      cc_user_ids_json TEXT,
      related_work_item_id TEXT,
      related_payment_request_id TEXT,
      payload_json TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_office_threads_branch_updated ON office_threads(branch_id, updated_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_office_threads_created_by ON office_threads(created_by_user_id);
    CREATE TABLE IF NOT EXISTS office_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      author_user_id TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES office_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_office_messages_thread ON office_messages(thread_id, created_at_iso);
    CREATE TABLE IF NOT EXISTS office_thread_reads (
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_read_at_iso TEXT NOT NULL,
      PRIMARY KEY (user_id, thread_id),
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id) REFERENCES office_threads(id) ON DELETE CASCADE
    );
  `);
  const cols = new Set(db.prepare(`PRAGMA table_info(office_threads)`).all().map((c) => c.name));
  if (!cols.has('document_class')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN document_class TEXT NOT NULL DEFAULT 'correspondence'`);
  }
  if (!cols.has('office_key')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN office_key TEXT NOT NULL DEFAULT 'office_admin'`);
  }
  if (!cols.has('related_work_item_id')) {
    db.exec(`ALTER TABLE office_threads ADD COLUMN related_work_item_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_office_threads_work_item ON office_threads(related_work_item_id)`);
}

function migrateOfficeThreadFiling(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_thread_filing (
      thread_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      category_key TEXT NOT NULL,
      category_label TEXT NOT NULL,
      summary TEXT NOT NULL,
      cost_ngn INTEGER,
      tags_json TEXT,
      key_facts_json TEXT,
      related_payment_request_id TEXT,
      conversation_digest TEXT,
      extracted_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      model_hint TEXT,
      FOREIGN KEY (thread_id) REFERENCES office_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_office_thread_filing_branch ON office_thread_filing(branch_id, updated_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_office_thread_filing_category ON office_thread_filing(category_key, branch_id);
  `);
}

/** Workspace command center — drafts, read state, bulk action log (Phases 7–9). */
function migrateOnlineOfficeDesk2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_record_versions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      edited_by_user_id TEXT,
      edited_by_display TEXT,
      edit_reason TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES office_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_office_record_versions_thread ON office_record_versions(thread_id, created_at_iso ASC);

    CREATE TABLE IF NOT EXISTS official_notices (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by_user_id TEXT,
      targets_json TEXT,
      requires_acknowledgement INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      expires_at_iso TEXT,
      attachments_json TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_official_notices_created ON official_notices(created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS official_notice_reads (
      notice_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at_iso TEXT NOT NULL,
      PRIMARY KEY (notice_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS official_notice_acknowledgements (
      notice_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      acknowledged_at_iso TEXT NOT NULL,
      PRIMARY KEY (notice_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS forum_topics (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'branch',
      branch_id TEXT,
      title TEXT NOT NULL,
      created_by_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_forum_topics_branch ON forum_topics(branch_id, updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS forum_posts (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      author_user_id TEXT,
      body TEXT NOT NULL,
      attachments_json TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_forum_posts_topic ON forum_posts(topic_id, created_at_iso ASC);

    CREATE TABLE IF NOT EXISTS forum_moderation_log (
      id TEXT PRIMARY KEY,
      topic_id TEXT,
      post_id TEXT,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      note TEXT,
      created_at_iso TEXT NOT NULL
    );
  `);
}

function migrateWorkspaceCommandCenter2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_memo_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      confidentiality TEXT NOT NULL DEFAULT 'internal',
      smart_memo_type TEXT,
      payload_json TEXT,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_office_memo_drafts_user_branch ON office_memo_drafts(user_id, branch_id, updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS workspace_read_state (
      user_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      last_read_at_iso TEXT NOT NULL,
      PRIMARY KEY (user_id, work_item_id),
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_read_state_user ON workspace_read_state(user_id, last_read_at_iso DESC);

    CREATE TABLE IF NOT EXISTS workspace_bulk_action_log (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      item_ids_json TEXT,
      result_json TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (actor_user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_bulk_action_log_time ON workspace_bulk_action_log(created_at_iso DESC);
  `);
}

function migrateUnifiedWorkspaceRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      office_key TEXT NOT NULL DEFAULT 'general',
      document_class TEXT NOT NULL,
      document_type TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      confidentiality TEXT NOT NULL DEFAULT 'internal',
      title TEXT NOT NULL,
      summary TEXT,
      body TEXT,
      sender_user_id TEXT,
      sender_display_name TEXT,
      sender_role_key TEXT,
      sender_office_key TEXT,
      sender_branch_id TEXT,
      responsible_office_key TEXT,
      responsible_user_id TEXT,
      due_at_iso TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      closed_at_iso TEXT,
      archived_at_iso TEXT,
      requires_response INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      key_decision_summary TEXT,
      source_kind TEXT,
      source_id TEXT,
      linked_thread_id TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_branch_updated ON work_items(branch_id, updated_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_work_items_office_status ON work_items(responsible_office_key, status, updated_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_linked_thread ON work_items(linked_thread_id);

    CREATE TABLE IF NOT EXISTS work_item_visibility (
      work_item_id TEXT NOT NULL,
      visibility_kind TEXT NOT NULL,
      visibility_value TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'view',
      PRIMARY KEY (work_item_id, visibility_kind, visibility_value, access_level),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_visibility_lookup
      ON work_item_visibility(visibility_kind, visibility_value, access_level);

    CREATE TABLE IF NOT EXISTS work_item_links (
      work_item_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      note TEXT,
      created_at_iso TEXT NOT NULL,
      PRIMARY KEY (work_item_id, entity_kind, entity_id),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_links_entity ON work_item_links(entity_kind, entity_id);

    CREATE TABLE IF NOT EXISTS work_item_decisions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      decision_key TEXT NOT NULL,
      outcome_status TEXT NOT NULL,
      note TEXT,
      actor_user_id TEXT,
      actor_display_name TEXT,
      actor_role_key TEXT,
      actor_office_key TEXT,
      actor_branch_id TEXT,
      acted_at_iso TEXT NOT NULL,
      data_json TEXT,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_decisions_item ON work_item_decisions(work_item_id, acted_at_iso DESC);

    CREATE TABLE IF NOT EXISTS work_item_sla_events (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      due_at_iso TEXT,
      occurred_at_iso TEXT,
      state TEXT NOT NULL,
      note TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_sla_events_item ON work_item_sla_events(work_item_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS work_item_filing (
      work_item_id TEXT PRIMARY KEY,
      filing_reference TEXT,
      filing_class TEXT,
      retention_label TEXT,
      archive_state TEXT NOT NULL DEFAULT 'open',
      print_summary TEXT,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS work_item_print_snapshots (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      snapshot_kind TEXT NOT NULL,
      title TEXT,
      body_text TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_print_snapshots_item
      ON work_item_print_snapshots(work_item_id, created_at_iso DESC);
  `);
}

function migrateOperationsMaintenanceWorkspace(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_requests (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      request_category TEXT NOT NULL,
      status TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'normal',
      requested_by_user_id TEXT,
      requested_by_display TEXT,
      requested_at_iso TEXT NOT NULL,
      required_by_iso TEXT,
      acknowledged_at_iso TEXT,
      approved_at_iso TEXT,
      approved_by_user_id TEXT,
      approved_by_display TEXT,
      approval_note TEXT,
      responsible_office_key TEXT,
      summary TEXT NOT NULL,
      note TEXT,
      related_purchase_order_id TEXT,
      related_work_item_id TEXT,
      source_kind TEXT,
      source_id TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_material_requests_branch_status
      ON material_requests(branch_id, status, requested_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_material_requests_work_item ON material_requests(related_work_item_id);

    CREATE TABLE IF NOT EXISTS material_request_lines (
      material_request_id TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      item_category TEXT NOT NULL,
      product_id TEXT,
      item_name TEXT,
      gauge TEXT,
      colour TEXT,
      material_type TEXT,
      unit TEXT NOT NULL,
      qty_requested REAL NOT NULL DEFAULT 0,
      qty_approved REAL,
      qty_received REAL NOT NULL DEFAULT 0,
      note TEXT,
      PRIMARY KEY (material_request_id, line_no),
      FOREIGN KEY (material_request_id) REFERENCES material_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS in_transit_loads (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      destination_branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'purchase_order',
      source_id TEXT,
      purchase_order_id TEXT,
      material_request_id TEXT,
      transport_agent_id TEXT,
      transport_agent_name TEXT,
      transport_reference TEXT,
      waybill_ref TEXT,
      eta_date_iso TEXT,
      loaded_at_iso TEXT,
      posted_at_iso TEXT,
      received_at_iso TEXT,
      delay_reason TEXT,
      exception_note TEXT,
      haulage_cost_ngn INTEGER NOT NULL DEFAULT 0,
      treasury_movement_id TEXT,
      related_work_item_id TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_in_transit_loads_branch_status
      ON in_transit_loads(destination_branch_id, status, posted_at_iso DESC);

    CREATE TABLE IF NOT EXISTS in_transit_load_lines (
      load_id TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      purchase_order_line_key TEXT,
      material_request_line_no INTEGER,
      product_id TEXT,
      item_name TEXT,
      unit TEXT NOT NULL,
      qty_loaded REAL NOT NULL DEFAULT 0,
      qty_received REAL NOT NULL DEFAULT 0,
      short_landed_qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (load_id, line_no),
      FOREIGN KEY (load_id) REFERENCES in_transit_loads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      name TEXT NOT NULL,
      machine_code TEXT,
      line_name TEXT,
      machine_type TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      asset_category TEXT,
      serial_no TEXT,
      model_no TEXT,
      manufacturer TEXT,
      installed_at_iso TEXT,
      commissioned_at_iso TEXT,
      legacy_machine_name TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_machines_branch_name ON machines(branch_id, name);

    CREATE TABLE IF NOT EXISTS machine_asset_links (
      machine_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      relation_kind TEXT NOT NULL DEFAULT 'primary',
      PRIMARY KEY (machine_id, asset_id),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES fixed_assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS machine_meter_logs (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      reading_date_iso TEXT NOT NULL,
      output_meters REAL NOT NULL DEFAULT 0,
      note TEXT,
      source_kind TEXT,
      source_id TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_machine_meter_logs_machine
      ON machine_meter_logs(machine_id, reading_date_iso DESC);

    CREATE TABLE IF NOT EXISTS maintenance_plans (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      plan_kind TEXT NOT NULL DEFAULT 'preventive',
      summary TEXT NOT NULL,
      calendar_interval_days INTEGER,
      meter_interval REAL,
      next_due_date_iso TEXT,
      next_due_meter REAL,
      last_service_at_iso TEXT,
      last_service_meter REAL,
      approval_required INTEGER NOT NULL DEFAULT 1,
      responsible_office_key TEXT NOT NULL DEFAULT 'operations',
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_plans_branch_status
      ON maintenance_plans(branch_id, status, next_due_date_iso);

    CREATE TABLE IF NOT EXISTS maintenance_work_orders (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      plan_id TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      kind TEXT NOT NULL DEFAULT 'corrective',
      summary TEXT NOT NULL,
      symptom TEXT,
      diagnosis TEXT,
      resolution TEXT,
      incident_date_iso TEXT,
      opened_at_iso TEXT NOT NULL,
      acknowledged_at_iso TEXT,
      approved_at_iso TEXT,
      closed_at_iso TEXT,
      opened_by_user_id TEXT,
      acknowledged_by_user_id TEXT,
      approved_by_user_id TEXT,
      closed_by_user_id TEXT,
      assigned_to_user_id TEXT,
      downtime_hours REAL NOT NULL DEFAULT 0,
      vendor_name TEXT,
      replacement_required INTEGER NOT NULL DEFAULT 0,
      related_material_request_id TEXT,
      related_payment_request_id TEXT,
      related_work_item_id TEXT,
      data_json TEXT,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES maintenance_plans(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_work_orders_branch_status
      ON maintenance_work_orders(branch_id, status, opened_at_iso DESC);

    CREATE TABLE IF NOT EXISTS maintenance_events (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      note TEXT,
      at_iso TEXT NOT NULL,
      actor_user_id TEXT,
      actor_display_name TEXT,
      actor_office_key TEXT,
      data_json TEXT,
      FOREIGN KEY (work_order_id) REFERENCES maintenance_work_orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_events_work_order
      ON maintenance_events(work_order_id, at_iso DESC);

    CREATE TABLE IF NOT EXISTS maintenance_cost_lines (
      id TEXT PRIMARY KEY,
      work_order_id TEXT NOT NULL,
      cost_kind TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      expense_category TEXT,
      note TEXT,
      posted_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      source_kind TEXT,
      source_id TEXT,
      FOREIGN KEY (work_order_id) REFERENCES maintenance_work_orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_cost_lines_work_order
      ON maintenance_cost_lines(work_order_id, posted_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_performance_reviews (
      id TEXT PRIMARY KEY,
      reference_no TEXT NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      machine_id TEXT,
      department_key TEXT,
      period_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      review_type TEXT NOT NULL DEFAULT 'periodic',
      reviewer_user_id TEXT,
      branch_recommendation TEXT,
      hr_final_note TEXT,
      score_json TEXT,
      linked_work_item_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_performance_reviews_branch_period
      ON hr_performance_reviews(branch_id, period_key, updated_at_iso DESC);
  `);

  const coilCols = new Set(db.prepare(`PRAGMA table_info(coil_requests)`).all().map((c) => c.name));
  if (coilCols.size) {
    if (!coilCols.has('branch_id')) db.exec(`ALTER TABLE coil_requests ADD COLUMN branch_id TEXT`);
    if (!coilCols.has('requested_by_user_id')) db.exec(`ALTER TABLE coil_requests ADD COLUMN requested_by_user_id TEXT`);
    if (!coilCols.has('requested_by_display')) db.exec(`ALTER TABLE coil_requests ADD COLUMN requested_by_display TEXT`);
    if (!coilCols.has('work_item_id')) db.exec(`ALTER TABLE coil_requests ADD COLUMN work_item_id TEXT`);
    if (!coilCols.has('material_request_id')) db.exec(`ALTER TABLE coil_requests ADD COLUMN material_request_id TEXT`);
    if (!coilCols.has('unit')) db.exec(`ALTER TABLE coil_requests ADD COLUMN unit TEXT NOT NULL DEFAULT 'kg'`);
    db.prepare(
      `UPDATE coil_requests SET branch_id = 'BR-KD' WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = ''`
    ).run();
    // Infer metres for existing stone-labelled requests that still say kg
    try {
      db.prepare(
        `UPDATE coil_requests
         SET unit = 'm'
         WHERE LOWER(TRIM(COALESCE(unit, 'kg'))) = 'kg'
           AND (
             LOWER(COALESCE(material_type, '')) LIKE '%stone%'
             OR LOWER(COALESCE(note, '')) LIKE '% shortfall % m%'
           )`
      ).run();
    } catch {
      /* ignore */
    }
  }
}

/** Inter-branch treasury lending (MD-approved disbursement + repayment history). */
function migrateInterBranchLoans(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inter_branch_loans (
      loan_id TEXT PRIMARY KEY,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_name TEXT,
      lender_branch_id TEXT NOT NULL,
      borrower_branch_id TEXT NOT NULL,
      principal_ngn INTEGER NOT NULL,
      repaid_ngn INTEGER NOT NULL DEFAULT 0,
      from_treasury_account_id INTEGER NOT NULL,
      to_treasury_account_id INTEGER NOT NULL,
      date_iso TEXT NOT NULL,
      reference TEXT,
      repayment_plan_json TEXT,
      status TEXT NOT NULL,
      proposed_note TEXT,
      md_approved_at_iso TEXT,
      md_approved_by_user_id TEXT,
      md_approved_by_name TEXT,
      md_rejected_at_iso TEXT,
      md_reject_note TEXT,
      treasury_batch_id TEXT,
      executed_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inter_branch_loans_branches
      ON inter_branch_loans(lender_branch_id, borrower_branch_id, status);
    CREATE TABLE IF NOT EXISTS inter_branch_loan_repayments (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      posted_at_iso TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      from_treasury_account_id INTEGER NOT NULL,
      to_treasury_account_id INTEGER NOT NULL,
      treasury_batch_id TEXT,
      note TEXT,
      created_by_user_id TEXT,
      created_by_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inter_branch_loan_repayments_loan
      ON inter_branch_loan_repayments(loan_id, posted_at_iso);
  `);
}

/** Branch equality filters for workspace quick search (after branch_id columns exist). */
function migrateWorkspaceSearchIndexes(db) {
  const hasBranchCol = (table) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'branch_id');
    } catch {
      return false;
    }
  };
  const ensure = (indexName, table) => {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)) return;
    if (!hasBranchCol(table)) return;
    db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(branch_id)`);
  };
  ensure('idx_ws_customers_branch', 'customers');
  ensure('idx_ws_quotations_branch', 'quotations');
  ensure('idx_ws_sales_receipts_branch', 'sales_receipts');
  ensure('idx_ws_purchase_orders_branch', 'purchase_orders');
  ensure('idx_ws_suppliers_branch', 'suppliers');
  ensure('idx_ws_cutting_lists_branch', 'cutting_lists');
  ensure('idx_ws_coil_lots_branch', 'coil_lots');
  ensure('idx_ws_customer_refunds_branch', 'customer_refunds');
  ensure('idx_ws_products_branch', 'products');
  ensure('idx_ws_hr_staff_profiles_branch', 'hr_staff_profiles');
}

/** FTS5 workspace search index (rebuild once per migration id). */
function migrateWorkspaceSearchFts2026(db) {
  if (schemaMigrationDone(db, SCHEMA_MIGRATION_FTS)) return;
  try {
    ensureWorkspaceSearchFtsSchema(db);
    const n = rebuildWorkspaceSearchFts(db);
    console.info(`[migrate] workspace search FTS indexed ${n} documents`);
  } catch (e) {
    console.warn('[migrate] workspace search FTS rebuild skipped:', e?.message || e);
  }
  markSchemaMigrationDone(db, SCHEMA_MIGRATION_FTS);
}

/** Coil vs stone-metre vs accessory PO classification for dashboards. */
function migrateProcurementOrderKind(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get()) return;
  if (schemaMigrationDone(db, SCHEMA_MIGRATION_PROCUREMENT_KIND)) return;

  const cols = new Set(db.prepare(`PRAGMA table_info(purchase_orders)`).all().map((c) => c.name));
  if (!cols.has('procurement_kind')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN procurement_kind TEXT NOT NULL DEFAULT 'coil'`);
  }
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_order_lines'`).get()) {
    const lineCols = new Set(db.prepare(`PRAGMA table_info(purchase_order_lines)`).all().map((c) => c.name));
    if (!lineCols.has('line_type')) {
      db.exec(`ALTER TABLE purchase_order_lines ADD COLUMN line_type TEXT`);
    }
  }

  /** @type {Map<string, { product_id?: string; line_type?: string; meters_offered?: number; qty_ordered?: number; unit_price_per_kg_ngn?: number }[]>} */
  const linesByPo = new Map();
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_order_lines'`).get()) {
    const allLines = db
      .prepare(
        `SELECT po_id, product_id, line_type, meters_offered, qty_ordered, unit_price_per_kg_ngn FROM purchase_order_lines`
      )
      .all();
    for (const row of allLines) {
      const poId = String(row.po_id || '').trim();
      if (!poId) continue;
      if (!linesByPo.has(poId)) linesByPo.set(poId, []);
      linesByPo.get(poId).push(row);
    }
  }

  const pos = db.prepare(`SELECT po_id FROM purchase_orders`).all();
  const updSql = `UPDATE purchase_orders SET procurement_kind = ? WHERE po_id = ?`;
  const statements = [];
  for (const { po_id } of pos) {
    const poId = String(po_id || '').trim();
    if (!poId) continue;
    const lines = linesByPo.get(poId) || [];
    const kind = deriveProcurementKindFromPoLines(
      lines.map((l) => ({
        lineType: l.line_type,
        productID: l.product_id,
        metersOffered: l.meters_offered,
        qtyOrdered: l.qty_ordered,
        unitPricePerKgNgn: l.unit_price_per_kg_ngn,
      }))
    );
    statements.push({ sql: updSql, args: [kind, poId] });
  }
  runManyInBatches(db, statements);
  markSchemaMigrationDone(db, SCHEMA_MIGRATION_PROCUREMENT_KIND);
}

/** Per-line PO type for unified procurement (coil_kg, stone_meter, etc.). */
function migratePurchaseOrderLineType(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_order_lines'`).get()) {
    return;
  }
  if (schemaMigrationDone(db, SCHEMA_MIGRATION_PO_LINE_TYPE)) return;

  const cols = new Set(db.prepare(`PRAGMA table_info(purchase_order_lines)`).all().map((c) => c.name));
  if (!cols.has('line_type')) {
    db.exec(`ALTER TABLE purchase_order_lines ADD COLUMN line_type TEXT`);
  }

  bulkBackfillPurchaseOrderLineTypesSql(db);

  const pending = db
    .prepare(
      `SELECT po_id, line_key, product_id, meters_offered, qty_ordered, unit_price_per_kg_ngn, line_type
       FROM purchase_order_lines
       WHERE line_type IS NULL OR TRIM(line_type) = ''`
    )
    .all();
  if (!pending.length) {
    markSchemaMigrationDone(db, SCHEMA_MIGRATION_PO_LINE_TYPE);
    return;
  }

  const updSql = `UPDATE purchase_order_lines SET line_type = ? WHERE po_id = ? AND line_key = ?`;
  const statements = [];
  for (const l of pending) {
    const lt = inferLineTypeFromProduct(l.product_id, null, {
      metersOffered: l.meters_offered,
      qtyOrdered: l.qty_ordered,
      unitPricePerKgNgn: l.unit_price_per_kg_ngn,
    });
    statements.push({ sql: updSql, args: [lt, l.po_id, l.line_key] });
  }
  runManyInBatches(db, statements);
  markSchemaMigrationDone(db, SCHEMA_MIGRATION_PO_LINE_TYPE);
}

/**
 * Link quote products that sit outside the coil metre workbook to default/list prices
 * (stone flatsheet m² + stone nail), and drop the duplicate Stone flatsheet 1.4 row.
 */
function migrateLinkUnpricedQuoteItems2026(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_quote_items'`).get()) return;

  const sqiCols = new Set(db.prepare(`PRAGMA table_info(setup_quote_items)`).all().map((c) => c.name));
  if (!sqiCols.has('floor_unit_price_ngn')) {
    db.exec(`ALTER TABLE setup_quote_items ADD COLUMN floor_unit_price_ngn INTEGER NOT NULL DEFAULT 0`);
  }

  const upsertQuoteDefaults = db.prepare(
    `UPDATE setup_quote_items
     SET default_unit_price_ngn = ?,
         floor_unit_price_ngn = CASE
           WHEN COALESCE(floor_unit_price_ngn, 0) > 0 THEN floor_unit_price_ngn
           ELSE ?
         END,
         inventory_product_id = COALESCE(NULLIF(TRIM(inventory_product_id), ''), ?),
         active = 1
     WHERE item_id = ?`
  );
  upsertQuoteDefaults.run(6000, 5500, 'STONE-FS-black-1p4m', 'SQI-037');
  upsertQuoteDefaults.run(6000, 5500, 'STONE-FS-black-2m', 'SQI-039');
  upsertQuoteDefaults.run(12000, 0, 'ACC-STONE-NAIL-PACK', 'SQI-035');

  // Duplicate of SQI-037 (same name/unit) — keep one active catalogue row.
  db.prepare(`UPDATE setup_quote_items SET active = 0, sort_order = 999 WHERE item_id = 'SQI-038'`).run();

  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_price_lists'`).get()) return;

  const plCols = new Set(db.prepare(`PRAGMA table_info(setup_price_lists)`).all().map((c) => c.name));
  const hasBook = plCols.has('book_label') && plCols.has('book_version') && plCols.has('effective_from_iso');

  const existsPrice = db.prepare(`SELECT 1 FROM setup_price_lists WHERE price_id = ?`);
  const insPrice = hasBook
    ? db.prepare(
        `INSERT INTO setup_price_lists (
           price_id, quote_item_id, item_name, unit, unit_price_ngn,
           gauge_id, colour_id, material_type_id, profile_id, notes,
           active, sort_order, book_label, book_version, effective_from_iso
         ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,1,?)`
      )
    : db.prepare(
        `INSERT INTO setup_price_lists (
           price_id, quote_item_id, item_name, unit, unit_price_ngn,
           gauge_id, colour_id, material_type_id, profile_id, notes,
           active, sort_order
         ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`
      );
  const updPrice = db.prepare(
    `UPDATE setup_price_lists
     SET quote_item_id = ?, item_name = ?, unit = ?, unit_price_ngn = ?,
         material_type_id = ?, notes = ?, active = 1
     WHERE price_id = ?`
  );

  /** @type {[string, string, string, string, number, string, string, number][]} */
  const priceRows = [
    [
      'PRI-SF-14',
      'SQI-037',
      'Stone flatsheet 1.4',
      'm²',
      6000,
      'MAT-005',
      'Default list ₦/m² (workbook metres do not apply). Floor guidance ₦5,500/m².',
      20,
    ],
    [
      'PRI-SF-20',
      'SQI-039',
      'Stone flatsheet 2',
      'm²',
      6000,
      'MAT-005',
      'Default list ₦/m² (workbook metres do not apply). Floor guidance ₦5,500/m².',
      21,
    ],
    [
      'PRI-ACC-STONE-NAIL',
      'SQI-035',
      'Stone nail',
      'pack',
      12000,
      '',
      'Default accessory list from recent quotations; edit in pricing workbook Accessories.',
      114,
    ],
  ];

  for (const [priceId, quoteItemId, itemName, unit, unitPrice, materialTypeId, notes, sortOrder] of priceRows) {
    if (existsPrice.get(priceId)) {
      updPrice.run(quoteItemId, itemName, unit, unitPrice, materialTypeId || '', notes, priceId);
    } else if (hasBook) {
      insPrice.run(
        priceId,
        quoteItemId,
        itemName,
        unit,
        unitPrice,
        '',
        '',
        materialTypeId || '',
        '',
        notes,
        sortOrder,
        'Standard',
        '2020-01-01'
      );
    } else {
      insPrice.run(
        priceId,
        quoteItemId,
        itemName,
        unit,
        unitPrice,
        '',
        '',
        materialTypeId || '',
        '',
        notes,
        sortOrder
      );
    }
  }
}

/** Canonical quotation line catalog: products, accessories, services (Zarewa 2026 list). */
function migrateQuotationLineCatalog2026(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_quote_items'`).get()) return;
  const cols = new Set(db.prepare(`PRAGMA table_info(setup_quote_items)`).all().map((c) => c.name));
  if (!cols.has('inventory_product_id')) {
    db.exec(`ALTER TABLE setup_quote_items ADD COLUMN inventory_product_id TEXT`);
  }

  /** @type {[string, string, string, string, number, string | null][]} */
  const rows = [
    ['SQI-001', 'product', 'Roofing Sheet', 'm', 1, null],
    ['SQI-002', 'product', 'Bargeboard', 'm', 2, null],
    ['SQI-003', 'product', 'Top End', 'm', 3, null],
    ['SQI-004', 'product', 'Gutter', 'm', 4, null],
    ['SQI-021', 'product', 'Eaves angle', 'm', 5, null],
    ['SQI-022', 'product', 'Wall Flashing', 'm', 6, null],
    ['SQI-023', 'product', 'Ridge Cap', 'm', 7, null],
    ['SQI-024', 'product', 'Capping', 'm', 8, null],
    ['SQI-025', 'product', 'Bottom eaves', 'm', 9, null],
    ['SQI-026', 'product', 'Fascia', 'm', 10, null],
    ['SQI-027', 'product', 'Cladding', 'm', 11, null],
    ['SQI-028', 'product', 'Flat sheet', 'm', 12, null],
    ['SQI-037', 'product', 'Stone flatsheet 1.4', 'm²', 13, null],
    ['SQI-038', 'product', 'Stone flatsheet 1.4', 'm²', 14, null],
    ['SQI-039', 'product', 'Stone flatsheet 2', 'm²', 15, null],
    ['SQI-029', 'product', 'Offcut', 'm', 16, null],
    ['SQI-030', 'product', 'Wall eaves', 'm', 17, null],
    ['SQI-031', 'product', 'Crimp', 'm', 18, null],
    ['SQI-032', 'product', 'Coil', 'kg', 19, null],
    ['SQI-005', 'accessory', 'Tapping Screw', 'pcs', 101, 'ACC-TAPPING-SCREW-PCS'],
    ['SQI-006', 'accessory', 'Silicone tube', 'tube', 102, 'ACC-SILICON-TUBE'],
    ['SQI-007', 'accessory', 'Rivet pins', 'pack', 103, 'ACC-RIVET-PACK'],
    ['SQI-008', 'accessory', 'Flash band', 'roll', 104, 'ACC-FLASH-BAND-ROLL'],
    ['SQI-012', 'accessory', 'Drive screw nail', 'pack', 105, 'ACC-DRIVE-SCREW-PACK'],
    ['SQI-013', 'accessory', 'Copper nail', 'pack', 106, 'ACC-COPPER-NAIL-PACK'],
    ['SQI-014', 'accessory', 'Concrete nail', 'pack', 107, 'ACC-CONCRETE-NAIL-PACK'],
    ['SQI-015', 'accessory', 'Felt', 'roll', 108, 'ACC-FELT-ROLL'],
    ['SQI-016', 'accessory', 'Hooks and bolts', 'pcs', 109, 'ACC-HOOKS-BOLT-PCS'],
    ['SQI-017', 'accessory', 'Washer', 'pack', 110, 'ACC-WASHER-PACK'],
    ['SQI-018', 'accessory', 'Repair Kit', 'kit', 111, 'ACC-REPAIR-KIT'],
    ['SQI-019', 'accessory', 'Strapping nail', 'pack', 112, 'ACC-STRAPPING-NAIL-PACK'],
    ['SQI-020', 'accessory', 'Spool', 'pack', 113, 'ACC-SPOOL-PACK'],
    ['SQI-035', 'accessory', 'Stone nail', 'pack', 114, 'ACC-STONE-NAIL-PACK'],
    ['SQI-009', 'service', 'Commission', 'job', 201, null],
    ['SQI-010', 'service', 'Transportation', 'job', 202, null],
    ['SQI-011', 'service', 'Installation', 'job', 203, null],
    ['SQI-033', 'service', 'Corrugation', 'job', 204, null],
    ['SQI-034', 'service', 'Bending', 'job', 205, null],
  ];

  const exists = db.prepare(`SELECT 1 FROM setup_quote_items WHERE item_id = ?`);
  const upd = db.prepare(
    `UPDATE setup_quote_items SET item_type = ?, name = ?, unit = ?, sort_order = ?, inventory_product_id = ? WHERE item_id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO setup_quote_items (item_id, item_type, name, unit, default_unit_price_ngn, active, sort_order, inventory_product_id)
     VALUES (?,?,?,?,0,1,?,?)`
  );

  db.transaction(() => {
    for (const [itemId, itemType, name, unit, sortOrder, inv] of rows) {
      const invVal = inv || null;
      if (exists.get(itemId)) {
        upd.run(itemType, name, unit, sortOrder, invVal, itemId);
      } else {
        ins.run(itemId, itemType, name, unit, sortOrder, invVal);
      }
    }
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_price_lists'`).get()) {
      db.prepare(
        `UPDATE setup_price_lists SET quote_item_id = 'SQI-011', item_name = 'Installation' WHERE quote_item_id = 'SQI-009' AND lower(trim(item_name)) = 'installation'`
      ).run();
      db.prepare(`UPDATE setup_price_lists SET item_name = 'Bargeboard' WHERE quote_item_id = 'SQI-002'`).run();
    }
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) {
      const pnm = db.prepare(`UPDATE products SET name = ? WHERE product_id = ?`);
      pnm.run('Silicone (tube)', 'ACC-SILICON-TUBE');
      pnm.run('Copper nail (pack)', 'ACC-COPPER-NAIL-PACK');
      pnm.run('Spool (pack)', 'ACC-SPOOL-PACK');
      pnm.run('Flash band (roll)', 'ACC-FLASH-BAND-ROLL');
      pnm.run('Hooks and bolts (pcs)', 'ACC-HOOKS-BOLT-PCS');
    }
    db.prepare(
      `UPDATE setup_quote_items SET inventory_product_id = 'ACC-COPPER-NAIL-PACK' WHERE item_id = 'SQI-013' AND inventory_product_id = 'ACC-CUPPA-NAIL-PACK'`
    ).run();
    db.prepare(
      `UPDATE setup_quote_items SET inventory_product_id = 'ACC-SPOOL-PACK' WHERE item_id = 'SQI-020' AND inventory_product_id = 'ACC-SPOOK-PACK'`
    ).run();
  })();
}

/**
 * Aluminium / aluzinc coil colours (names + codes). Stone-coated profiles keep separate COL-ST-* rows from
 * migrateStoneCoatedAndPricingArch. NB = Nut Brown (not navy); TR = TC red code; NA green → National Green;
 * C blue → Cobalt Blue (CB); CBN yellow → Canary Yellow; extras: Wine Red, Vandal Grey (common variants beyond the core list).
 */
function migrateCoilAluzincColours2026(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_colours'`).get()) return;
  const exists = db.prepare(`SELECT 1 FROM setup_colours WHERE colour_id = ?`);
  const upd = db.prepare(
    `UPDATE setup_colours SET name = ?, abbreviation = ?, active = 1, sort_order = ? WHERE colour_id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO setup_colours (colour_id, name, abbreviation, active, sort_order) VALUES (?,?,?,1,?)`
  );

  /** @type {[string, string, string, number][]} */
  const rows = [
    ['COL-001', 'HM Blue', 'HMB', 10],
    ['COL-002', 'Traffic Black', 'TB', 20],
    ['COL-003', 'TC Red', 'TR', 30],
    ['COL-004', 'Bush Green', 'BG', 40],
    ['COL-010', 'Gray Beige', 'GB', 50],
    ['COL-006', 'Ivory Beige', 'IV', 60],
    ['COL-009', 'P Red', 'PR', 70],
    ['COL-008', 'Pale Green', 'PG', 80],
    ['COL-007', 'Nut Brown', 'NB', 90],
    ['COL-011', 'Stucco', 'ST', 100],
    ['COL-012', 'National Green', 'NG', 110],
    ['COL-013', 'Cobalt Blue', 'CB', 120],
    ['COL-014', 'Canary Yellow', 'CY', 130],
    ['COL-015', 'Coloured', 'CL', 140],
    ['COL-005', 'Zinc Grey', 'ZG', 150],
    ['COL-016', 'Wine Red', 'WR', 160],
    ['COL-017', 'Vandal Grey', 'VG', 170],
    ['COL-018', 'Dark Grey', 'DG', 175],
  ];

  db.transaction(() => {
    for (const [id, name, abbr, sort] of rows) {
      if (exists.get(id)) {
        upd.run(name, abbr, sort, id);
      } else {
        ins.run(id, name, abbr, sort);
      }
    }
  })();
}

/**
 * Legacy stone flatsheet 1.5 m → 1.4 m (SKU merge + catalog rename).
 * Stock on STONE-FS-*-1p5m is added into the matching *-1p4m SKU then the 1.5 SKU is zeroed.
 */
function migrateStoneFlatsheetLength15To14(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) return;
  try {
    const legacy = db
      .prepare(
        `SELECT product_id, branch_id, stock_level, name, colour, dashboard_attrs_json
         FROM products WHERE product_id LIKE 'STONE-FS-%-1p5m'`
      )
      .all();
    for (const row of legacy) {
      const fromId = String(row.product_id || '');
      const toId = fromId.replace(/-1p5m$/i, '-1p4m');
      if (!toId || toId === fromId) continue;
      const branchId = String(row.branch_id || 'BR-KD');
      const stock = Number(row.stock_level) || 0;
      const target = db
        .prepare(`SELECT product_id, stock_level FROM products WHERE product_id = ? AND branch_id = ?`)
        .get(toId, branchId);
      if (target) {
        db.prepare(`UPDATE products SET stock_level = COALESCE(stock_level, 0) + ? WHERE product_id = ? AND branch_id = ?`).run(
          stock,
          toId,
          branchId
        );
        db.prepare(`UPDATE products SET stock_level = 0, name = REPLACE(name, '1.5 m', '1.4 m (merged)') WHERE product_id = ? AND branch_id = ?`).run(
          fromId,
          branchId
        );
      } else {
        let dash = row.dashboard_attrs_json;
        try {
          const j = JSON.parse(String(dash || '{}'));
          j.stoneFlatsheetLengthM = 1.4;
          dash = JSON.stringify(j);
        } catch {
          /* keep */
        }
        db.prepare(
          `UPDATE products SET product_id = ?, name = REPLACE(COALESCE(name,''), '1.5 m', '1.4 m'), dashboard_attrs_json = ? WHERE product_id = ? AND branch_id = ?`
        ).run(toId, dash, fromId, branchId);
      }
    }
  } catch {
    /* best-effort */
  }
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_quote_items'`).get()) {
    try {
      db.prepare(
        `UPDATE setup_quote_items SET name = 'Stone flatsheet 1.4' WHERE item_id = 'SQI-038' OR lower(trim(name)) = 'stone flatsheet 1.5'`
      ).run();
    } catch {
      /* ignore */
    }
  }
}

/** Stone-coated routing, profile scoping, colours, accessory SKUs, extended price_list_items. */
function migrateStoneCoatedAndPricingArch(db) {
  const tableCols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  const mtCols = tableCols('setup_material_types');
  if (mtCols.size && !mtCols.has('inventory_model')) {
    db.exec(`ALTER TABLE setup_material_types ADD COLUMN inventory_model TEXT NOT NULL DEFAULT 'coil_kg'`);
  }
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_material_types'`).get()) {
    db.prepare(`UPDATE setup_material_types SET inventory_model = 'coil_kg' WHERE material_type_id IN ('MAT-001','MAT-002')`).run();
    db.prepare(`UPDATE setup_material_types SET inventory_model = 'finished_good' WHERE material_type_id = 'MAT-003'`).run();
    db.prepare(`UPDATE setup_material_types SET inventory_model = 'consumable' WHERE material_type_id = 'MAT-004'`).run();
    const hasStone = db.prepare(`SELECT 1 FROM setup_material_types WHERE material_type_id = 'MAT-005'`).get();
    if (!hasStone) {
      db.prepare(
        `INSERT INTO setup_material_types (material_type_id, name, density_kg_per_m3, width_m, active, sort_order, inventory_model)
         VALUES ('MAT-005','Stone coated',0,0,1,4,'stone_meter')`
      ).run();
    } else {
      db.prepare(`UPDATE setup_material_types SET inventory_model = 'stone_meter', name = 'Stone coated' WHERE material_type_id = 'MAT-005'`).run();
    }
  }

  const prCols = tableCols('setup_profiles');
  if (prCols.size && !prCols.has('material_type_id')) {
    db.exec(`ALTER TABLE setup_profiles ADD COLUMN material_type_id TEXT`);
  }
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_profiles'`).get()) {
    db.prepare(
      `UPDATE setup_profiles SET material_type_id = 'MAT-002' WHERE material_type_id IS NULL OR trim(material_type_id) = ''`
    ).run();
    const stoneProfiles = [
      ['PROF-007', 'Milano', 7],
      ['PROF-008', 'Bond', 8],
      ['PROF-009', 'Classic', 9],
      ['PROF-010', 'Shingle', 10],
    ];
    for (const [pid, pname, sort] of stoneProfiles) {
      const ex = db.prepare(`SELECT 1 FROM setup_profiles WHERE profile_id = ?`).get(pid);
      if (!ex) {
        db.prepare(
          `INSERT INTO setup_profiles (profile_id, name, active, sort_order, material_type_id) VALUES (?,?,1,?,'MAT-005')`
        ).run(pid, pname, sort);
      }
    }
  }

  const colourPairs = [
    ['Black', 'BLK'],
    ['Coffee brown', 'CFB'],
    ['Red', 'RED'],
    ['Red mix black', 'RMB'],
    ['Red patch black', 'RPB'],
    ['Black patch white', 'BPW'],
    ['Coffee mix black', 'CMB'],
  ];
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_colours'`).get()) {
    let n = 0;
    const maxRow = db.prepare(`SELECT colour_id FROM setup_colours ORDER BY colour_id DESC`).all();
    for (const r of maxRow || []) {
      const m = String(r.colour_id || '').match(/(\d+)/);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    }
    for (const [cname, abbr] of colourPairs) {
      const exists = db.prepare(`SELECT 1 FROM setup_colours WHERE lower(trim(name)) = lower(?)`).get(cname);
      if (exists) continue;
      n += 1;
      const cid = `COL-ST-${String(n).padStart(3, '0')}`;
      db.prepare(
        `INSERT INTO setup_colours (colour_id, name, abbreviation, active, sort_order) VALUES (?,?,?,?,?)`
      ).run(cid, cname, abbr, 1, 500 + n);
    }
  }

  const pli = tableCols('price_list_items');
  if (pli.size) {
    if (!pli.has('material_type_key')) db.exec(`ALTER TABLE price_list_items ADD COLUMN material_type_key TEXT NOT NULL DEFAULT ''`);
    if (!pli.has('colour_key')) db.exec(`ALTER TABLE price_list_items ADD COLUMN colour_key TEXT NOT NULL DEFAULT ''`);
    if (!pli.has('profile_key')) db.exec(`ALTER TABLE price_list_items ADD COLUMN profile_key TEXT NOT NULL DEFAULT ''`);
  }

  const accessoryProducts = [
    ['ACC-DRIVE-SCREW-PACK', 'Drive screw nail (pack)', 'pack'],
    ['ACC-SILICON-TUBE', 'Silicone (tube)', 'tube'],
    ['ACC-RIVET-PACK', 'Rivet pins (pack)', 'pack'],
    ['ACC-CONCRETE-NAIL-PACK', 'Concrete nail (pack)', 'pack'],
    ['ACC-COPPER-NAIL-PACK', 'Copper nail (pack)', 'pack'],
    ['ACC-TAPPING-SCREW-PCS', 'Tapping screw nail (pcs)', 'pcs'],
    ['ACC-FLASH-BAND-ROLL', 'Flash band (roll)', 'roll'],
    ['ACC-FELT-ROLL', 'Felt (roll)', 'roll'],
    ['ACC-HOOKS-BOLT-PCS', 'Hooks and bolts (pcs)', 'pcs'],
    ['ACC-WASHER-PACK', 'Washer (pack)', 'pack'],
    ['ACC-REPAIR-KIT', 'Repair Kit', 'kit'],
    ['ACC-STRAPPING-NAIL-PACK', 'Strapping nail (pack)', 'pack'],
    ['ACC-SPOOL-PACK', 'Spool (pack)', 'pack'],
    ['ACC-STONE-NAIL-PACK', 'Stone nail (pack)', 'pack'],
  ];
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) {
    for (const [pid, pname, unit] of accessoryProducts) {
      const ex = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get(pid);
      if (ex) continue;
      const dash = JSON.stringify({ inventoryModel: 'consumable', accessoryKind: 'accessory' });
      db.prepare(
        `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
         VALUES (?,?,0,?,0,0,'','','Accessory',?, '')`
      ).run(pid, pname, unit, dash);
    }
  }

  const accessoryQuoteLinks = [
    ['SQI-005', 'Tapping Screw', 'ACC-TAPPING-SCREW-PCS', 'pcs'],
    ['SQI-006', 'Silicone tube', 'ACC-SILICON-TUBE', 'tube'],
    ['SQI-007', 'Rivet pins', 'ACC-RIVET-PACK', 'pack'],
    ['SQI-008', 'Flash band', 'ACC-FLASH-BAND-ROLL', 'roll'],
    ['SQI-012', 'Drive screw nail', 'ACC-DRIVE-SCREW-PACK', 'pack'],
    ['SQI-013', 'Copper nail', 'ACC-COPPER-NAIL-PACK', 'pack'],
    ['SQI-014', 'Concrete nail', 'ACC-CONCRETE-NAIL-PACK', 'pack'],
    ['SQI-015', 'Felt', 'ACC-FELT-ROLL', 'roll'],
    ['SQI-016', 'Hooks and bolts', 'ACC-HOOKS-BOLT-PCS', 'pcs'],
    ['SQI-017', 'Washer', 'ACC-WASHER-PACK', 'pack'],
    ['SQI-018', 'Repair Kit', 'ACC-REPAIR-KIT', 'kit'],
    ['SQI-019', 'Strapping nail', 'ACC-STRAPPING-NAIL-PACK', 'pack'],
    ['SQI-020', 'Spool', 'ACC-SPOOL-PACK', 'pack'],
    ['SQI-035', 'Stone nail', 'ACC-STONE-NAIL-PACK', 'pack'],
  ];
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_quote_items'`).get()) {
    for (const [itemId, , invPid, unit] of accessoryQuoteLinks) {
      const ex = db.prepare(`SELECT 1 FROM setup_quote_items WHERE item_id = ?`).get(itemId);
      if (ex) {
        db.prepare(`UPDATE setup_quote_items SET inventory_product_id = ?, unit = ? WHERE item_id = ?`).run(
          invPid,
          unit,
          itemId
        );
      }
      // Do not INSERT here: pre-seed rows make seedMasterData skip the whole quote-items table,
      // leaving core items (e.g. SQI-001) missing and breaking setup_price_lists FKs.
    }
  }
}

/**
 * Roofing / sheet designs (aluzinc + stone-coated). Metcopo → Metcoppo; Steptiles → Steptile;
 * Stonecoted → Stone coated; Flatsheet → Flat sheet; Off Cut → Offcut; Krimpt curve → Crimp curve;
 * Metrotile → Longspan (Metra). Adds Roman, Metcoppo, Stone coated, Offcut, Crimp curve profiles.
 */
function migrateRoofingProfileCatalog2026(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_profiles'`).get()) return;
  try {
    const pc = db.prepare(`PRAGMA table_info(setup_profiles)`).all();
    if (!pc.some((c) => c.name === 'material_type_id')) {
      db.exec(`ALTER TABLE setup_profiles ADD COLUMN material_type_id TEXT`);
    }
  } catch {
    return;
  }

  const exists = db.prepare(`SELECT 1 FROM setup_profiles WHERE profile_id = ?`);
  const upd = db.prepare(
    `UPDATE setup_profiles SET name = ?, active = 1, sort_order = ?, material_type_id = ? WHERE profile_id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO setup_profiles (profile_id, name, active, sort_order, material_type_id) VALUES (?,?,1,?,?)`
  );

  /** @type {[string, string, string, number][]} */
  const rows = [
    ['PROF-001', 'Longspan (Indus6)', 'MAT-002', 10],
    ['PROF-002', 'Longspan (Metra)', 'MAT-002', 20],
    ['PROF-012', 'Metcoppo', 'MAT-002', 30],
    ['PROF-013', 'Stone coated', 'MAT-005', 40],
    ['PROF-006', 'Flat sheet', 'MAT-002', 50],
    ['PROF-014', 'Offcut', 'MAT-002', 60],
    ['PROF-003', 'Steptile', 'MAT-002', 70],
    ['PROF-004', 'Capping', 'MAT-002', 75],
    ['PROF-005', 'Ridge Cap', 'MAT-002', 80],
    ['PROF-008', 'Bond', 'MAT-005', 90],
    ['PROF-007', 'Milano', 'MAT-005', 100],
    ['PROF-009', 'Classic', 'MAT-005', 110],
    ['PROF-016', 'Single', 'MAT-005', 115],
    ['PROF-010', 'Shingle', 'MAT-005', 120],
    ['PROF-011', 'Roman', 'MAT-005', 130],
    ['PROF-015', 'Crimp curve', 'MAT-002', 140],
  ];

  db.transaction(() => {
    for (const [id, name, mat, sort] of rows) {
      if (exists.get(id)) {
        upd.run(name, sort, mat, id);
      } else {
        ins.run(id, name, sort, mat);
      }
    }
  })();
}

/**
 * Quotations must offer coil (Aluminium / Aluzinc) and stone-coated types. Some DBs only had
 * MAT-005 after partial migrations, or MAT-001/002 were left inactive — repair rows so Sales sees all three.
 */
function migrateEnsureQuotationMaterialTypes(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_material_types'`).get()) {
    return;
  }
  let cols;
  try {
    cols = new Set(db.prepare(`PRAGMA table_info(setup_material_types)`).all().map((c) => c.name));
  } catch {
    return;
  }
  if (!cols.has('inventory_model')) {
    db.exec(`ALTER TABLE setup_material_types ADD COLUMN inventory_model TEXT NOT NULL DEFAULT 'coil_kg'`);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO setup_material_types
      (material_type_id, name, density_kg_per_m3, width_m, active, sort_order, inventory_model)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  insert.run('MAT-001', 'Aluminium', 7850, 1.2, 1, 'coil_kg');
  insert.run('MAT-002', 'Aluzinc', 7850, 1.2, 2, 'coil_kg');
  insert.run('MAT-005', 'Stone coated', 0, 0, 4, 'stone_meter');

  db.prepare(
    `UPDATE setup_material_types SET active = 1, name = 'Aluminium', inventory_model = 'coil_kg' WHERE material_type_id = 'MAT-001'`
  ).run();
  db.prepare(
    `UPDATE setup_material_types SET active = 1, name = 'Aluzinc', inventory_model = 'coil_kg' WHERE material_type_id = 'MAT-002'`
  ).run();
  db.prepare(
    `UPDATE setup_material_types SET active = 1, name = 'Stone coated', inventory_model = 'stone_meter' WHERE material_type_id = 'MAT-005'`
  ).run();
}

/** HR roadmap: three-step request workflow, policy store, holidays, branch history, payroll signing, discipline & appraisals. */
function migrateHrExcellence2026(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_requests'`).get()) return;

  const reqC = tableCols('hr_requests');
  if (reqC.size && !reqC.has('gm_hr_reviewer_user_id')) {
    db.exec(`ALTER TABLE hr_requests ADD COLUMN gm_hr_reviewer_user_id TEXT`);
  }
  if (reqC.size && !reqC.has('gm_hr_reviewer_note')) {
    db.exec(`ALTER TABLE hr_requests ADD COLUMN gm_hr_reviewer_note TEXT`);
  }
  if (reqC.size && !reqC.has('gm_hr_reviewed_at_iso')) {
    db.exec(`ALTER TABLE hr_requests ADD COLUMN gm_hr_reviewed_at_iso TEXT`);
  }
  try {
    db.prepare(`UPDATE hr_requests SET status = 'branch_manager_review' WHERE status = 'manager_review'`).run();
  } catch {
    /* ignore */
  }

  const prof = tableCols('hr_staff_profiles');
  if (prof.size && !prof.has('line_manager_user_id')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN line_manager_user_id TEXT`);
  }
  if (prof.size && !prof.has('leave_entitlement_band')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN leave_entitlement_band TEXT`);
  }

  const pr = tableCols('hr_payroll_runs');
  if (pr.size && !pr.has('signed_at_iso')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN signed_at_iso TEXT`);
  }
  if (pr.size && !pr.has('signed_by_user_id')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN signed_by_user_id TEXT`);
  }
  if (pr.size && !pr.has('signature_kind')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN signature_kind TEXT`);
  }
  if (pr.size && !pr.has('signed_pdf_sha256')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN signed_pdf_sha256 TEXT`);
  }
  if (pr.size && !pr.has('filing_status')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN filing_status TEXT`);
  }
  if (pr.size && !pr.has('filing_reference')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN filing_reference TEXT`);
  }
  if (pr.size && !pr.has('filing_at_iso')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN filing_at_iso TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_policy_config (
      id TEXT PRIMARY KEY,
      effective_from_iso TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hr_public_holidays (
      day_iso TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'NG',
      PRIMARY KEY (day_iso, scope)
    );

    CREATE TABLE IF NOT EXISTS hr_staff_branch_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_branch_id TEXT,
      to_branch_id TEXT NOT NULL,
      effective_from_iso TEXT NOT NULL,
      reason TEXT,
      actor_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_branch_hist_user ON hr_staff_branch_history(user_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_discipline_cases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      offence_category TEXT,
      summary TEXT,
      opened_at_iso TEXT NOT NULL,
      opened_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_discipline_user ON hr_discipline_cases(user_id, opened_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_discipline_events (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      note TEXT,
      actor_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_discipline_events_case ON hr_discipline_events(case_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_appraisal_cycles (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      year INTEGER NOT NULL,
      due_by_iso TEXT,
      status TEXT NOT NULL,
      created_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hr_appraisal_forms (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      reviewer_user_id TEXT,
      scores_json TEXT,
      md_confirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT,
      FOREIGN KEY (cycle_id) REFERENCES hr_appraisal_cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_appraisal_subject ON hr_appraisal_forms(subject_user_id, cycle_id);

    CREATE TABLE IF NOT EXISTS hr_feedback_notes (
      id TEXT PRIMARY KEY,
      subject_user_id TEXT NOT NULL,
      author_user_id TEXT,
      body TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (subject_user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_feedback_subject ON hr_feedback_notes(subject_user_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_job_runs (
      id TEXT PRIMARY KEY,
      job_key TEXT NOT NULL,
      started_at_iso TEXT NOT NULL,
      finished_at_iso TEXT,
      status TEXT NOT NULL,
      detail_json TEXT
    );
  `);

  const holCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_public_holidays`).get().c;
  if (holCount === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO hr_public_holidays (day_iso, label, scope) VALUES (?,?,?)`);
    const y = new Date().getFullYear();
    const fixed = [
      [`${y}-01-01`, "New Year's Day", 'NG'],
      [`${y}-05-01`, 'Workers Day', 'NG'],
      [`${y}-12-25`, 'Christmas Day', 'NG'],
      [`${y}-12-26`, 'Boxing Day', 'NG'],
    ];
    for (const [d, l, s] of fixed) ins.run(d, l, s);
  }

  const pc = db.prepare(`SELECT COUNT(*) AS c FROM hr_policy_config`).get().c;
  if (pc === 0) {
    const id = `HRPOL-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const payload = JSON.stringify({
      loanMinServiceYears: 3,
      loanMaxSalaryMonths: 4,
      loanMaxRepaymentMonths: 12,
      maxConcurrentBranchLoans: 5,
      annualLeaveDaysSenior: 21,
      annualLeaveDaysJunior: 14,
      casualLeaveDaysPerYear: 7,
      maternityLeaveDays: 60,
      pensionEmployeePercent: 8,
      pensionEmployerPercent: 10,
      halfMonthBonusRate: 0.5,
    });
    db.prepare(
      `INSERT INTO hr_policy_config (id, effective_from_iso, payload_json, created_at_iso) VALUES (?,?,?,?)`
    ).run(id, now.slice(0, 10), payload, now);
  }
}

/** Finished-goods metre adjustments after completion (audit + stock_movements; original completion unchanged). */
function migrateProductionCompletionAdjustments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_completion_adjustments (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      branch_id TEXT,
      delta_finished_goods_m REAL NOT NULL,
      note TEXT NOT NULL,
      at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_name TEXT,
      FOREIGN KEY (job_id) REFERENCES production_jobs(job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_production_completion_adj_job
      ON production_completion_adjustments(job_id, at_iso DESC);
  `);
}

/** Price list, payroll MD approval columns, HR self-service flag. */
function migratePriceListAndPayrollMd(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_list_items (
      id TEXT PRIMARY KEY,
      gauge_key TEXT NOT NULL,
      design_key TEXT NOT NULL,
      unit_price_per_meter_ngn INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      branch_id TEXT,
      effective_from_iso TEXT,
      updated_at_iso TEXT,
      updated_by_user_id TEXT,
      material_type_key TEXT NOT NULL DEFAULT '',
      colour_key TEXT NOT NULL DEFAULT '',
      profile_key TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_price_list_gauge_design ON price_list_items(gauge_key, design_key, branch_id);
  `);
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('self_service_eligible')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN self_service_eligible INTEGER NOT NULL DEFAULT 0`);
  }
  if (hr.size && !hr.has('profile_submitted_at_iso')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN profile_submitted_at_iso TEXT`);
  }
  if (hr.size && !hr.has('profile_locked')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN profile_locked INTEGER NOT NULL DEFAULT 0`);
  }
  if (hr.size && !hr.has('profile_verified_at_iso')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN profile_verified_at_iso TEXT`);
  }
  const pr = tableCols('hr_payroll_runs');
  if (pr.size && !pr.has('md_approved_at_iso')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN md_approved_at_iso TEXT`);
  }
  if (pr.size && !pr.has('md_approved_by_user_id')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN md_approved_by_user_id TEXT`);
  }
  if (pr.size && !pr.has('gm_approved_at_iso')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN gm_approved_at_iso TEXT`);
  }
  if (pr.size && !pr.has('gm_approved_by_user_id')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN gm_approved_by_user_id TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_sensitive_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'general',
      created_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_sensitive_tokens_user ON hr_sensitive_tokens(user_id, expires_at_iso DESC);
  `);
}

/** Quote item → inventory SKU mapping; per-job accessory fulfillment for refunds and stock. */
function migrateAccessoryOperations(db) {
  const sqiCols = db.prepare(`PRAGMA table_info(setup_quote_items)`).all();
  const sqiNames = new Set(sqiCols.map((c) => c.name));
  if (sqiCols.length > 0 && !sqiNames.has('inventory_product_id')) {
    db.exec(`ALTER TABLE setup_quote_items ADD COLUMN inventory_product_id TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_job_accessory_usage (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      quotation_ref TEXT,
      quote_line_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ordered_qty REAL NOT NULL DEFAULT 0,
      supplied_qty REAL NOT NULL DEFAULT 0,
      inventory_product_id TEXT,
      posted_at_iso TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES production_jobs(job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_job_acc_usage_quotation
      ON production_job_accessory_usage(quotation_ref, quote_line_id);
    CREATE INDEX IF NOT EXISTS idx_prod_job_acc_usage_job
      ON production_job_accessory_usage(job_id);
    CREATE TABLE IF NOT EXISTS production_job_stone_flatsheet_usage (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      quotation_ref TEXT,
      quote_line_id TEXT NOT NULL,
      name TEXT NOT NULL,
      length_m REAL NOT NULL,
      ordered_m2 REAL NOT NULL DEFAULT 0,
      supplied_m2 REAL NOT NULL DEFAULT 0,
      deduction_m2 REAL NOT NULL DEFAULT 0,
      inventory_product_id TEXT,
      posted_at_iso TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES production_jobs(job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prod_job_sf_usage_quotation
      ON production_job_stone_flatsheet_usage(quotation_ref, quote_line_id);
    CREATE INDEX IF NOT EXISTS idx_prod_job_sf_usage_job
      ON production_job_stone_flatsheet_usage(job_id);
  `);
}

/** Map legacy free-text expense categories on `expenses` to canonical labels; refresh treasury counterparty names. */
function migrateExpenseCategoriesToCanonical(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='expenses'`).get()) return;
  const rows = db.prepare(`SELECT expense_id, category FROM expenses WHERE category IS NOT NULL`).all();
  const upd = db.prepare(`UPDATE expenses SET category = ? WHERE expense_id = ?`);
  for (const r of rows) {
    const cur = String(r.category ?? '').trim();
    if (!cur || isAllowedExpenseCategory(cur)) continue;
    const next = mapLegacyExpenseCategoryToCanonical(cur);
    if (next !== cur) upd.run(next, r.expense_id);
  }
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='treasury_movements'`).get()) return;
  db.prepare(
    `UPDATE treasury_movements
     SET counterparty_name = COALESCE(
       (SELECT e.category FROM expenses e WHERE e.expense_id = treasury_movements.counterparty_id),
       counterparty_name
     )
     WHERE counterparty_kind = 'EXPENSE'
       AND source_kind = 'EXPENSE'
       AND EXISTS (SELECT 1 FROM expenses e WHERE e.expense_id = treasury_movements.counterparty_id)`
  ).run();
}

/** Landed cost on coil lots, movement values, GL tables + seed chart. */
function migrateAccountingLayer(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const cl = tableCols('coil_lots');
  if (cl.size && !cl.has('landed_cost_ngn')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN landed_cost_ngn INTEGER`);
  }
  if (cl.size && !cl.has('unit_cost_ngn_per_kg')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN unit_cost_ngn_per_kg INTEGER`);
  }
  const sm = tableCols('stock_movements');
  if (sm.size && !sm.has('value_ngn')) {
    db.exec(`ALTER TABLE stock_movements ADD COLUMN value_ngn INTEGER`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS gl_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gl_journal_entries (
      id TEXT PRIMARY KEY,
      entry_date_iso TEXT NOT NULL,
      period_key TEXT NOT NULL,
      memo TEXT,
      source_kind TEXT,
      source_id TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      branch_id TEXT
    );
    CREATE TABLE IF NOT EXISTS gl_journal_lines (
      id TEXT PRIMARY KEY,
      journal_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      debit_ngn INTEGER NOT NULL DEFAULT 0,
      credit_ngn INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      cost_center TEXT,
      FOREIGN KEY (journal_id) REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES gl_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gl_lines_journal ON gl_journal_lines(journal_id);
    CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_journal_lines(account_id);
  `);
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_journal_source ON gl_journal_entries(source_kind, source_id) WHERE source_kind IS NOT NULL AND source_id IS NOT NULL AND TRIM(source_id) != '';`
    );
  } catch {
    /* ignore */
  }

  seedDefaultGlAccounts(db);
  const gllCols = db.prepare(`PRAGMA table_info(gl_journal_lines)`).all();
  const gllNames = new Set(gllCols.map((c) => c.name));
  if (gllNames.size && !gllNames.has('cost_center')) {
    db.exec(`ALTER TABLE gl_journal_lines ADD COLUMN cost_center TEXT`);
  }
}

/** Extra columns on hr_staff_profiles (idempotent). */
function migrateHrStaffProfileColumns(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('academic_qualification')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN academic_qualification TEXT`);
  }
  if (hr.size && !hr.has('paye_tax_percent')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN paye_tax_percent REAL`);
  }
  if (hr.size && !hr.has('pension_percent_override')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN pension_percent_override REAL`);
  }
  if (hr.size && !hr.has('payroll_group')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN payroll_group TEXT`);
  }
  if (hr.size && !hr.has('is_production_staff')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN is_production_staff INTEGER NOT NULL DEFAULT 0`);
  }
  if (hr.size && !hr.has('salary_level')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN salary_level INTEGER`);
  }
  if (hr.size && !hr.has('salary_step')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN salary_step INTEGER`);
  }
  migrateHrModule(db);
  migrateHrPhase5PayrollSchema(db);
  migrateHrPhase6BenefitsAndOps(db);
  migrateHrStaffDocumentsSchema(db);
  migrateHrLifecycleAndNotificationsSchema(db);
  migrateHrRecruitingLearningEngagementSchema(db);
  migrateHrNewFieldsPhase10(db);
  migrateHrPhase2Policy2026(db);
  migrateHrPhase4Ops2026(db);
  migrateHrPhase5Ops2026(db);
  migrateHrPhase5aCompleteness2026(db);
  migrateHrPhase6Governance2026(db);
  migrateHrPhase7DisciplineLetters2026(db);
  migrateHrPhase8Operational2026(db);
  migrateHrPhase9ExecutiveBenefits2026(db);
  migrateHrOrgTenure2026(db);
  migratePayrollPensionPolicy2026(db);
  migratePayeTaxAmount2026(db);
}

/** Designation tenure gates + functional office metadata on catalog. */
function migrateHrOrgTenure2026(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const des = tableCols('hr_designations');
  if (des.size && !des.has('min_service_years')) {
    db.exec(`ALTER TABLE hr_designations ADD COLUMN min_service_years REAL`);
  }
  if (des.size && !des.has('title_tier')) {
    db.exec(`ALTER TABLE hr_designations ADD COLUMN title_tier TEXT`);
  }
  if (des.size && !des.has('functional_office_key')) {
    db.exec(`ALTER TABLE hr_designations ADD COLUMN functional_office_key TEXT`);
  }
  if (des.size && !des.has('is_acting')) {
    db.exec(`ALTER TABLE hr_designations ADD COLUMN is_acting INTEGER NOT NULL DEFAULT 0`);
  }
}

/** PAYE as fixed monthly naira amount per staff (not percentage). */
function migratePayeTaxAmount2026(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('paye_tax_ngn')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN paye_tax_ngn INTEGER`);
  }
}

/** Pension employer totals on payroll runs/lines; policy pension defaults. */
function migratePayrollPensionPolicy2026(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const runs = tableCols('hr_payroll_runs');
  if (runs.size && !runs.has('pension_employer_percent')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN pension_employer_percent REAL`);
  }
  if (runs.size && !runs.has('pension_employer_total_ngn')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN pension_employer_total_ngn REAL DEFAULT 0`);
  }
  const lines = tableCols('hr_payroll_lines');
  if (lines.size && !lines.has('pension_employer_ngn')) {
    db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN pension_employer_ngn INTEGER NOT NULL DEFAULT 0`);
  }
  try {
    const row = db
      .prepare(`SELECT payload_json FROM hr_policy_config ORDER BY effective_from_iso DESC LIMIT 1`)
      .get();
    if (row?.payload_json) {
      const parsed = JSON.parse(String(row.payload_json));
      const merged = {
        ...parsed,
        pensionEmployeePercent: parsed.pensionEmployeePercent ?? 8,
        pensionEmployerPercent: parsed.pensionEmployerPercent ?? 10,
        halfMonthBonusRate: parsed.halfMonthBonusRate ?? 0.5,
      };
      if (
        parsed.pensionEmployeePercent == null ||
        parsed.pensionEmployerPercent == null ||
        parsed.halfMonthBonusRate == null
      ) {
        const id = `HRPOL-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO hr_policy_config (id, effective_from_iso, payload_json, created_at_iso) VALUES (?,?,?,?)`
        ).run(id, now.slice(0, 10), JSON.stringify(merged), now);
      } else if (Number(parsed.loanMaxRepaymentMonths) === 4) {
        const id = `HRPOL-${Date.now().toString(36)}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO hr_policy_config (id, effective_from_iso, payload_json, created_at_iso) VALUES (?,?,?,?)`
        ).run(
          id,
          now.slice(0, 10),
          JSON.stringify({ ...parsed, loanMaxRepaymentMonths: 12 }),
          now
        );
      }
    }
  } catch {
    /* ignore */
  }
}

/** Phase 9: executive benefits — scholarships, stipends, domestic staff, beneficiary payments. */
function migrateHrPhase9ExecutiveBenefits2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_chairman_school_fees (
      id TEXT PRIMARY KEY,
      child_name TEXT,
      school_name TEXT,
      term TEXT,
      academic_year TEXT,
      fee_amount_ngn REAL,
      fee_type TEXT,
      payment_status TEXT,
      amount_paid_ngn REAL DEFAULT 0,
      payment_date_iso TEXT,
      notes TEXT,
      created_at_iso TEXT,
      created_by_user_id TEXT,
      updated_at_iso TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_chairman_expenses (
      id TEXT PRIMARY KEY,
      expense_type TEXT,
      description TEXT,
      amount_ngn REAL,
      quantity INTEGER DEFAULT 1,
      unit TEXT,
      period_yyyymm TEXT,
      payment_status TEXT,
      payment_date_iso TEXT,
      vendor_name TEXT,
      notes TEXT,
      created_at_iso TEXT,
      created_by_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_executive_beneficiaries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      beneficiary_type TEXT,
      relationship TEXT,
      linked_executive TEXT,
      school_name TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      bank_name TEXT,
      bank_code TEXT,
      bank_account_name TEXT,
      bank_account_enc TEXT,
      created_at_iso TEXT,
      created_by_user_id TEXT,
      updated_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_ex_ben_exec ON hr_executive_beneficiaries(linked_executive);

    CREATE TABLE IF NOT EXISTS hr_executive_stipends (
      id TEXT PRIMARY KEY,
      beneficiary_id TEXT,
      beneficiary_name TEXT,
      beneficiary_type TEXT,
      linked_executive TEXT,
      monthly_amount_ngn REAL NOT NULL DEFAULT 0,
      start_date_iso TEXT,
      end_date_iso TEXT,
      payment_frequency TEXT NOT NULL DEFAULT 'monthly',
      bank_name TEXT,
      bank_code TEXT,
      bank_account_name TEXT,
      bank_account_enc TEXT,
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      approval_status TEXT NOT NULL DEFAULT 'draft',
      approved_by_user_id TEXT,
      last_paid_period TEXT,
      notes TEXT,
      created_at_iso TEXT,
      created_by_user_id TEXT,
      updated_at_iso TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_domestic_staff_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      staff_name TEXT NOT NULL,
      employee_no TEXT,
      designation TEXT,
      assigned_executive TEXT,
      work_location TEXT,
      employment_type TEXT,
      date_joined_iso TEXT,
      salary_amount_ngn REAL DEFAULT 0,
      bank_name TEXT,
      bank_code TEXT,
      bank_account_name TEXT,
      bank_account_enc TEXT,
      emergency_contact TEXT,
      next_of_kin TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at_iso TEXT,
      created_by_user_id TEXT,
      updated_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_domestic_exec ON hr_domestic_staff_profiles(assigned_executive);

    CREATE TABLE IF NOT EXISTS hr_executive_payments (
      id TEXT PRIMARY KEY,
      payment_type TEXT NOT NULL,
      source_kind TEXT,
      source_id TEXT,
      payee_name TEXT,
      amount_ngn REAL NOT NULL DEFAULT 0,
      period_yyyymm TEXT,
      term TEXT,
      academic_session TEXT,
      bank_name TEXT,
      bank_code TEXT,
      bank_account_name TEXT,
      bank_account_enc TEXT,
      narration TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      requested_by_user_id TEXT,
      reviewed_by_user_id TEXT,
      approved_by_user_id TEXT,
      paid_by_user_id TEXT,
      paid_at_iso TEXT,
      document_ref TEXT,
      proof_ref TEXT,
      rejection_reason TEXT,
      export_id TEXT,
      created_at_iso TEXT,
      updated_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_ex_pay_status ON hr_executive_payments(status, payment_type);

    CREATE TABLE IF NOT EXISTS hr_executive_payment_exports (
      id TEXT PRIMARY KEY,
      period_yyyymm TEXT,
      payment_type TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      total_ngn REAL NOT NULL DEFAULT 0,
      exported_by_user_id TEXT,
      exported_at_iso TEXT,
      meta_json TEXT
    );
  `);
  const fees = cols('hr_chairman_school_fees');
  if (fees.size) {
    const add = (name, ddl) => {
      if (!fees.has(name)) db.exec(`ALTER TABLE hr_chairman_school_fees ADD COLUMN ${ddl}`);
    };
    add('beneficiary_id', 'beneficiary_id TEXT');
    add('beneficiary_type', 'beneficiary_type TEXT');
    add('linked_executive', 'linked_executive TEXT');
    add('relationship', 'relationship TEXT');
    add('class_level', 'class_level TEXT');
    add('academic_session', 'academic_session TEXT');
    add('amount_requested_ngn', 'amount_requested_ngn REAL');
    add('amount_approved_ngn', 'amount_approved_ngn REAL');
    add('due_date_iso', 'due_date_iso TEXT');
    add('approval_status', 'approval_status TEXT');
    add('approved_by_user_id', 'approved_by_user_id TEXT');
    add('paid_by_user_id', 'paid_by_user_id TEXT');
    add('document_ref', 'document_ref TEXT');
    add('workflow_status', 'workflow_status TEXT');
    add('payment_id', 'payment_id TEXT');
    add('beneficiary_name', 'beneficiary_name TEXT');
  }
}

/** Phase 8: letter workflow, settings, bulk import, staff numbering. */
function migrateHrPhase8Operational2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at_iso TEXT,
      updated_by_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_staff_import_runs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_staff_import_runs_at ON hr_staff_import_runs(created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_employee_number_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      old_employee_no TEXT,
      new_employee_no TEXT,
      batch_id TEXT,
      changed_at_iso TEXT NOT NULL,
      changed_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_empno_hist_user ON hr_employee_number_history(user_id, changed_at_iso DESC);
  `);
  const letters = cols('hr_employment_letters');
  if (letters.size) {
    const add = (name, ddl) => {
      if (!letters.has(name)) db.exec(`ALTER TABLE hr_employment_letters ADD COLUMN ${ddl}`);
    };
    add('reference_number', 'reference_number TEXT');
    add('draft_id', 'draft_id TEXT');
    add('prepared_by_user_id', 'prepared_by_user_id TEXT');
    add('submitted_at_iso', 'submitted_at_iso TEXT');
    add('submitted_by_user_id', 'submitted_by_user_id TEXT');
    add('hr_reviewed_at_iso', 'hr_reviewed_at_iso TEXT');
    add('hr_reviewed_by_user_id', 'hr_reviewed_by_user_id TEXT');
    add('gm_reviewed_at_iso', 'gm_reviewed_at_iso TEXT');
    add('gm_reviewed_by_user_id', 'gm_reviewed_by_user_id TEXT');
    add('md_approved_at_iso', 'md_approved_at_iso TEXT');
    add('md_approved_by_user_id', 'md_approved_by_user_id TEXT');
    add('rejection_reason', 'rejection_reason TEXT');
    add('download_count', 'download_count INTEGER NOT NULL DEFAULT 0');
    add('print_count', 'print_count INTEGER NOT NULL DEFAULT 0');
    if (letters.has('status')) {
      /* existing rows stay issued; new letters use draft via app code */
    } else {
      db.exec(`ALTER TABLE hr_employment_letters ADD COLUMN status TEXT NOT NULL DEFAULT 'issued'`);
    }
  }
  const ack = cols('hr_policy_acknowledgements');
  if (ack.size) {
    if (!ack.has('expires_at_iso')) db.exec(`ALTER TABLE hr_policy_acknowledgements ADD COLUMN expires_at_iso TEXT`);
    if (!ack.has('witness_user_id')) db.exec(`ALTER TABLE hr_policy_acknowledgements ADD COLUMN witness_user_id TEXT`);
    if (!ack.has('client_meta_json')) db.exec(`ALTER TABLE hr_policy_acknowledgements ADD COLUMN client_meta_json TEXT`);
  }
}

/** Phase 7: discipline case management, evidence, witnesses, appeals. */
function migrateHrPhase7DisciplineLetters2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  let cases = cols('hr_discipline_cases');
  if (!cases.size) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hr_discipline_cases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        status TEXT NOT NULL,
        offence_category TEXT,
        summary TEXT,
        opened_at_iso TEXT NOT NULL,
        opened_by_user_id TEXT,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_hr_discipline_user ON hr_discipline_cases(user_id, opened_at_iso DESC);
    `);
    cases = cols('hr_discipline_cases');
  }
  if (cases.size) {
    const addCol = (name, ddl) => {
      if (!cases.has(name)) db.exec(`ALTER TABLE hr_discipline_cases ADD COLUMN ${ddl}`);
    };
    addCol('case_number', 'case_number TEXT');
    addCol('case_type', 'case_type TEXT');
    addCol('severity', "severity TEXT NOT NULL DEFAULT 'medium'");
    addCol('description', 'description TEXT');
    addCol('department', 'department TEXT');
    addCol('designation', 'designation TEXT');
    addCol('incident_date_iso', 'incident_date_iso TEXT');
    addCol('reported_date_iso', 'reported_date_iso TEXT');
    addCol('reported_by_user_id', 'reported_by_user_id TEXT');
    addCol('employee_response', 'employee_response TEXT');
    addCol('investigation_officer_user_id', 'investigation_officer_user_id TEXT');
    addCol('investigation_findings', 'investigation_findings TEXT');
    addCol('hr_recommendation', 'hr_recommendation TEXT');
    addCol('management_decision', 'management_decision TEXT');
    addCol('sanction', 'sanction TEXT');
    addCol('appeal_status', 'appeal_status TEXT');
    addCol('final_outcome', 'final_outcome TEXT');
    addCol('closure_date_iso', 'closure_date_iso TEXT');
    addCol('closed_by_user_id', 'closed_by_user_id TEXT');
    addCol('related_letter_ids_json', 'related_letter_ids_json TEXT');
    addCol('payroll_block_flags_json', 'payroll_block_flags_json TEXT');
    addCol('meta_json', 'meta_json TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_discipline_case_evidence (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      description TEXT NOT NULL,
      file_ref TEXT,
      document_id TEXT,
      uploaded_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_discipline_evidence_case ON hr_discipline_case_evidence(case_id, created_at_iso);

    CREATE TABLE IF NOT EXISTS hr_discipline_case_witnesses (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      witness_name TEXT NOT NULL,
      witness_role TEXT,
      statement TEXT,
      contact TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_discipline_witness_case ON hr_discipline_case_witnesses(case_id);

    CREATE TABLE IF NOT EXISTS hr_discipline_appeals (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      grounds TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      outcome TEXT,
      filed_at_iso TEXT NOT NULL,
      decided_at_iso TEXT,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_discipline_appeals_case ON hr_discipline_appeals(case_id, filed_at_iso DESC);
  `);
  const letters = cols('hr_employment_letters');
  if (letters.size && !letters.has('status')) {
    db.exec(`ALTER TABLE hr_employment_letters ADD COLUMN status TEXT NOT NULL DEFAULT 'issued'`);
  }
}

/** Phase 5A: document verification, ID card metadata. */
function migrateHrPhase5aCompleteness2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const docs = cols('hr_staff_documents');
  if (docs.size) {
    if (!docs.has('expiry_date_iso')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN expiry_date_iso TEXT`);
    if (!docs.has('issue_date_iso')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN issue_date_iso TEXT`);
    if (!docs.has('verification_status')) {
      db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'`);
    }
    if (!docs.has('verified_by_user_id')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN verified_by_user_id TEXT`);
    if (!docs.has('verified_at_iso')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN verified_at_iso TEXT`);
    if (!docs.has('rejection_reason')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN rejection_reason TEXT`);
    if (!docs.has('notes')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN notes TEXT`);
    if (!docs.has('doc_category')) db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN doc_category TEXT`);
  }
  const cards = cols('hr_id_cards');
  if (cards.size) {
    if (!cards.has('issue_date_iso')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN issue_date_iso TEXT`);
    if (!cards.has('expiry_date_iso')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN expiry_date_iso TEXT`);
    if (!cards.has('blood_group')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN blood_group TEXT`);
    if (!cards.has('emergency_contact')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN emergency_contact TEXT`);
    if (!cards.has('replacement_reason')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN replacement_reason TEXT`);
    if (!cards.has('lost_damaged_flag')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN lost_damaged_flag INTEGER NOT NULL DEFAULT 0`);
    if (!cards.has('approved_by_user_id')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN approved_by_user_id TEXT`);
    if (!cards.has('printed_by_user_id')) db.exec(`ALTER TABLE hr_id_cards ADD COLUMN printed_by_user_id TEXT`);
  }
}

/** Phase 6 governance: payroll control, skills, grievances, exit interviews. */
function migrateHrPhase6Governance2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const lines = cols('hr_payroll_lines');
  if (lines.size) {
    if (!lines.has('pay_hold')) db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN pay_hold INTEGER NOT NULL DEFAULT 0`);
    if (!lines.has('hold_reason')) db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN hold_reason TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_bonus_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      bonus_type TEXT NOT NULL DEFAULT 'half_month',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      requested_at_iso TEXT NOT NULL,
      requested_by_user_id TEXT,
      approved_at_iso TEXT,
      approved_by_user_id TEXT,
      rejected_at_iso TEXT,
      rejection_reason TEXT,
      applied_at_iso TEXT,
      FOREIGN KEY (run_id) REFERENCES hr_payroll_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_bonus_requests_run ON hr_bonus_requests(run_id, status);

    CREATE TABLE IF NOT EXISTS hr_payroll_reconciliations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      bank_export_total_ngn INTEGER NOT NULL DEFAULT 0,
      exported_at_iso TEXT,
      exported_by_user_id TEXT,
      reconciled_at_iso TEXT,
      reconciled_by_user_id TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES hr_payroll_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_staff_skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      proficiency_level INTEGER NOT NULL DEFAULT 3,
      verified INTEGER NOT NULL DEFAULT 0,
      verified_at_iso TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      updated_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_staff_skills_user ON hr_staff_skills(user_id);

    CREATE TABLE IF NOT EXISTS hr_grievances (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      branch_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      anonymous_flag INTEGER NOT NULL DEFAULT 0,
      assigned_to_user_id TEXT,
      resolution_note TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      resolved_at_iso TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_grievances_branch ON hr_grievances(branch_id, status);

    CREATE TABLE IF NOT EXISTS hr_exit_interviews (
      id TEXT PRIMARY KEY,
      clearance_id TEXT NOT NULL UNIQUE,
      user_id TEXT,
      responses_json TEXT NOT NULL,
      conducted_at_iso TEXT,
      conducted_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
  `);
}

/** Phase 5: transfer timeline, letter linking metadata. */
function migrateHrPhase5Ops2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const xfer = cols('hr_transfer_requests');
  if (xfer.size) {
    if (!xfer.has('rejection_reason')) db.exec(`ALTER TABLE hr_transfer_requests ADD COLUMN rejection_reason TEXT`);
    if (!xfer.has('timeline_json')) db.exec(`ALTER TABLE hr_transfer_requests ADD COLUMN timeline_json TEXT`);
    if (!xfer.has('resubmitted_from_id')) db.exec(`ALTER TABLE hr_transfer_requests ADD COLUMN resubmitted_from_id TEXT`);
  }
  const letters = cols('hr_employment_letters');
  if (letters.size && !letters.has('source_record_kind')) {
    db.exec(`ALTER TABLE hr_employment_letters ADD COLUMN source_record_kind TEXT`);
    db.exec(`ALTER TABLE hr_employment_letters ADD COLUMN source_record_id TEXT`);
  }
}

/** Phase 4: master data, transfer requests, bank fields (2026). */
function migrateHrPhase4Ops2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      branch_scope TEXT,
      head_user_id TEXT,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_departments_active ON hr_departments(active, name);

    CREATE TABLE IF NOT EXISTS hr_designations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      department_id TEXT,
      grade_category TEXT,
      seniority_band TEXT,
      default_salary_level INTEGER,
      default_salary_step INTEGER,
      job_description TEXT,
      duties_responsibilities TEXT,
      reporting_line TEXT,
      required_qualification TEXT,
      skills_required TEXT,
      working_conditions TEXT,
      salary_range_note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      FOREIGN KEY (department_id) REFERENCES hr_departments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_designations_dept ON hr_designations(department_id, active);

    CREATE TABLE IF NOT EXISTS hr_transfer_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transfer_type TEXT NOT NULL,
      from_branch_id TEXT,
      to_branch_id TEXT,
      from_department TEXT,
      to_department TEXT,
      from_designation TEXT,
      to_designation TEXT,
      effective_date_iso TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      requested_by_user_id TEXT,
      recommended_by_user_id TEXT,
      approved_by_user_id TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      completed_at_iso TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_transfer_requests_user ON hr_transfer_requests(user_id, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_hr_transfer_requests_status ON hr_transfer_requests(status, effective_date_iso);
  `);

  const tableCols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('bank_account_no')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN bank_account_no TEXT`);
  }
  if (hr.size && !hr.has('bank_code')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN bank_code TEXT`);
  }
  if (hr.size && !hr.has('department_id')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN department_id TEXT`);
  }
  if (hr.size && !hr.has('designation_id')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN designation_id TEXT`);
  }
  if (hr.size && !hr.has('onboarding_complete')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN onboarding_complete INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Phase 2 HR policy workflows: absence and exit clearance (2026). */
function migrateHrPhase2Policy2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_absence_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT,
      department TEXT,
      absence_start_iso TEXT NOT NULL,
      expected_return_iso TEXT NOT NULL,
      actual_return_iso TEXT,
      reason TEXT NOT NULL,
      absence_type TEXT NOT NULL DEFAULT 'other',
      illness_related INTEGER NOT NULL DEFAULT 0,
      doctor_note_document_id TEXT,
      status TEXT NOT NULL DEFAULT 'reported',
      reported_by_user_id TEXT NOT NULL,
      reviewed_by_user_id TEXT,
      reviewed_at_iso TEXT,
      review_note TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_absence_reports_user ON hr_absence_reports(user_id, absence_start_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_hr_absence_reports_branch ON hr_absence_reports(branch_id, status);

    CREATE TABLE IF NOT EXISTS hr_exit_clearance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      separation_type TEXT NOT NULL,
      initiated_by_user_id TEXT NOT NULL,
      last_working_day_iso TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      finance_cleared_by_user_id TEXT,
      finance_cleared_at_iso TEXT,
      finance_notes TEXT,
      admin_cleared_by_user_id TEXT,
      admin_cleared_at_iso TEXT,
      admin_notes TEXT,
      hr_final_cleared_by_user_id TEXT,
      hr_final_cleared_at_iso TEXT,
      hr_final_notes TEXT,
      completed_at_iso TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_exit_clearance_user ON hr_exit_clearance(user_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_exit_property_items (
      id TEXT PRIMARY KEY,
      clearance_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_category TEXT NOT NULL DEFAULT 'other',
      serial_or_reference TEXT,
      condition_on_return TEXT,
      expected_return INTEGER NOT NULL DEFAULT 1,
      returned INTEGER NOT NULL DEFAULT 0,
      waived INTEGER NOT NULL DEFAULT 0,
      waived_note TEXT,
      returned_at_iso TEXT,
      received_by_user_id TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (clearance_id) REFERENCES hr_exit_clearance(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_exit_property_clearance ON hr_exit_property_items(clearance_id);
  `);
}

/** New HR fields: gender/DOB/contract/NHIS on profiles; expiry on documents; ITF/NSITF on payroll runs (Phase 10). */
function migrateHrNewFieldsPhase10(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  // hr_staff_profiles new fields
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('gender')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN gender TEXT`);
  }
  if (hr.size && !hr.has('date_of_birth')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN date_of_birth TEXT`);
  }
  if (hr.size && !hr.has('contract_end_iso')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN contract_end_iso TEXT`);
  }
  if (hr.size && !hr.has('nhis_deduction_ngn')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN nhis_deduction_ngn REAL DEFAULT 0`);
  }
  if (hr.size && !hr.has('nhis_provider')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN nhis_provider TEXT`);
  }

  // hr_staff_documents: expiry date
  const docs = tableCols('hr_staff_documents');
  if (docs.size && !docs.has('expiry_date_iso')) {
    db.exec(`ALTER TABLE hr_staff_documents ADD COLUMN expiry_date_iso TEXT`);
  }

  // hr_payroll_runs: ITF and NSITF employer levies
  const runs = tableCols('hr_payroll_runs');
  if (runs.size && !runs.has('itf_ngn')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN itf_ngn REAL DEFAULT 0`);
  }
  if (runs.size && !runs.has('nsitf_ngn')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN nsitf_ngn REAL DEFAULT 0`);
  }
}

/** Recruiting, L&D training records, engagement surveys (Phase 9). */
function migrateHrRecruitingLearningEngagementSchema(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_job_postings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      branch_id TEXT,
      department TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      openings INTEGER NOT NULL DEFAULT 1,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_job_postings_status ON hr_job_postings(status, updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_job_applicants (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'applied',
      notes TEXT,
      applied_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      hired_user_id TEXT,
      created_by_user_id TEXT,
      FOREIGN KEY (job_id) REFERENCES hr_job_postings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_job_applicants_job ON hr_job_applicants(job_id, status);

    CREATE TABLE IF NOT EXISTS hr_training_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      provider TEXT,
      completed_at_iso TEXT,
      expiry_at_iso TEXT,
      certificate_ref TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_training_user ON hr_training_records(user_id, completed_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_engagement_surveys (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      questions_json TEXT NOT NULL,
      opens_at_iso TEXT,
      closes_at_iso TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_engagement_responses (
      id TEXT PRIMARY KEY,
      survey_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      submitted_at_iso TEXT NOT NULL,
      FOREIGN KEY (survey_id) REFERENCES hr_engagement_surveys(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
      UNIQUE(survey_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_engagement_responses_survey ON hr_engagement_responses(survey_id);
  `);
  const applicants = tableCols('hr_job_applicants');
  if (applicants.size && !applicants.has('interview_scores_json')) {
    db.exec(`ALTER TABLE hr_job_applicants ADD COLUMN interview_scores_json TEXT`);
  }
  if (applicants.size && !applicants.has('offer_letter_text')) {
    db.exec(`ALTER TABLE hr_job_applicants ADD COLUMN offer_letter_text TEXT`);
  }
}

/** Lifecycle checklists + in-app HR notifications (Phase 8). */
function migrateHrLifecycleAndNotificationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      route_path TEXT,
      entity_kind TEXT,
      entity_id TEXT,
      created_at_iso TEXT NOT NULL,
      read_at_iso TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_notifications_user ON hr_notifications(user_id, read_at_iso, created_at_iso DESC);
  `);
}

/** Staff onboarding documents + NIN (Phase 7). */
function migrateHrStaffDocumentsSchema(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const hr = tableCols('hr_staff_profiles');
  if (hr.size && !hr.has('nin_number')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN nin_number TEXT`);
  }
  if (hr.size && !hr.has('bvn_number')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN bvn_number TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_staff_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      doc_kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      data_b64 TEXT NOT NULL,
      uploaded_at_iso TEXT NOT NULL,
      uploaded_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_staff_docs_user ON hr_staff_documents(user_id, doc_kind);
  `);
}

/** Benefits, incident memos, transfer recommendations (Phase 6–7). */
function migrateHrPhase6BenefitsAndOps(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_beneficiaries (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      display_name TEXT NOT NULL,
      beneficiary_type TEXT NOT NULL DEFAULT 'allowance',
      branch_id TEXT,
      monthly_amount_ngn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_beneficiaries_branch ON hr_beneficiaries(branch_id, status);

    CREATE TABLE IF NOT EXISTS hr_benefit_payments (
      id TEXT PRIMARY KEY,
      beneficiary_id TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      paid_at_iso TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (beneficiary_id) REFERENCES hr_beneficiaries(id) ON DELETE CASCADE,
      UNIQUE(beneficiary_id, period_yyyymm)
    );

    CREATE TABLE IF NOT EXISTS hr_incident_memos (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reported_by_user_id TEXT,
      incident_date_iso TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      disciplinary_event_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_incident_memos_branch ON hr_incident_memos(branch_id, incident_date_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_transfer_recommendations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_branch_id TEXT NOT NULL,
      to_branch_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      recommended_by_user_id TEXT,
      reviewed_at_iso TEXT,
      reviewed_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_transfer_rec_status ON hr_transfer_recommendations(status, created_at_iso DESC);
  `);
}

/** Salary matrix, salary history, branch payroll contributions (Phase 5). */
function migrateHrPhase5PayrollSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_salary_matrix (
      id TEXT PRIMARY KEY,
      payroll_group TEXT NOT NULL,
      salary_level INTEGER NOT NULL,
      salary_step INTEGER NOT NULL,
      base_salary_ngn INTEGER NOT NULL DEFAULT 0,
      housing_allowance_ngn INTEGER NOT NULL DEFAULT 0,
      transport_allowance_ngn INTEGER NOT NULL DEFAULT 0,
      effective_from_iso TEXT,
      notes TEXT,
      updated_at_iso TEXT,
      updated_by_user_id TEXT,
      UNIQUE(payroll_group, salary_level, salary_step)
    );

    CREATE TABLE IF NOT EXISTS hr_salary_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      effective_from_iso TEXT NOT NULL,
      salary_level INTEGER,
      salary_step INTEGER,
      base_salary_ngn INTEGER,
      housing_allowance_ngn INTEGER,
      transport_allowance_ngn INTEGER,
      reason TEXT,
      actor_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_salary_history_user ON hr_salary_history(user_id, effective_from_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_branch_payroll_contributions (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      expected_ngn INTEGER NOT NULL DEFAULT 0,
      contributed_ngn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      marked_at_iso TEXT,
      marked_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT,
      UNIQUE(branch_id, period_yyyymm)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_branch_contrib_period ON hr_branch_payroll_contributions(period_yyyymm);
  `);
}

/** HR staff files, requests, payroll, attendance (idempotent). */
function migrateHrModule(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_staff_profiles (
      user_id TEXT PRIMARY KEY,
      branch_id TEXT,
      employee_no TEXT,
      job_title TEXT,
      department TEXT,
      employment_type TEXT,
      date_joined_iso TEXT,
      probation_end_iso TEXT,
      bank_account_name TEXT,
      bank_name TEXT,
      bank_account_no_masked TEXT,
      tax_id TEXT,
      pension_rsa_pin TEXT,
      next_of_kin_json TEXT,
      base_salary_ngn INTEGER NOT NULL DEFAULT 0,
      housing_allowance_ngn INTEGER NOT NULL DEFAULT 0,
      transport_allowance_ngn INTEGER NOT NULL DEFAULT 0,
      bonus_accrual_note TEXT,
      minimum_qualification TEXT,
      academic_qualification TEXT,
      promotion_grade TEXT,
      welfare_notes TEXT,
      training_summary TEXT,
      profile_extra_json TEXT,
      paye_tax_percent REAL,
      pension_percent_override REAL,
      updated_at_iso TEXT,
      updated_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      payload_json TEXT,
      created_at_iso TEXT NOT NULL,
      submitted_at_iso TEXT,
      hr_reviewer_user_id TEXT,
      hr_reviewer_note TEXT,
      hr_reviewed_at_iso TEXT,
      manager_reviewer_user_id TEXT,
      manager_note TEXT,
      manager_reviewed_at_iso TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_hr_requests_branch ON hr_requests(branch_id);
    CREATE INDEX IF NOT EXISTS idx_hr_requests_user ON hr_requests(user_id);

    CREATE TABLE IF NOT EXISTS hr_payroll_runs (
      id TEXT PRIMARY KEY,
      period_yyyymm TEXT NOT NULL,
      status TEXT NOT NULL,
      tax_percent REAL NOT NULL,
      pension_percent REAL NOT NULL,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS hr_payroll_lines (
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      gross_ngn INTEGER NOT NULL,
      bonus_ngn INTEGER NOT NULL,
      attendance_deduction_ngn INTEGER NOT NULL,
      other_deduction_ngn INTEGER NOT NULL,
      tax_ngn INTEGER NOT NULL,
      pension_ngn INTEGER NOT NULL,
      net_ngn INTEGER NOT NULL,
      PRIMARY KEY (run_id, user_id),
      FOREIGN KEY (run_id) REFERENCES hr_payroll_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );

    CREATE TABLE IF NOT EXISTS hr_payroll_line_loans (
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      hr_request_id TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      loan_title TEXT,
      computed_at_iso TEXT,
      PRIMARY KEY (run_id, hr_request_id),
      FOREIGN KEY (run_id) REFERENCES hr_payroll_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_attendance_uploads (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      uploaded_by_user_id TEXT,
      notes TEXT,
      rows_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hr_daily_roll_calls (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      day_iso TEXT NOT NULL,
      recorded_by_user_id TEXT,
      notes TEXT,
      rows_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      UNIQUE(branch_id, day_iso)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_daily_roll_branch_day ON hr_daily_roll_calls(branch_id, day_iso);

    CREATE TABLE IF NOT EXISTS hr_employment_letters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      letter_kind TEXT NOT NULL,
      content_text TEXT NOT NULL,
      issued_at_iso TEXT NOT NULL,
      issued_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id)
    );

    CREATE TABLE IF NOT EXISTS hr_policy_acknowledgements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      policy_key TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      accepted_at_iso TEXT NOT NULL,
      signature_name TEXT,
      accepted_by_user_id TEXT,
      context_json TEXT,
      record_hash TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id),
      FOREIGN KEY (accepted_by_user_id) REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_policy_ack_user ON hr_policy_acknowledgements(user_id, accepted_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_hr_policy_ack_policy ON hr_policy_acknowledgements(policy_key, policy_version);

    CREATE TABLE IF NOT EXISTS hr_audit_events (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      actor_user_id TEXT,
      actor_display_name TEXT,
      action TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_id TEXT,
      branch_id TEXT,
      reason TEXT,
      details_json TEXT,
      correlation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_audit_events_time ON hr_audit_events(occurred_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_leave_balances (
      user_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      opening_days REAL NOT NULL DEFAULT 0,
      accrued_days REAL NOT NULL DEFAULT 0,
      used_days REAL NOT NULL DEFAULT 0,
      adjusted_days REAL NOT NULL DEFAULT 0,
      closing_days REAL NOT NULL DEFAULT 0,
      updated_at_iso TEXT NOT NULL,
      PRIMARY KEY (user_id, leave_type, period_yyyymm),
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_leave_accrual_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      movement_kind TEXT NOT NULL,
      days REAL NOT NULL,
      reference_id TEXT,
      note TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_attendance_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      event_date_iso TEXT NOT NULL,
      status TEXT NOT NULL,
      minutes_late INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL DEFAULT 'upload',
      source_id TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_request_leave (
      request_id TEXT PRIMARY KEY,
      leave_type TEXT,
      start_date_iso TEXT,
      end_date_iso TEXT,
      days_requested REAL,
      handover_to TEXT,
      contact_during_leave TEXT,
      FOREIGN KEY (request_id) REFERENCES hr_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_request_loan (
      request_id TEXT PRIMARY KEY,
      amount_ngn INTEGER,
      repayment_months INTEGER,
      deduction_per_month_ngn INTEGER,
      purpose TEXT,
      FOREIGN KEY (request_id) REFERENCES hr_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hr_request_discipline (
      request_id TEXT PRIMARY KEY,
      case_type TEXT,
      severity TEXT,
      incident_date_iso TEXT,
      summary TEXT,
      FOREIGN KEY (request_id) REFERENCES hr_requests(id) ON DELETE CASCADE
    );
  `);
}

/** Role consolidation, workspace branch on app_users (no HR profile required). */
function migrateOrganisationRoles2026(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const users = tableCols('app_users');
  if (users.size && !users.has('workspace_branch_id')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN workspace_branch_id TEXT`);
  }
  try {
    if (
      users.has('workspace_branch_id') &&
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_profiles'`).get()
    ) {
      db.prepare(
        `UPDATE app_users SET workspace_branch_id = (
           SELECT p.branch_id FROM hr_staff_profiles p WHERE p.user_id = app_users.id LIMIT 1
         )
         WHERE (workspace_branch_id IS NULL OR trim(workspace_branch_id) = '')
           AND EXISTS (
             SELECT 1 FROM hr_staff_profiles p
             WHERE p.user_id = app_users.id AND p.branch_id IS NOT NULL AND trim(p.branch_id) != ''
           )`
      ).run();
    }
  } catch {
    /* ignore */
  }

  try {
    db.prepare(
      `UPDATE app_users SET role_key = 'sales_staff', permissions_json = NULL WHERE role_key IN ('hr_officer')`
    ).run();
    db.prepare(`UPDATE app_users SET role_key = 'sales_manager', permissions_json = NULL WHERE role_key = 'hr_manager'`).run();
    db.prepare(
      `UPDATE app_users SET role_key = 'operations_officer', permissions_json = NULL WHERE role_key = 'procurement_officer'`
    ).run();
    db.prepare(
      `UPDATE app_users SET role_key = 'operations_officer', permissions_json = NULL, department = 'operations_officer'
       WHERE role_key IN ('storekeeper', 'store_keeper')
          OR lower(replace(trim(COALESCE(department, '')), ' ', '_')) IN ('storekeeper', 'store_keeper')`
    ).run();
    db.prepare(
      `UPDATE app_users SET role_key = 'operations_officer', permissions_json = NULL, department = 'operations_officer'
       WHERE lower(replace(trim(COALESCE(department, '')), ' ', '_')) IN ('inventory', 'production')
         AND role_key NOT IN ('admin', 'md', 'operations_officer', 'sales_manager')`
    ).run();
  } catch {
    /* ignore */
  }

  if (users.has('department')) {
    try {
      db.prepare(`UPDATE app_users SET department = lower(trim(role_key)) WHERE role_key IS NOT NULL`).run();
    } catch {
      /* ignore */
    }
  }
}

/** User profile fields + password reset token table. */
function migrateUserProfileAndPasswordReset(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  const users = tableCols('app_users');
  if (users.size && !users.has('email')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN email TEXT`);
  }
  if (users.size && !users.has('avatar_url')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN avatar_url TEXT`);
  }
  if (users.size && !users.has('must_change_password')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
    const allowSeeded =
      process.env.ZAREWA_ALLOW_SEEDED_USERS === 'true' ||
      process.env.ZAREWA_ALLOW_SEEDED_USERS === '1' ||
      process.env.NODE_ENV === 'test';
    if (!allowSeeded) {
      const defaultUsernames = [
        'admin',
        'md',
        'finance.manager',
        'cashier',
        'sales.manager',
        'sales.staff',
        'operations',
        'ceo',
        'viewer',
      ];
      const placeholders = defaultUsernames.map(() => '?').join(',');
      db.prepare(
        `UPDATE app_users SET must_change_password = 1
         WHERE lower(trim(username)) IN (${placeholders})
           AND status = 'active'`
      ).run(...defaultUsernames);
    }
  }
  if (users.size && !users.has('registered_password')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN registered_password TEXT`);
    const defaultPasswordByUsername = [
      ['admin', 'Admin@123'],
      ['md', 'Md@1234567890!'],
      ['finance.manager', 'Finance@123'],
      ['cashier', 'Cashier@12345!'],
      ['sales.manager', 'Sales@123'],
      ['sales.staff', 'Sales@123'],
      ['operations', 'Ops@123'],
      ['ceo', 'Ceo@1234567890!'],
      ['viewer', 'Viewer@123456!'],
    ];
    const backfill = db.prepare(
      `UPDATE app_users
       SET registered_password = ?
       WHERE lower(trim(username)) = ?
         AND (registered_password IS NULL OR trim(registered_password) = '')`
    );
    for (const [username, password] of defaultPasswordByUsername) {
      backfill.run(password, username);
    }
  }
  if (users.size && users.has('registered_password')) {
    const defaultPasswordByUsername = [
      ['admin', 'Admin@123'],
      ['md', 'Md@1234567890!'],
      ['finance.manager', 'Finance@123'],
      ['cashier', 'Cashier@12345!'],
      ['sales.manager', 'Sales@123'],
      ['sales.staff', 'Sales@123'],
      ['operations', 'Ops@123'],
      ['ceo', 'Ceo@1234567890!'],
      ['viewer', 'Viewer@123456!'],
    ];
    const backfill = db.prepare(
      `UPDATE app_users
       SET registered_password = ?
       WHERE lower(trim(username)) = ?
         AND (registered_password IS NULL OR trim(registered_password) = '')`
    );
    for (const [username, password] of defaultPasswordByUsername) {
      backfill.run(password, username);
    }
  }
  if (users.size && !users.has('training_completed_at_iso')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN training_completed_at_iso TEXT NOT NULL DEFAULT ''`);
    db.prepare(
      `UPDATE app_users
       SET training_completed_at_iso = COALESCE(NULLIF(trim(last_login_at_iso), ''), created_at_iso, ?)
       WHERE training_completed_at_iso IS NULL OR trim(training_completed_at_iso) = ''`
    ).run(new Date().toISOString());
  }

  if (users.size && !users.has('department')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN department TEXT NOT NULL DEFAULT 'general'`);
    db.prepare(
      `UPDATE app_users SET department = CASE role_key
        WHEN 'admin' THEN 'admin'
        WHEN 'md' THEN 'md'
        WHEN 'finance_manager' THEN 'finance_manager'
        WHEN 'sales_manager' THEN 'sales_manager'
        WHEN 'sales_staff' THEN 'sales_staff'
        WHEN 'cashier' THEN 'cashier'
        WHEN 'operations_officer' THEN 'operations_officer'
        ELSE 'sales_staff' END`
    ).run();
  }

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_unique
      ON app_users(email) WHERE email IS NOT NULL AND trim(email) != '';
    `);
  } catch {
    /* ignore if SQLite version disallows — rare */
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      used_at_iso TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_pwreset_expires ON password_reset_tokens(expires_at_iso);
    CREATE INDEX IF NOT EXISTS idx_pwreset_token_hash ON password_reset_tokens(token_hash);
  `);
}

/** One-time repair: onboarding-complete users should not be forced to change password again. */
function migrateRepairMustChangePasswordLoop2026(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('must_change_password') || !names.has('training_completed_at_iso')) return;
    db.prepare(
      `UPDATE app_users
       SET must_change_password = 0
       WHERE must_change_password = 1
         AND trim(COALESCE(training_completed_at_iso, '')) != ''`
    ).run();
  } catch {
    /* ignore */
  }
}

/** Phase 12 — account lockout columns, remove plaintext password display data. */
function migrateLoginSecurityPhase12(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const users = tableCols('app_users');
  if (!users.size) return;

  if (!users.has('failed_login_count')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!users.has('locked_until_iso')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN locked_until_iso TEXT`);
  }
  if (!users.has('username_change_count')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN username_change_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (users.has('registered_password')) {
    db.prepare(`UPDATE app_users SET registered_password = NULL WHERE registered_password IS NOT NULL`).run();
  }
}

/** Cutting-list production hold, price-list book versioning. */
function migrateWorkflowExtensions(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  const cl = tableCols('cutting_lists');
  if (cl.size && !cl.has('production_release_pending')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN production_release_pending INTEGER NOT NULL DEFAULT 0`);
  }
  if (cl.size && !cl.has('production_released_at_iso')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN production_released_at_iso TEXT`);
  }
  if (cl.size && !cl.has('production_released_by')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN production_released_by TEXT`);
  }
  if (cl.size && !cl.has('print_count')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN print_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (cl.size && !cl.has('last_printed_at_iso')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN last_printed_at_iso TEXT`);
  }
  if (cl.size && !cl.has('last_printed_by')) {
    db.exec(`ALTER TABLE cutting_lists ADD COLUMN last_printed_by TEXT`);
  }

  const pl = tableCols('setup_price_lists');
  if (pl.size && !pl.has('book_label')) {
    db.exec(`ALTER TABLE setup_price_lists ADD COLUMN book_label TEXT NOT NULL DEFAULT 'Standard'`);
  }
  if (pl.size && !pl.has('book_version')) {
    db.exec(`ALTER TABLE setup_price_lists ADD COLUMN book_version INTEGER NOT NULL DEFAULT 1`);
  }
  if (pl.size && !pl.has('effective_from_iso')) {
    db.exec(`ALTER TABLE setup_price_lists ADD COLUMN effective_from_iso TEXT NOT NULL DEFAULT '2020-01-01'`);
    db.prepare(`UPDATE setup_price_lists SET effective_from_iso = '2020-01-01' WHERE effective_from_iso IS NULL OR effective_from_iso = ''`).run();
  }
}

/** Audited coil control register (scrap, adjustments, offcut pool, supplier defects). */
function migrateCoilControlEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coil_control_events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      coil_no TEXT,
      product_id TEXT,
      gauge_label TEXT,
      colour TEXT,
      meters REAL,
      kg_coil_delta REAL NOT NULL DEFAULT 0,
      kg_book REAL,
      book_ref TEXT,
      cutting_list_ref TEXT,
      quotation_ref TEXT,
      customer_label TEXT,
      supplier_id TEXT,
      defect_m_from REAL,
      defect_m_to REAL,
      supplier_resolution TEXT,
      outbound_destination TEXT,
      credit_scrap_inventory INTEGER NOT NULL DEFAULT 0,
      scrap_product_id TEXT,
      scrap_reason TEXT,
      note TEXT,
      date_iso TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      actor_user_id TEXT,
      actor_display TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coil_control_events_branch_time
      ON coil_control_events(branch_id, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_coil_control_events_kind
      ON coil_control_events(branch_id, event_kind);
  `);
}

/** Material exception & offcut control (incidents, pool balances, approvals). */
function migrateMaterialIncidents(db) {
  repairMaterialIncidentIndexesMysql(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_incidents (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      material_family TEXT NOT NULL DEFAULT 'aluminium',
      product_id TEXT,
      gauge_label TEXT,
      colour TEXT,
      profile_label TEXT,
      coil_no TEXT,
      quotation_ref TEXT,
      cutting_list_ref TEXT,
      production_job_id TEXT,
      delivery_id TEXT,
      customer_id TEXT,
      customer_label TEXT,
      supplier_id TEXT,
      before_kg REAL,
      after_kg REAL,
      kg_deducted REAL,
      total_meters REAL NOT NULL DEFAULT 0,
      conversion_kg_per_m REAL,
      conversion_source TEXT,
      return_disposition TEXT,
      storekeeper_user_id TEXT,
      storekeeper_display TEXT,
      operator_display TEXT,
      created_by_user_id TEXT,
      approved_by_user_id TEXT,
      approved_at_iso TEXT,
      posted_at_iso TEXT,
      storekeeper_remark TEXT,
      manager_remark TEXT,
      reason_code TEXT,
      reason_text TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      book_ref TEXT,
      meters_available REAL NOT NULL DEFAULT 0,
      customer_refund_id TEXT,
      date_iso TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      void_reason TEXT,
      voided_by_user_id TEXT,
      voided_at_iso TEXT,
      edit_unlocked_by_user_id TEXT,
      edit_unlocked_at_iso TEXT
    );

    CREATE TABLE IF NOT EXISTS material_incident_lines (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      length_m REAL NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      total_m REAL NOT NULL,
      condition_note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (incident_id) REFERENCES material_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_material_incident_lines_incident
      ON material_incident_lines(incident_id, sort_order);

    CREATE TABLE IF NOT EXISTS material_incident_attachments (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data_b64 TEXT NOT NULL,
      uploaded_at_iso TEXT NOT NULL,
      uploaded_by_user_id TEXT,
      FOREIGN KEY (incident_id) REFERENCES material_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_material_incident_attachments_incident
      ON material_incident_attachments(incident_id);

    CREATE TABLE IF NOT EXISTS material_incident_stock_links (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      coil_control_event_id TEXT,
      stock_movement_id TEXT,
      link_role TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (incident_id) REFERENCES material_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_material_incident_stock_links_incident
      ON material_incident_stock_links(incident_id);

    CREATE TABLE IF NOT EXISTS material_incident_issues (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      meters REAL NOT NULL,
      issued_at_iso TEXT NOT NULL,
      issued_by_user_id TEXT,
      target_kind TEXT NOT NULL,
      target_ref TEXT,
      manager_price_ngn_per_m REAL,
      manager_price_ngn_total REAL,
      priced_by_user_id TEXT,
      priced_at_iso TEXT,
      coil_control_event_id TEXT,
      note TEXT,
      FOREIGN KEY (incident_id) REFERENCES material_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_material_incident_issues_incident
      ON material_incident_issues(incident_id);

    CREATE TABLE IF NOT EXISTS material_incident_audit (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor_user_id TEXT,
      actor_display TEXT,
      at_iso TEXT NOT NULL,
      reason TEXT,
      FOREIGN KEY (incident_id) REFERENCES material_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_material_incident_audit_incident
      ON material_incident_audit(incident_id, at_iso DESC);
  `);

  repairMaterialIncidentIndexesMysql(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_material_incidents_branch_status
      ON material_incidents(branch_id, status, date_iso);
    CREATE INDEX IF NOT EXISTS idx_material_incidents_pool
      ON material_incidents(branch_id, material_family, gauge_label, colour);
    CREATE INDEX IF NOT EXISTS idx_material_incidents_quotation
      ON material_incidents(quotation_ref);
    CREATE INDEX IF NOT EXISTS idx_material_incidents_job
      ON material_incidents(production_job_id);
  `);

  const cce = db.prepare(`PRAGMA table_info(coil_control_events)`).all();
  const cceCols = new Set(cce.map((c) => c.name));
  if (cceCols.size && !cceCols.has('material_incident_id')) {
    db.exec(`ALTER TABLE coil_control_events ADD COLUMN material_incident_id TEXT`);
  }
  if (cceCols.size && !cceCols.has('material_incident_issue_id')) {
    db.exec(`ALTER TABLE coil_control_events ADD COLUMN material_incident_issue_id TEXT`);
  }

  const pj = db.prepare(`PRAGMA table_info(production_jobs)`).all();
  const pjCols = new Set(pj.map((c) => c.name));
  if (pjCols.size && !pjCols.has('offcut_supply_json')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN offcut_supply_json TEXT`);
  }
}

/** Coil split lineage + scrap SKU for off-cuts / scrap posting. */
function migrateCoilMaterialOps(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };
  const cl = tableCols('coil_lots');
  if (cl.size && !cl.has('parent_coil_no')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN parent_coil_no TEXT`);
  }
  if (cl.size && !cl.has('material_origin_note')) {
    db.exec(`ALTER TABLE coil_lots ADD COLUMN material_origin_note TEXT`);
  }
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) return;
  if (!db.prepare(`SELECT 1 FROM products WHERE product_id = 'SCRAP-COIL'`).get()) {
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'SCRAP-COIL',
      'Coil scrap / off-cuts (kg)',
      0,
      'kg',
      0,
      0,
      'Mixed',
      'Mixed',
      'Scrap',
      '{}',
      'BR-KD'
    );
  }
}

/** Rename legacy branch rows: BR-KAD→BR-KD (code KD), BR-YOL→BR-YL (YL), BR-MAI→BR-MDG (MDG). */
function migrateCanonicalBranchIds(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='branches'`).get()) return;
  const hasLegacy = db
    .prepare(`SELECT 1 FROM branches WHERE id IN ('BR-KAD','BR-YOL','BR-MAI') LIMIT 1`)
    .get();
  if (!hasLegacy) return;

  const pairs = [
    { old: 'BR-KAD', next: 'BR-KD', code: 'KD' },
    { old: 'BR-YOL', next: 'BR-YL', code: 'YL' },
    { old: 'BR-MAI', next: 'BR-MDG', code: 'MDG' },
  ];

  const tablesWithBranchId = [
    'quotations',
    'sales_receipts',
    'ledger_entries',
    'cutting_lists',
    'purchase_orders',
    'coil_lots',
    'deliveries',
    'production_jobs',
    'customer_refunds',
    'expenses',
    'customers',
    'customer_crm_interactions',
    'customer_complaints',
    'suppliers',
    'transport_agents',
    'products',
    'bank_reconciliation_lines',
    'bank_deposits',
    'stock_movements',
    'hr_staff_profiles',
    'hr_requests',
    'hr_daily_roll_calls',
    'hr_attendance_events',
    'hr_attendance_uploads',
    'fixed_assets',
    'gl_journal_entries',
    'price_list_items',
  ];

  db.pragma('foreign_keys = OFF');
  try {
    for (const { old, next } of pairs) {
      for (const t of tablesWithBranchId) {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)) continue;
        const cols = db.prepare(`PRAGMA table_info(${t})`).all();
        if (!cols.some((c) => c.name === 'branch_id')) continue;
        db.prepare(`UPDATE ${t} SET branch_id = ? WHERE branch_id = ?`).run(next, old);
      }
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_sessions'`).get()) {
        const sc = db.prepare(`PRAGMA table_info(user_sessions)`).all();
        if (sc.some((c) => c.name === 'current_branch_id')) {
          db.prepare(`UPDATE user_sessions SET current_branch_id = ? WHERE current_branch_id = ?`).run(
            next,
            old
          );
        }
      }
    }
    for (const { old, next, code } of pairs) {
      db.prepare(`UPDATE branches SET id = ?, code = ? WHERE id = ?`).run(next, code, old);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * One-time marker: legacy BR-YL → BR-KD name-based repair used to run on every boot
 * and reverted admin branch reassignments. Repair is retired; branch assignment is via Finance UI.
 */
function migrateTreasuryBranchLegacyRepairOnce(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_patches (
      patch_id TEXT PRIMARY KEY,
      applied_at_iso TEXT NOT NULL
    );
  `);
  const patchId = 'treasury_branch_legacy_repair_2026';
  if (db.prepare(`SELECT 1 FROM schema_patches WHERE patch_id = ?`).get(patchId)) return;
  db.prepare(`INSERT INTO schema_patches (patch_id, applied_at_iso) VALUES (?, ?)`).run(
    patchId,
    new Date().toISOString()
  );
}

/** Branches + branch_id on operational tables + session workspace columns. */
function migrateBranches(db) {
  const tableCols = (name) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${name})`).all();
      return new Set(rows.map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  const bc = db.prepare(`SELECT COUNT(*) AS c FROM branches`).get().c;
  if (bc === 0) {
    db.exec(`
      INSERT INTO branches (id, code, name, active, sort_order) VALUES
      ('BR-KD', 'KD', 'Kaduna (HQ)', 1, 1),
      ('BR-YL', 'YL', 'Yola Factory', 1, 2),
      ('BR-MDG', 'MDG', 'Maiduguri Factory', 1, 3);
    `);
  }
  const branchesCols = tableCols('branches');
  if (branchesCols.size && !branchesCols.has('cutting_list_min_paid_fraction')) {
    db.exec(`ALTER TABLE branches ADD COLUMN cutting_list_min_paid_fraction REAL NOT NULL DEFAULT 0.7`);
  }
  if (branchesCols.size && !branchesCols.has('opening_cutover_date_iso')) {
    db.exec(
      `ALTER TABLE branches ADD COLUMN opening_cutover_date_iso TEXT NOT NULL DEFAULT '2026-06-01'`
    );
  }

  const sessions = tableCols('user_sessions');
  if (!sessions.has('current_branch_id')) {
    db.exec(`ALTER TABLE user_sessions ADD COLUMN current_branch_id TEXT`);
  }
  if (!sessions.has('view_all_branches')) {
    db.exec(`ALTER TABLE user_sessions ADD COLUMN view_all_branches INTEGER NOT NULL DEFAULT 0`);
  }

  const defaultBranch = 'BR-KD';
  const addBranch = (table) => {
    const cols = tableCols(table);
    if (!cols.size) return;
    if (!cols.has('branch_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN branch_id TEXT`);
    }
    db.prepare(
      `UPDATE ${table} SET branch_id = ? WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = ''`
    ).run(defaultBranch);
  };

  addBranch('quotations');
  addBranch('sales_receipts');
  addBranch('ledger_entries');
  addBranch('cutting_lists');
  addBranch('purchase_orders');
  addBranch('coil_lots');
  addBranch('deliveries');
  addBranch('production_jobs');
  addBranch('customer_refunds');
  addBranch('expenses');
  addBranch('customers');
  addBranch('customer_crm_interactions');
  addBranch('customer_complaints');
  addBranch('suppliers');
  const supplierCols = tableCols('suppliers');
  if (supplierCols.size && !supplierCols.has('supplier_profile_json')) {
    db.exec(`ALTER TABLE suppliers ADD COLUMN supplier_profile_json TEXT`);
  }
  addBranch('transport_agents');
  const transportAgentCols = tableCols('transport_agents');
  if (transportAgentCols.size && !transportAgentCols.has('profile_json')) {
    db.exec(`ALTER TABLE transport_agents ADD COLUMN profile_json TEXT`);
  }
  addBranch('products');
  addBranch('bank_reconciliation_lines');
  addBranch('bank_deposits');
  if (tableCols('treasury_accounts').has('branch_id')) {
    db.prepare(
      `UPDATE treasury_accounts SET branch_id = 'BR-KD' WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = ''`
    ).run();
    migrateTreasuryBranchLegacyRepairOnce(db);
  }
  if (tableCols('suppliers').has('branch_id')) {
    db.prepare(`UPDATE suppliers SET branch_id = '' WHERE TRIM(COALESCE(branch_id, '')) != ''`).run();
  }
  if (tableCols('transport_agents').has('branch_id')) {
    db.prepare(`UPDATE transport_agents SET branch_id = '' WHERE TRIM(COALESCE(branch_id, '')) != ''`).run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      branch_id TEXT NOT NULL,
      acquisition_date_iso TEXT NOT NULL,
      cost_ngn INTEGER NOT NULL DEFAULT 0,
      salvage_ngn INTEGER NOT NULL DEFAULT 0,
      useful_life_months INTEGER NOT NULL DEFAULT 60,
      depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
      status TEXT NOT NULL DEFAULT 'active',
      disposal_date_iso TEXT,
      treasury_reference TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      updated_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fixed_assets_branch ON fixed_assets(branch_id);
    CREATE TABLE IF NOT EXISTS http_idempotency (
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      body_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      PRIMARY KEY (user_id, scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_http_idempotency_created ON http_idempotency(created_at_iso);
    CREATE TABLE IF NOT EXISTS product_standard_costs (
      product_id TEXT PRIMARY KEY,
      standard_material_cost_ngn_per_kg INTEGER,
      standard_overhead_ngn_per_m INTEGER,
      effective_from_iso TEXT NOT NULL,
      notes TEXT,
      updated_at_iso TEXT NOT NULL,
      updated_by_user_id TEXT
    );
  `);
}

/**
 * Scope WIP by branch (matches products.branch_id; empty string = shared catalogue SKUs).
 * Idempotent: skips when composite primary key (branch_id, product_id) already exists.
 */
function migrateWipBalancesBranchComposite(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='wip_balances'`).get()) return;
  const cols = db.prepare(`PRAGMA table_info(wip_balances)`).all();
  const colSet = new Set(cols.map((c) => c.name));
  const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
  const hasCompositePk =
    colSet.has('branch_id') && pkCols.includes('branch_id') && pkCols.includes('product_id');
  if (hasCompositePk) return;

  db.transaction(() => {
    if (!colSet.has('branch_id')) {
      db.exec(`ALTER TABLE wip_balances ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''`);
    }
    const allWip = db.prepare(`SELECT product_id FROM wip_balances`).all();
    for (const w of allWip) {
      const p = db.prepare(`SELECT branch_id FROM products WHERE product_id = ?`).get(w.product_id);
      const bid = p ? String(p.branch_id ?? '').trim() : '';
      db.prepare(`UPDATE wip_balances SET branch_id = ? WHERE product_id = ?`).run(bid, w.product_id);
    }

    db.exec(`DROP TABLE IF EXISTS wip_balances__new`);
    db.exec(`CREATE TABLE wip_balances__new (
      branch_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (branch_id, product_id)
    )`);
    db.exec(`
      REPLACE INTO wip_balances__new (branch_id, product_id, qty)
      SELECT TRIM(COALESCE(branch_id,'')), product_id, qty FROM wip_balances
    `);
    db.exec(`DROP TABLE wip_balances`);
    db.exec(`RENAME TABLE wip_balances__new TO wip_balances`);
  })();
}

/** Align setup material type names with product.material_type (Aluminium / Aluzinc). */
function migrateMaterialTypeLabels(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_material_types'`).get()) {
    return;
  }
  db.prepare(
    `UPDATE setup_material_types SET name = 'Aluminium' WHERE material_type_id = 'MAT-001' AND name != 'Aluminium'`
  ).run();
  db.prepare(
    `UPDATE setup_material_types SET name = 'Aluzinc' WHERE material_type_id = 'MAT-002' AND name != 'Aluzinc'`
  ).run();
}

/** Replace removed SKU PRD-101 with COIL-ALU (aluminium kg stock). */
function migratePrd101ToCoilAlu(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) return;
  const hasOld = db.prepare(`SELECT 1 FROM products WHERE product_id = 'PRD-101'`).get();
  if (!hasOld) return;

  const hasNew = db.prepare(`SELECT 1 FROM products WHERE product_id = 'COIL-ALU'`).get();

  const dashJson = JSON.stringify({
    gauge: 'Per PO / coil',
    colour: 'Per PO / coil (HMB, GB, TB, …)',
    materialType: 'Aluminium',
  });

  db.transaction(() => {
    const oldRow = db.prepare(`SELECT * FROM products WHERE product_id = 'PRD-101'`).get();
    if (!hasNew) {
      db.prepare(
        `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        'COIL-ALU',
        'Aluminium coil (kg)',
        oldRow.stock_level,
        oldRow.unit,
        oldRow.low_stock_threshold,
        oldRow.reorder_qty,
        'Per PO / coil',
        'Per PO / coil (HMB, GB, TB, …)',
        'Aluminium',
        dashJson,
        ''
      );
    } else {
      const cur = db.prepare(`SELECT stock_level FROM products WHERE product_id = 'COIL-ALU'`).get();
      const merged = Number(cur?.stock_level || 0) + Number(oldRow.stock_level || 0);
      db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = 'COIL-ALU'`).run(merged);
    }

    db.prepare(
      `UPDATE purchase_order_lines SET product_id = 'COIL-ALU', product_name = 'Aluminium coil (kg)' WHERE product_id = 'PRD-101'`
    ).run();
    db.prepare(`UPDATE coil_lots SET product_id = 'COIL-ALU' WHERE product_id = 'PRD-101'`).run();
    db.prepare(`UPDATE stock_movements SET product_id = 'COIL-ALU' WHERE product_id = 'PRD-101'`).run();
    db.prepare(`UPDATE production_jobs SET product_id = 'COIL-ALU' WHERE product_id = 'PRD-101'`).run();
    db.prepare(`UPDATE production_job_coils SET product_id = 'COIL-ALU' WHERE product_id = 'PRD-101'`).run();
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='procurement_catalog'`).get()) {
      db.prepare(`UPDATE procurement_catalog SET product_id = 'COIL-ALU' WHERE product_id = 'PRD-101'`).run();
    }

    const prdWipRows = db.prepare(`SELECT branch_id, qty FROM wip_balances WHERE product_id = 'PRD-101'`).all();
    for (const pr of prdWipRows) {
      const br = String(pr.branch_id ?? '').trim();
      const coilRow = db
        .prepare(`SELECT qty FROM wip_balances WHERE product_id = 'COIL-ALU' AND branch_id = ?`)
        .get(br);
      const mergedWip = (Number(coilRow?.qty) || 0) + (Number(pr.qty) || 0);
      db.prepare(`DELETE FROM wip_balances WHERE product_id = 'PRD-101' AND branch_id = ?`).run(br);
      db.prepare(`DELETE FROM wip_balances WHERE product_id = 'COIL-ALU' AND branch_id = ?`).run(br);
      db.prepare(`INSERT INTO wip_balances (branch_id, product_id, qty) VALUES (?, 'COIL-ALU', ?)`).run(
        br,
        mergedWip
      );
    }

    db.prepare(`DELETE FROM products WHERE product_id = 'PRD-101'`).run();
  })();
}

/** Aluzinc (PPGI) labels and Stonecoated kg coil SKU for procurement conversion. */
function migrateProcurementCoilMaterials(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) return;

  const row102 = db.prepare(`SELECT dashboard_attrs_json FROM products WHERE product_id = 'PRD-102'`).get();
  if (row102) {
    let attrs = {};
    try {
      attrs = JSON.parse(row102.dashboard_attrs_json || '{}');
    } catch {
      attrs = {};
    }
    const dashJson = JSON.stringify({
      gauge: attrs.gauge ?? 'Per PO / coil',
      colour: attrs.colour ?? 'Per PO / coil',
      materialType: 'Aluzinc (PPGI)',
    });
    db.prepare(
      `UPDATE products SET name = ?, material_type = ?, dashboard_attrs_json = ? WHERE product_id = 'PRD-102'`
    ).run('Aluzinc (PPGI) coil (kg)', 'Aluzinc (PPGI)', dashJson);
  }

  /* Stone-coated stock is metre-based (STONE-* SKUs); legacy COIL-SC kg SKU is no longer seeded. */
}

/**
 * Coil kg SKUs use a single products row for all branches (branch_id '').
 * Otherwise only the branch stamped on that row (e.g. BR-KD) can import coils.
 */
function migrateCoilSkuProductsBranchGlobal(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) return;
  const cols = db.prepare(`PRAGMA table_info(products)`).all();
  if (!cols.some((c) => c.name === 'branch_id')) return;
  db.prepare(`UPDATE products SET branch_id = '' WHERE product_id IN ('COIL-ALU','PRD-102')`).run();
}

/** Material pricing workbook (coil): conversions, suggested ₦/m, minimum floor, change log. */
function migrateMaterialPricingWorkbook(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_pricing_sheet_rows (
      id TEXT PRIMARY KEY,
      material_key TEXT NOT NULL,
      gauge_mm TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      design_key TEXT NOT NULL DEFAULT '',
      conversion_standard_kg_per_m REAL,
      conversion_reference_kg_per_m REAL,
      conversion_history_kg_per_m REAL,
      conversion_used_kg_per_m REAL,
      cost_per_kg_ngn REAL NOT NULL DEFAULT 0,
      overhead_ngn_per_m REAL NOT NULL DEFAULT 0,
      profit_ngn_per_m REAL NOT NULL DEFAULT 0,
      minimum_price_per_m_ngn INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at_iso TEXT NOT NULL,
      updated_by_user_id TEXT,
      UNIQUE(material_key, gauge_mm, branch_id, design_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mps_mat_branch ON material_pricing_sheet_rows(material_key, branch_id);
    CREATE INDEX IF NOT EXISTS idx_mps_mat_branch_gauge_design
      ON material_pricing_sheet_rows(material_key, branch_id, gauge_mm, design_key);
    CREATE TABLE IF NOT EXISTS material_pricing_sheet_events (
      id TEXT PRIMARY KEY,
      row_id TEXT NOT NULL,
      material_key TEXT NOT NULL,
      gauge_mm TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      design_key TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      changed_at_iso TEXT NOT NULL,
      changed_by_user_id TEXT,
      action TEXT NOT NULL DEFAULT 'upsert'
    );
    CREATE INDEX IF NOT EXISTS idx_mpse_material_time ON material_pricing_sheet_events(material_key, changed_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_mpse_mat_gauge_branch_design_time
      ON material_pricing_sheet_events(material_key, gauge_mm, branch_id, design_key, changed_at_iso);
  `);
  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()) {
      const coilCols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
      if (coilCols.some((c) => c.name === 'branch_id')) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_coil_lots_product_branch ON coil_lots(product_id, branch_id)`);
      } else {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_coil_lots_product_received ON coil_lots(product_id, received_at_iso)`
        );
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const cols = db.prepare(`PRAGMA table_info(material_pricing_sheet_rows)`).all();
    if (cols.length && !cols.some((c) => c.name === 'commission_ngn_per_m')) {
      db.exec(`ALTER TABLE material_pricing_sheet_rows ADD COLUMN commission_ngn_per_m REAL NOT NULL DEFAULT 0`);
    }
    if (cols.length && !cols.some((c) => c.name === 'gauge_customer_label')) {
      db.exec(`ALTER TABLE material_pricing_sheet_rows ADD COLUMN gauge_customer_label TEXT`);
    }
    if (cols.length && !cols.some((c) => c.name === 'sync_minimum_to_price_list')) {
      db.exec(
        `ALTER TABLE material_pricing_sheet_rows ADD COLUMN sync_minimum_to_price_list INTEGER NOT NULL DEFAULT 0`
      );
    }
    if (cols.length && !cols.some((c) => c.name === 'sync_design_key')) {
      db.exec(`ALTER TABLE material_pricing_sheet_rows ADD COLUMN sync_design_key TEXT NOT NULL DEFAULT ''`);
    }
    if (
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_list_items'`).get() &&
      cols.some((c) => c.name === 'sync_minimum_to_price_list')
    ) {
      const mpsRows = db.prepare(`SELECT id FROM material_pricing_sheet_rows`).all();
      const upd = db.prepare(
        `UPDATE material_pricing_sheet_rows SET sync_minimum_to_price_list = 1, sync_design_key = ? WHERE id = ? AND COALESCE(sync_minimum_to_price_list, 0) = 0`
      );
      for (const r of mpsRows) {
        const plId = `PL-MPS-${String(r.id).replace(/^MPS-/i, '').slice(0, 16)}`;
        const pl = db.prepare(`SELECT design_key FROM price_list_items WHERE id = ?`).get(plId);
        const dk = String(pl?.design_key ?? '').trim();
        if (dk) upd.run(dk, r.id);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Trading bands, ridge add-ons, profile→design aliases; customer price book support. */
function migratePricingPolicy2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_policy (
      id TEXT PRIMARY KEY,
      default_trading_band_ngn INTEGER NOT NULL DEFAULT 50,
      updated_at_iso TEXT,
      updated_by_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS pricing_trading_band_tiers (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      gauge_min_mm REAL NOT NULL DEFAULT 0,
      gauge_max_mm REAL NOT NULL DEFAULT 999,
      band_ngn INTEGER NOT NULL DEFAULT 50
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_band_tiers_sort ON pricing_trading_band_tiers(sort_order ASC);
    CREATE TABLE IF NOT EXISTS pricing_ridge_add_ons (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      girth_mm REAL NOT NULL,
      material_family TEXT NOT NULL DEFAULT '',
      add_on_ngn INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_ridge_girth ON pricing_ridge_add_ons(girth_mm, material_family);
    CREATE TABLE IF NOT EXISTS pricing_profile_aliases (
      id TEXT PRIMARY KEY,
      alias_key TEXT NOT NULL UNIQUE,
      canonical_design_key TEXT NOT NULL DEFAULT '',
      canonical_profile_key TEXT NOT NULL DEFAULT ''
    );
  `);
  const hasPolicy = db.prepare(`SELECT 1 FROM pricing_policy WHERE id = 'default'`).get();
  if (!hasPolicy) {
    db.prepare(`INSERT INTO pricing_policy (id, default_trading_band_ngn) VALUES ('default', 50)`).run();
  }
  const tierCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM pricing_trading_band_tiers`).get()?.c) || 0;
  if (tierCount === 0) {
    db.prepare(
      `INSERT INTO pricing_trading_band_tiers (id, sort_order, gauge_min_mm, gauge_max_mm, band_ngn) VALUES ('PT-LO', 1, 0, 0.499, 50)`
    ).run();
    db.prepare(
      `INSERT INTO pricing_trading_band_tiers (id, sort_order, gauge_min_mm, gauge_max_mm, band_ngn) VALUES ('PT-HI', 2, 0.5, 999, 100)`
    ).run();
  }
  const aliasCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM pricing_profile_aliases`).get()?.c) || 0;
  if (aliasCount === 0) {
    db.prepare(
      `INSERT INTO pricing_profile_aliases (id, alias_key, canonical_design_key, canonical_profile_key) VALUES ('PA-MET', 'metcoppo', 'metcoppo & steptiles', '')`
    ).run();
    db.prepare(
      `INSERT INTO pricing_profile_aliases (id, alias_key, canonical_design_key, canonical_profile_key) VALUES ('PA-STE', 'steptiles', 'metcoppo & steptiles', '')`
    ).run();
  }
  try {
    const ridgeCols = db.prepare(`PRAGMA table_info(pricing_ridge_add_ons)`).all();
    if (ridgeCols.length && !ridgeCols.some((c) => c.name === 'list_add_on_ngn')) {
      db.exec(`ALTER TABLE pricing_ridge_add_ons ADD COLUMN list_add_on_ngn INTEGER`);
    }
  } catch {
    /* ignore */
  }
}

/** HR accountability — incident registry, responsibility, recovery, asset linkage. */
function migrateHrAccountability2026(db) {
  const cols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_registry (
      id TEXT PRIMARY KEY,
      incident_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      incident_type TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      branch_id TEXT NOT NULL,
      reporter_user_id TEXT,
      subject_user_id TEXT,
      linked_entities_json TEXT,
      summary TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      UNIQUE(incident_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_incident_registry_branch ON incident_registry(branch_id, updated_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_incident_registry_status ON incident_registry(status, branch_id);

    CREATE TABLE IF NOT EXISTS incident_responsibility_map (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'other',
      responsibility_weight REAL NOT NULL DEFAULT 0,
      contribution_type TEXT NOT NULL DEFAULT 'negligence',
      note TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_incident_resp_case ON incident_responsibility_map(case_id);
    CREATE INDEX IF NOT EXISTS idx_incident_resp_user ON incident_responsibility_map(user_id);

    CREATE TABLE IF NOT EXISTS hr_incident_recovery_schedules (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      registry_id TEXT,
      total_amount_ngn INTEGER NOT NULL DEFAULT 0,
      installment_amount_ngn INTEGER NOT NULL DEFAULT 0,
      duration_months INTEGER NOT NULL DEFAULT 12,
      principal_outstanding_ngn INTEGER NOT NULL DEFAULT 0,
      months_deducted INTEGER NOT NULL DEFAULT 0,
      deductions_active INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      activated_at_iso TEXT,
      closed_at_iso TEXT,
      cancel_reason TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      approved_by_user_id TEXT,
      FOREIGN KEY (case_id) REFERENCES hr_discipline_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_recovery_case ON hr_incident_recovery_schedules(case_id, status);
    CREATE INDEX IF NOT EXISTS idx_hr_recovery_user ON hr_incident_recovery_schedules(user_id, status);

    CREATE TABLE IF NOT EXISTS hr_incident_recovery_settlements (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      principal_before_ngn INTEGER NOT NULL,
      principal_after_ngn INTEGER NOT NULL,
      payment_reference TEXT,
      payment_date_iso TEXT,
      note TEXT,
      settlement_kind TEXT NOT NULL DEFAULT 'lump_sum',
      recorded_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES hr_incident_recovery_schedules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_recovery_settlement_sched
      ON hr_incident_recovery_settlements(schedule_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS hr_payroll_line_recoveries (
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      period_yyyymm TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL,
      case_number TEXT,
      computed_at_iso TEXT,
      PRIMARY KEY (run_id, schedule_id),
      FOREIGN KEY (run_id) REFERENCES hr_payroll_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS operational_incidents (
      id TEXT PRIMARY KEY,
      registry_id TEXT,
      branch_id TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      asset_id TEXT,
      machine_id TEXT,
      loss_value_ngn INTEGER,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      severity TEXT NOT NULL DEFAULT 'medium',
      subject_user_id TEXT,
      reported_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operational_incidents_branch ON operational_incidents(branch_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS asset_custody_events (
      id TEXT PRIMARY KEY,
      asset_id TEXT,
      machine_id TEXT,
      branch_id TEXT NOT NULL,
      location_label TEXT,
      custodian_user_id TEXT,
      event_type TEXT NOT NULL,
      shift_day_iso TEXT,
      daily_roll_id TEXT,
      note TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asset_custody_asset ON asset_custody_events(asset_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS gate_pass_events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      pass_date_iso TEXT NOT NULL,
      direction TEXT NOT NULL,
      authorized_by_user_id TEXT,
      vehicle_ref TEXT,
      personnel_summary TEXT,
      asset_ids_json TEXT,
      notes TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gate_pass_branch_date ON gate_pass_events(branch_id, pass_date_iso DESC);
  `);

  const cases = cols('hr_discipline_cases');
  if (cases.size) {
    const addCol = (name, ddl) => {
      if (!cases.has(name)) db.exec(`ALTER TABLE hr_discipline_cases ADD COLUMN ${ddl}`);
    };
    addCol('registry_id', 'registry_id TEXT');
    addCol('asset_id', 'asset_id TEXT');
    addCol('machine_id', 'machine_id TEXT');
    addCol('loss_value_ngn', 'loss_value_ngn INTEGER');
    addCol('decision_type', 'decision_type TEXT');
  }

  const memos = cols('hr_incident_memos');
  if (memos.size) {
    if (!memos.has('discipline_case_id')) {
      db.exec(`ALTER TABLE hr_incident_memos ADD COLUMN discipline_case_id TEXT`);
    }
    if (!memos.has('registry_id')) {
      db.exec(`ALTER TABLE hr_incident_memos ADD COLUMN registry_id TEXT`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_performance_recognitions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      metric_json TEXT,
      summary TEXT NOT NULL,
      bonus_eligible INTEGER NOT NULL DEFAULT 1,
      registry_id TEXT,
      created_at_iso TEXT NOT NULL,
      created_by_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hr_performance_user ON hr_performance_recognitions(user_id, created_at_iso DESC);
  `);
}

/** Staff financial obligation ledger — loans, future purchase credit / recovery unification. */
function migrateStaffObligationLedger2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_staff_obligation_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'loan',
      origin TEXT NOT NULL DEFAULT 'new',
      title TEXT NOT NULL,
      principal_original_ngn INTEGER NOT NULL DEFAULT 0,
      principal_outstanding_ngn INTEGER NOT NULL DEFAULT 0,
      installment_ngn INTEGER NOT NULL DEFAULT 0,
      term_months INTEGER NOT NULL DEFAULT 0,
      months_paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'approved_pending_disbursement',
      deductions_active INTEGER NOT NULL DEFAULT 0,
      hr_request_id TEXT,
      quotation_ref TEXT,
      discipline_case_id TEXT,
      finance_payment_request_id TEXT,
      disbursed_at_iso TEXT,
      due_date_iso TEXT,
      note TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      created_by_user_id TEXT,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_obligation_hr_request ON hr_staff_obligation_accounts(hr_request_id)
      WHERE hr_request_id IS NOT NULL AND trim(hr_request_id) != '';
    CREATE INDEX IF NOT EXISTS idx_hr_obligation_user_status ON hr_staff_obligation_accounts(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_hr_obligation_branch ON hr_staff_obligation_accounts(branch_id, status);
    CREATE INDEX IF NOT EXISTS idx_hr_obligation_fin_pr ON hr_staff_obligation_accounts(finance_payment_request_id);

    CREATE TABLE IF NOT EXISTS hr_staff_obligation_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      principal_before_ngn INTEGER NOT NULL DEFAULT 0,
      principal_after_ngn INTEGER NOT NULL DEFAULT 0,
      effective_at_iso TEXT NOT NULL,
      source_kind TEXT,
      source_id TEXT,
      payment_reference TEXT,
      note TEXT,
      recorded_by_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES hr_staff_obligation_accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_obligation_tx_account ON hr_staff_obligation_transactions(account_id, created_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_hr_obligation_tx_source ON hr_staff_obligation_transactions(source_kind, source_id);
  `);

  const loanCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(hr_payroll_line_loans)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (loanCols.size && !loanCols.has('obligation_account_id')) {
    db.exec(`ALTER TABLE hr_payroll_line_loans ADD COLUMN obligation_account_id TEXT`);
  }

  try {
    backfillStaffObligationsFromLoans(db);
  } catch (e) {
    console.warn('[migrate] staff obligation backfill skipped:', e?.message || e);
  }
}

/** Staff purchase credit — link HR staff to sales customer + quotation flags. */
function migrateStaffPurchaseCredit2026(db) {
  const profCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(hr_staff_profiles)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (profCols.size && !profCols.has('sales_customer_id')) {
    db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN sales_customer_id TEXT`);
  }

  const qCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(quotations)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (qCols.size && !qCols.has('is_staff_purchase')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN is_staff_purchase INTEGER NOT NULL DEFAULT 0`);
  }
  if (qCols.size && !qCols.has('staff_purchase_credit_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN staff_purchase_credit_id TEXT`);
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_quotations_staff_purchase ON quotations(staff_purchase_credit_id)`);
  } catch {
    /* ignore */
  }
  try {
    backfillStaffSalesCustomerNames(db);
  } catch (e) {
    console.warn('[migrate] staff sales customer name backfill skipped:', e?.message || e);
  }
  try {
    const policy = getHrPolicyPayload(db);
    const months = Number(policy.staffPurchaseCredit?.maxRepaymentMonths);
    if (!Number.isFinite(months) || months === 6) {
      updateHrPolicyPayload(db, { staffPurchaseCredit: { maxRepaymentMonths: 12 } });
    }
  } catch (e) {
    console.warn('[migrate] staff purchase credit repayment cap bump skipped:', e?.message || e);
  }
}

/** Link incident recovery schedules to unified obligation ledger. */
function migrateStaffRecoveryObligation2026(db) {
  const obCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(hr_staff_obligation_accounts)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (obCols.size && !obCols.has('recovery_schedule_id')) {
    db.exec(`ALTER TABLE hr_staff_obligation_accounts ADD COLUMN recovery_schedule_id TEXT`);
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_obligation_recovery_schedule ON hr_staff_obligation_accounts(recovery_schedule_id) WHERE recovery_schedule_id IS NOT NULL AND trim(recovery_schedule_id) != ''`
      );
    } catch {
      /* ignore */
    }
  }

  const recCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(hr_payroll_line_recoveries)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (recCols.size && !recCols.has('obligation_account_id')) {
    db.exec(`ALTER TABLE hr_payroll_line_recoveries ADD COLUMN obligation_account_id TEXT`);
  }

  try {
    backfillRecoveryObligationsFromSchedules(db);
  } catch (e) {
    console.warn('[migrate] recovery obligation backfill skipped:', e?.message || e);
  }
}

/** Pause metadata on staff obligation accounts (payroll deduction hold). */
function migrateStaffObligationPause2026(db) {
  const obCols = (() => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(hr_staff_obligation_accounts)`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  })();
  if (!obCols.size) return;
  for (const col of ['pause_until_iso', 'pause_reason', 'paused_at_iso', 'paused_by_user_id']) {
    if (!obCols.has(col)) {
      db.exec(`ALTER TABLE hr_staff_obligation_accounts ADD COLUMN ${col} TEXT`);
    }
  }
}

/** Per-user saved staff directory filter views (sync across devices). */
function migrateHrStaffDirectoryViews2026(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_staff_directory_views (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_dir_views_user_name ON hr_staff_directory_views(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_hr_dir_views_user ON hr_staff_directory_views(user_id, updated_at_iso DESC);
  `);
}

/** One HQ payroll run per calendar month (skip if legacy duplicates exist). */
function migratePayrollPeriodUnique2026(db) {
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_payroll_runs'`).get()) return;
    const dup = db
      .prepare(`SELECT period_yyyymm FROM hr_payroll_runs GROUP BY period_yyyymm HAVING COUNT(*) > 1 LIMIT 1`)
      .get();
    if (dup?.period_yyyymm) return;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_payroll_runs_period_yyyymm ON hr_payroll_runs(period_yyyymm)`);
  } catch {
    /* ignore — duplicate periods or host limitation */
  }
}

/** Ledger / receipt duplicate-check hot paths (bootstrap, finance desk). */
function migrateLedgerPerformanceIndexes(db) {
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'`).get()) return;
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ledger_branch_at ON ledger_entries(branch_id, at_iso DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_ledger_customer_quotation ON ledger_entries(customer_id, quotation_ref, type, at_iso DESC);
      CREATE INDEX IF NOT EXISTS idx_quotations_branch_date ON quotations(branch_id, date_iso DESC, id DESC);
    `);
  } catch {
    /* ignore — index may already exist under another name on some hosts */
  }
}

/** Cross-quote refund/overpay credit apply onto a new quotation (no bank clearance). */
function migrateRefundCreditApplications(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS refund_credit_applications (
        application_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        target_quotation_ref TEXT NOT NULL,
        source_quotation_ref TEXT,
        refund_id TEXT,
        kind TEXT NOT NULL,
        amount_ngn INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'Credit confirmation',
        ledger_bank_reference TEXT,
        created_at_iso TEXT NOT NULL,
        created_by_user_id TEXT,
        created_by_name TEXT,
        branch_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refund_credit_apps_customer
        ON refund_credit_applications(customer_id, created_at_iso DESC);
      CREATE INDEX IF NOT EXISTS idx_refund_credit_apps_target
        ON refund_credit_applications(target_quotation_ref, created_at_iso DESC);
    `);
  } catch {
    /* MySQL / host differences */
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS refund_credit_applications (
          application_id VARCHAR(64) PRIMARY KEY,
          customer_id VARCHAR(64) NOT NULL,
          target_quotation_ref VARCHAR(64) NOT NULL,
          source_quotation_ref VARCHAR(64) NULL,
          refund_id VARCHAR(64) NULL,
          kind VARCHAR(32) NOT NULL,
          amount_ngn BIGINT NOT NULL,
          status VARCHAR(64) NOT NULL DEFAULT 'Credit confirmation',
          ledger_bank_reference VARCHAR(128) NULL,
          created_at_iso VARCHAR(40) NOT NULL,
          created_by_user_id VARCHAR(64) NULL,
          created_by_name VARCHAR(128) NULL,
          branch_id VARCHAR(64) NULL
        )
      `);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Role-requirement compliance, versioned salary structure, loan installment rows,
 * branch assessment reports, and payslip provenance columns.
 * Payroll must read hr_loan_schedule_installments by period (not installment_ngn × remaining months).
 * hr_salary_matrix is retained as a historical reference and no longer feeds payroll.
 */
function migrateHrRoleComplianceLifecycle2026(db) {
  const tableCols = (name) => {
    try {
      return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    } catch {
      return new Set();
    }
  };

  const des = tableCols('hr_designations');
  if (des.size) {
    if (!des.has('staff_band')) {
      db.exec(`ALTER TABLE hr_designations ADD COLUMN staff_band TEXT`);
    }
    if (!des.has('min_qualification_rank')) {
      db.exec(`ALTER TABLE hr_designations ADD COLUMN min_qualification_rank INTEGER`);
    }
    if (!des.has('max_tenure_years')) {
      db.exec(`ALTER TABLE hr_designations ADD COLUMN max_tenure_years REAL`);
    }
  }

  const hr = tableCols('hr_staff_profiles');
  if (hr.size) {
    if (!hr.has('role_started_at_iso')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN role_started_at_iso TEXT`);
    }
    if (!hr.has('qualification_rank')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN qualification_rank INTEGER`);
    }
    if (!hr.has('employment_status')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN employment_status TEXT`);
    }
    if (!hr.has('bank_verification_status')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN bank_verification_status TEXT`);
    }
    if (!hr.has('compliance_status')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN compliance_status TEXT`);
    }
    if (!hr.has('compliance_reason')) {
      db.exec(`ALTER TABLE hr_staff_profiles ADD COLUMN compliance_reason TEXT`);
    }
    try {
      db.exec(`
        UPDATE hr_staff_profiles
        SET role_started_at_iso = date_joined_iso
        WHERE (role_started_at_iso IS NULL OR TRIM(role_started_at_iso) = '')
          AND date_joined_iso IS NOT NULL AND TRIM(date_joined_iso) != ''
      `);
      db.exec(`UPDATE hr_staff_profiles SET employment_status = 'active' WHERE employment_status IS NULL OR TRIM(employment_status) = ''`);
      db.exec(
        `UPDATE hr_staff_profiles SET bank_verification_status = 'unverified' WHERE bank_verification_status IS NULL OR TRIM(bank_verification_status) = ''`
      );
      db.exec(`UPDATE hr_staff_profiles SET compliance_status = 'ok' WHERE compliance_status IS NULL OR TRIM(compliance_status) = ''`);
    } catch {
      /* host SQL dialect */
    }
    try {
      recomputeAllStaffRoleCompliance(db);
    } catch {
      /* compute is also invoked from hr.daily_tick */
    }
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hr_salary_structure_versions (
        id TEXT PRIMARY KEY,
        designation_id TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT '',
        amount_ngn INTEGER NOT NULL,
        effective_from_iso TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by_user_id TEXT,
        approved_at_iso TEXT,
        proposed_by_user_id TEXT,
        proposed_at_iso TEXT,
        notes TEXT,
        created_at_iso TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hr_sal_struct_desig_branch
        ON hr_salary_structure_versions(designation_id, branch_id, status);
      CREATE INDEX IF NOT EXISTS idx_hr_sal_struct_status
        ON hr_salary_structure_versions(status, effective_from_iso);

      CREATE TABLE IF NOT EXISTS hr_loan_schedule_installments (
        id TEXT PRIMARY KEY,
        hr_request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        period_yyyymm TEXT NOT NULL,
        amount_ngn INTEGER NOT NULL,
        status TEXT NOT NULL,
        payroll_run_id TEXT,
        applied_at_iso TEXT,
        created_at_iso TEXT NOT NULL,
        FOREIGN KEY (hr_request_id) REFERENCES hr_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_loan_inst_request_period
        ON hr_loan_schedule_installments(hr_request_id, period_yyyymm);
      CREATE INDEX IF NOT EXISTS idx_hr_loan_inst_user_period
        ON hr_loan_schedule_installments(user_id, period_yyyymm, status);

      CREATE TABLE IF NOT EXISTS hr_assessment_reports (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        period_yyyymm TEXT NOT NULL,
        due_date_iso TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted_at_iso TEXT,
        submitted_by_user_id TEXT,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_assess_branch_period
        ON hr_assessment_reports(branch_id, period_yyyymm);
      CREATE INDEX IF NOT EXISTS idx_hr_assess_status_due
        ON hr_assessment_reports(status, due_date_iso);

      CREATE TABLE IF NOT EXISTS hr_assessment_report_lines (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        attendance_summary TEXT,
        punctuality_summary TEXT,
        disciplinary_deduction_ngn INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (report_id) REFERENCES hr_assessment_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_assess_line_report_user
        ON hr_assessment_report_lines(report_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_hr_assess_line_user
        ON hr_assessment_report_lines(user_id);
    `);
  } catch {
    /* tables/indexes may already exist on MySQL hosts */
  }

  const lines = tableCols('hr_payroll_lines');
  if (lines.size) {
    if (!lines.has('salary_version_id')) {
      db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN salary_version_id TEXT`);
    }
    if (!lines.has('loan_deduction_ngn')) {
      db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN loan_deduction_ngn INTEGER NOT NULL DEFAULT 0`);
    }
    if (!lines.has('disciplinary_deduction_ngn')) {
      db.exec(`ALTER TABLE hr_payroll_lines ADD COLUMN disciplinary_deduction_ngn INTEGER NOT NULL DEFAULT 0`);
    }
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_staff_branch_compliance ON hr_staff_profiles(branch_id, compliance_status)`);
  } catch {
    /* index optional until columns exist on host */
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_staff_bank_verification ON hr_staff_profiles(bank_verification_status)`);
  } catch {
    /* optional */
  }
}
