/**
 * Staff loan deduction schedule views (Phase 5).
 * @module server/hrLoanSchedule
 */

import { hrTablesReady, listHrRequests } from './hrOps.js';

export function getStaffLoanSchedule(db, userId) {
  if (!hrTablesReady(db)) return [];
  const loans = listHrRequests(db, { viewAll: true }, { userId, kind: 'loan' }).filter(
    (r) => r.status === 'approved' || r.status === 'paid' || r.status === 'completed'
  );
  return loans.map((r) => {
    const payload = r.payload || {};
    const amount = Math.round(Number(payload.amountNgn ?? payload.loanAmountNgn) || 0);
    const months = Math.round(Number(payload.repaymentMonths ?? payload.loanMonths) || 0);
    const monthly = Math.round(Number(payload.deductionPerMonthNgn ?? payload.monthlyDeductionNgn) || 0);
    const paidMonths = Math.round(Number(payload.loanMonthsDeducted) || 0);
    const outstanding = Math.round(Number(payload.principalOutstandingNgn) || Math.max(0, amount - paidMonths * monthly));
    const deductionsActive = payload.deductionsActive !== false && outstanding > 0;
    return {
      requestId: r.id,
      title: payload.loanTitle || payload.purpose || 'Staff loan',
      amountNgn: amount,
      repaymentMonths: months,
      monthlyDeductionNgn: monthly,
      monthsPaid: paidMonths,
      outstandingNgn: outstanding,
      deductionsActive,
      status: outstanding <= 0 ? 'paid_off' : deductionsActive ? 'active' : 'inactive',
      disbursedAtIso: payload.loanDisbursedAtIso || r.updatedAtIso,
    };
  });
}

export function listLoanScheduleIssues(db) {
  if (!hrTablesReady(db)) return [];
  const issues = [];
  const staffIds = new Set(
    db.prepare(`SELECT user_id FROM hr_staff_profiles`).all().map((r) => r.user_id)
  );
  for (const uid of staffIds) {
    for (const loan of getStaffLoanSchedule(db, uid)) {
      if (loan.status === 'active' && !loan.monthlyDeductionNgn) {
        issues.push({ userId: uid, requestId: loan.requestId, issue: 'missing_deduction_schedule' });
      }
      if (loan.outstandingNgn <= 0 && loan.deductionsActive) {
        issues.push({ userId: uid, requestId: loan.requestId, issue: 'paid_but_active' });
      }
    }
  }
  return issues.slice(0, 100);
}
