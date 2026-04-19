/**
 * One-time DB hardening: branch backfill, referential triggers, non-negative checks,
 * coil serial sequence, treasury reconcile, stock_movements.coil_no.
 * Canonical DDL lives in schemaSql.js; additive columns/FKs for new DBs are there too.
 * Existing files always run runMigrations() after SCHEMA_SQL — see schemaSql.js header.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';

const PATCH = 'db_integrity_hardening_v1';

const BRANCH_BACKFILL_TABLES = [
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
  'stock_movements',
  'coil_requests',
];

function hasTable(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function tableCols(db, name) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

function backfillBranchIds(db) {
  for (const t of BRANCH_BACKFILL_TABLES) {
    if (!hasTable(db, t)) continue;
    const cols = tableCols(db, t);
    if (!cols.has('branch_id')) continue;
    db.prepare(
      `UPDATE ${t} SET branch_id = ? WHERE branch_id IS NULL OR TRIM(COALESCE(branch_id, '')) = ''`
    ).run(DEFAULT_BRANCH_ID);
  }
}

function ensureBranchIndexes(db) {
  for (const t of BRANCH_BACKFILL_TABLES) {
    if (!hasTable(db, t)) continue;
    if (!tableCols(db, t).has('branch_id')) continue;
    const idx = `idx_${t}_branch_id`;
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${idx} ON ${t}(branch_id)`);
    } catch {
      /* ignore invalid names — tables are whitelisted */
    }
  }
}

function ensureStockMovementsCoilNo(db) {
  if (!hasTable(db, 'stock_movements')) return;
  const cols = tableCols(db, 'stock_movements');
  if (!cols.has('coil_no')) {
    db.exec(`ALTER TABLE stock_movements ADD COLUMN coil_no TEXT`);
  }
}

function ensureEntitySequences(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_sequences (
      name TEXT PRIMARY KEY,
      next_val INTEGER NOT NULL
    );
  `);
  const hasLots = hasTable(db, 'coil_lots');
  let maxSerial = 0;
  if (hasLots) {
    const rows = db.prepare(`SELECT coil_no FROM coil_lots`).all();
    for (const { coil_no } of rows) {
      const m = String(coil_no ?? '').match(/^C\d{2}-(\d+)$/i);
      if (m) maxSerial = Math.max(maxSerial, parseInt(m[1], 10));
    }
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM coil_lots`).get().c;
    maxSerial = Math.max(maxSerial, cnt);
  }
  const nextVal = Math.max(1, maxSerial + 1);
  db.prepare(
    `INSERT INTO entity_sequences (name, next_val) VALUES ('coil_grn_serial', ?)
     ON CONFLICT(name) DO UPDATE SET next_val = CASE
       WHEN excluded.next_val > entity_sequences.next_val THEN excluded.next_val
       ELSE entity_sequences.next_val
     END`
  ).run(nextVal);
}

function reconcileTreasuryBalances(db) {
  if (!hasTable(db, 'treasury_accounts') || !hasTable(db, 'treasury_movements')) return;
  const accounts = db.prepare(`SELECT id FROM treasury_accounts`).all();
  for (const { id } of accounts) {
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM treasury_movements WHERE treasury_account_id = ?`).get(id)
      .c;
    if (cnt === 0) continue;
    const sumRow = db
      .prepare(`SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements WHERE treasury_account_id = ?`)
      .get(id);
    db.prepare(`UPDATE treasury_accounts SET balance = ? WHERE id = ?`).run(sumRow.s, id);
  }
}

function dropTriggers(db, names) {
  for (const n of names) {
    try {
      db.exec(`DROP TRIGGER IF EXISTS ${n}`);
    } catch {
      /* ignore */
    }
  }
}

function createReferentialTriggers(db) {
  const allNames = [
    'tr_coil_lots_product_ins',
    'tr_coil_lots_product_upd',
    'tr_coil_lots_po_ins',
    'tr_coil_lots_po_upd',
    'tr_coil_lots_supplier_ins',
    'tr_coil_lots_supplier_upd',
    'tr_ledger_quotation_ins',
    'tr_ledger_quotation_upd',
    'tr_receipt_ledger_ins',
    'tr_receipt_ledger_upd',
    'tr_deliveries_customer_ins',
    'tr_deliveries_customer_upd',
    'tr_deliveries_cl_ins',
    'tr_deliveries_cl_upd',
    'tr_po_transport_agent_ins',
    'tr_po_transport_agent_upd',
    'tr_wip_product_ins',
    'tr_wip_product_upd',
    'tr_stock_mv_product_ins',
    'tr_stock_mv_product_upd',
    'tr_stock_mv_coil_ins',
    'tr_stock_mv_coil_upd',
    'tr_payreq_expense_ins',
    'tr_payreq_expense_upd',
  ];
  dropTriggers(db, allNames);

  if (hasTable(db, 'coil_lots') && hasTable(db, 'products')) {
    db.exec(`
    CREATE TRIGGER tr_coil_lots_product_ins
    BEFORE INSERT ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'coil_lots.product_id must reference products')
      END;
    END;
    CREATE TRIGGER tr_coil_lots_product_upd
    BEFORE UPDATE OF product_id ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'coil_lots.product_id must reference products')
      END;
    END;
    `);
  }

  if (hasTable(db, 'coil_lots') && hasTable(db, 'purchase_orders')) {
    db.exec(`
    CREATE TRIGGER tr_coil_lots_po_ins
    BEFORE INSERT ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.po_id IS NOT NULL AND TRIM(COALESCE(NEW.po_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE po_id = NEW.po_id)
        THEN RAISE(ABORT, 'coil_lots.po_id must reference purchase_orders')
      END;
    END;
    CREATE TRIGGER tr_coil_lots_po_upd
    BEFORE UPDATE OF po_id ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.po_id IS NOT NULL AND TRIM(COALESCE(NEW.po_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE po_id = NEW.po_id)
        THEN RAISE(ABORT, 'coil_lots.po_id must reference purchase_orders')
      END;
    END;
    `);
  }

  if (hasTable(db, 'coil_lots') && hasTable(db, 'suppliers')) {
    db.exec(`
    CREATE TRIGGER tr_coil_lots_supplier_ins
    BEFORE INSERT ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.supplier_id IS NOT NULL AND TRIM(COALESCE(NEW.supplier_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM suppliers WHERE supplier_id = NEW.supplier_id)
        THEN RAISE(ABORT, 'coil_lots.supplier_id must reference suppliers')
      END;
    END;
    CREATE TRIGGER tr_coil_lots_supplier_upd
    BEFORE UPDATE OF supplier_id ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.supplier_id IS NOT NULL AND TRIM(COALESCE(NEW.supplier_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM suppliers WHERE supplier_id = NEW.supplier_id)
        THEN RAISE(ABORT, 'coil_lots.supplier_id must reference suppliers')
      END;
    END;
    `);
  }

  if (hasTable(db, 'ledger_entries') && hasTable(db, 'quotations')) {
    db.exec(`
    CREATE TRIGGER tr_ledger_quotation_ins
    BEFORE INSERT ON ledger_entries
    BEGIN
      SELECT CASE
        WHEN NEW.quotation_ref IS NOT NULL AND TRIM(COALESCE(NEW.quotation_ref, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM quotations WHERE id = NEW.quotation_ref)
        THEN RAISE(ABORT, 'ledger_entries.quotation_ref must reference quotations')
      END;
    END;
    CREATE TRIGGER tr_ledger_quotation_upd
    BEFORE UPDATE OF quotation_ref ON ledger_entries
    BEGIN
      SELECT CASE
        WHEN NEW.quotation_ref IS NOT NULL AND TRIM(COALESCE(NEW.quotation_ref, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM quotations WHERE id = NEW.quotation_ref)
        THEN RAISE(ABORT, 'ledger_entries.quotation_ref must reference quotations')
      END;
    END;
    `);
  }

  if (hasTable(db, 'sales_receipts') && hasTable(db, 'ledger_entries')) {
    db.exec(`
    CREATE TRIGGER tr_receipt_ledger_ins
    BEFORE INSERT ON sales_receipts
    BEGIN
      SELECT CASE
        WHEN NEW.ledger_entry_id IS NOT NULL AND TRIM(COALESCE(NEW.ledger_entry_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE id = NEW.ledger_entry_id)
        THEN RAISE(ABORT, 'sales_receipts.ledger_entry_id must reference ledger_entries')
      END;
    END;
    CREATE TRIGGER tr_receipt_ledger_upd
    BEFORE UPDATE OF ledger_entry_id ON sales_receipts
    BEGIN
      SELECT CASE
        WHEN NEW.ledger_entry_id IS NOT NULL AND TRIM(COALESCE(NEW.ledger_entry_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE id = NEW.ledger_entry_id)
        THEN RAISE(ABORT, 'sales_receipts.ledger_entry_id must reference ledger_entries')
      END;
    END;
    `);
  }

  if (hasTable(db, 'deliveries') && hasTable(db, 'customers')) {
    db.exec(`
    CREATE TRIGGER tr_deliveries_customer_ins
    BEFORE INSERT ON deliveries
    BEGIN
      SELECT CASE
        WHEN NEW.customer_id IS NOT NULL AND TRIM(COALESCE(NEW.customer_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM customers WHERE customer_id = NEW.customer_id)
        THEN RAISE(ABORT, 'deliveries.customer_id must reference customers')
      END;
    END;
    CREATE TRIGGER tr_deliveries_customer_upd
    BEFORE UPDATE OF customer_id ON deliveries
    BEGIN
      SELECT CASE
        WHEN NEW.customer_id IS NOT NULL AND TRIM(COALESCE(NEW.customer_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM customers WHERE customer_id = NEW.customer_id)
        THEN RAISE(ABORT, 'deliveries.customer_id must reference customers')
      END;
    END;
    `);
  }

  if (hasTable(db, 'deliveries') && hasTable(db, 'cutting_lists')) {
    db.exec(`
    CREATE TRIGGER tr_deliveries_cl_ins
    BEFORE INSERT ON deliveries
    BEGIN
      SELECT CASE
        WHEN NEW.cutting_list_id IS NOT NULL AND TRIM(COALESCE(NEW.cutting_list_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM cutting_lists WHERE id = NEW.cutting_list_id)
        THEN RAISE(ABORT, 'deliveries.cutting_list_id must reference cutting_lists')
      END;
    END;
    CREATE TRIGGER tr_deliveries_cl_upd
    BEFORE UPDATE OF cutting_list_id ON deliveries
    BEGIN
      SELECT CASE
        WHEN NEW.cutting_list_id IS NOT NULL AND TRIM(COALESCE(NEW.cutting_list_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM cutting_lists WHERE id = NEW.cutting_list_id)
        THEN RAISE(ABORT, 'deliveries.cutting_list_id must reference cutting_lists')
      END;
    END;
    `);
  }

  if (hasTable(db, 'purchase_orders') && hasTable(db, 'transport_agents')) {
    db.exec(`
    CREATE TRIGGER tr_po_transport_agent_ins
    BEFORE INSERT ON purchase_orders
    BEGIN
      SELECT CASE
        WHEN NEW.transport_agent_id IS NOT NULL AND TRIM(COALESCE(NEW.transport_agent_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM transport_agents WHERE id = NEW.transport_agent_id)
        THEN RAISE(ABORT, 'purchase_orders.transport_agent_id must reference transport_agents')
      END;
    END;
    CREATE TRIGGER tr_po_transport_agent_upd
    BEFORE UPDATE OF transport_agent_id ON purchase_orders
    BEGIN
      SELECT CASE
        WHEN NEW.transport_agent_id IS NOT NULL AND TRIM(COALESCE(NEW.transport_agent_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM transport_agents WHERE id = NEW.transport_agent_id)
        THEN RAISE(ABORT, 'purchase_orders.transport_agent_id must reference transport_agents')
      END;
    END;
    `);
  }

  if (hasTable(db, 'wip_balances') && hasTable(db, 'products')) {
    dropTriggers(db, ['tr_wip_product_ins', 'tr_wip_product_upd']);
    if (tableCols(db, 'wip_balances').has('branch_id')) {
      db.exec(`
    CREATE TRIGGER tr_wip_product_ins
    BEFORE INSERT ON wip_balances
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM products p
          WHERE p.product_id = NEW.product_id
            AND TRIM(COALESCE(p.branch_id,'')) = TRIM(COALESCE(NEW.branch_id,''))
        )
        THEN RAISE(ABORT, 'wip_balances must match products.branch_id for this SKU')
      END;
    END;
    CREATE TRIGGER tr_wip_product_upd
    BEFORE UPDATE OF product_id, branch_id ON wip_balances
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM products p
          WHERE p.product_id = NEW.product_id
            AND TRIM(COALESCE(p.branch_id,'')) = TRIM(COALESCE(NEW.branch_id,''))
        )
        THEN RAISE(ABORT, 'wip_balances must match products.branch_id for this SKU')
      END;
    END;
    `);
    } else {
      db.exec(`
    CREATE TRIGGER tr_wip_product_ins
    BEFORE INSERT ON wip_balances
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'wip_balances.product_id must reference products')
      END;
    END;
    CREATE TRIGGER tr_wip_product_upd
    BEFORE UPDATE OF product_id ON wip_balances
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'wip_balances.product_id must reference products')
      END;
    END;
    `);
    }
  }

  if (hasTable(db, 'stock_movements') && hasTable(db, 'products')) {
    db.exec(`
    CREATE TRIGGER tr_stock_mv_product_ins
    BEFORE INSERT ON stock_movements
    BEGIN
      SELECT CASE
        WHEN NEW.product_id IS NOT NULL AND TRIM(COALESCE(NEW.product_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'stock_movements.product_id must reference products')
      END;
    END;
    CREATE TRIGGER tr_stock_mv_product_upd
    BEFORE UPDATE OF product_id ON stock_movements
    BEGIN
      SELECT CASE
        WHEN NEW.product_id IS NOT NULL AND TRIM(COALESCE(NEW.product_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM products WHERE product_id = NEW.product_id)
        THEN RAISE(ABORT, 'stock_movements.product_id must reference products')
      END;
    END;
    `);
  }

  if (
    hasTable(db, 'stock_movements') &&
    hasTable(db, 'coil_lots') &&
    tableCols(db, 'stock_movements').has('coil_no')
  ) {
    db.exec(`
    CREATE TRIGGER tr_stock_mv_coil_ins
    BEFORE INSERT ON stock_movements
    BEGIN
      SELECT CASE
        WHEN NEW.coil_no IS NOT NULL AND TRIM(COALESCE(NEW.coil_no, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM coil_lots WHERE coil_no = NEW.coil_no)
        THEN RAISE(ABORT, 'stock_movements.coil_no must reference coil_lots')
      END;
    END;
    CREATE TRIGGER tr_stock_mv_coil_upd
    BEFORE UPDATE OF coil_no ON stock_movements
    BEGIN
      SELECT CASE
        WHEN NEW.coil_no IS NOT NULL AND TRIM(COALESCE(NEW.coil_no, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM coil_lots WHERE coil_no = NEW.coil_no)
        THEN RAISE(ABORT, 'stock_movements.coil_no must reference coil_lots')
      END;
    END;
    `);
  }

  if (hasTable(db, 'payment_requests') && hasTable(db, 'expenses')) {
    db.exec(`
    CREATE TRIGGER tr_payreq_expense_ins
    BEFORE INSERT ON payment_requests
    BEGIN
      SELECT CASE
        WHEN NEW.expense_id IS NOT NULL AND TRIM(COALESCE(NEW.expense_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM expenses WHERE expense_id = NEW.expense_id)
        THEN RAISE(ABORT, 'payment_requests.expense_id must reference expenses')
      END;
    END;
    CREATE TRIGGER tr_payreq_expense_upd
    BEFORE UPDATE OF expense_id ON payment_requests
    BEGIN
      SELECT CASE
        WHEN NEW.expense_id IS NOT NULL AND TRIM(COALESCE(NEW.expense_id, '')) != ''
             AND NOT EXISTS (SELECT 1 FROM expenses WHERE expense_id = NEW.expense_id)
        THEN RAISE(ABORT, 'payment_requests.expense_id must reference expenses')
      END;
    END;
  `);
  }
}

function createNonNegativeTriggers(db) {
  const names = [
    'tr_products_stock_ins',
    'tr_products_stock_upd',
    'tr_coil_qty_ins',
    'tr_coil_qty_upd',
    'tr_wip_qty_ins',
    'tr_wip_qty_upd',
    'tr_treasury_balance_ins',
    'tr_treasury_balance_upd',
  ];
  dropTriggers(db, names);

  if (hasTable(db, 'products')) {
    db.exec(`
    CREATE TRIGGER tr_products_stock_ins
    BEFORE INSERT ON products
    BEGIN
      SELECT CASE WHEN NEW.stock_level < 0 THEN RAISE(ABORT, 'products.stock_level must be >= 0') END;
    END;
    CREATE TRIGGER tr_products_stock_upd
    BEFORE UPDATE OF stock_level ON products
    BEGIN
      SELECT CASE WHEN NEW.stock_level < 0 THEN RAISE(ABORT, 'products.stock_level must be >= 0') END;
    END;
    `);
  }

  if (hasTable(db, 'coil_lots')) {
    db.exec(`
    CREATE TRIGGER tr_coil_qty_ins
    BEFORE INSERT ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.qty_remaining < 0 OR NEW.qty_reserved < 0 OR NEW.current_weight_kg < 0
        THEN RAISE(ABORT, 'coil_lots qty/weight fields must be >= 0')
      END;
    END;
    CREATE TRIGGER tr_coil_qty_upd
    BEFORE UPDATE OF qty_remaining, qty_reserved, current_weight_kg ON coil_lots
    BEGIN
      SELECT CASE
        WHEN NEW.qty_remaining < 0 OR NEW.qty_reserved < 0 OR NEW.current_weight_kg < 0
        THEN RAISE(ABORT, 'coil_lots qty/weight fields must be >= 0')
      END;
    END;
    `);
  }

  if (hasTable(db, 'wip_balances')) {
    db.exec(`
    CREATE TRIGGER tr_wip_qty_ins
    BEFORE INSERT ON wip_balances
    BEGIN
      SELECT CASE WHEN NEW.qty < 0 THEN RAISE(ABORT, 'wip_balances.qty must be >= 0') END;
    END;
    CREATE TRIGGER tr_wip_qty_upd
    BEFORE UPDATE OF qty ON wip_balances
    BEGIN
      SELECT CASE WHEN NEW.qty < 0 THEN RAISE(ABORT, 'wip_balances.qty must be >= 0') END;
    END;
    `);
  }

  if (hasTable(db, 'treasury_accounts')) {
    db.exec(`
    CREATE TRIGGER tr_treasury_balance_ins
    BEFORE INSERT ON treasury_accounts
    BEGIN
      SELECT CASE WHEN NEW.balance < 0 THEN RAISE(ABORT, 'treasury_accounts.balance must be >= 0') END;
    END;
    CREATE TRIGGER tr_treasury_balance_upd
    BEFORE UPDATE OF balance ON treasury_accounts
    BEGIN
      SELECT CASE WHEN NEW.balance < 0 THEN RAISE(ABORT, 'treasury_accounts.balance must be >= 0') END;
    END;
    `);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function runDbIntegrityHardening(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_patches (
      name TEXT PRIMARY KEY,
      applied_at_iso TEXT NOT NULL
    );
  `);
  if (db.prepare(`SELECT 1 FROM schema_patches WHERE name = ?`).get(PATCH)) return;

  db.transaction(() => {
    backfillBranchIds(db);
    ensureBranchIndexes(db);
    ensureStockMovementsCoilNo(db);
    ensureEntitySequences(db);
    reconcileTreasuryBalances(db);

    createReferentialTriggers(db);
    createNonNegativeTriggers(db);

    db.prepare(`INSERT INTO schema_patches (name, applied_at_iso) VALUES (?, ?)`).run(
      PATCH,
      new Date().toISOString()
    );
  })();
}
