/**
 * Bank statement balances (Reports round 2, C): opening and closing balance per treasury account per month, as
 * printed on the bank statement (kobo kept), entered by Finance. The bank reconciliation statement reads them;
 * the ERP never derives them. Every save is in the audit log with the previous values.
 */
import { appendAuditLog } from '../controlOps.js';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const toKobo = (v) => Math.round(Number(String(v ?? '').replace(/,/g, '')) * 100);
const fromKobo = (k) => (k == null ? null : Math.round(Number(k)) / 100);

/** "2026-08" when [startDate, endDate] is exactly one calendar month, else ''. */
export function calendarMonthKey(startDate, endDate) {
  const m = String(startDate || '').match(/^(\d{4})-(\d{2})-01$/);
  if (!m) return '';
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  return endDate === last ? `${m[1]}-${m[2]}` : '';
}

function mapRow(r) {
  return {
    treasuryAccountId: r.treasury_account_id,
    periodKey: r.period_key,
    openingNgn: fromKobo(r.opening_kobo),
    closingNgn: fromKobo(r.closing_kobo),
    note: r.note || '',
    enteredByName: r.entered_by_name || '',
    enteredByUserId: r.entered_by_user_id || '',
    enteredAtISO: r.entered_at_iso || '',
    branchId: r.branch_id || '',
  };
}

/**
 * @param {(sql: string, args: unknown[]) => object[] | Promise<object[]>} all
 * @param {{ periodKey: string, branchScope?: string }} p
 */
export async function listStatementBalancesWith(all, { periodKey, branchScope = 'ALL' }) {
  if (!PERIOD_RE.test(String(periodKey || ''))) return [];
  const scoped = branchScope && branchScope !== 'ALL';
  const rows = await all(
    `SELECT * FROM bank_statement_balances WHERE period_key = ?${scoped ? ' AND branch_id = ?' : ''} ORDER BY treasury_account_id`,
    scoped ? [periodKey, branchScope] : [periodKey]
  );
  return rows.map(mapRow);
}

export function listStatementBalances(db, p) {
  return db.prepare(
    `SELECT * FROM bank_statement_balances WHERE period_key = ?${p.branchScope && p.branchScope !== 'ALL' ? ' AND branch_id = ?' : ''} ORDER BY treasury_account_id`
  )
    .all(...(p.branchScope && p.branchScope !== 'ALL' ? [p.periodKey, p.branchScope] : [p.periodKey]))
    .map(mapRow);
}

/**
 * Save (insert or replace) one account-month. Opening and closing are both required.
 * @param {object} db
 * @param {{ treasuryAccountId: number|string, periodKey: string, openingNgn: number|string, closingNgn: number|string, note?: string }} body
 * @param {{ id?: string, displayName?: string, username?: string }} user
 * @param {{ workspaceBranchId?: string, workspaceViewAll?: boolean }} [scope]
 */
export function upsertStatementBalance(db, body = {}, user = {}, scope = {}) {
  const periodKey = String(body.periodKey || '').trim();
  if (!PERIOD_RE.test(periodKey)) return { ok: false, error: 'periodKey must be YYYY-MM.' };
  const accountId = Number(body.treasuryAccountId);
  const acc = db.prepare(`SELECT id, name, branch_id FROM treasury_accounts WHERE id = ?`).get(accountId);
  if (!acc) return { ok: false, error: 'Unknown treasury account.' };
  if (!scope.workspaceViewAll && scope.workspaceBranchId && acc.branch_id && acc.branch_id !== scope.workspaceBranchId) {
    return { ok: false, error: 'This account belongs to another branch.' };
  }
  const opening = toKobo(body.openingNgn);
  const closing = toKobo(body.closingNgn);
  if (!Number.isFinite(opening) || !Number.isFinite(closing) || body.openingNgn === '' || body.closingNgn === '') {
    return { ok: false, error: 'Opening and closing balances are both required.' };
  }
  const id = `${accountId}|${periodKey}`;
  const before = db.prepare(`SELECT * FROM bank_statement_balances WHERE id = ?`).get(id);
  const now = new Date().toISOString();
  const by = String(user.displayName || user.username || '').trim();
  const note = String(body.note || '').trim().slice(0, 200);
  if (before) {
    db.prepare(
      `UPDATE bank_statement_balances SET opening_kobo = ?, closing_kobo = ?, note = ?, entered_by_user_id = ?, entered_by_name = ?, entered_at_iso = ? WHERE id = ?`
    ).run(opening, closing, note, String(user.id || ''), by, now, id);
  } else {
    db.prepare(
      `INSERT INTO bank_statement_balances (id, treasury_account_id, period_key, opening_kobo, closing_kobo, note, entered_by_user_id, entered_by_name, entered_at_iso, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, accountId, periodKey, opening, closing, note, String(user.id || ''), by, now, acc.branch_id || '');
  }
  appendAuditLog(db, {
    actor: user,
    action: 'bank_statement_balance.save',
    entityKind: 'bank_statement_balance',
    entityId: id,
    note: `${acc.name} ${periodKey}: opening ${fromKobo(opening)} closing ${fromKobo(closing)}`,
    details: {
      before: before ? mapRow(before) : null,
      after: { treasuryAccountId: accountId, periodKey, openingNgn: fromKobo(opening), closingNgn: fromKobo(closing), note },
    },
  });
  return { ok: true, balance: mapRow(db.prepare(`SELECT * FROM bank_statement_balances WHERE id = ?`).get(id)) };
}
