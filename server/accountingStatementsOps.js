/**
 * Management statement pack from GL trial balance + light sub-ledger hints.
 * @param {import('better-sqlite3').Database} db
 */

import { branchPredicate } from './branchSql.js';
import { trialBalanceRows } from './glOps.js';

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

/** @param {string} periodKey YYYY-MM */
export function monthBounds(periodKey) {
  const pk = String(periodKey || '').trim();
  if (!/^\d{4}-\d{2}$/.test(pk)) return null;
  const [y, m] = pk.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    periodKey: pk,
    start: `${pk}-01`,
    end: `${pk}-${String(last).padStart(2, '0')}`,
  };
}

function accountBalanceForType(row, accountType) {
  const d = Math.round(Number(row.debitNgn) || 0);
  const c = Math.round(Number(row.creditNgn) || 0);
  const t = String(accountType || '').toLowerCase();
  if (t === 'asset' || t === 'expense') return d - c;
  if (t === 'liability' || t === 'equity' || t === 'revenue') return c - d;
  return d - c;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 * @param {'ALL' | string} branchScope
 */
export function getAccountingStatementsPack(db, periodKey, branchScope = 'ALL') {
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  const plTb = trialBalanceRows(db, b.start, b.end);
  if (!plTb.ok) return plTb;

  const bsTb = trialBalanceRows(db, '2000-01-01', b.end);
  if (!bsTb.ok) return bsTb;

  const plLines = [];
  let revenueTotal = 0;
  let expenseTotal = 0;
  for (const r of plTb.rows) {
    const t = String(r.accountType || '').toLowerCase();
    if (t !== 'revenue' && t !== 'expense') continue;
    const bal = accountBalanceForType(r, t);
    if (bal === 0) continue;
    plLines.push({
      accountCode: r.accountCode,
      accountName: r.accountName,
      accountType: t,
      amountNgn: bal,
    });
    if (t === 'revenue') revenueTotal += bal;
    if (t === 'expense') expenseTotal += bal;
  }

  const bsLines = [];
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const r of bsTb.rows) {
    const t = String(r.accountType || '').toLowerCase();
    if (t !== 'asset' && t !== 'liability' && t !== 'equity') continue;
    const bal = accountBalanceForType(r, t);
    if (bal === 0) continue;
    bsLines.push({
      accountCode: r.accountCode,
      accountName: r.accountName,
      accountType: t,
      balanceNgn: bal,
    });
    if (t === 'asset') assets += bal;
    if (t === 'liability') liabilities += bal;
    if (t === 'equity') equity += bal;
  }

  const netIncome = revenueTotal - expenseTotal;
  const totalLiabEq = liabilities + equity;
  const bsBalanced = Math.abs(assets - totalLiabEq) <= 1;

  let receiptsNgn = 0;
  if (hasColumn(db, 'sales_receipts', 'date_iso')) {
    const bw = branchPredicate(db, 'sales_receipts', branchScope);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM sales_receipts WHERE date_iso >= ? AND date_iso <= ?${bw.sql}`
      )
      .get(b.start, b.end, ...bw.args);
    receiptsNgn = Math.round(Number(row?.s) || 0);
  }

  return {
    ok: true,
    periodKey: b.periodKey,
    range: { start: b.start, end: b.end },
    branchScope,
    profitAndLoss: {
      revenueTotalNgn: revenueTotal,
      expenseTotalNgn: expenseTotal,
      netIncomeNgn: netIncome,
      lines: plLines,
    },
    balanceSheet: {
      assetsNgn: assets,
      liabilitiesNgn: liabilities,
      equityNgn: equity,
      totalLiabilitiesAndEquityNgn: totalLiabEq,
      balanced: bsBalanced,
      lines: bsLines,
    },
    reconciliationHints: {
      salesReceiptsInPeriodNgn: receiptsNgn,
      note:
        'Receipts total is operational (sales_receipts in period). Compare to treasury cash movements and GL cash/receipt postings for month-end.',
    },
  };
}
