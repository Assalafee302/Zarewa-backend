/**
 * Import treasury accounts, supplier list, receipt→account routing, expenses, and purchase payments
 * from Excel under docs/import (or --dir). Works alongside Access sales import: run sales first so
 * LE-LEGACY-R* ledger rows exist before receipt routing.
 *
 * Files (case-insensitive names in import dir):
 *   Preferred: one workbook — Finance cash.xlsx | Cash book.xlsx | Cash.xlsx | Treasury pack.xlsx
 *     with sheets whose names contain (any match):
 *       • accounts / treasury / cash accounts — columns: AccountKey (or Code), Name, BankName, Type (Cash|Bank), OpeningBalance
 *       • supplier — columns: SupplierID (optional), Name, City, PaymentTerms, Notes
 *       • receipt routing — ReceiptID (numeric → LE-LEGACY-R{id}), AccountKey (matches AccountKey above)
 *       • expense — Date, Amount, Category, AccountKey, Reference, PaymentMethod, Description (optional)
 *       • purchase / supplier payment — Date, Amount, SupplierID or SupplierName, AccountKey, Reference, InvoiceNo (optional), PaymentID (optional id)
 *
 *   Or separate workbooks:
 *     Suppliers.xlsx | Supplier.xlsx
 *     Cash accounts.xlsx | Treasury accounts.xlsx | Accounts.xlsx
 *     Receipt treasury.xlsx | Receipt accounts.xlsx (receipt routing sheet)
 *     Expenses import.xlsx | Expenses.xlsx
 *     Purchases import.xlsx | Supplier payments.xlsx
 *
 * Usage:
 *   node server/importAccessFinancePack.mjs
 *   node server/importAccessFinancePack.mjs --dry-run --dir docs/import
 *   node server/importAccessFinancePack.mjs --default-treasury-account-id 1
 *
 * If there is no receipt-routing sheet, pass --default-treasury-account-id <id> to post all legacy
 * receipts that still lack a LEDGER_RECEIPT movement to that account (same idea as backfill script).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { mapLegacyExpenseCategoryToCanonical } from '../shared/expenseCategories.js';
import { SCHEMA_SQL } from './schemaSql.js';
import { runMigrations } from './migrate.js';
import { defaultDbPath } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  insertTreasuryMovementTx,
  recordCustomerReceiptCash,
  insertExpenseEntry,
  insertPurchaseOrder,
  recordSupplierPayment,
} from './writeOps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {
    dryRun: false,
    dir: path.join(ROOT, 'docs', 'import'),
    dbPath: process.env.ZAREWA_DB || defaultDbPath(),
    branchId: DEFAULT_BRANCH_ID,
    defaultTreasuryAccountId: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir' && argv[i + 1]) out.dir = path.resolve(argv[++i]);
    else if (a === '--db' && argv[i + 1]) out.dbPath = path.resolve(argv[++i]);
    else if (a === '--branch' && argv[i + 1]) out.branchId = String(argv[++i]).trim();
    else if (a === '--default-treasury-account-id' && argv[i + 1]) {
      out.defaultTreasuryAccountId = parseInt(String(argv[++i]), 10) || 0;
    }
  }
  return out;
}

function resolveFile(importDir, ...candidates) {
  if (!fs.existsSync(importDir)) return null;
  const list = fs.readdirSync(importDir);
  for (const c of candidates) {
    const hit = list.find((f) => f.toLowerCase() === c.toLowerCase());
    if (hit) return path.join(importDir, hit);
  }
  return null;
}

function intMoney(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[₦#,]/g, '').trim()) || 0);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(v) {
  if (v instanceof Date && !Number.isNaN(+v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const utc = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(utc);
    if (!Number.isNaN(+d)) return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d2 = new Date(s);
  if (!Number.isNaN(+d2)) return d2.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return row[k];
    const hit = Object.keys(row).find((rk) => rk.toLowerCase().replace(/\s+/g, '') === k.toLowerCase().replace(/\s+/g, ''));
    if (hit != null && String(row[hit]).trim() !== '') return row[hit];
  }
  return '';
}

function findSheetName(names, patterns) {
  const lower = names.map((n) => ({ n, l: n.toLowerCase() }));
  for (const p of patterns) {
    const hit = lower.find((x) => x.l.includes(p));
    if (hit) return hit.n;
  }
  return '';
}

function readWorkbook(pathToFile) {
  if (!pathToFile || !fs.existsSync(pathToFile)) return null;
  return XLSX.readFile(pathToFile, { cellDates: true, dense: false });
}

function sheetRows(wb, sheetName) {
  if (!wb || !sheetName || !wb.Sheets[sheetName]) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: true });
}

function openDb(dbPath, dryRun) {
  if (dryRun) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function ensureLegacyCoilProduct(db, branchId) {
  const exists = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get('PRD-LEGACY-COIL');
  if (exists) return;
  db.prepare(
    `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('PRD-LEGACY-COIL', 'Imported coil stock (legacy)', 0, 'kg', 0, 0, '', '', '', '{}', branchId);
}

/**
 * @param {string} importDir
 */
export function buildFinanceImportPlan(importDir) {
  const combinedPath = resolveFile(
    importDir,
    'Finance cash.xlsx',
    'Cash book.xlsx',
    'Cash.xlsx',
    'Treasury pack.xlsx',
    'Finance import.xlsx'
  );

  /** @type {import('xlsx').WorkBook | null} */
  let wb = combinedPath ? readWorkbook(combinedPath) : null;

  const loadRows = (patterns, fileCandidates, sheetFallback = '') => {
    if (wb) {
      const sn = findSheetName(wb.SheetNames, patterns);
      if (sn) return { rows: sheetRows(wb, sn), source: `${path.basename(combinedPath)} · ${sn}` };
    }
    const fp = resolveFile(importDir, ...fileCandidates);
    if (!fp) return { rows: [], source: '' };
    const one = readWorkbook(fp);
    const sn = sheetFallback
      ? one.SheetNames.find((s) => s.toLowerCase().includes(sheetFallback.toLowerCase())) || one.SheetNames[0]
      : one.SheetNames[0];
    return { rows: sheetRows(one, sn), source: `${path.basename(fp)} · ${sn}` };
  };

  const accounts = loadRows(
    ['accounts', 'treasury', 'cash account', 'bank account'],
    ['Cash accounts.xlsx', 'Treasury accounts.xlsx', 'Accounts.xlsx'],
    'account'
  );
  const suppliers = loadRows(
    ['supplier'],
    ['Suppliers.xlsx', 'Supplier.xlsx', 'Supplier list.xlsx'],
    'supplier'
  );
  const receiptRoute = loadRows(
    ['receipt rout', 'receipt treas', 'receipt account', 'cash receipt'],
    ['Receipt treasury.xlsx', 'Receipt accounts.xlsx', 'Receipt cash.xlsx'],
    'receipt'
  );
  const expenses = loadRows(['expense'], ['Expenses import.xlsx', 'Expenses.xlsx', 'Expense.xlsx'], 'expense');
  const purchases = loadRows(
    ['purchas', 'supplier pay', 'payment', 'po pay'],
    ['Purchases import.xlsx', 'Supplier payments.xlsx', 'Purchase payments.xlsx'],
    'purch'
  );

  return {
    combinedPath,
    accounts,
    suppliers,
    receiptRoute,
    expenses,
    purchases,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof buildFinanceImportPlan>} plan
 * @param {string} branchId
 * @param {{ defaultTreasuryAccountId?: number }} opts
 */
export function runFinanceImport(db, plan, branchId, opts = {}) {
  const defaultTid = Number(opts.defaultTreasuryAccountId) || 0;
  const stats = {
    treasuryAccountsUpserted: 0,
    openingMovements: 0,
    suppliersUpserted: 0,
    receiptTreasuryLinked: 0,
    receiptTreasurySkipped: 0,
    expensesCreated: 0,
    purchasesCreated: 0,
    defaultReceiptBackfill: 0,
  };

  /** @type {Map<string, number>} */
  const accountKeyToId = new Map();

  const zimpKey = (raw) => {
    const s = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '');
    return s || `row-${accountKeyToId.size}`;
  };

  // --- Treasury accounts (acc_no = ZIMP:<key> for stable re-import) ---
  const insTa = db.prepare(`
    INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no)
    VALUES (?,?,?,?,?)
  `);
  const selTa = db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = ?`);
  const updTa = db.prepare(`UPDATE treasury_accounts SET name = ?, bank_name = ?, type = ? WHERE id = ?`);

  for (const row of plan.accounts.rows) {
    const key = zimpKey(pick(row, ['AccountKey', 'AccountCode', 'Code', 'Key', 'ID']));
    const name = String(pick(row, ['Name', 'AccountName', 'Title']) || key).trim() || key;
    const bankName = String(pick(row, ['BankName', 'Bank', 'Bank name']) || '').trim();
    let typ = String(pick(row, ['Type', 'AccountType']) || 'Bank').trim();
    if (/cash/i.test(typ)) typ = 'Cash';
    else typ = 'Bank';
    const opening = intMoney(pick(row, ['OpeningBalance', 'Opening', 'Balance', 'Opening balance NGN']));
    const accNo = `ZIMP:${key}`;

    let id = selTa.get(accNo)?.id;
    if (id == null) {
      insTa.run(name, bankName, 0, typ, accNo);
      id = Number(db.prepare(`SELECT last_insert_rowid() AS id`).get().id);
      if (opening > 0) {
        insertTreasuryMovementTx(db, {
          type: 'INTERNAL_TRANSFER_IN',
          treasuryAccountId: id,
          amountNgn: opening,
          postedAtISO: `${isoDate(pick(row, ['OpeningDate', 'AsOf', 'Date']) || new Date().toISOString().slice(0, 10))}T12:00:00.000Z`,
          reference: 'Opening balance (import)',
          sourceKind: 'IMPORT_FINANCE',
          sourceId: `OPEN-${accNo}`,
          note: 'Finance pack import',
          createdBy: 'import-finance',
        });
        stats.openingMovements += 1;
      }
    } else {
      updTa.run(name, bankName, typ, id);
    }
    accountKeyToId.set(key, id);
    accountKeyToId.set(String(pick(row, ['AccountKey', 'AccountCode', 'Code', 'Key', 'ID'])).trim().toLowerCase(), id);
    stats.treasuryAccountsUpserted += 1;
  }

  function resolveTreasuryId(accountKeyRaw) {
    const raw = String(accountKeyRaw ?? '').trim();
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && String(n) === raw) {
      const row = db.prepare(`SELECT id FROM treasury_accounts WHERE id = ?`).get(n);
      if (row) return n;
    }
    const k = zimpKey(raw);
    if (accountKeyToId.has(k)) return accountKeyToId.get(k);
    const low = raw.toLowerCase();
    if (accountKeyToId.has(low)) return accountKeyToId.get(low);
    const byName = db
      .prepare(`SELECT id FROM treasury_accounts WHERE LOWER(TRIM(name)) = ? LIMIT 1`)
      .get(low);
    return byName ? Number(byName.id) : null;
  }

  // --- Suppliers ---
  const upsertSup = db.prepare(`
    INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id, supplier_profile_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(supplier_id) DO UPDATE SET
      name = excluded.name,
      city = excluded.city,
      payment_terms = excluded.payment_terms,
      quality_score = excluded.quality_score,
      notes = excluded.notes,
      branch_id = excluded.branch_id
  `);

  for (let si = 0; si < plan.suppliers.rows.length; si++) {
    const row = plan.suppliers.rows[si];
    const legacy = String(pick(row, ['SupplierID', 'SupplierId', 'ID', 'Code']) || '').trim();
    const name = String(
      pick(row, [
        'Name',
        'SupplierName',
        'CompanyName',
        'Supplier',
        'Supplier name',
        'Company',
        'Vendor',
        'Business name',
      ]) || ''
    ).trim();
    if (!name) continue;
    const sid = legacy
      ? legacy.toUpperCase().startsWith('SUP-')
        ? legacy
        : `SUP-LEGACY-${legacy}`
      : `SUP-LEGACY-N${crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 12)}`;
    upsertSup.run(
      sid,
      name,
      String(pick(row, ['City', 'Location', 'Address']) || '').trim(),
      String(pick(row, ['PaymentTerms', 'Terms']) || 'Credit').trim(),
      Number(pick(row, ['QualityScore', 'Score']) || 80) || 80,
      String(pick(row, ['Notes', 'Note', 'Remark', 'Discription', 'Description']) || '').trim(),
      branchId,
      null
    );
    stats.suppliersUpserted += 1;
  }

  // --- Receipt → treasury (per-row routing) ---
  const hasTm = db.prepare(`SELECT 1 FROM treasury_movements WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ?`);

  for (const row of plan.receiptRoute.rows) {
    const rid = String(pick(row, ['ReceiptID', 'ReceiptId', 'RecieptID', 'Receipt']) || '').trim();
    if (!rid) continue;
    const leId = rid.toUpperCase().startsWith('LE-') ? rid : `LE-LEGACY-R${rid}`;
    const ledger = db.prepare(`SELECT * FROM ledger_entries WHERE id = ? AND type = 'RECEIPT'`).get(leId);
    if (!ledger) {
      stats.receiptTreasurySkipped += 1;
      continue;
    }
    if (hasTm.get(leId)) {
      stats.receiptTreasurySkipped += 1;
      continue;
    }
    const tid = resolveTreasuryId(pick(row, ['AccountKey', 'TreasuryAccount', 'Account', 'Bank']));
    if (!tid) {
      stats.receiptTreasurySkipped += 1;
      continue;
    }
    const amt = Math.round(Number(ledger.amount_ngn) || 0);
    if (amt <= 0) continue;
    const dateISO = String(ledger.at_iso || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    recordCustomerReceiptCash(db, {
      sourceId: leId,
      customerID: ledger.customer_id,
      customerName: ledger.customer_name || '',
      dateISO,
      reference: String(ledger.quotation_ref || '').trim() || leId,
      note: `Imported receipt routing · ${String(ledger.payment_method || '').trim() || '—'}`,
      paymentLines: [{ treasuryAccountId: tid, amountNgn: amt, reference: leId }],
      createdBy: 'import-finance',
    });
    stats.receiptTreasuryLinked += 1;
  }

  // --- Default backfill for legacy receipts still without treasury lines ---
  if (defaultTid > 0) {
    const rows = db
      .prepare(
        `SELECT le.id, le.at_iso, le.customer_id, le.customer_name, le.amount_ngn, le.quotation_ref, le.payment_method
         FROM ledger_entries le
         WHERE le.type = 'RECEIPT' AND le.id LIKE 'LE-LEGACY-R%'
         AND NOT EXISTS (SELECT 1 FROM treasury_movements tm WHERE tm.source_kind = 'LEDGER_RECEIPT' AND tm.source_id = le.id)`
      )
      .all();
    for (const ledger of rows) {
      const amt = Math.round(Number(ledger.amount_ngn) || 0);
      if (amt <= 0) continue;
      const dateISO = String(ledger.at_iso || '').slice(0, 10);
      recordCustomerReceiptCash(db, {
        sourceId: ledger.id,
        customerID: ledger.customer_id,
        customerName: ledger.customer_name || '',
        dateISO,
        reference: String(ledger.quotation_ref || '').trim() || ledger.id,
        note: `Default account backfill · ${String(ledger.payment_method || '').trim() || '—'}`,
        paymentLines: [{ treasuryAccountId: defaultTid, amountNgn: amt, reference: ledger.id }],
        createdBy: 'import-finance',
      });
      stats.defaultReceiptBackfill += 1;
    }
  }

  // --- Expenses (+ treasury outflow) ---
  for (let i = 0; i < plan.expenses.rows.length; i++) {
    const row = plan.expenses.rows[i];
    const amt = intMoney(pick(row, ['Amount', 'AmountNgn', 'Value']));
    if (amt <= 0) continue;
    const catRaw = String(pick(row, ['Category', 'Type', 'ExpenseType']) || '').trim();
    const category = mapLegacyExpenseCategoryToCanonical(catRaw);
    const date = isoDate(pick(row, ['Date', 'ExpenseDate', 'Posted']));
    const eid = String(pick(row, ['ExpenseID', 'ID']) || '').trim() || `EXP-LEGACY-${branchId}-${i + 1}`;
    if (db.prepare(`SELECT 1 FROM expenses WHERE expense_id = ?`).get(eid)) continue;
    const tid = resolveTreasuryId(pick(row, ['AccountKey', 'TreasuryAccount', 'Account', 'PaidFrom']));
    const r = insertExpenseEntry(
      db,
      {
        expenseID: eid,
        category,
        amountNgn: amt,
        date,
        reference: String(pick(row, ['Reference', 'Ref', 'Narration']) || eid).trim(),
        expenseType: String(pick(row, ['Description', 'Detail', 'Memo']) || catRaw).trim(),
        paymentMethod: String(pick(row, ['PaymentMethod', 'Method']) || 'Import').trim(),
        treasuryAccountId: tid || undefined,
        createdBy: 'import-finance',
        actor: null,
      },
      branchId
    );
    if (r.ok) stats.expensesCreated += 1;
  }

  // --- Purchases: minimal PO + supplier payment ---
  ensureLegacyCoilProduct(db, branchId);
  for (let i = 0; i < plan.purchases.rows.length; i++) {
    const row = plan.purchases.rows[i];
    const amt = intMoney(pick(row, ['Amount', 'AmountNgn', 'Paid', 'Payment']));
    if (amt <= 0) continue;
    const payId = String(pick(row, ['PaymentID', 'ID', 'PO', 'Reference']) || '').trim() || `P${i + 1}`;
    const poId = payId.toUpperCase().startsWith('PO-') ? payId : `PO-LEGACY-${payId.replace(/[^a-z0-9_-]/gi, '')}`;
    if (db.prepare(`SELECT 1 FROM purchase_orders WHERE po_id = ?`).get(poId)) continue;

    const supLegacy = String(pick(row, ['SupplierID', 'SupplierId']) || '').trim();
    const supName = String(pick(row, ['SupplierName', 'Supplier', 'Vendor']) || '').trim();
    let supplierId = supLegacy
      ? supLegacy.toUpperCase().startsWith('SUP-')
        ? supLegacy
        : `SUP-LEGACY-${supLegacy}`
      : '';
    if (!supplierId && supName) {
      const hit = db.prepare(`SELECT supplier_id FROM suppliers WHERE branch_id = ? AND LOWER(TRIM(name)) = ?`).get(branchId, supName.toLowerCase());
      supplierId = hit?.supplier_id || '';
    }
    if (!supplierId) {
      supplierId = `SUP-LEGACY-${(supName || 'unknown').slice(0, 20).replace(/\W/g, '-') || 'x'}-${i}`;
      if (!db.prepare(`SELECT 1 FROM suppliers WHERE supplier_id = ?`).get(supplierId)) {
        db.prepare(
          `INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id, supplier_profile_json) VALUES (?,?,?,?,?,?,?,?)`
        ).run(supplierId, supName || supplierId, '', 'Credit', 80, 'Auto-created from purchase import', branchId, null);
      }
    }

    const supRow = db.prepare(`SELECT name FROM suppliers WHERE supplier_id = ?`).get(supplierId);
    const supplierName = supRow?.name || supName || supplierId;
    const orderDate = isoDate(pick(row, ['Date', 'PaymentDate', 'OrderDate']));
    const tid = resolveTreasuryId(pick(row, ['AccountKey', 'TreasuryAccount', 'Account', 'PaidFrom']));
    if (!tid) continue;

    insertPurchaseOrder(
      db,
      {
        poID: poId,
        supplierID: supplierId,
        supplierName,
        orderDateISO: orderDate,
        expectedDeliveryISO: '',
        status: 'Delivered',
        lines: [
          {
            lineKey: 'L1',
            productID: 'PRD-LEGACY-COIL',
            productName: 'Legacy import (summary line)',
            qtyOrdered: 1,
            unitPriceNgn: amt,
            qtyReceived: 1,
          },
        ],
      },
      branchId
    );

    recordSupplierPayment(db, poId, amt, String(pick(row, ['Note', 'Description']) || 'Import').trim(), {
      treasuryAccountId: tid,
      dateISO: `${orderDate}T12:00:00.000Z`,
      reference: String(pick(row, ['InvoiceNo', 'Invoice', 'Reference']) || poId).trim(),
      createdBy: 'import-finance',
      actor: null,
    });
    stats.purchasesCreated += 1;
  }

  return stats;
}

function main() {
  const args = parseArgs(process.argv);
  const plan = buildFinanceImportPlan(args.dir);
  const hasAny =
    plan.accounts.rows.length +
      plan.suppliers.rows.length +
      plan.receiptRoute.rows.length +
      plan.expenses.rows.length +
      plan.purchases.rows.length >
    0;

  console.log('Finance / cash import plan');
  console.log('  combined workbook:', plan.combinedPath || '(none)');
  console.log('  accounts:', plan.accounts.rows.length, plan.accounts.source ? `← ${plan.accounts.source}` : '');
  console.log('  suppliers:', plan.suppliers.rows.length, plan.suppliers.source ? `← ${plan.suppliers.source}` : '');
  console.log('  receipt routing rows:', plan.receiptRoute.rows.length, plan.receiptRoute.source ? `← ${plan.receiptRoute.source}` : '');
  console.log('  expenses:', plan.expenses.rows.length, plan.expenses.source ? `← ${plan.expenses.source}` : '');
  console.log('  purchases / payments:', plan.purchases.rows.length, plan.purchases.source ? `← ${plan.purchases.source}` : '');
  console.log('  DB:', args.dbPath);
  console.log('  branch:', args.branchId);
  console.log('  default treasury id (receipt backfill):', args.defaultTreasuryAccountId || '(off)');
  console.log('  dryRun:', args.dryRun);

  if (!hasAny && !args.defaultTreasuryAccountId) {
    console.error('\nNo finance sheets found and no --default-treasury-account-id. Add Excel files to', args.dir);
    console.error('See header comment in server/importAccessFinancePack.mjs for layout.');
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('\nDry run only — no writes.');
    process.exit(0);
  }

  if (!fs.existsSync(path.dirname(args.dbPath))) {
    fs.mkdirSync(path.dirname(args.dbPath), { recursive: true });
  }

  const db = openDb(args.dbPath, false);
  if (!db) {
    console.error('Failed to open database');
    process.exit(1);
  }

  try {
    const stats = db.transaction(() => runFinanceImport(db, plan, args.branchId, { defaultTreasuryAccountId: args.defaultTreasuryAccountId }))();
    console.log('\nFinance import finished.', stats);
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry && import.meta.url === entry) {
  main();
}
