/**
 * One-time rewrite of timestamp-style document ids (e.g. LE-1775318268346-xsvka, CL-1775305324659-sy55)
 * to human serials (LE-KD-26-0001, CL-KD-26-0001). Safe to re-run: no-op when none match.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  ensureHumanIdSequencesTable,
  nextCuttingListHumanId,
  nextLedgerEntryId,
} from './humanId.js';

const LEGACY_BRANCH_CODE_PAIRS = [
  ['KAD', 'KD'],
  ['YOL', 'YL'],
  ['MAI', 'MDG'],
];

const DOC_PREFIXES = [
  'LE',
  'CL',
  'QT',
  'PRO',
  'DN',
  'PO',
  'TM',
  'EXP',
  'RF',
  'PREQ',
  'BKR',
  'CRM',
  'CR',
  'CUS',
];

function isLegacyLedgerId(id) {
  return /^LE-\d{10,}-[a-z0-9]+$/i.test(String(id || '').trim());
}

function isLegacyCuttingListId(id) {
  return /^CL-\d{10,}-[a-z0-9]+$/i.test(String(id || '').trim());
}

function hasTable(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function rowExists(db, sql, ...args) {
  return Boolean(db.prepare(sql).get(...args));
}

/** @param {import('better-sqlite3').Database} db */
export function needsLegacyTimestampIdMigration(db) {
  if (!hasTable(db, 'ledger_entries')) return false;
  const le = db.prepare(`SELECT id FROM ledger_entries WHERE id REGEXP '^LE-[0-9]+$' LIMIT 1`).get();
  if (le && isLegacyLedgerId(le.id)) return true;
  if (!hasTable(db, 'cutting_lists')) return false;
  const cl = db.prepare(`SELECT id FROM cutting_lists WHERE id REGEXP '^CL-[0-9]+$' LIMIT 1`).get();
  return Boolean(cl && isLegacyCuttingListId(cl.id));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} badCode
 */
function hasLegacyBranchCodePattern(db, badCode) {
  const pattern = `%-${badCode}-%`;
  const prefixPattern = `%-${badCode}-%`;
  if (
    hasTable(db, 'ledger_entries') &&
    rowExists(
      db,
      `SELECT 1 AS x FROM ledger_entries WHERE id LIKE ? OR bank_reference LIKE ? OR note LIKE ? LIMIT 1`,
      pattern,
      pattern,
      pattern
    )
  ) {
    return true;
  }
  const idTables = [
    'cutting_lists',
    'quotations',
    'sales_receipts',
    'treasury_movements',
    'purchase_orders',
    'expenses',
    'payment_requests',
    'customers',
    'production_jobs',
    'customer_refunds',
  ];
  for (const table of idTables) {
    if (!hasTable(db, table)) continue;
    const col =
      table === 'cutting_lists' || table === 'quotations'
        ? 'id'
        : table === 'purchase_orders'
          ? 'po_id'
          : table === 'expenses'
            ? 'expense_id'
            : table === 'payment_requests'
              ? 'request_id'
              : table === 'customers'
                ? 'customer_id'
                : table === 'customer_refunds'
                  ? 'refund_id'
                  : table === 'production_jobs'
                    ? 'job_id'
                    : 'id';
    if (rowExists(db, `SELECT 1 AS x FROM ${table} WHERE ${col} LIKE ? LIMIT 1`, prefixPattern)) return true;
  }
  return false;
}

/** @param {import('better-sqlite3').Database} db */
export function needsLegacyBranchCodeNormalization(db) {
  for (const [bad] of LEGACY_BRANCH_CODE_PAIRS) {
    if (hasLegacyBranchCodePattern(db, bad)) return true;
  }
  return false;
}

function runUpdateIfMatched(db, checkSql, checkArgs, updateSql, updateArgs) {
  if (!rowExists(db, checkSql, ...checkArgs)) return;
  db.prepare(updateSql).run(...updateArgs);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateTimestampStyleDocumentIds(db) {
  if (!hasTable(db, 'ledger_entries')) return;

  const needsTs = needsLegacyTimestampIdMigration(db);
  const needsBranch = needsLegacyBranchCodeNormalization(db);
  if (!needsTs && !needsBranch) return;

  ensureHumanIdSequencesTable(db);

  if (needsTs) {
    migrateLegacyTimestampIds(db);
  }
  if (needsBranch) {
    normalizeLegacyBranchCodesInHumanIds(db);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function migrateLegacyTimestampIds(db) {
  const fk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      const leRows = db
        .prepare(`SELECT id, branch_id, at_iso FROM ledger_entries WHERE id REGEXP '^LE-[0-9]+$'`)
        .all()
        .filter((r) => isLegacyLedgerId(r.id));
      leRows.sort((a, b) => String(a.at_iso).localeCompare(String(b.at_iso)) || String(a.id).localeCompare(String(b.id)));

      /** @type {Map<string, string>} */
      const leMap = new Map();
      for (const row of leRows) {
        const bid = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
        const newId = nextLedgerEntryId(db, bid);
        leMap.set(row.id, newId);
      }

      const applyRefMap = (text) => {
        let s = String(text ?? '');
        const pairs = [...leMap.entries()].sort((a, b) => b[0].length - a[0].length);
        for (const [o, n] of pairs) {
          if (s.includes(o)) s = s.split(o).join(n);
        }
        return s;
      };

      for (const oldId of leMap.keys()) {
        const row = db.prepare(`SELECT bank_reference, note FROM ledger_entries WHERE id = ?`).get(oldId);
        if (!row) continue;
        const br = applyRefMap(row.bank_reference);
        const note = applyRefMap(row.note);
        if (br !== row.bank_reference || note !== row.note) {
          db.prepare(`UPDATE ledger_entries SET bank_reference = ?, note = ? WHERE id = ?`).run(br, note, oldId);
        }
      }

      if (hasTable(db, 'sales_receipts')) {
        for (const [oldId, newId] of leMap) {
          db.prepare(`UPDATE sales_receipts SET id = ?, ledger_entry_id = ? WHERE id = ?`).run(newId, newId, oldId);
          db.prepare(`UPDATE sales_receipts SET ledger_entry_id = ? WHERE ledger_entry_id = ?`).run(newId, oldId);
        }
      }

      if (hasTable(db, 'advance_in_events')) {
        for (const [oldId, newId] of leMap) {
          db.prepare(`UPDATE advance_in_events SET ledger_entry_id = ? WHERE ledger_entry_id = ?`).run(newId, oldId);
        }
      }

      if (hasTable(db, 'treasury_movements')) {
        for (const [oldId, newId] of leMap) {
          db.prepare(
            `UPDATE treasury_movements SET source_id = ? WHERE source_id = ? AND source_kind IN ('LEDGER_RECEIPT','LEDGER_ADVANCE','LEDGER_ADVANCE_REFUND')`
          ).run(newId, oldId);
        }
      }

      if (hasTable(db, 'gl_journal_entries')) {
        for (const [oldId, newId] of leMap) {
          db.prepare(`UPDATE gl_journal_entries SET source_id = ? WHERE source_id = ?`).run(newId, oldId);
        }
      }

      if (hasTable(db, 'gl_journal_lines')) {
        for (const [oldId, newId] of leMap) {
          db.prepare(`UPDATE gl_journal_lines SET memo = REPLACE(memo, ?, ?) WHERE memo LIKE ?`).run(
            oldId,
            newId,
            `%${oldId}%`
          );
        }
      }

      if (hasTable(db, 'bank_reconciliation_lines')) {
        const cols = db.prepare(`PRAGMA table_info(bank_reconciliation_lines)`).all();
        const names = new Set(cols.map((c) => c.name));
        for (const [oldId, newId] of leMap) {
          if (names.has('system_match')) {
            db.prepare(`UPDATE bank_reconciliation_lines SET system_match = ? WHERE system_match = ?`).run(newId, oldId);
          }
        }
      }

      for (const [oldId, newId] of leMap) {
        db.prepare(`UPDATE ledger_entries SET id = ? WHERE id = ?`).run(newId, oldId);
      }

      const clRows = db
        .prepare(`SELECT id, branch_id FROM cutting_lists WHERE id REGEXP '^CL-[0-9]+$'`)
        .all()
        .filter((r) => isLegacyCuttingListId(r.id));

      /** @type {Map<string, string>} */
      const clMap = new Map();
      for (const row of clRows) {
        const bid = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
        clMap.set(row.id, nextCuttingListHumanId(db, bid));
      }

      for (const [oldId, newId] of clMap) {
        if (hasTable(db, 'cutting_list_lines')) {
          db.prepare(`UPDATE cutting_list_lines SET cutting_list_id = ? WHERE cutting_list_id = ?`).run(newId, oldId);
        }
        if (hasTable(db, 'production_jobs')) {
          db.prepare(`UPDATE production_jobs SET cutting_list_id = ? WHERE cutting_list_id = ?`).run(newId, oldId);
        }
        if (hasTable(db, 'deliveries')) {
          const dcols = db.prepare(`PRAGMA table_info(deliveries)`).all();
          if (dcols.some((c) => c.name === 'cutting_list_id')) {
            db.prepare(`UPDATE deliveries SET cutting_list_id = ? WHERE cutting_list_id = ?`).run(newId, oldId);
          }
        }
        if (hasTable(db, 'customer_refunds')) {
          db.prepare(`UPDATE customer_refunds SET cutting_list_ref = ? WHERE cutting_list_ref = ?`).run(newId, oldId);
        }
        db.prepare(`UPDATE cutting_lists SET id = ? WHERE id = ?`).run(newId, oldId);
      }
    })();
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
}

/**
 * Stored ids like LE-KAD-26-0001 (from old branch.code) → LE-KD-26-0001. Idempotent.
 * Runs outside the timestamp-id transaction to avoid long cross-table locks on boot.
 * @param {import('better-sqlite3').Database} db
 */
function normalizeLegacyBranchCodesInHumanIds(db) {
  for (const [bad, good] of LEGACY_BRANCH_CODE_PAIRS) {
    for (const p of DOC_PREFIXES) {
      const oldP = `${p}-${bad}-`;
      const newP = `${p}-${good}-`;
      const likeAny = `%${oldP}%`;
      const likePrefix = `${oldP}%`;

      if (hasTable(db, 'ledger_entries')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM ledger_entries WHERE bank_reference LIKE ? OR note LIKE ? LIMIT 1`,
          [likeAny, likeAny],
          `UPDATE ledger_entries SET bank_reference = replace(bank_reference, ?, ?), note = replace(note, ?, ?) WHERE bank_reference LIKE ? OR note LIKE ?`,
          [oldP, newP, oldP, newP, likeAny, likeAny]
        );
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM ledger_entries WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE ledger_entries SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'sales_receipts')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM sales_receipts WHERE id LIKE ? OR ledger_entry_id LIKE ? LIMIT 1`,
          [likePrefix, likePrefix],
          `UPDATE sales_receipts SET id = replace(id, ?, ?), ledger_entry_id = replace(ledger_entry_id, ?, ?) WHERE id LIKE ? OR ledger_entry_id LIKE ?`,
          [oldP, newP, oldP, newP, likePrefix, likePrefix]
        );
      }
      if (hasTable(db, 'treasury_movements')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM treasury_movements WHERE source_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE treasury_movements SET source_id = replace(source_id, ?, ?) WHERE source_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM treasury_movements WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE treasury_movements SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM treasury_movements WHERE batch_id LIKE ? LIMIT 1`,
          [likeAny],
          `UPDATE treasury_movements SET batch_id = replace(batch_id, ?, ?) WHERE batch_id LIKE ?`,
          [oldP, newP, likeAny]
        );
      }
      if (hasTable(db, 'gl_journal_entries')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM gl_journal_entries WHERE source_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE gl_journal_entries SET source_id = replace(source_id, ?, ?) WHERE source_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'gl_journal_lines')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM gl_journal_lines WHERE memo LIKE ? LIMIT 1`,
          [likeAny],
          `UPDATE gl_journal_lines SET memo = replace(memo, ?, ?) WHERE memo LIKE ?`,
          [oldP, newP, likeAny]
        );
      }
      if (hasTable(db, 'advance_in_events')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM advance_in_events WHERE ledger_entry_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE advance_in_events SET ledger_entry_id = replace(ledger_entry_id, ?, ?) WHERE ledger_entry_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'bank_reconciliation_lines')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM bank_reconciliation_lines WHERE system_match LIKE ? LIMIT 1`,
          [likeAny],
          `UPDATE bank_reconciliation_lines SET system_match = replace(system_match, ?, ?) WHERE system_match LIKE ?`,
          [oldP, newP, likeAny]
        );
      }
      if (hasTable(db, 'cutting_list_lines')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM cutting_list_lines WHERE cutting_list_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE cutting_list_lines SET cutting_list_id = replace(cutting_list_id, ?, ?) WHERE cutting_list_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'production_jobs')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM production_jobs WHERE cutting_list_id LIKE ? OR job_id LIKE ? LIMIT 1`,
          [likePrefix, likePrefix],
          `UPDATE production_jobs SET cutting_list_id = replace(cutting_list_id, ?, ?), job_id = replace(job_id, ?, ?) WHERE cutting_list_id LIKE ? OR job_id LIKE ?`,
          [oldP, newP, oldP, newP, likePrefix, likePrefix]
        );
      }
      if (hasTable(db, 'deliveries')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM deliveries WHERE cutting_list_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE deliveries SET cutting_list_id = replace(cutting_list_id, ?, ?) WHERE cutting_list_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'customer_refunds')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM customer_refunds WHERE refund_id LIKE ? OR cutting_list_ref LIKE ? LIMIT 1`,
          [likePrefix, likePrefix],
          `UPDATE customer_refunds SET refund_id = replace(refund_id, ?, ?), cutting_list_ref = replace(cutting_list_ref, ?, ?) WHERE refund_id LIKE ? OR cutting_list_ref LIKE ?`,
          [oldP, newP, oldP, newP, likePrefix, likePrefix]
        );
      }
      if (hasTable(db, 'cutting_lists')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM cutting_lists WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE cutting_lists SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'quotation_lines')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM quotation_lines WHERE id LIKE ? OR quotation_id LIKE ? LIMIT 1`,
          [likeAny, likePrefix],
          `UPDATE quotation_lines SET id = replace(id, ?, ?), quotation_id = replace(quotation_id, ?, ?) WHERE id LIKE ? OR quotation_id LIKE ?`,
          [oldP, newP, oldP, newP, likeAny, likePrefix]
        );
      }
      if (hasTable(db, 'quotations')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM quotations WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE quotations SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'purchase_orders')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM purchase_orders WHERE po_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE purchase_orders SET po_id = replace(po_id, ?, ?) WHERE po_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'expenses')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM expenses WHERE expense_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE expenses SET expense_id = replace(expense_id, ?, ?) WHERE expense_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'payment_requests')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM payment_requests WHERE request_id LIKE ? OR expense_id LIKE ? LIMIT 1`,
          [likePrefix, likePrefix],
          `UPDATE payment_requests SET request_id = replace(request_id, ?, ?), expense_id = replace(expense_id, ?, ?) WHERE request_id LIKE ? OR expense_id LIKE ?`,
          [oldP, newP, oldP, newP, likePrefix, likePrefix]
        );
      }
      if (hasTable(db, 'customers')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM customers WHERE customer_id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE customers SET customer_id = replace(customer_id, ?, ?) WHERE customer_id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'customer_crm_interactions')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM customer_crm_interactions WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE customer_crm_interactions SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
      if (hasTable(db, 'coil_requests')) {
        runUpdateIfMatched(
          db,
          `SELECT 1 AS x FROM coil_requests WHERE id LIKE ? LIMIT 1`,
          [likePrefix],
          `UPDATE coil_requests SET id = replace(id, ?, ?) WHERE id LIKE ?`,
          [oldP, newP, likePrefix]
        );
      }
    }
  }
}
