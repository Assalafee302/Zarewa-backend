/**
 * Finance Phase A (A8): record which treasury account a bank-statement import covers and up to
 * when, and serve the latest point per account for the bank cards.
 * Rules: shared/lib/bankStatementFreshness.js.
 */
import crypto from 'node:crypto';
import { actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { latestStatementByAccount, statementCoveredTo } from '../../shared/lib/bankStatementFreshness.js';

function clean(v) {
  return String(v ?? '').trim();
}

/**
 * Call after an import inserted its lines. Tags those lines to the account (only where untagged)
 * and stores the statement point. No-op without a treasury account.
 * @param {import('better-sqlite3').Database} db
 * @param {{ treasuryAccountId?: number|string, statementToISO?: string, branchId?: string, lineDays?: string[], createdIds?: string[] }} p
 */
function recordBankStatementImportTx(db, p = {}, actor = null) {
  const treasuryAccountId = Number(p.treasuryAccountId);
  if (!treasuryAccountId) return { ok: true, skipped: true };
  const account = db.prepare(`SELECT id, name FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId);
  if (!account) return { ok: false, error: 'Treasury account for this statement was not found.' };
  const importedAtISO = new Date().toISOString();
  const covered = statementCoveredTo({ statementToISO: p.statementToISO, lineDays: p.lineDays, importedAtISO });
  if (!covered) return { ok: true, skipped: true };
  const ids = (p.createdIds || []).map(clean).filter(Boolean);
  if (ids.length) {
    db.prepare(
      `UPDATE bank_reconciliation_lines SET treasury_account_id = ?
       WHERE treasury_account_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`
    ).run(treasuryAccountId, ...ids);
  }
  const id = `BSI-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO bank_statement_imports
       (id, treasury_account_id, branch_id, statement_to_iso, statement_to_has_time, line_count,
        imported_at_iso, imported_by_user_id, imported_by_name)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    treasuryAccountId,
    clean(p.branchId) || null,
    covered.statementToISO,
    covered.hasTime ? 1 : 0,
    ids.length,
    importedAtISO,
    actor?.id ?? null,
    actorName(actor) || null
  );
  appendAuditLog(db, {
    actor,
    action: 'bank_statement.import_recorded',
    entityKind: 'treasury_account',
    entityId: String(treasuryAccountId),
    note: `Statement for ${account.name} loaded to ${covered.statementToISO} (${ids.length} new line${ids.length === 1 ? '' : 's'})`,
    details: { importId: id, ...covered, lineCount: ids.length },
  });
  return { ok: true, importId: id, treasuryAccountId, ...covered };
}

/** Latest statement point per treasury account in scope. */
export function listStatementFreshness(db, branchScope = 'ALL') {
  const scoped = branchScope && branchScope !== 'ALL';
  let imports = [];
  try {
    imports = db
      .prepare(
        `SELECT bsi.treasury_account_id, bsi.statement_to_iso, bsi.statement_to_has_time, bsi.imported_at_iso
         FROM bank_statement_imports bsi
         JOIN treasury_accounts a ON a.id = bsi.treasury_account_id
         ${scoped ? 'WHERE a.branch_id = ?' : ''}`
      )
      .all(...(scoped ? [branchScope] : []))
      .map((r) => ({
        treasuryAccountId: Number(r.treasury_account_id),
        statementToISO: clean(r.statement_to_iso),
        hasTime: Number(r.statement_to_has_time) === 1,
        importedAtISO: clean(r.imported_at_iso),
      }));
  } catch {
    imports = [];
  }
  const lineMax = db
    .prepare(
      `SELECT l.treasury_account_id, MAX(SUBSTR(l.bank_date_iso, 1, 10)) AS last_day
       FROM bank_reconciliation_lines l
       JOIN treasury_accounts a ON a.id = l.treasury_account_id
       WHERE l.treasury_account_id IS NOT NULL ${scoped ? 'AND a.branch_id = ?' : ''}
       GROUP BY l.treasury_account_id`
    )
    .all(...(scoped ? [branchScope] : []))
    .map((r) => ({ treasuryAccountId: Number(r.treasury_account_id), lastBankDateISO: clean(r.last_day) }));
  return { ok: true, accounts: latestStatementByAccount(imports, lineMax) };
}

/** Never fails the import itself: the statement lines are already saved when this runs. */
export function recordBankStatementImport(db, p = {}, actor = null) {
  try {
    return recordBankStatementImportTx(db, p, actor);
  } catch (e) {
    console.error('[bank-statement-import]', e);
    return { ok: false, error: String(e?.message || e) };
  }
}
