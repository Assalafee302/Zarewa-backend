/**
 * Human-readable document ids: PREFIX-BRANCHCODE-YY-NNNN (or PREFIX-YY-NNNN for global scopes), YY = calendar year mod 100.
 * Sequences are still scoped per full calendar year; existing ...-2026-... ids are counted when seeding the counter.
 * @param {import('better-sqlite3').Database} db
 */
import { DEFAULT_BRANCH_ID } from './branches.js';

const SAFE_TABLES = new Set([
  'ledger_entries',
  'sales_receipts',
  'quotations',
  'cutting_lists',
  'production_jobs',
  'deliveries',
  'purchase_orders',
  'customers',
  'expenses',
  'treasury_movements',
  'stock_movements',
  'coil_requests',
  'bank_reconciliation_lines',
  'customer_crm_interactions',
  'customer_refunds',
  'payment_requests',
  'gl_journal_entries',
  'gl_journal_lines',
  'audit_log',
  'approval_actions',
  'inter_branch_loans',
  'inter_branch_loan_repayments',
  'work_items',
  'work_item_decisions',
  'material_requests',
  'in_transit_loads',
  'machines',
  'maintenance_plans',
  'maintenance_work_orders',
  'maintenance_events',
  'hr_performance_reviews',
  'coil_control_events',
]);

function assertSafeTable(table) {
  if (!SAFE_TABLES.has(table)) {
    throw new Error(`humanId: disallowed table ${table}`);
  }
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ensureHumanIdSequencesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_id_sequences (
      scope TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function getBranchCodeUpper(db, branchId) {
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  if (bid === 'BR-KAD' || bid === 'BR-KD') return 'KD';
  if (bid === 'BR-YOL' || bid === 'BR-YL') return 'YL';
  if (bid === 'BR-MAI' || bid === 'BR-MDG') return 'MDG';
  try {
    const row = db.prepare(`SELECT code FROM branches WHERE id = ?`).get(bid);
    if (row?.code) {
      const c = String(row.code).trim().toUpperCase();
      if (c === 'KAD') return 'KD';
      if (c === 'YOL') return 'YL';
      if (c === 'MAI') return 'MDG';
      return c;
    }
  } catch {
    /* branches missing */
  }
  return 'HQ';
}

export function bumpHumanSerial(db, scope) {
  ensureHumanIdSequencesTable(db);
  db.prepare(
    `INSERT INTO human_id_sequences (scope, last_value) VALUES (?, 1)
     ON CONFLICT(scope) DO UPDATE SET last_value = human_id_sequences.last_value + 1`
  ).run(scope);
  const row = db.prepare(`SELECT last_value FROM human_id_sequences WHERE scope = ?`).get(scope);
  return row.last_value;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} idColumn
 * @param {RegExp[]} patterns
 */
function maxMatchFromColumn(db, table, idColumn, patterns) {
  assertSafeTable(table);
  let rows;
  try {
    rows = db.prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} IS NOT NULL`).all();
  } catch {
    return 0;
  }
  let max = 0;
  for (const row of rows) {
    const s = String(row.id ?? '');
    for (const re of patterns) {
      const m = s.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max;
}

function maxTreasuryBatchSerial(db, prefix, fullYear, yy) {
  assertSafeTable('treasury_movements');
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT batch_id AS id FROM treasury_movements
         WHERE batch_id IS NOT NULL AND TRIM(COALESCE(batch_id, '')) != ''`
      )
      .all();
  } catch {
    return 0;
  }
  const reYy = new RegExp(`^${escRe(prefix)}-${yy}-(\\d+)$`);
  const reFull = new RegExp(`^${escRe(prefix)}-${fullYear}-(\\d+)$`);
  let max = 0;
  for (const row of rows) {
    const s = String(row.id);
    let m = s.match(reYy);
    if (m) max = Math.max(max, parseInt(m[1], 10));
    m = s.match(reFull);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} prefix e.g. LE, QT
 * @param {string | null | undefined} branchId
 * @param {{ table: string, idColumn?: string, width?: number, extraPatterns?: RegExp[], global?: boolean }} opts
 */
export function allocateHumanId(db, prefix, branchId, opts) {
  const fullYear = new Date().getFullYear();
  const yy = String(fullYear).slice(-2);
  const width = opts.width ?? 4;
  const idColumn = opts.idColumn || 'id';
  const global = opts.global === true;
  const code = global ? null : getBranchCodeUpper(db, branchId);
  const scope = global ? `${prefix}||${fullYear}` : `${prefix}|${code}|${fullYear}`;
  ensureHumanIdSequencesTable(db);
  const existing = db.prepare(`SELECT last_value FROM human_id_sequences WHERE scope = ?`).get(scope);
  if (!existing) {
    const escP = escRe(prefix);
    const patterns = [];
    if (global) {
      patterns.push(new RegExp(`^${escP}-${yy}-(\\d+)$`));
      patterns.push(new RegExp(`^${escP}-${fullYear}-(\\d+)$`));
    } else {
      patterns.push(new RegExp(`^${escP}-${escRe(code)}-${yy}-(\\d+)$`));
      patterns.push(new RegExp(`^${escP}-${escRe(code)}-${fullYear}-(\\d+)$`));
      patterns.push(new RegExp(`^${escP}-${fullYear}-(\\d+)$`));
      patterns.push(new RegExp(`^${escP}-${yy}-(\\d+)$`));
    }
    if (Array.isArray(opts.extraPatterns)) {
      for (const re of opts.extraPatterns) patterns.push(re);
    }
    const max = opts.table ? maxMatchFromColumn(db, opts.table, idColumn, patterns) : 0;
    db.prepare(`INSERT INTO human_id_sequences (scope, last_value) VALUES (?, ?)`).run(scope, max);
  }
  const n = bumpHumanSerial(db, scope);
  if (global) return `${prefix}-${yy}-${String(n).padStart(width, '0')}`;
  return `${prefix}-${code}-${yy}-${String(n).padStart(width, '0')}`;
}

export function nextLedgerEntryId(db, branchId) {
  return allocateHumanId(db, 'LE', branchId, { table: 'ledger_entries', idColumn: 'id' });
}

export function nextTreasuryMovementHumanId(db, branchId) {
  return allocateHumanId(db, 'TM', branchId, { table: 'treasury_movements', idColumn: 'id' });
}

export function nextStockMovementHumanId(db) {
  return allocateHumanId(db, 'MV', null, {
    global: true,
    table: 'stock_movements',
    idColumn: 'id',
    width: 5,
  });
}

export function nextCuttingListHumanId(db, branchId) {
  return allocateHumanId(db, 'CL', branchId, { table: 'cutting_lists', idColumn: 'id' });
}

export function nextCoilControlEventHumanId(db, branchId) {
  return allocateHumanId(db, 'CCR', branchId, { table: 'coil_control_events', idColumn: 'id' });
}

export function nextQuotationHumanId(db, branchId) {
  return allocateHumanId(db, 'QT', branchId, { table: 'quotations', idColumn: 'id' });
}

export function nextProductionJobHumanId(db, branchId) {
  return allocateHumanId(db, 'PRO', branchId, { table: 'production_jobs', idColumn: 'job_id' });
}

export function nextDeliveryHumanId(db, branchId) {
  return allocateHumanId(db, 'DN', branchId, { table: 'deliveries', idColumn: 'id' });
}

export function nextPurchaseOrderHumanId(db, branchId) {
  return allocateHumanId(db, 'PO', branchId, { table: 'purchase_orders', idColumn: 'po_id' });
}

export function nextCustomerHumanId(db, branchId) {
  return allocateHumanId(db, 'CUS', branchId, {
    table: 'customers',
    idColumn: 'customer_id',
    extraPatterns: [/^CUS-(\d+)$/],
  });
}

export function nextCoilRequestHumanId(db, branchId) {
  return allocateHumanId(db, 'CR', branchId, { table: 'coil_requests', idColumn: 'id' });
}

export function nextBankReconLineHumanId(db, branchId) {
  return allocateHumanId(db, 'BKR', branchId, { table: 'bank_reconciliation_lines', idColumn: 'id' });
}

export function nextCrmInteractionHumanId(db, branchId) {
  return allocateHumanId(db, 'CRM', branchId, { table: 'customer_crm_interactions', idColumn: 'id' });
}

export function nextExpenseHumanId(db, branchId) {
  return allocateHumanId(db, 'EXP', branchId, { table: 'expenses', idColumn: 'expense_id' });
}

export function nextPaymentRequestHumanId(db, branchId) {
  return allocateHumanId(db, 'PREQ', branchId, { table: 'payment_requests', idColumn: 'request_id' });
}

export function nextRefundHumanId(db, branchId) {
  return allocateHumanId(db, 'RF', branchId, { table: 'customer_refunds', idColumn: 'refund_id' });
}

export function nextAuditLogHumanId(db) {
  return allocateHumanId(db, 'AUD', null, {
    global: true,
    table: 'audit_log',
    idColumn: 'id',
    width: 6,
  });
}

export function nextApprovalActionHumanId(db) {
  return allocateHumanId(db, 'APR', null, {
    global: true,
    table: 'approval_actions',
    idColumn: 'id',
    width: 6,
  });
}

export function nextWorkItemHumanId(db, branchId) {
  return allocateHumanId(db, 'WI', branchId, { table: 'work_items', idColumn: 'id' });
}

export function nextWorkItemDecisionHumanId(db) {
  return allocateHumanId(db, 'WID', null, {
    global: true,
    table: 'work_item_decisions',
    idColumn: 'id',
    width: 5,
  });
}

export function nextMaterialRequestHumanId(db, branchId) {
  return allocateHumanId(db, 'MR', branchId, { table: 'material_requests', idColumn: 'id' });
}

export function nextInTransitLoadHumanId(db, branchId) {
  return allocateHumanId(db, 'MT', branchId, { table: 'in_transit_loads', idColumn: 'id' });
}

export function nextMachineHumanId(db, branchId) {
  return allocateHumanId(db, 'MAC', branchId, { table: 'machines', idColumn: 'id' });
}

export function nextMaintenancePlanHumanId(db, branchId) {
  return allocateHumanId(db, 'MPL', branchId, { table: 'maintenance_plans', idColumn: 'id' });
}

export function nextMaintenanceWorkOrderHumanId(db, branchId) {
  return allocateHumanId(db, 'MWO', branchId, { table: 'maintenance_work_orders', idColumn: 'id' });
}

export function nextMaintenanceEventHumanId(db, branchId) {
  return allocateHumanId(db, 'MEV', branchId, { table: 'maintenance_events', idColumn: 'id' });
}

export function nextHrPerformanceReviewHumanId(db, branchId) {
  return allocateHumanId(db, 'PRV', branchId, { table: 'hr_performance_reviews', idColumn: 'id' });
}

export function nextGlJournalHumanId(db, branchId) {
  return allocateHumanId(db, 'JE', branchId, { table: 'gl_journal_entries', idColumn: 'id' });
}

export function nextGlJournalLineHumanId(db, branchId) {
  return allocateHumanId(db, 'JL', branchId, { table: 'gl_journal_lines', idColumn: 'id' });
}

/** Shared batch id for paired treasury transfer legs. */
export function nextInterBranchLoanHumanId(db) {
  return allocateHumanId(db, 'IBL', null, {
    global: true,
    table: 'inter_branch_loans',
    idColumn: 'loan_id',
    width: 5,
  });
}

export function nextInterBranchLoanRepaymentHumanId(db) {
  return allocateHumanId(db, 'IBLR', null, {
    global: true,
    table: 'inter_branch_loan_repayments',
    idColumn: 'id',
    width: 5,
  });
}

export function nextTreasuryTransferBatchHumanId(db) {
  const fullYear = new Date().getFullYear();
  const yy = String(fullYear).slice(-2);
  const prefix = 'TR';
  const scope = `${prefix}||${fullYear}`;
  ensureHumanIdSequencesTable(db);
  const existing = db.prepare(`SELECT last_value FROM human_id_sequences WHERE scope = ?`).get(scope);
  if (!existing) {
    const max = maxTreasuryBatchSerial(db, prefix, fullYear, yy);
    db.prepare(`INSERT INTO human_id_sequences (scope, last_value) VALUES (?, ?)`).run(scope, max);
  }
  const n = bumpHumanSerial(db, scope);
  return `${prefix}-${yy}-${String(n).padStart(5, '0')}`;
}

/** Batch id for grouped receipt / treasury postings (e.g. same customer, one sweep). */
export function nextPostingBatchHumanId(db) {
  const fullYear = new Date().getFullYear();
  const yy = String(fullYear).slice(-2);
  const prefix = 'TB';
  const scope = `${prefix}||${fullYear}`;
  ensureHumanIdSequencesTable(db);
  const existing = db.prepare(`SELECT last_value FROM human_id_sequences WHERE scope = ?`).get(scope);
  if (!existing) {
    const max = maxTreasuryBatchSerial(db, prefix, fullYear, yy);
    db.prepare(`INSERT INTO human_id_sequences (scope, last_value) VALUES (?, ?)`).run(scope, max);
  }
  const n = bumpHumanSerial(db, scope);
  return `${prefix}-${yy}-${String(n).padStart(4, '0')}`;
}
