/**
 * Full till/bank statement for one treasury account and date range.
 * Cashier desk bootstrap only ships recent movements, so older import dates
 * disappear from the on-screen picker. This query is not capped.
 */
import { roundMoney } from '../ap2ReceivedBasisOps.js';

function dayIso(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

function sourceLabel(row) {
  const kind = String(row.source_kind || row.type || '').trim().toUpperCase();
  if (kind === 'EXPENSE' || row.type === 'EXPENSE') return 'Expense';
  if (kind === 'PAYMENT_REQUEST' || String(row.type || '').includes('PAYMENT_REQUEST')) return 'Payment req';
  if (kind === 'LEDGER_RECEIPT' || row.type === 'RECEIPT_IN') return 'Sales receipt';
  if (kind === 'REFUND' || kind === 'REFUND_PAYOUT' || row.type === 'REFUND_PAYOUT') return 'Refund';
  if (
    kind === 'REFUND_COMPANY_RETENTION' ||
    kind === 'REFUND_COMPANY_CUT_PAYOUT' ||
    row.type === 'REFUND_COMPANY_CUT_PAYOUT'
  ) {
    return 'Company cut';
  }
  if (kind === 'TREASURY_TRANSFER' || String(row.type || '').includes('TRANSFER')) return 'Transfer';
  return row.type || kind || 'Movement';
}

function description(row) {
  const bits = [
    row.counterparty_name,
    row.reference ? `Ref ${row.reference}` : '',
    row.note,
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return bits.join(' · ') || row.type || '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} treasuryAccountId
 * @param {string} fromISO
 * @param {string} toISO
 */
export function buildTreasuryAccountStatement(db, treasuryAccountId, fromISO, toISO) {
  const id = Number(treasuryAccountId);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'Pick a cash or bank account.' };
  const from = dayIso(fromISO);
  const to = dayIso(toISO);
  if (!from || !to) return { ok: false, error: 'Set both from and to dates (YYYY-MM-DD).' };
  if (from > to) return { ok: false, error: 'From date must be on or before the to date.' };

  const account = db
    .prepare(
      `SELECT id, name, type, bank_name, acc_no, balance, opening_balance_ngn, branch_id
       FROM treasury_accounts WHERE id = ?`
    )
    .get(id);
  if (!account) return { ok: false, error: 'Treasury account not found.' };

  const liveBalance = roundMoney(account.balance);
  // Registered opening is the books' starting figure, not the balance on date D.
  // Opening on D = that figure plus every movement posted before D.
  const openingRegistered = roundMoney(account.opening_balance_ngn);
  const sumThroughTo = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s
       FROM treasury_movements
       WHERE treasury_account_id = ?
         AND SUBSTR(posted_at_iso, 1, 10) <= ?`
    )
    .get(id, to);
  const sumBeforeFrom = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s
       FROM treasury_movements
       WHERE treasury_account_id = ?
         AND SUBSTR(posted_at_iso, 1, 10) < ?`
    )
    .get(id, from);
  const treasuryThroughToNgn = roundMoney(openingRegistered + roundMoney(sumThroughTo?.s));
  const openingBalanceNgn = roundMoney(openingRegistered + roundMoney(sumBeforeFrom?.s));

  let pendingReceiptIds = new Set();
  try {
    const pendingRows = db
      .prepare(
        `SELECT id FROM sales_receipts WHERE LOWER(COALESCE(status, '')) LIKE '%pending%'`
      )
      .all();
    pendingReceiptIds = new Set((pendingRows || []).map((r) => String(r.id || '').trim()).filter(Boolean));
  } catch {
    pendingReceiptIds = new Set();
  }

  const rows = db
    .prepare(
      `SELECT tm.*, ta.name AS account_name
       FROM treasury_movements tm
       LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE tm.treasury_account_id = ?
         AND SUBSTR(tm.posted_at_iso, 1, 10) >= ?
         AND SUBSTR(tm.posted_at_iso, 1, 10) <= ?
       ORDER BY tm.posted_at_iso ASC, tm.id ASC`
    )
    .all(id, from, to);

  let running = openingBalanceNgn;
  let inflowNgn = 0;
  let outflowNgn = 0;
  const lines = rows.map((row, i) => {
    const amountNgn = roundMoney(row.amount_ngn);
    if (amountNgn > 0) inflowNgn += amountNgn;
    else outflowNgn += Math.abs(amountNgn);
    running = roundMoney(running + amountNgn);
    const sourceId = String(row.source_id || '').trim();
    const pending = pendingReceiptIds.has(sourceId);
    const text = description(row);
    return {
      n: i + 1,
      id: row.id,
      date: dayIso(row.posted_at_iso),
      source: sourceLabel(row),
      description: pending ? (text ? `${text} · pending` : 'pending') : text,
      pending,
      inNgn: amountNgn > 0 ? amountNgn : 0,
      outNgn: amountNgn < 0 ? Math.abs(amountNgn) : 0,
      balanceNgn: running,
      type: row.type,
      reference: row.reference || '',
      sourceKind: row.source_kind || '',
      sourceId: row.source_id || '',
    };
  });

  const statementClosingNgn = lines.length ? lines[lines.length - 1].balanceNgn : openingBalanceNgn;
  const tieOut = {
    statementClosingNgn,
    treasuryThroughToNgn,
    equal: statementClosingNgn === treasuryThroughToNgn,
  };

  return {
    ok: true,
    account: {
      id: Number(account.id),
      name: account.name || `Account ${account.id}`,
      type: account.type || '',
      bankName: account.bank_name || '',
      accNo: account.acc_no || '',
      branchId: account.branch_id || '',
      liveBalanceNgn: liveBalance,
    },
    fromISO: from,
    toISO: to,
    openingBalanceNgn,
    closingBalanceNgn: statementClosingNgn,
    tieOut,
    inflowNgn: roundMoney(inflowNgn),
    outflowNgn: roundMoney(outflowNgn),
    lineCount: lines.length,
    lines,
  };
}
