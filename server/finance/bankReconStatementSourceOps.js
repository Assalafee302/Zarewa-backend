import { buildBankReconStatement } from '../../shared/lib/bankReconStatementCore.js';
import { getBranch } from '../branches.js';

/** Bank lines and movements this many days either side of the period label links that cross the period edge. */
const LINK_WINDOW_DAYS = 45;

function shiftDay(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2:1500000,4:-20" → { 2: 1500000, 4: -20 } (statement balances typed by the user; not stored in the ERP). */
export function parseAccountAmounts(text) {
  const out = {};
  for (const part of String(text || '').split(',')) {
    const m = part.trim().match(/^(\d+)\s*:\s*(-?\d+(?:\.\d+)?)$/);
    if (m) out[m[1]] = Math.round(Number(m[2]));
  }
  return out;
}

/**
 * Read-only inputs for the bank reconciliation statement. SELECT only.
 * ERP opening per account = account opening balance + every movement before `startDate` (one aggregate query).
 * @param {(sql: string, args: unknown[]) => object[] | Promise<object[]>} all — runs one SELECT
 * @param {{ branchScope: string, startDate: string, endDate: string, branchName?: string }} p
 */
export async function loadBankReconStatementSourceWith(all, { branchScope, startDate, endDate, branchName }) {
  const scoped = branchScope && branchScope !== 'ALL';
  const accounts = await all(
      `SELECT a.id, a.name, a.bank_name, a.type, a.acc_no, a.balance, a.opening_balance_ngn, a.branch_id,
              COALESCE((SELECT SUM(m.amount_ngn) FROM treasury_movements m
                        WHERE m.treasury_account_id = a.id AND SUBSTR(m.posted_at_iso, 1, 10) < ?), 0) AS before_ngn
       FROM treasury_accounts a ${scoped ? 'WHERE a.branch_id = ?' : ''} ORDER BY a.id`,
    scoped ? [startDate, branchScope] : [startDate]
  );
  const ids = accounts.map((a) => a.id);
  const from = shiftDay(startDate, -LINK_WINDOW_DAYS);
  const to = shiftDay(endDate, LINK_WINDOW_DAYS);
  const inIds = ids.map(() => '?').join(',');
  const movements = ids.length
    ? await all(
        `SELECT id, posted_at_iso, type, treasury_account_id, amount_ngn, reference, counterparty_name, source_kind, source_id
         FROM treasury_movements
         WHERE treasury_account_id IN (${inIds}) AND SUBSTR(posted_at_iso, 1, 10) BETWEEN ? AND ?`,
        [...ids, from, to]
      )
    : [];
  const bankLines = ids.length
    ? await all(
        `SELECT id, bank_date_iso, description, amount_ngn, status, system_match, treasury_account_id
         FROM bank_reconciliation_lines
         WHERE treasury_account_id IN (${inIds}) AND SUBSTR(bank_date_iso, 1, 10) BETWEEN ? AND ?`,
        [...ids, from, to]
      )
    : [];
  const expenseIds = [...new Set(movements.filter((m) => m.type === 'EXPENSE').map((m) => String(m.source_id || '')))].filter(Boolean);
  const expenses = expenseIds.length
    ? await all(`SELECT expense_id, category FROM expenses WHERE expense_id IN (${expenseIds.map(() => '?').join(',')})`, expenseIds)
    : [];
  return {
    branch: scoped ? { id: branchScope, name: branchName || branchScope } : { id: 'ALL', name: 'All branches' },
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      bankName: a.bank_name || '',
      type: a.type,
      accNo: a.acc_no || '',
      balance: a.balance,
      branchId: a.branch_id,
      erpOpeningNgn: Math.round(Number(a.opening_balance_ngn) || 0) + Math.round(Number(a.before_ngn) || 0),
    })),
    treasuryMovements: movements.map((m) => ({
      id: m.id,
      postedAtISO: m.posted_at_iso,
      type: m.type,
      treasuryAccountId: m.treasury_account_id,
      amountNgn: m.amount_ngn,
      reference: m.reference || '',
      counterpartyName: m.counterparty_name || '',
      sourceKind: m.source_kind || '',
      sourceId: m.source_id || '',
    })),
    bankLines: bankLines.map((b) => ({
      id: b.id,
      bankDateISO: b.bank_date_iso,
      description: b.description || '',
      amountNgn: b.amount_ngn,
      status: b.status || '',
      systemMatch: b.system_match || '',
      treasuryAccountId: b.treasury_account_id,
    })),
    expenses: expenses.map((e) => ({ expenseID: e.expense_id, category: e.category || '' })),
    startDate,
    endDate,
  };
}

/** Statement from loaded source + the statement balances the user typed ("2:1500000,4:-20"). */
export function bankReconStatementFromSource(src, p) {
  const report = buildBankReconStatement({
    ...src,
    bankOpeningByAccount: parseAccountAmounts(p.bankOpening),
    bankClosingByAccount: parseAccountAmounts(p.bankClosing),
  });
  return { ...report, branch: src.branch };
}

/**
 * @param {object} db
 * @param {{ branchScope: string, startDate: string, endDate: string, bankOpening?: string, bankClosing?: string }} p
 */
export async function buildBankReconStatementReport(db, p) {
  const scoped = p.branchScope && p.branchScope !== 'ALL';
  const branchRow = scoped ? getBranch(db, p.branchScope) : null;
  const src = await loadBankReconStatementSourceWith((sql, args) => db.prepare(sql).all(...args), {
    ...p,
    branchName: branchRow?.name || '',
  });
  return bankReconStatementFromSource(src, p);
}
