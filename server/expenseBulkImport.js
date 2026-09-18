/**
 * Bulk expense import — Excel template, preview, and commit (editable preview rows).
 * Used by HTTP /api/expenses/import/* and the docs/import template builder.
 */
import XLSX from 'xlsx';
import {
  EXPENSE_CATEGORY_OPTIONS,
  mapLegacyExpenseCategoryToCanonical,
  isAllowedExpenseCategory,
} from '../shared/expenseCategories.js';
import { validateExpenseCategorySelection } from '../shared/expenseCategoryPolicy.js';
import { userHasPermission } from './auth.js';
import { insertExpenseEntry } from './writeOps.js';
import { DEFAULT_BRANCH_ID, requireExplicitBranchId } from './branches.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';

export const EXPENSE_IMPORT_HEADERS = Object.freeze([
  'Date',
  'Amount',
  'Category',
  'AccountKey',
  'Reference',
  'PaymentMethod',
  'Description',
  'ExpenseID',
]);

const MAX_IMPORT_ROWS = 500;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse workbook/UI dates to YYYY-MM-DD.
 * Never defaults to today — blank stays blank so the user can set last-month dates in preview.
 * @param {unknown} v
 * @returns {string}
 */
export function parseExpenseImportDate(v) {
  if (v instanceof Date && !Number.isNaN(+v)) {
    // Use local calendar parts so a Nigeria midnight Date is not shifted back by toISOString() UTC.
    return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial day count → UTC y/m/d
    const utc = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(utc);
    if (!Number.isNaN(+d)) return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Nigerian / UK style DD/MM/YYYY (or DD-MM-YYYY)
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const year = Number(dmy[3]);
    let day = a;
    let month = b;
    // If first part > 12, it must be day (DMY). If second > 12, treat as MDY.
    if (a <= 12 && b > 12) {
      month = a;
      day = b;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return ymd(year, month, day);
    }
  }

  return '';
}

function intMoney(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[₦#,]/g, '').trim()) || 0);
  return Number.isFinite(n) ? n : 0;
}

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return row[k];
    const hit = Object.keys(row).find(
      (rk) => rk.toLowerCase().replace(/\s+/g, '') === k.toLowerCase().replace(/\s+/g, '')
    );
    if (hit != null && String(row[hit]).trim() !== '') return row[hit];
  }
  return '';
}

function zimpKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

/**
 * Resolve a treasury account within the workspace branch when possible.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number|null|undefined} accountKeyRaw
 * @param {string} [branchId]
 * @returns {{ id: number|null, error?: string, otherBranch?: boolean }}
 */
export function resolveTreasuryAccountId(db, accountKeyRaw, branchId = '') {
  const raw = String(accountKeyRaw ?? '').trim();
  if (!raw) return { id: null };
  const bid = String(branchId || '').trim();
  const hasBranch = hasColumn(db, 'treasury_accounts', 'branch_id');
  const branchSql = hasBranch && bid ? ` AND (TRIM(COALESCE(branch_id,'')) = ? OR TRIM(COALESCE(branch_id,'')) = '')` : '';
  const branchArgs = hasBranch && bid ? [bid] : [];

  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && String(n) === raw) {
    const row = db.prepare(`SELECT id, branch_id FROM treasury_accounts WHERE id = ?`).get(n);
    if (!row) return { id: null, error: `Treasury account #${n} not found.` };
    if (hasBranch && bid) {
      const rowBid = String(row.branch_id || '').trim();
      if (rowBid && rowBid !== bid) {
        return {
          id: null,
          otherBranch: true,
          error: `Treasury account #${n} belongs to another branch — pick an account for this workspace branch.`,
        };
      }
    }
    return { id: n };
  }

  const byAcc = db
    .prepare(`SELECT id FROM treasury_accounts WHERE LOWER(TRIM(acc_no)) = ?${branchSql} LIMIT 1`)
    .get(`zimp:${zimpKey(raw)}`, ...branchArgs);
  if (byAcc) return { id: Number(byAcc.id) };

  const byName = db
    .prepare(`SELECT id FROM treasury_accounts WHERE LOWER(TRIM(name)) = ?${branchSql} LIMIT 1`)
    .get(raw.toLowerCase(), ...branchArgs);
  if (byName) return { id: Number(byName.id) };

  const byBank = db
    .prepare(`SELECT id FROM treasury_accounts WHERE LOWER(TRIM(bank_name)) = ?${branchSql} LIMIT 1`)
    .get(raw.toLowerCase(), ...branchArgs);
  if (byBank) return { id: Number(byBank.id) };

  if (hasBranch && bid) {
    const elsewhere = db
      .prepare(
        `SELECT id, branch_id FROM treasury_accounts
         WHERE LOWER(TRIM(name)) = ? OR LOWER(TRIM(acc_no)) = ?
         LIMIT 1`
      )
      .get(raw.toLowerCase(), `zimp:${zimpKey(raw)}`);
    if (elsewhere) {
      return {
        id: null,
        otherBranch: true,
        error: `Account "${raw}" is on another branch — choose a treasury account for this workspace branch.`,
      };
    }
  }

  return { id: null, error: `Treasury account not found for "${raw}" on this branch.` };
}

function isCashTreasuryType(row) {
  return String(row?.type || '').trim().toLowerCase() === 'cash';
}

/**
 * Cash/bank accounts the cashier desk can post against on this workspace branch.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchId]
 */
export function listBranchTreasuryAccountsForImport(db, branchId = '') {
  const bid = String(branchId || '').trim();
  const hasBranch = hasColumn(db, 'treasury_accounts', 'branch_id');
  const sql = `SELECT id, name, type, bank_name, acc_no, balance, branch_id FROM treasury_accounts`;
  if (!hasBranch || !bid) {
    return db.prepare(`${sql} ORDER BY id`).all();
  }
  return db
    .prepare(
      `${sql}
       WHERE branch_id = ?
          OR (TRIM(COALESCE(branch_id, '')) = '' AND ? = ?)
       ORDER BY id`
    )
    .all(bid, bid, DEFAULT_BRANCH_ID);
}

/**
 * Pick the cashier book when AccountKey is blank: the only account, else the account with the latest movement (the desk they are using), else Cash/till, else the largest balance.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchId]
 * @returns {{ id: number|null, account?: object, auto?: boolean, error?: string, accounts?: object[] }}
 */
export function resolveDefaultBranchTreasuryAccount(db, branchId = '') {
  const accounts = listBranchTreasuryAccountsForImport(db, branchId);
  if (!accounts.length) {
    return {
      id: null,
      accounts,
      error: 'This branch has no cash or bank account. Add the till on Cashier desk, then import again.',
    };
  }
  if (accounts.length === 1) {
    return { id: Number(accounts[0].id), account: accounts[0], auto: true };
  }

  const ids = accounts.map((a) => Number(a.id)).filter((n) => n > 0);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const last = db
      .prepare(
        `SELECT treasury_account_id AS id
         FROM treasury_movements
         WHERE treasury_account_id IN (${placeholders})
         ORDER BY posted_at_iso DESC, id DESC
         LIMIT 1`
      )
      .get(...ids);
    const active = last?.id
      ? accounts.find((a) => Number(a.id) === Number(last.id))
      : null;
    if (active) {
      return { id: Number(active.id), account: active, auto: true };
    }
  }

  const cash = accounts.filter(isCashTreasuryType);
  if (cash.length === 1) {
    return { id: Number(cash[0].id), account: cash[0], auto: true };
  }
  if (cash.length > 1) {
    const namedTill = cash.find((a) => /till|cash office|cashier/i.test(String(a.name || '')));
    if (namedTill) {
      return { id: Number(namedTill.id), account: namedTill, auto: true };
    }
  }

  const richest = [...accounts].sort(
    (a, b) => Number(b.balance || 0) - Number(a.balance || 0)
  )[0];
  return { id: Number(richest.id), account: richest, auto: true };
}

/**
 * Row AccountKey wins; otherwise the request paid-from account; otherwise the branch cash till.
 * @param {import('better-sqlite3').Database} db
 * @param {{ treasuryAccountId?: number|null, accountKey?: string }} row
 * @param {string} branchId
 * @param {{ requireTreasury?: boolean, defaultTreasuryAccountId?: number|string, accountKey?: string }} [opts]
 */
export function resolveImportRowTreasury(db, row, branchId, opts = {}) {
  const rowTid = Number(row.treasuryAccountId);
  if (Number.isFinite(rowTid) && rowTid > 0) {
    return resolveTreasuryAccountId(db, rowTid, branchId);
  }
  if (row.accountKey) {
    return resolveTreasuryAccountId(db, row.accountKey, branchId);
  }
  const defaultTid = Number(opts.defaultTreasuryAccountId);
  if (Number.isFinite(defaultTid) && defaultTid > 0) {
    return resolveTreasuryAccountId(db, defaultTid, branchId);
  }
  if (opts.accountKey) {
    return resolveTreasuryAccountId(db, opts.accountKey, branchId);
  }
  if (opts.requireTreasury) {
    return resolveDefaultBranchTreasuryAccount(db, branchId);
  }
  return { id: null };
}

/**
 * @returns {Buffer}
 */
export function buildExpenseImportTemplateXlsx() {
  const examples = [
    [
      '2026-07-15',
      45000,
      'Fuel & lubricant',
      'Main Cash',
      'PETROL-JUL-15',
      'Cash',
      'Diesel for generator — Kaduna yard',
      '',
    ],
    [
      '2026-07-20',
      125000,
      'Maintenance',
      'GTB Ops',
      'INV-MECH-882',
      'Transfer',
      'Corrugator bearing replacement',
      '',
    ],
    [
      '2026-07-28',
      80000,
      'Office expenses',
      '1',
      'STATIONERY-JUL',
      'Cash',
      'Printer paper and ink',
      '',
    ],
  ];

  const expenseAoA = [EXPENSE_IMPORT_HEADERS, ...examples];
  for (let i = 0; i < 25; i += 1) expenseAoA.push(EXPENSE_IMPORT_HEADERS.map(() => ''));

  const wb = XLSX.utils.book_new();
  const expensesWs = XLSX.utils.aoa_to_sheet(expenseAoA);
  expensesWs['!cols'] = [
    { wch: 12 },
    { wch: 12 },
    { wch: 22 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 40 },
    { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(wb, expensesWs, 'Expenses');

  const catWs = XLSX.utils.aoa_to_sheet([
    ['Category (copy exactly into Expenses.Category)'],
    ...EXPENSE_CATEGORY_OPTIONS.map((c) => [c]),
  ]);
  catWs['!cols'] = [{ wch: 36 }];
  XLSX.utils.book_append_sheet(wb, catWs, 'Categories');

  const instrWs = XLSX.utils.aoa_to_sheet([
    ['Bulk expenses import — Zarewa'],
    [''],
    ['In the app: Account → Payouts & expenses → Import expenses'],
    ['1. Download this template (or use the Categories sheet as the full category list).'],
    ['2. Fill the Expenses sheet — one row per expense. Delete sample rows before a real import if you do not want them.'],
    ['3. Upload in the Import expenses room → incomplete rows are highlighted — update them in the preview → confirm → Post.'],
    ['4. Import is branch-sensitive: expenses and treasury accounts apply to your current workspace branch only.'],
    [''],
    ['CLI (optional): node server/importAccessFinancePack.mjs --dry-run --dir docs/import'],
    [''],
    ['Columns'],
    ['Date — REQUIRED. Use the real expense date (e.g. 2026-07-15 for July). Dates are NEVER auto-filled to today.'],
    ['Amount — NGN (blank/zero rows must be updated in preview before post)'],
    ['Category — use a value from the Categories sheet. Refund is allowed on this import for Finance/Admin historical catch-up (it is blocked on the regular expense form).'],
    ['AccountKey — cashier till / bank name on this branch. If you leave it blank, import uses the branch cash till (or the only account). Required when the branch has more than one cash/bank account.'],
    ['Reference — voucher / invoice ref'],
    ['PaymentMethod — Cash, Transfer, etc.'],
    ['Description — memo (Others category needs at least 40 characters)'],
    ['ExpenseID — leave blank (system assigns). Sample ids are ignored.'],
    [''],
    ['Last-month catch-up: set each row Date to a day in that month, or blank Date and use “Apply date” in the preview.'],
  ]);
  instrWs['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * @param {Buffer} buffer
 * @returns {{ ok: true, rows: object[], sheetName: string } | { ok: false, error: string }}
 */
export function parseExpenseImportWorkbook(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { ok: false, error: 'Upload a valid Excel (.xlsx) file.' };
  }
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: false });
  } catch {
    return { ok: false, error: 'Could not read Excel file. Save as .xlsx and try again.' };
  }
  const names = wb.SheetNames || [];
  if (!names.length) return { ok: false, error: 'Workbook has no sheets.' };
  const expenseSheet =
    names.find((n) => /expense/i.test(n)) ||
    names.find((n) => !/categor|instruct|readme|guide/i.test(n)) ||
    names[0];
  const sheet = wb.Sheets[expenseSheet];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rawRows.length) {
    return { ok: false, error: `Sheet "${expenseSheet}" has no data rows.` };
  }
  if (rawRows.length > MAX_IMPORT_ROWS) {
    return { ok: false, error: `Too many rows (max ${MAX_IMPORT_ROWS}). Split the file and import in batches.` };
  }

  const rows = rawRows
    .map((row, i) => {
      const amountRaw = pick(row, ['Amount', 'AmountNgn', 'Value']);
      const catRaw = String(pick(row, ['Category', 'Type', 'ExpenseType']) || '').trim();
      const category = catRaw ? mapLegacyExpenseCategoryToCanonical(catRaw) : '';
      return {
        row: i + 2,
        include: true,
        date: parseExpenseImportDate(pick(row, ['Date', 'ExpenseDate', 'Posted'])),
        amountNgn: intMoney(amountRaw),
        category,
        categoryRaw: catRaw,
        accountKey: String(pick(row, ['AccountKey', 'TreasuryAccount', 'Account', 'PaidFrom']) || '').trim(),
        reference: String(pick(row, ['Reference', 'Ref', 'Narration']) || '').trim(),
        paymentMethod: String(pick(row, ['PaymentMethod', 'Method']) || '').trim() || 'Import',
        description: String(pick(row, ['Description', 'Detail', 'Memo']) || '').trim(),
        expenseID: String(pick(row, ['ExpenseID', 'ID']) || '').trim(),
      };
    })
    .filter(
      (r) =>
        r.date ||
        r.amountNgn > 0 ||
        r.categoryRaw ||
        r.accountKey ||
        r.reference ||
        r.description ||
        r.expenseID
    );

  if (!rows.length) {
    return { ok: false, error: `Sheet "${expenseSheet}" has no expense data rows.` };
  }

  return { ok: true, rows, sheetName: expenseSheet, categories: [...EXPENSE_CATEGORY_OPTIONS] };
}

/**
 * Normalize client-edited preview rows.
 * @param {unknown[]} input
 */
export function normalizeExpenseImportRows(input) {
  if (!Array.isArray(input)) return [];
  return input.map((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const catRaw = String(r.category ?? r.categoryRaw ?? '').trim();
    const category = catRaw ? mapLegacyExpenseCategoryToCanonical(catRaw) : '';
    const treasuryRaw =
      r.treasuryAccountId != null && String(r.treasuryAccountId).trim() !== ''
        ? r.treasuryAccountId
        : '';
    const treasuryAccountId =
      treasuryRaw !== '' && Number.isFinite(Number(treasuryRaw)) ? Number(treasuryRaw) : null;
    const accountKey = String(r.accountKey ?? '').trim() || (treasuryAccountId == null ? String(treasuryRaw || '').trim() : '');
    let expenseID = String(r.expenseID ?? r.expenseId ?? '').trim();
    // Template / legacy sample ids are never stored by insertExpenseEntry; drop them so they
    // do not block re-imports via the "already exists" preview check.
    if (/^EXP-IMPORT-SAMPLE/i.test(expenseID) || /^EXP-LEGACY-/i.test(expenseID)) {
      expenseID = '';
    }
    return {
      row: Number(r.row) || i + 2,
      include: r.include !== false && r.include !== 0 && r.include !== '0',
      date: parseExpenseImportDate(r.date),
      amountNgn: intMoney(r.amountNgn ?? r.amount),
      category,
      categoryRaw: catRaw,
      accountKey,
      treasuryAccountId,
      reference: String(r.reference ?? '').trim(),
      paymentMethod: String(r.paymentMethod ?? '').trim() || 'Import',
      description: String(r.description ?? '').trim(),
      expenseID,
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof normalizeExpenseImportRows>[number]} row
 * @param {object|null} actor
 * @param {{ requireTreasury?: boolean, branchId?: string, defaultTreasuryAccountId?: number|string, accountKey?: string }} [opts]
 */
function validateImportRow(db, row, actor, opts = {}) {
  const errors = [];
  const missingFields = [];
  const warnings = [];
  if (!row.include) {
    return { errors, warnings, missingFields, treasuryAccountId: null, needsUpdate: false };
  }

  const branchCheck = requireExplicitBranchId(opts.branchId, 'expense import row');
  if (!branchCheck.ok) {
    errors.push(branchCheck.error);
    return { errors, warnings, missingFields, treasuryAccountId: null, needsUpdate: true };
  }
  const bid = branchCheck.branchId;

  if (!row.date) {
    missingFields.push('date');
    errors.push('Set the expense date in the preview (YYYY-MM-DD). It is never filled with today automatically.');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    missingFields.push('date');
    errors.push('Date must be YYYY-MM-DD (example: 2026-07-15 for July).');
  }
  if (!(row.amountNgn > 0)) {
    missingFields.push('amount');
    errors.push('Update amount in the preview (must be greater than zero).');
  }
  if (!row.category) {
    missingFields.push('category');
    errors.push('Update category in the preview — pick from the category list.');
  } else if (!isAllowedExpenseCategory(row.category)) {
    missingFields.push('category');
    errors.push('Category is not on the standard list — update it in the preview.');
  } else {
    const catCheck = validateExpenseCategorySelection({
      actor,
      category: row.category,
      amountNgn: row.amountNgn,
      description: row.description || row.reference || '',
      categoryJustification: row.description || row.reference || '',
      hasAttachment: true,
      requireAttachment: false,
      allowRevenue: true,
      hasPermission: (p) => userHasPermission(actor, p),
    });
    if (!catCheck.ok) {
      if (/explanation|justification|characters/i.test(String(catCheck.error || ''))) {
        missingFields.push('description');
      }
      errors.push(`Update in preview: ${catCheck.error || 'Category not allowed.'}`);
    }
  }

  let treasuryAccountId = null;
  const resolved = resolveImportRowTreasury(db, row, bid, opts);
  if (resolved.id) {
    treasuryAccountId = resolved.id;
    if (resolved.auto && resolved.account?.name) {
      warnings.push(
        `Will deduct from "${resolved.account.name}" on this branch (cashier till). AccountKey was blank.`
      );
    }
  } else if (opts.requireTreasury) {
    missingFields.push('treasury');
    errors.push(resolved.error || 'Update treasury account in the preview (required for this import).');
  } else {
    warnings.push('No treasury account — expense will post on this branch without cash outflow.');
  }

  if (row.expenseID) {
    const exists = db
      .prepare(`SELECT expense_id, branch_id FROM expenses WHERE expense_id = ?`)
      .get(row.expenseID);
    if (exists) {
      const existsBid = String(exists.branch_id || '').trim();
      errors.push(
        existsBid && existsBid !== bid
          ? `ExpenseID ${row.expenseID} already exists on another branch — change or clear it in the preview.`
          : `ExpenseID ${row.expenseID} already exists — skip this row or change the id in the preview.`
      );
    }
  }

  if (row.categoryRaw && row.category && row.categoryRaw !== row.category) {
    warnings.push(`Mapped "${row.categoryRaw}" → "${row.category}".`);
  }

  const needsUpdate = missingFields.length > 0 || errors.length > 0;
  return { errors, warnings, missingFields, treasuryAccountId, needsUpdate };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} rows
 * @param {object|null} actor
 * @param {{ requireTreasury?: boolean, branchId?: string, defaultTreasuryAccountId?: number|string, accountKey?: string }} [opts]
 */
export function previewExpenseBulkImport(db, rows, actor, opts = {}) {
  const branchCheck = requireExplicitBranchId(opts.branchId, 'expense import');
  if (!branchCheck.ok) return { ok: false, error: branchCheck.error };
  const branchId = branchCheck.branchId;
  const normalized = normalizeExpenseImportRows(rows);
  const previewTable = normalized.map((row) => {
    const v = validateImportRow(db, row, actor, { ...opts, branchId });
    let status = 'ok';
    if (!row.include) status = 'skipped';
    else if (v.missingFields.length) status = 'incomplete';
    else if (v.errors.length) status = 'error';
    return {
      ...row,
      treasuryAccountId: v.treasuryAccountId,
      errors: v.errors,
      warnings: v.warnings,
      missingFields: v.missingFields,
      needsUpdate: Boolean(v.needsUpdate && row.include),
      errorCount: v.errors.length,
      warningCount: v.warnings.length,
      status,
    };
  });

  const included = previewTable.filter((r) => r.include);
  const valid = included.filter((r) => r.status === 'ok');
  const incomplete = included.filter((r) => r.status === 'incomplete');
  const invalid = included.filter((r) => r.status === 'error');
  const needsUpdateCount = included.filter((r) => r.needsUpdate).length;

  const paidFrom = resolveImportRowTreasury(
    db,
    { treasuryAccountId: null, accountKey: '' },
    branchId,
    opts
  );
  let message = '';
  if (needsUpdateCount > 0) {
    message = `${needsUpdateCount} row(s) need updates in the preview before you can post (missing or invalid fields).`;
  } else if (valid.length) {
    const tillName = paidFrom.account?.name || (paidFrom.id ? `#${paidFrom.id}` : '');
    message = tillName
      ? `${valid.length} row(s) ready to post to branch ${branchId} from ${tillName}. Balance will drop and statement lines will be created.`
      : `${valid.length} row(s) ready to post to branch ${branchId}.`;
  }

  return {
    ok: true,
    branchId,
    paidFromAccountId: paidFrom.id || null,
    paidFromAccountName: paidFrom.account?.name || '',
    paidFromAccountType: paidFrom.account?.type || '',
    paidFromAutoAssigned: Boolean(paidFrom.auto),
    categories: [...EXPENSE_CATEGORY_OPTIONS],
    previewTable,
    totalRows: previewTable.length,
    includedCount: included.length,
    validCount: valid.length,
    incompleteCount: incomplete.length,
    invalidCount: invalid.length,
    needsUpdateCount,
    skippedCount: previewTable.length - included.length,
    totalAmountNgn: valid.reduce((s, r) => s + r.amountNgn, 0),
    message,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {object[]} rows
 * @param {string} branchId
 * @param {{ workspaceViewAll?: boolean, requireTreasury?: boolean, defaultTreasuryAccountId?: number|string, accountKey?: string }} [opts]
 */
export function commitExpenseBulkImport(db, actor, rows, branchId, opts = {}) {
  const branchCheck = requireExplicitBranchId(branchId, 'expense import');
  if (!branchCheck.ok) return { ok: false, error: branchCheck.error };
  const bid = branchCheck.branchId;
  // Import must hit the cashier book unless a catch-up test explicitly opts out.
  const requireTreasury = opts.requireTreasury !== false;
  const preview = previewExpenseBulkImport(db, rows, actor, { ...opts, branchId: bid, requireTreasury });
  const toPost = preview.previewTable.filter((r) => r.include && r.status === 'ok');
  if (!toPost.length) {
    return {
      ok: false,
      error:
        preview.needsUpdateCount > 0
          ? preview.message || 'Update incomplete rows in the preview before posting.'
          : 'No valid rows to import. Fix errors in the preview first.',
      preview,
    };
  }

  // Do not wrap in an outer db.transaction(): insertExpenseEntry already opens a transaction,
  // and nested MySQL SAVEPOINTs are unreliable (`SAVEPOINT sp_N does not exist`).
  const created = [];
  const failed = [];

  for (const row of toPost) {
    const expenseDate = parseExpenseImportDate(row.date);
    if (!expenseDate) {
      failed.push({
        row: row.row,
        error: 'Expense date is required (YYYY-MM-DD). Import never auto-fills today’s date.',
      });
      continue;
    }
    let treasuryAccountId = row.treasuryAccountId || null;
    if (!treasuryAccountId && requireTreasury) {
      const fallback = resolveDefaultBranchTreasuryAccount(db, bid);
      if (!fallback.id) {
        failed.push({
          row: row.row,
          error: fallback.error || 'Pick the cashier till these expenses were paid from.',
        });
        continue;
      }
      treasuryAccountId = fallback.id;
    }
    const r = insertExpenseEntry(
      db,
      {
        category: row.category,
        amountNgn: row.amountNgn,
        date: expenseDate,
        reference: row.reference || `IMPORT-${row.row}`,
        expenseType: row.description || row.category,
        paymentMethod: row.paymentMethod || 'Import',
        treasuryAccountId: treasuryAccountId || undefined,
        categoryJustification: row.description || row.reference || '',
        createdBy: actor?.displayName || actor?.username || 'expense-import',
        actor,
        workspaceViewAll: Boolean(opts.workspaceViewAll),
        allowNegativeBalance: true,
        // Historical catch-up may post Refund / contra-revenue; regular expense form cannot.
        allowRevenue: true,
      },
      bid
    );
    if (r.ok) {
      created.push({
        row: row.row,
        expenseID: r.expenseID,
        date: expenseDate,
        amountNgn: row.amountNgn,
        category: row.category,
        reference: row.reference || '',
        paymentMethod: row.paymentMethod || 'Import',
        description: row.description || '',
        treasuryAccountId: treasuryAccountId || null,
      });
    } else {
      failed.push({ row: row.row, error: r.error || 'Could not create expense.' });
    }
  }

  if (!created.length) {
    const first = failed[0]?.error || 'Import failed.';
    return {
      ok: false,
      error: failed.length > 1 ? `${first} (${failed.length} rows failed.)` : first,
      createdCount: 0,
      created: [],
      failed,
      preview,
    };
  }

  return {
    ok: true,
    branchId: bid,
    createdCount: created.length,
    created,
    failed,
    skippedIncomplete: preview.incompleteCount + preview.invalidCount,
    totalAmountNgn: created.reduce((s, r) => s + (Number(r.amountNgn) || 0), 0),
    paidFromAccountId: preview.paidFromAccountId || null,
    paidFromAccountName: preview.paidFromAccountName || '',
    preview,
    warning:
      failed.length > 0
        ? `Posted ${created.length} expense(s); ${failed.length} row(s) failed.`
        : preview.incompleteCount + preview.invalidCount > 0
          ? `Posted ${created.length} ready row(s). Incomplete/error rows were left unposted.`
          : '',
    message:
      failed.length > 0
        ? `Posted ${created.length} expense(s) to the cashier book; ${failed.length} row(s) failed.`
        : `Posted ${created.length} expense(s) to ${
            preview.paidFromAccountName || 'the cashier account'
          }. Balance reduced and statement lines created.`,
  };
}
