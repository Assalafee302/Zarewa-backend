/**
 * GL posting for customer receivable write-offs (round-off, settlement, bad debt).
 * @param {import('better-sqlite3').Database} db
 */
import { ensureArchitecturalGlAccounts } from './accountingPostingOps.js';
import { postBalancedJournalTx } from './glOps.js';

const SOURCE_KIND = 'RECEIVABLE_WRITE_OFF';

function assertWriteOffPeriodOpen(db, entryDateISO) {
  const periodKey = String(entryDateISO || '').slice(0, 7);
  if (!periodKey || periodKey.length < 7) return periodKey;
  const row = db.prepare(`SELECT period_key FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (row) {
    throw new Error(`Receivable write-off date falls in locked period ${periodKey}.`);
  }
  return periodKey;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function ensureBadDebtGlAccount(db) {
  ensureArchitecturalGlAccounts(db);
  db.prepare(
    `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
  ).run('acc-bad-debt', '5060', 'Bad debt & receivable write-offs', 'expense', 86);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quotationRef: string;
 *   amountNgn: number;
 *   entryDateISO: string;
 *   branchId?: string | null;
 *   createdByUserId?: string | null;
 *   category: string;
 *   memo?: string;
 * }} opts
 */
export function tryPostReceivableWriteOffGl(db, opts) {
  const quotationRef = String(opts.quotationRef || '').trim();
  const amt = Math.round(Number(opts.amountNgn) || 0);
  if (!quotationRef || amt <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };

  const entryDateISO = String(opts.entryDateISO || new Date().toISOString()).slice(0, 10);
  const periodKey = assertWriteOffPeriodOpen(db, entryDateISO);

  ensureBadDebtGlAccount(db);
  const category = String(opts.category || 'bad_debt').trim() || 'bad_debt';
  const sourceId = `${quotationRef}:${category}:${amt}`;

  const existing = db
    .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = ? AND source_id = ? LIMIT 1`)
    .get(SOURCE_KIND, sourceId);
  if (existing) return { ok: true, skipped: true, reason: 'already_posted', journalId: existing.id };

  const memo =
    String(opts.memo || '').trim() ||
    `Receivable write-off ${category.replace(/_/g, ' ')} — ${quotationRef}`;

  const result = postBalancedJournalTx(db, {
    entryDateISO,
    periodKey,
    memo,
    sourceKind: SOURCE_KIND,
    sourceId,
    branchId: opts.branchId || null,
    createdByUserId: opts.createdByUserId || null,
    lines: [
      { accountCode: '5060', debitNgn: amt, memo: quotationRef },
      { accountCode: '1200', creditNgn: amt, memo: quotationRef },
    ],
  });

  return result?.ok ? { ok: true, journalId: result.journalId } : result;
}
