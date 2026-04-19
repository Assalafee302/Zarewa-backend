import { mapLegacyExpenseCategoryToCanonical, isAllowedExpenseCategory } from '../shared/expenseCategories.js';
import { ensureEditApprovalTable } from './editApproval.js';
import { seedDefaultGlAccounts } from './glOps.js';
import { migrateTimestampStyleDocumentIds } from './migrateTimestampDocIds.js';
import { deriveProcurementKindFromProductIds } from './procurementPoKind.js';

/**
 * Idempotent SQLite migrations for existing DB files (CREATE IF NOT EXISTS misses new columns).
 * @param {import('better-sqlite3').Database} db
 */
export function runMigrations(db) {
  ensureEditApprovalTable(db);
  const tableCols = (name) => {
    const rows = db.prepare(`PRAGMA table_info(${name})`).all();
    return new Set(rows.map((c) => c.name));
  };

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
  if (!q.has('md_price_exception_approved_at_iso')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN md_price_exception_approved_at_iso TEXT`);
  }
  if (!q.has('md_price_exception_approved_by_user_id')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN md_price_exception_approved_by_user_id TEXT`);
  }
  if (!q.has('archived')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!q.has('quotation_lifecycle_note')) {
    db.exec(`ALTER TABLE quotations ADD COLUMN quotation_lifecycle_note TEXT`);
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

  const deliveries = tableCols('deliveries');
  if (!deliveries.has('customer_id')) {
    db.exec(`ALTER TABLE deliveries ADD COLUMN customer_id TEXT`);
  }
  if (!deliveries.has('cutting_list_id')) {
    db.exec(`ALTER TABLE deliveries ADD COLUMN cutting_list_id TEXT`);
  }
  if (!deliveries.has('fulfillment_posted')) {
    db.exec(`ALTER TABLE deliveries ADD COLUMN fulfillment_posted INTEGER DEFAULT 0`);
  }

  const cutting = tableCols('cutting_lists');
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
  if (!productionJobs.has('coil_spec_mismatch_pending')) {
    db.exec(`ALTER TABLE production_jobs ADD COLUMN coil_spec_mismatch_pending INTEGER NOT NULL DEFAULT 0`);
  }

  const pjc = tableCols('production_job_coils');
  if (pjc.size > 0 && !pjc.has('spec_mismatch')) {
    db.exec(`ALTER TABLE production_job_coils ADD COLUMN spec_mismatch INTEGER NOT NULL DEFAULT 0`);
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
  if (!refunds.has('preview_snapshot_json')) {
    db.exec(`ALTER TABLE customer_refunds ADD COLUMN preview_snapshot_json TEXT`);
  }
  // Legacy index blocked multiple refund requests per quotation (product defaulted to "—").
  db.exec(`DROP INDEX IF EXISTS idx_customer_refunds_single_pending`);
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
      coil_spec_mismatch_pending INTEGER NOT NULL DEFAULT 0,
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
  migrateMaterialPricingWorkbook(db);
  migrateUserProfileAndPasswordReset(db);
  migrateHrStaffProfileColumns(db);
  migrateAccountingLayer(db);
  migrateExpenseCategoriesToCanonical(db);
  migrateAccessoryOperations(db);
  migratePriceListAndPayrollMd(db);
  migrateProductionCompletionAdjustments(db);
  migrateStoneCoatedAndPricingArch(db);
  migrateEnsureQuotationMaterialTypes(db);
  migrateProcurementOrderKind(db);
  migrateHrExcellence2026(db);
  migrateWorkspaceSearchIndexes(db);
  migrateInterBranchLoans(db);
  migrateOfficeDesk(db);
  migrateOfficeThreadFiling(db);
  migrateUnifiedWorkspaceRegistry(db);
  migrateOperationsMaintenanceWorkspace(db);
  migrateOfficeOperations2026(db);
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
    db.prepare(
      `UPDATE coil_requests SET branch_id = 'BR-KD' WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = ''`
    ).run();
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

/** Coil vs stone-metre vs accessory PO classification for dashboards. */
function migrateProcurementOrderKind(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get()) return;
  const cols = new Set(db.prepare(`PRAGMA table_info(purchase_orders)`).all().map((c) => c.name));
  if (!cols.has('procurement_kind')) {
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN procurement_kind TEXT NOT NULL DEFAULT 'coil'`);
  }
  const pos = db.prepare(`SELECT po_id FROM purchase_orders`).all();
  const lineStmt = db.prepare(`SELECT product_id FROM purchase_order_lines WHERE po_id = ?`);
  const upd = db.prepare(`UPDATE purchase_orders SET procurement_kind = ? WHERE po_id = ?`);
  for (const { po_id } of pos) {
    const lines = lineStmt.all(po_id);
    const kind = deriveProcurementKindFromProductIds(lines.map((l) => l.product_id));
    upd.run(kind, po_id);
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
    ['ACC-SILICON-TUBE', 'Silicon (tube)', 'tube'],
    ['ACC-RIVET-PACK', 'Rivet pin (pack)', 'pack'],
    ['ACC-CONCRETE-NAIL-PACK', 'Concrete nail (pack)', 'pack'],
    ['ACC-COPPER-NAIL-PACK', 'Copper nail (pack)', 'pack'],
    ['ACC-TAPPING-SCREW-PCS', 'Tapping screw nail (pcs)', 'pcs'],
    ['ACC-HOOKS-PCS', 'Hooks (pcs)', 'pcs'],
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
    ['SQI-006', 'Silicon Tube', 'ACC-SILICON-TUBE', 'tube'],
    ['SQI-007', 'Rivets', 'ACC-RIVET-PACK', 'pack'],
    ['SQI-012', 'Drive screw nail', 'ACC-DRIVE-SCREW-PACK', 'pack'],
    ['SQI-013', 'Rivet pin', 'ACC-RIVET-PACK', 'pack'],
    ['SQI-014', 'Concrete nail', 'ACC-CONCRETE-NAIL-PACK', 'pack'],
    ['SQI-015', 'Copper nail', 'ACC-COPPER-NAIL-PACK', 'pack'],
    ['SQI-016', 'Hooks', 'ACC-HOOKS-PCS', 'pcs'],
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
  const pr = tableCols('hr_payroll_runs');
  if (pr.size && !pr.has('md_approved_at_iso')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN md_approved_at_iso TEXT`);
  }
  if (pr.size && !pr.has('md_approved_by_user_id')) {
    db.exec(`ALTER TABLE hr_payroll_runs ADD COLUMN md_approved_by_user_id TEXT`);
  }
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
  migrateHrModule(db);
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
  if (users.size && !users.has('department')) {
    db.exec(`ALTER TABLE app_users ADD COLUMN department TEXT NOT NULL DEFAULT 'general'`);
    db.prepare(
      `UPDATE app_users SET department = CASE role_key
        WHEN 'admin' THEN 'it'
        WHEN 'finance_manager' THEN 'finance'
        WHEN 'sales_manager' THEN 'sales'
        WHEN 'sales_staff' THEN 'sales'
        WHEN 'procurement_officer' THEN 'purchase'
        WHEN 'operations_officer' THEN 'inventory'
        WHEN 'viewer' THEN 'reports'
        ELSE 'general' END`
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
    'suppliers',
    'transport_agents',
    'products',
    'bank_reconciliation_lines',
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
    const allWip = db.prepare(`SELECT rowid, product_id FROM wip_balances`).all();
    for (const w of allWip) {
      const p = db.prepare(`SELECT branch_id FROM products WHERE product_id = ?`).get(w.product_id);
      const bid = p ? String(p.branch_id ?? '').trim() : '';
      db.prepare(`UPDATE wip_balances SET branch_id = ? WHERE rowid = ?`).run(bid, w.rowid);
    }

    db.exec(`DROP TABLE IF EXISTS wip_balances__new`);
    db.exec(`CREATE TABLE wip_balances__new (
      branch_id TEXT NOT NULL DEFAULT '',
      product_id TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (branch_id, product_id)
    )`);
    db.exec(`
      INSERT OR REPLACE INTO wip_balances__new (branch_id, product_id, qty)
      SELECT TRIM(COALESCE(branch_id,'')), product_id, qty FROM wip_balances
    `);
    db.exec(`DROP TABLE wip_balances`);
    db.exec(`ALTER TABLE wip_balances__new RENAME TO wip_balances`);
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
  db.prepare(`UPDATE products SET branch_id = '' WHERE product_id LIKE 'STONE-%' OR product_id LIKE 'ACC-%'`).run();
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
  `);
}
