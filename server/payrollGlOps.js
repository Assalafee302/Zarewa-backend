/**
 * Payroll → GL (accrual on lock, net pay on treasury payout, optional statutory remittance).
 */
import { postBalancedJournalTx } from './glOps.js';
import { ensureTreasuryCashGlAccount } from './accountingPostingOps.js';

/** @param {import('better-sqlite3').Database} db @param {string} runId */
function payrollRunRow(db, runId) {
  try {
    const row = db.prepare(`SELECT id, period_yyyymm, status FROM hr_payroll_runs WHERE id = ?`).get(runId);
    if (!row) return null;
    return { id: row.id, periodYyyymm: row.period_yyyymm, status: row.status };
  } catch {
    return null;
  }
}

/** @param {import('better-sqlite3').Database} db @param {string} runId */
function payrollGlLineRows(db, runId) {
  try {
    return db
      .prepare(
        `SELECT gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn
         FROM hr_payroll_lines WHERE run_id = ?`
      )
      .all(runId);
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 */
export function computePayrollRunGlAmounts(db, runId) {
  const run = payrollRunRow(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = payrollGlLineRows(db, runId);
  let expenseDr = 0;
  let taxCr = 0;
  let penCr = 0;
  let netCr = 0;
  for (const l of lines) {
    const g = Math.round(Number(l.gross_ngn) || 0) + Math.round(Number(l.bonus_ngn) || 0);
    const ad = Math.round(Number(l.attendance_deduction_ngn) || 0);
    const od = Math.round(Number(l.other_deduction_ngn) || 0);
    expenseDr += g - ad - od;
    taxCr += Math.round(Number(l.tax_ngn) || 0);
    penCr += Math.round(Number(l.pension_ngn) || 0);
    netCr += Math.round(Number(l.net_ngn) || 0);
  }
  return {
    ok: true,
    runId,
    periodYyyymm: run.periodYyyymm,
    expenseDr,
    taxCr,
    penCr,
    netCr,
    balanced: expenseDr === taxCr + penCr + netCr,
  };
}

function payrollPeriodEndIso(periodYyyymm) {
  const pk = String(periodYyyymm || '').trim();
  if (!/^\d{4}-\d{2}$/.test(pk)) return new Date().toISOString().slice(0, 10);
  const [y, m] = pk.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${pk}-${String(last).padStart(2, '0')}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {{ createdByUserId?: string | null; branchId?: string | null }} [actor]
 */
export function tryPostPayrollAccrualGlTx(db, runId, actor = {}) {
  const amounts = computePayrollRunGlAmounts(db, runId);
  if (!amounts.ok) return amounts;
  if (amounts.expenseDr <= 0) return { ok: true, skipped: true, reason: 'zero_payroll_expense' };
  if (!amounts.balanced) {
    return { ok: false, error: 'Payroll lines do not balance for GL accrual (expense vs credits).' };
  }
  const run = payrollRunRow(db, runId);
  const lines = [
    { accountCode: '6000', debitNgn: amounts.expenseDr, memo: `Payroll accrual ${run?.periodYyyymm || runId}` },
  ];
  if (amounts.taxCr > 0) {
    lines.push({ accountCode: '2300', creditNgn: amounts.taxCr, memo: 'PAYE payable' });
  }
  if (amounts.penCr > 0) {
    lines.push({ accountCode: '2400', creditNgn: amounts.penCr, memo: 'Pension payable' });
  }
  if (amounts.netCr > 0) {
    lines.push({ accountCode: '2200', creditNgn: amounts.netCr, memo: 'Net payroll payable' });
  }
  return postBalancedJournalTx(db, {
    entryDateISO: payrollPeriodEndIso(run?.periodYyyymm),
    memo: `Payroll accrual ${run?.periodYyyymm || runId}`,
    sourceKind: 'HR_PAYROLL_ACCRUAL_GL',
    sourceId: runId,
    branchId: actor.branchId ?? null,
    createdByUserId: actor.createdByUserId ?? null,
    lines,
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   runId: string;
 *   movementId: string;
 *   treasuryAccountId: number;
 *   amountNgn: number;
 *   entryDateISO: string;
 *   createdByUserId?: string | null;
 *   branchId?: string | null;
 * }} payload
 */
export function tryPostPayrollNetPaymentGlTx(db, payload) {
  const amt = Math.round(Number(payload.amountNgn) || 0);
  if (amt <= 0) return { ok: true, skipped: true, reason: 'zero_amount' };
  const cash = ensureTreasuryCashGlAccount(db, payload.treasuryAccountId);
  if (!cash.ok) return cash;
  const sid = String(payload.movementId || '').trim();
  if (!sid) return { ok: false, error: 'movementId required.' };
  return postBalancedJournalTx(db, {
    entryDateISO: String(payload.entryDateISO || '').slice(0, 10),
    memo: `Payroll net payment ${payload.runId}`,
    sourceKind: 'HR_PAYROLL_PAYMENT_GL',
    sourceId: sid,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: [
      { accountCode: '2200', debitNgn: amt, memo: payload.runId },
      { accountCode: cash.accountCode, creditNgn: amt, memo: sid },
    ],
  });
}

/**
 * PAYE / pension remittance to authority (clears payables).
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   entryDateISO: string;
 *   treasuryAccountId: number;
 *   payeNgn?: number;
 *   pensionNgn?: number;
 *   sourceId: string;
 *   memo?: string;
 *   createdByUserId?: string | null;
 *   branchId?: string | null;
 * }} payload
 */
export function tryPostPayrollStatutoryRemittanceGlTx(db, payload) {
  const paye = Math.round(Number(payload.payeNgn) || 0);
  const pension = Math.round(Number(payload.pensionNgn) || 0);
  const total = paye + pension;
  if (total <= 0) return { ok: false, error: 'Enter PAYE and/or pension amount to remit.' };
  const cash = ensureTreasuryCashGlAccount(db, payload.treasuryAccountId);
  if (!cash.ok) return cash;
  const lines = [];
  if (paye > 0) lines.push({ accountCode: '2300', debitNgn: paye, memo: 'PAYE remittance' });
  if (pension > 0) lines.push({ accountCode: '2400', debitNgn: pension, memo: 'Pension remittance' });
  lines.push({ accountCode: cash.accountCode, creditNgn: total, memo: payload.sourceId });
  return postBalancedJournalTx(db, {
    entryDateISO: String(payload.entryDateISO || '').slice(0, 10),
    memo: payload.memo || 'Payroll statutory remittance',
    sourceKind: 'HR_PAYROLL_REMITTANCE_GL',
    sourceId: String(payload.sourceId || '').trim() || `REMIT-${payload.entryDateISO}`,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines,
  });
}

/** @param {import('better-sqlite3').Database} db @param {string} runId */
export function payrollGlStatusForRun(db, runId) {
  const accrual = db
    .prepare(`SELECT id, entry_date_iso FROM gl_journal_entries WHERE source_kind = 'HR_PAYROLL_ACCRUAL_GL' AND source_id = ?`)
    .get(runId);
  const payment = db
    .prepare(
      `SELECT je.id, je.entry_date_iso FROM gl_journal_entries je
       JOIN treasury_movements tm ON tm.id = je.source_id
       WHERE je.source_kind = 'HR_PAYROLL_PAYMENT_GL' AND tm.source_kind = 'HR_PAYROLL_RUN' AND tm.source_id = ?`
    )
    .get(runId);
  return {
    ok: true,
    runId,
    accrualPosted: Boolean(accrual),
    accrualJournalId: accrual?.id ?? null,
    netPaymentPosted: Boolean(payment),
    paymentJournalId: payment?.id ?? null,
  };
}
