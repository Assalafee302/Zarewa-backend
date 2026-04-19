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

function isLegacyLedgerId(id) {
  return /^LE-\d{10,}-[a-z0-9]+$/i.test(String(id || '').trim());
}

function isLegacyCuttingListId(id) {
  return /^CL-\d{10,}-[a-z0-9]+$/i.test(String(id || '').trim());
}

function hasTable(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateTimestampStyleDocumentIds(db) {
  if (!hasTable(db, 'ledger_entries')) return;

  ensureHumanIdSequencesTable(db);

  const fk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      const leRows = db
        .prepare(`SELECT id, branch_id, at_iso FROM ledger_entries WHERE id GLOB 'LE-[0-9]*'`)
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
        .prepare(`SELECT id, branch_id FROM cutting_lists WHERE id GLOB 'CL-[0-9]*'`)
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

      normalizeLegacyBranchCodesInHumanIds(db);
    })();
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
}

/**
 * Stored ids like LE-KAD-26-0001 (from old branch.code) → LE-KD-26-0001. Idempotent.
 * @param {import('better-sqlite3').Database} db
 */
function normalizeLegacyBranchCodesInHumanIds(db) {
  const codePairs = [
    ['KAD', 'KD'],
    ['YOL', 'YL'],
    ['MAI', 'MDG'],
  ];
  const docPrefixes = [
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

  for (const [bad, good] of codePairs) {
    for (const p of docPrefixes) {
      const oldP = `${p}-${bad}-`;
      const newP = `${p}-${good}-`;

      if (hasTable(db, 'ledger_entries')) {
        db.prepare(
          `UPDATE ledger_entries SET bank_reference = replace(bank_reference, ?, ?), note = replace(note, ?, ?) WHERE bank_reference LIKE ? OR note LIKE ?`
        ).run(oldP, newP, oldP, newP, `%${oldP}%`, `%${oldP}%`);
      }
      if (hasTable(db, 'sales_receipts')) {
        db.prepare(
          `UPDATE sales_receipts SET id = replace(id, ?, ?), ledger_entry_id = replace(ledger_entry_id, ?, ?) WHERE id LIKE ? OR ledger_entry_id LIKE ?`
        ).run(oldP, newP, oldP, newP, `${oldP}%`, `${oldP}%`);
      }
      if (hasTable(db, 'treasury_movements')) {
        db.prepare(`UPDATE treasury_movements SET source_id = replace(source_id, ?, ?) WHERE source_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
        db.prepare(`UPDATE treasury_movements SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
        db.prepare(`UPDATE treasury_movements SET batch_id = replace(batch_id, ?, ?) WHERE batch_id LIKE ?`).run(
          oldP,
          newP,
          `%${oldP}%`
        );
      }
      if (hasTable(db, 'gl_journal_entries')) {
        db.prepare(`UPDATE gl_journal_entries SET source_id = replace(source_id, ?, ?) WHERE source_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
      }
      if (hasTable(db, 'gl_journal_lines')) {
        db.prepare(`UPDATE gl_journal_lines SET memo = replace(memo, ?, ?) WHERE memo LIKE ?`).run(oldP, newP, `%${oldP}%`);
      }
      if (hasTable(db, 'advance_in_events')) {
        db.prepare(`UPDATE advance_in_events SET ledger_entry_id = replace(ledger_entry_id, ?, ?) WHERE ledger_entry_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
      }
      if (hasTable(db, 'bank_reconciliation_lines')) {
        db.prepare(`UPDATE bank_reconciliation_lines SET system_match = replace(system_match, ?, ?) WHERE system_match LIKE ?`).run(
          oldP,
          newP,
          `%${oldP}%`
        );
      }
      if (hasTable(db, 'cutting_list_lines')) {
        db.prepare(`UPDATE cutting_list_lines SET cutting_list_id = replace(cutting_list_id, ?, ?) WHERE cutting_list_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
      }
      if (hasTable(db, 'production_jobs')) {
        db.prepare(
          `UPDATE production_jobs SET cutting_list_id = replace(cutting_list_id, ?, ?), job_id = replace(job_id, ?, ?) WHERE cutting_list_id LIKE ? OR job_id LIKE ?`
        ).run(oldP, newP, oldP, newP, `${oldP}%`, `${oldP}%`);
      }
      if (hasTable(db, 'deliveries')) {
        db.prepare(`UPDATE deliveries SET cutting_list_id = replace(cutting_list_id, ?, ?) WHERE cutting_list_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
      }
      if (hasTable(db, 'customer_refunds')) {
        db.prepare(
          `UPDATE customer_refunds SET refund_id = replace(refund_id, ?, ?), cutting_list_ref = replace(cutting_list_ref, ?, ?) WHERE refund_id LIKE ? OR cutting_list_ref LIKE ?`
        ).run(oldP, newP, oldP, newP, `${oldP}%`, `${oldP}%`);
      }
      if (hasTable(db, 'cutting_lists')) {
        db.prepare(`UPDATE cutting_lists SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'quotation_lines')) {
        db.prepare(
          `UPDATE quotation_lines SET id = replace(id, ?, ?), quotation_id = replace(quotation_id, ?, ?) WHERE id LIKE ? OR quotation_id LIKE ?`
        ).run(oldP, newP, oldP, newP, `%${oldP}%`, `${oldP}%`);
      }
      if (hasTable(db, 'quotations')) {
        db.prepare(`UPDATE quotations SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'purchase_orders')) {
        db.prepare(`UPDATE purchase_orders SET po_id = replace(po_id, ?, ?) WHERE po_id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'expenses')) {
        db.prepare(`UPDATE expenses SET expense_id = replace(expense_id, ?, ?) WHERE expense_id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'payment_requests')) {
        db.prepare(
          `UPDATE payment_requests SET request_id = replace(request_id, ?, ?), expense_id = replace(expense_id, ?, ?) WHERE request_id LIKE ? OR expense_id LIKE ?`
        ).run(oldP, newP, oldP, newP, `${oldP}%`, `${oldP}%`);
      }
      if (hasTable(db, 'customers')) {
        db.prepare(`UPDATE customers SET customer_id = replace(customer_id, ?, ?) WHERE customer_id LIKE ?`).run(
          oldP,
          newP,
          `${oldP}%`
        );
      }
      if (hasTable(db, 'customer_crm_interactions')) {
        db.prepare(`UPDATE customer_crm_interactions SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'coil_requests')) {
        db.prepare(`UPDATE coil_requests SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
      if (hasTable(db, 'ledger_entries')) {
        db.prepare(`UPDATE ledger_entries SET id = replace(id, ?, ?) WHERE id LIKE ?`).run(oldP, newP, `${oldP}%`);
      }
    }
  }
}
