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
import { DEFAULT_BRANCH_ID } from './branches.js';
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
  return '';
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

/**
 * @returns {Buffer}
 */
export function buildExpenseImportTemplateXlsx() {
  const examples = [
    [
      '2026-07-01',
      45000,
      'Fuel & lubricant',
      'Main Cash',
      'PETROL-JUL-01',
      'Cash',
      'Diesel for generator — Kaduna yard',
      'EXP-IMPORT-SAMPLE-1',
    ],
    [
      '2026-07-03',
      125000,
      'Maintenance',
      'GTB Ops',
      'INV-MECH-882',
      'Transfer',
      'Corrugator bearing replacement',
      'EXP-IMPORT-SAMPLE-2',
    ],
    [
      '2026-07-05',
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
    ['Date — YYYY-MM-DD preferred (incomplete dates can be fixed in preview)'],
    ['Amount — NGN (blank/zero rows must be updated in preview before post)'],
    ['Category — use a value from the Categories sheet'],
    ['AccountKey — treasury account name/id on the same branch'],
    ['Reference — voucher / invoice ref'],
    ['PaymentMethod — Cash, Transfer, etc.'],
    ['Description — memo (Others category needs at least 40 characters)'],
    ['ExpenseID — optional stable id; skipped if already present'],
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
        date: isoDate(pick(row, ['Date', 'ExpenseDate', 'Posted'])),
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
    return {
      row: Number(r.row) || i + 2,
      include: r.include !== false && r.include !== 0 && r.include !== '0',
      date: isoDate(r.date),
      amountNgn: intMoney(r.amountNgn ?? r.amount),
      category,
      categoryRaw: catRaw,
      accountKey,
      treasuryAccountId,
      reference: String(r.reference ?? '').trim(),
      paymentMethod: String(r.paymentMethod ?? '').trim() || 'Import',
      description: String(r.description ?? '').trim(),
      expenseID: String(r.expenseID ?? r.expenseId ?? '').trim(),
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof normalizeExpenseImportRows>[number]} row
 * @param {object|null} actor
 * @param {{ requireTreasury?: boolean, branchId?: string }} [opts]
 */
function validateImportRow(db, row, actor, opts = {}) {
  const errors = [];
  const missingFields = [];
  const warnings = [];
  if (!row.include) {
    return { errors, warnings, missingFields, treasuryAccountId: null, needsUpdate: false };
  }

  const bid = String(opts.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  if (!row.date) {
    missingFields.push('date');
    errors.push('Update date in the preview (YYYY-MM-DD).');
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
  if (row.treasuryAccountId != null && Number.isFinite(Number(row.treasuryAccountId))) {
    const id = Number(row.treasuryAccountId);
    const resolved = resolveTreasuryAccountId(db, id, bid);
    if (!resolved.id) {
      missingFields.push('treasury');
      errors.push(resolved.error || `Update treasury account in the preview (#${id}).`);
    } else {
      treasuryAccountId = resolved.id;
    }
  } else if (row.accountKey) {
    const resolved = resolveTreasuryAccountId(db, row.accountKey, bid);
    if (!resolved.id) {
      missingFields.push('treasury');
      errors.push(resolved.error || `Update treasury account in the preview for "${row.accountKey}".`);
    } else {
      treasuryAccountId = resolved.id;
    }
  } else if (opts.requireTreasury) {
    missingFields.push('treasury');
    errors.push('Update treasury account in the preview (required for this import).');
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
 * @param {{ requireTreasury?: boolean, branchId?: string }} [opts]
 */
export function previewExpenseBulkImport(db, rows, actor, opts = {}) {
  const branchId = String(opts.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
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

  let message = '';
  if (needsUpdateCount > 0) {
    message = `${needsUpdateCount} row(s) need updates in the preview before you can post (missing or invalid fields).`;
  } else if (valid.length) {
    message = `${valid.length} row(s) ready to post to branch ${branchId}.`;
  }

  return {
    ok: true,
    branchId,
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
 * @param {{ workspaceViewAll?: boolean, requireTreasury?: boolean }} [opts]
 */
export function commitExpenseBulkImport(db, actor, rows, branchId = DEFAULT_BRANCH_ID, opts = {}) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const preview = previewExpenseBulkImport(db, rows, actor, { ...opts, branchId: bid });
  if (!preview.validCount) {
    return {
      ok: false,
      error:
        preview.needsUpdateCount > 0
          ? preview.message || 'Update incomplete rows in the preview before posting.'
          : 'No valid rows to import. Fix errors in the preview first.',
      preview,
    };
  }
  if (preview.incompleteCount > 0 || preview.invalidCount > 0 || preview.needsUpdateCount > 0) {
    return {
      ok: false,
      error:
        preview.message ||
        `${preview.needsUpdateCount || preview.incompleteCount + preview.invalidCount} row(s) still need updates in the preview. Fix or uncheck them before posting.`,
      preview,
    };
  }

  const created = [];
  const failed = [];

  const run = db.transaction(() => {
    for (const row of preview.previewTable) {
      if (!row.include || row.status !== 'ok') continue;
      const r = insertExpenseEntry(
        db,
        {
          expenseID: row.expenseID || undefined,
          category: row.category,
          amountNgn: row.amountNgn,
          date: row.date,
          reference: row.reference || row.expenseID || `IMPORT-${row.row}`,
          expenseType: row.description || row.category,
          paymentMethod: row.paymentMethod || 'Import',
          treasuryAccountId: row.treasuryAccountId || undefined,
          categoryJustification: row.description || row.reference || '',
          createdBy: actor?.displayName || actor?.username || 'expense-import',
          actor,
          workspaceViewAll: Boolean(opts.workspaceViewAll),
        },
        bid
      );
      if (r.ok) {
        created.push({
          row: row.row,
          expenseID: r.expenseID,
          date: row.date,
          amountNgn: row.amountNgn,
          category: row.category,
          reference: row.reference || '',
          paymentMethod: row.paymentMethod || 'Import',
          description: row.description || '',
          treasuryAccountId: row.treasuryAccountId || null,
        });
      } else {
        failed.push({ row: row.row, error: r.error || 'Could not create expense.' });
        throw new Error(r.error || `Row ${row.row} failed.`);
      }
    }
  });

  try {
    run();
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || 'Import failed.'),
      createdCount: 0,
      failed,
      preview,
    };
  }

  return {
    ok: true,
    branchId: bid,
    createdCount: created.length,
    created,
    totalAmountNgn: preview.totalAmountNgn,
    preview,
  };
}
