/**
 * Phase B — month-end close checklist (read-only gates).
 */
import { monthBounds, getAccountingStatementsPack } from './accountingStatementsOps.js';
import { ACCOUNTING_OPENING_DATE_LABEL } from '../shared/lib/accountingCutover.js';
import { getOpeningBalanceStatus } from './accountingPostingOps.js';
import { previewDepreciationRun } from './depreciationRunOps.js';
import { trialBalanceRows } from './glOps.js';

/**
 * @param {'ok'|'warn'|'fail'} status
 * @param {string} id
 * @param {string} label
 * @param {string} detail
 * @param {string} [focusTab]
 */
function step(status, id, label, detail, focusTab = '') {
  return { id, label, status, detail, focusTab };
}

export function buildPeriodLockCloseMeta(periodKey, periodLockRow, ready) {
  const periodLock = periodLockRow || { locked: false, periodKey };
  if (periodLockRow?.locked) {
    return {
      periodLock: periodLockRow,
      readyToLock: false,
      periodLockStep: step(
        'ok',
        'period_lock',
        'Period locked',
        `${periodLockRow.reason || 'Locked'} · ${periodLockRow.lockedByName || 'Finance'}`,
        ''
      ),
      summary: `Period ${periodKey} is locked.`,
    };
  }
  if (ready) {
    return {
      periodLock,
      readyToLock: true,
      periodLockStep: step(
        'warn',
        'period_lock',
        'Lock accounting period',
        'Checklist clear — lock this period to block backdated GL postings and corrections.',
        ''
      ),
      summary: 'All close checks passed — lock the period when HoA sign-off is complete.',
    };
  }
  return {
    periodLock,
    readyToLock: false,
    periodLockStep: step(
      'warn',
      'period_lock',
      'Period open',
      'Resolve blockers and warnings before locking this period.',
      ''
    ),
    summary: null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 */
export function getPeriodLock(db, periodKey) {
  try {
    const row = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
    if (!row) return null;
    return {
      locked: true,
      periodKey: row.period_key,
      lockedAtISO: row.locked_at_iso,
      lockedByName: row.locked_by_name ?? '',
      reason: row.reason ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} periodKey
 * @param {'ALL' | string} branchScope
 * @param {{ trialExceptions?: object }} [opts]
 */
export function buildMonthEndCloseChecklist(db, periodKey, branchScope = 'ALL', opts = {}) {
  const b = monthBounds(periodKey);
  if (!b) return { ok: false, error: 'periodKey must be YYYY-MM.' };

  const steps = [];
  const ex = opts.trialExceptions?.exceptions || opts.trialExceptions || {};

  const opening = getOpeningBalanceStatus(db);
  steps.push(
    step(
      opening.posted ? 'ok' : 'warn',
      'opening_balance',
      'Opening balance posted',
      opening.posted ? 'Cutover journal exists in GL.' : `Post ${ACCOUNTING_OPENING_DATE_LABEL} opening balance before first close.`,
      'opening'
    )
  );

  const pendingReceipts = Number(ex.pendingReceiptClearance) || 0;
  steps.push(
    step(
      pendingReceipts === 0 ? 'ok' : 'warn',
      'receipt_clearance',
      'Receipts confirmed',
      pendingReceipts === 0 ? 'No receipts awaiting cashier confirmation.' : `${pendingReceipts} receipt(s) still pending confirmation.`,
      'overview'
    )
  );

  const ap1c = opts.trialExceptions?.ap1cDryRun;
  const legacyReceiptGl =
    !opts.trialExceptions?.flags?.accountingPolicyV1ReceiptGl &&
    Number(ap1c?.receiptsBeforeProductionCredited1200Count) > 0;
  if (legacyReceiptGl || (ap1c?.available && Number(ap1c?.receiptsBeforeProductionCredited1200Count) > 0)) {
    steps.push(
      step(
        'warn',
        'receipt_policy',
        'Receipt / deposit policy',
        `${ap1c?.receiptsBeforeProductionCredited1200Count ?? '?'} receipt(s) credited to AR before production — review Policy tab before cutover.`,
        'policy'
      )
    );
  }

  const depPreview = previewDepreciationRun(db, periodKey, branchScope);
  if (depPreview.ok && depPreview.totalDepreciationNgn > 0) {
    const sid = `${b.periodKey}:${branchScope || 'ALL'}`;
    const depPosted = Boolean(
      db
        .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'DEPRECIATION_RUN' AND source_id = ?`)
        .get(sid)
    );
    steps.push(
      step(
        depPosted ? 'ok' : 'warn',
        'depreciation',
        'Depreciation posted',
        depPosted
          ? `Depreciation ₦${depPreview.totalDepreciationNgn.toLocaleString('en-NG')} posted for ${periodKey}.`
          : `₦${depPreview.totalDepreciationNgn.toLocaleString('en-NG')} depreciation due — post from Fixed assets.`,
        'assets'
      )
    );
  } else {
    steps.push(
      step('ok', 'depreciation', 'Depreciation posted', 'No depreciation due this period.', 'assets')
    );
  }

  let payrollRuns = [];
  try {
    payrollRuns = db
      .prepare(
        `SELECT id, status FROM hr_payroll_runs WHERE period_yyyymm = ? AND status IN ('locked','paid')`
      )
      .all(b.periodKey);
  } catch {
    payrollRuns = [];
  }
  let payrollMissingAccrual = 0;
  for (const r of payrollRuns) {
    const has = db
      .prepare(`SELECT 1 FROM gl_journal_entries WHERE source_kind = 'HR_PAYROLL_ACCRUAL_GL' AND source_id = ?`)
      .get(r.id);
    if (!has) payrollMissingAccrual += 1;
  }
  steps.push(
    step(
      payrollRuns.length === 0 ? 'ok' : payrollMissingAccrual === 0 ? 'ok' : 'warn',
      'payroll_accrual',
      'Payroll accrual in GL',
      payrollRuns.length === 0
        ? 'No locked/paid payroll run for this period.'
        : payrollMissingAccrual === 0
          ? `${payrollRuns.length} run(s) accrued to GL.`
          : `${payrollMissingAccrual} run(s) missing accrual journal — lock/repost from Payroll tab.`,
      'payroll'
    )
  );

  const tb = trialBalanceRows(db, b.start, b.end);
  let glBalanced = true;
  if (tb.ok && Array.isArray(tb.rows)) {
    let d = 0;
    let c = 0;
    for (const r of tb.rows) {
      d += Math.round(Number(r.debitNgn) || 0);
      c += Math.round(Number(r.creditNgn) || 0);
    }
    glBalanced = d === c;
  }
  steps.push(
    step(
      glBalanced ? 'ok' : 'fail',
      'gl_activity',
      'GL period activity balanced',
      glBalanced ? 'Total debits equal credits for period journals.' : 'GL activity out of balance — review journals.',
      'gl'
    )
  );

  const statements = getAccountingStatementsPack(db, periodKey, branchScope);
  const bsBalanced = statements.ok ? Boolean(statements.balanceSheet?.balanced) : false;
  steps.push(
    step(
      statements.ok ? (bsBalanced ? 'ok' : 'warn') : 'fail',
      'statements',
      'Draft statements',
      statements.ok
        ? bsBalanced
          ? 'P&L and balance sheet generated; BS equation holds on GL data.'
          : 'Statements generated but assets ≠ liabilities + equity — complete GL postings.'
        : statements.error || 'Could not build statements.',
      'statements'
    )
  );

  const mismatch = Number(ex.receiptBankAmountMismatch) || 0;
  if (mismatch > 0) {
    steps.push(
      step(
        'warn',
        'receipt_mismatch',
        'Receipt bank mismatches',
        `${mismatch} receipt(s) with bank amount variance.`,
        'overview'
      )
    );
  }

  const blockers = steps.filter((s) => s.status === 'fail').length;
  const warnings = steps.filter((s) => s.status === 'warn').length;
  const ready = blockers === 0 && warnings === 0;

  const periodLock = getPeriodLock(db, b.periodKey);
  const lockMeta = buildPeriodLockCloseMeta(b.periodKey, periodLock, ready);
  steps.push(lockMeta.periodLockStep);

  return {
    ok: true,
    periodKey: b.periodKey,
    range: { start: b.start, end: b.end },
    branchScope,
    ready,
    readyToLock: lockMeta.readyToLock,
    periodLock: lockMeta.periodLock,
    blockers,
    warnings,
    steps,
    summary:
      lockMeta.summary ??
      (ready
        ? 'All close checks passed — lock the period when HoA sign-off is complete.'
        : `${blockers} blocker(s), ${warnings} warning(s) — resolve before locking the period.`),
  };
}
