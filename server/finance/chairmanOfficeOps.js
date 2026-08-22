/**
 * Chairman Office — company pulse impact, family/household load, drawings (GL 3200), and loans (GL 1200).
 * Withdrawals are payment requests with category "Chairman withdrawal" (equity, not P&L).
 * Loans are payment requests with category "Chairman loan" (receivable, not a staff payroll loan).
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { insertPaymentRequest } from '../controlOps.js';
import { trialBalanceRows } from '../glOps.js';
import {
  getExecutiveDomesticDashboard,
  getExecutiveFamilyDashboard,
  summarizeExecutivePaymentsForExecutive,
} from '../hrExecutiveBenefitsOps.js';
import { listTreasuryAccounts } from '../readModel.js';
import {
  CHAIRMAN_OFFICE_ROLE_KEYS,
  userMayAccessChairmanOffice,
  userMayRequestChairmanWithdrawal,
} from './chairmanOfficeAccess.js';
import {
  listChairmanOfficeLoans,
  summarizeChairmanOfficeLoans,
} from './chairmanOfficeLoansOps.js';
import { loadPaymentRequestTimelines } from './paymentRequestTimelineOps.js';

export { CHAIRMAN_OFFICE_ROLE_KEYS, userMayAccessChairmanOffice, userMayRequestChairmanWithdrawal };

export const CHAIRMAN_WITHDRAWAL_CATEGORY = 'Chairman withdrawal';
export const CHAIRMAN_LINKED_EXECUTIVE = 'Chairman';

const WITHDRAWAL_LIST_CAP = 200;

function roundNgn(n) {
  return Math.round(Number(n) || 0);
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthBounds(isoDate) {
  const raw = String(isoDate || todayIso()).slice(0, 10);
  const y = raw.slice(0, 4);
  const m = raw.slice(5, 7);
  const last = new Date(Number(y), Number(m), 0).getDate();
  return {
    periodKey: `${y}-${m}`,
    start: `${y}-${m}-01`,
    end: `${y}-${m}-${String(last).padStart(2, '0')}`,
    yearStart: `${y}-01-01`,
  };
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    return false;
  }
}

/**
 * Equity-type GL balance (credit − debit). Drawings taken is the opposite (debit − credit).
 * @param {{ debitNgn?: number; creditNgn?: number } | null | undefined} row
 */
export function equityCreditBalanceNgn(row) {
  return roundNgn(row?.creditNgn) - roundNgn(row?.debitNgn);
}

/**
 * Amount drawn from 3200 Drawings (debit − credit). Positive when cash has left the company.
 * @param {{ debitNgn?: number; creditNgn?: number } | null | undefined} row
 */
export function drawingsTakenNgn(row) {
  return Math.max(0, roundNgn(row?.debitNgn) - roundNgn(row?.creditNgn));
}

/**
 * Cash left if pending drawings and this request both pay out.
 * @param {number} treasuryCashNgn
 * @param {number} pendingDrawingsNgn
 * @param {number} [requestedNgn]
 */
export function remainingCashAfterDraw(treasuryCashNgn, pendingDrawingsNgn, requestedNgn = 0) {
  return roundNgn(treasuryCashNgn) - roundNgn(pendingDrawingsNgn) - roundNgn(requestedNgn);
}

function glRow(tb, code) {
  return (tb?.ok && Array.isArray(tb.rows) ? tb.rows : []).find((r) => String(r.accountCode) === code) || null;
}

function listChairmanWithdrawalRequests(db) {
  if (!tableExists(db, 'payment_requests') || !tableExists(db, 'expenses')) return [];
  return db
    .prepare(
      `SELECT pr.request_id, pr.amount_requested_ngn, pr.request_date, pr.approval_status,
              pr.description, pr.approved_by, pr.approved_at_iso, pr.approval_note,
              pr.paid_amount_ngn, pr.paid_at_iso, pr.paid_by, pr.payee_name, pr.payee_account_no,
              pr.payee_bank_name, pr.payment_note,
              e.category AS expense_category, e.branch_id
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE e.category = ?
       ORDER BY pr.request_date DESC, pr.request_id DESC
       LIMIT ?`
    )
    .all(CHAIRMAN_WITHDRAWAL_CATEGORY, WITHDRAWAL_LIST_CAP)
    .map((row) => {
      const requested = roundNgn(row.amount_requested_ngn);
      const paid = roundNgn(row.paid_amount_ngn);
      const status = String(row.approval_status || '').trim() || 'Pending';
      const unpaid = paid < requested && status.toLowerCase() !== 'rejected';
      return {
        requestID: row.request_id,
        amountRequestedNgn: requested,
        paidAmountNgn: paid,
        outstandingNgn: Math.max(0, requested - paid),
        requestDate: row.request_date || '',
        approvalStatus: status,
        description: row.description || '',
        approvedBy: row.approved_by || '',
        approvedAtISO: row.approved_at_iso || '',
        approvalNote: row.approval_note || '',
        paidAtISO: row.paid_at_iso || '',
        paidBy: row.paid_by || '',
        payeeName: row.payee_name || '',
        payeeBankName: row.payee_bank_name || '',
        payeeAccountNo: row.payee_account_no || '',
        paymentNote: row.payment_note || '',
        branchId: row.branch_id || '',
        unpaid,
        hitsGl: paid > 0,
      };
    });
}

function listHrChairmanExpenses(db, periodYyyymm) {
  if (!tableExists(db, 'hr_chairman_expenses')) return [];
  const period = String(periodYyyymm || '').trim();
  const compact = period.replace(/\D/g, '').slice(0, 6);
  const dashed = compact.length === 6 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : period;
  const rows = period
    ? db
        .prepare(
          `SELECT id, expense_type, description, amount_ngn, period_yyyymm, payment_status, payment_date_iso, vendor_name
           FROM hr_chairman_expenses
           WHERE period_yyyymm = ? OR period_yyyymm = ?
           ORDER BY created_at_iso DESC LIMIT 50`
        )
        .all(dashed, compact)
    : db
        .prepare(
          `SELECT id, expense_type, description, amount_ngn, period_yyyymm, payment_status, payment_date_iso, vendor_name
           FROM hr_chairman_expenses ORDER BY created_at_iso DESC LIMIT 50`
        )
        .all();
  return rows.map((row) => ({
    id: row.id,
    expenseType: row.expense_type || '',
    description: row.description || '',
    amountNgn: roundNgn(row.amount_ngn),
    periodYyyymm: row.period_yyyymm || '',
    paymentStatus: row.payment_status || '',
    paymentDateIso: row.payment_date_iso || '',
    vendorName: row.vendor_name || '',
  }));
}

/**
 * Chairman Office snapshot: impact strip, equity, and withdrawal trail.
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {{ asOfIso?: string }} [opts]
 */
export function buildChairmanOffice(db, user, opts = {}) {
  const asOf = String(opts.asOfIso || todayIso()).slice(0, 10);
  const bounds = monthBounds(asOf);
  const family = getExecutiveFamilyDashboard(db, { linkedExecutive: CHAIRMAN_LINKED_EXECUTIVE });
  const domestic = getExecutiveDomesticDashboard(db, { assignedExecutive: CHAIRMAN_LINKED_EXECUTIVE });

  const householdMonthlyNgn = roundNgn(domestic?.summary?.totalMonthlySalaryNgn);
  const paid = summarizeExecutivePaymentsForExecutive(db, {
    linkedExecutive: CHAIRMAN_LINKED_EXECUTIVE,
    periodYyyymm: bounds.periodKey,
    yearPrefix: bounds.yearStart.slice(0, 4),
  });
  const householdPaidThisMonthNgn = paid.householdPaidMonthNgn;
  const scholarshipMonthlyNgn = roundNgn(family?.summary?.totalMonthlyAllowanceNgn);
  const scholarshipPaidThisMonthNgn = paid.scholarshipPaidMonthNgn;
  const pendingSchoolFeesNgn = (family?.children || []).reduce(
    (sum, c) => sum + roundNgn(c.schoolFees?.pending?.amountNgn),
    0
  );

  const ytdTb = trialBalanceRows(db, bounds.yearStart, asOf, { branchScope: 'ALL' });
  const monthTb = trialBalanceRows(db, bounds.start, bounds.end, { branchScope: 'ALL' });
  const drawingsYtdNgn = drawingsTakenNgn(glRow(ytdTb, '3200'));
  const drawingsMonthNgn = drawingsTakenNgn(glRow(monthTb, '3200'));
  const capitalNgn = equityCreditBalanceNgn(glRow(ytdTb, '3100'));
  const retainedEarningsNgn = equityCreditBalanceNgn(glRow(ytdTb, '3900'));

  const withdrawals = listChairmanWithdrawalRequests(db);
  const withdrawalTimelines = loadPaymentRequestTimelines(
    db,
    withdrawals.map((w) => w.requestID),
    { glCode: '3200', glLabel: 'Drawings' }
  );
  for (const w of withdrawals) {
    w.timeline = withdrawalTimelines.get(w.requestID) || [];
    w.howApprove =
      'MD or Finance approve this payment request (special drawings lane). Approval does not move cash.';
    w.howPay =
      'Cashier pays from a treasury till or bank (finance.pay). GL 3200 Drawings — equity, not profit.';
  }
  const pendingWithdrawals = withdrawals.filter((w) => w.unpaid);
  const pendingWithdrawalsNgn = pendingWithdrawals.reduce((sum, w) => sum + w.outstandingNgn, 0);
  const pendingWithdrawalsCount = pendingWithdrawals.length;

  const loans = listChairmanOfficeLoans(db);
  const loanSummary = summarizeChairmanOfficeLoans(loans);

  const treasuryCashNgn = listTreasuryAccounts(db, 'ALL').reduce(
    (sum, a) => sum + roundNgn(a.balance),
    0
  );
  const cashAfterPendingNgn = remainingCashAfterDraw(
    treasuryCashNgn,
    pendingWithdrawalsNgn + paid.pendingBenefitPaymentsNgn + loanSummary.pendingDisbursementNgn,
    0
  );

  const hrExpenses = listHrChairmanExpenses(db, bounds.periodKey);
  const hrExpensesMonthNgn = hrExpenses.reduce((sum, e) => sum + e.amountNgn, 0);

  const totalOwnerLoadMonthNgn =
    householdPaidThisMonthNgn + scholarshipPaidThisMonthNgn + drawingsMonthNgn;

  return {
    asOfIso: asOf,
    periodKey: bounds.periodKey,
    linkedExecutive: CHAIRMAN_LINKED_EXECUTIVE,
    canRequestWithdrawal: userMayRequestChairmanWithdrawal(user),
    canRequestLoan: userMayRequestChairmanWithdrawal(user),
    impact: {
      householdMonthlyNgn,
      householdPaidThisMonthNgn,
      householdPaidYtdNgn: paid.householdPaidYtdNgn,
      householdStaffCount: Number(domestic?.summary?.staffCount) || 0,
      scholarshipMonthlyNgn,
      scholarshipPaidThisMonthNgn,
      scholarshipPaidYtdNgn: paid.scholarshipPaidYtdNgn,
      pendingBenefitPaymentsNgn: paid.pendingBenefitPaymentsNgn,
      pendingBenefitPaymentCount: paid.pendingBenefitPaymentCount,
      pendingSchoolFeesNgn,
      pendingFeeCount: Number(family?.summary?.pendingFeeCount) || 0,
      childCount: Number(family?.summary?.childCount) || 0,
      drawingsMonthNgn,
      drawingsYtdNgn,
      pendingWithdrawalsNgn,
      pendingWithdrawalsCount,
      pendingLoanDisbursementNgn: loanSummary.pendingDisbursementNgn,
      pendingLoanCount: loanSummary.pendingCount,
      loansOutstandingNgn: loanSummary.outstandingNgn,
      hrExpensesMonthNgn,
      totalOwnerLoadMonthNgn,
      treasuryCashNgn,
      cashAfterPendingNgn,
    },
    equity: {
      capitalNgn,
      drawingsYtdNgn,
      retainedEarningsNgn,
      /** Capital − drawings YTD; retained earnings shown separately. */
      capitalNetOfDrawingsNgn: capitalNgn - drawingsYtdNgn,
    },
    withdrawals,
    loans,
    hrExpenses,
  };
}

/**
 * Create a Chairman withdrawal payment request (GL 3200 on payout).
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 */
export function requestChairmanWithdrawal(db, user, body = {}) {
  if (!userMayRequestChairmanWithdrawal(user)) {
    return { ok: false, error: 'You cannot request a chairman withdrawal.', code: 'FORBIDDEN' };
  }
  const amountNgn = roundNgn(body.amountNgn ?? body.amount);
  if (amountNgn <= 0) {
    return { ok: false, error: 'Enter a withdrawal amount greater than zero.', code: 'VALIDATION_ERROR' };
  }
  const reason = String(body.reason || body.description || '').trim();
  if (reason.length < 8) {
    return {
      ok: false,
      error: 'Add a short reason (at least 8 characters) so finance can post this as drawings.',
      code: 'VALIDATION_ERROR',
    };
  }
  const payeeName = String(body.payeeName || user?.displayName || 'Chairman').trim();
  const payeeAccountNo = String(body.payeeAccountNo || '').trim();
  const payeeBankName = String(body.payeeBankName || '').trim();
  const branchId = String(body.workspaceBranchId || body.branchId || '').trim() || DEFAULT_BRANCH_ID;
  const requestDate = String(body.requestDate || todayIso()).slice(0, 10);

  const inserted = insertPaymentRequest(
    db,
    {
      expenseCategory: CHAIRMAN_WITHDRAWAL_CATEGORY,
      description: `Chairman withdrawal — ${reason}`,
      categoryJustification: reason,
      requestDate,
      workspaceBranchId: branchId,
      payeeName,
      payeeAccountNo,
      payeeBankName,
      lineItems: [
        {
          item: reason,
          unit: 1,
          unitPriceNgn: amountNgn,
          lineTotalNgn: amountNgn,
        },
      ],
    },
    user
  );
  if (!inserted?.ok) {
    return { ok: false, error: inserted?.error || 'Could not create the withdrawal request.', code: 'REQUEST_FAILED' };
  }

  const office = buildChairmanOffice(db, user);
  return {
    ok: true,
    requestID: inserted.requestID,
    office,
  };
}
