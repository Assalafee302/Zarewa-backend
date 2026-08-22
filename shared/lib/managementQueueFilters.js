/**
 * Manager queue inclusion rules.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/managementQueueFilters.js
 */
import { effectiveOutstandingNgn, isEffectivelyFullyPaid } from './paymentOutstandingTolerance.js';
import { accountingReceivableOutstandingNgn, quotationWaivedBalanceNgn } from './customerLedgerCore.js';

/** Paid quotation awaiting branch manager clearance (any payment counts). */
export function quotationNeedsManagerClearance(q) {
  if ((Number(q?.paidNgn ?? q?.paid_ngn) || 0) <= 0) return false;
  if (q?.managerClearedAtISO ?? q?.manager_cleared_at_iso) return false;
  if (q?.managerFlaggedAtISO ?? q?.manager_flagged_at_iso) return false;
  return true;
}

export function quotationIsFlaggedForAudit(q) {
  return Boolean(q?.managerFlaggedAtISO ?? q?.manager_flagged_at_iso);
}

/** Draft cutting list blocked by the sub-70% payment rule (₦1 residual counts as fully paid). */
export function cuttingListInProductionGate(cl, q) {
  if (String(cl?.status || '').trim() !== 'Draft') return false;
  if (!q) return false;
  const total = Number(q.totalNgn ?? q.total_ngn) || 0;
  const paid = Number(q.paidNgn ?? q.paid_ngn) || 0;
  if (total <= 0) return false;
  if (q.managerProductionApprovedAtISO ?? q.manager_production_approved_at_iso) return false;
  if (isEffectivelyFullyPaid(paid, total)) return false;
  if (paid >= total * 0.7) return false;
  return true;
}

/** Collections follow-up — skip when no accounting receivable and no operational balance due. */
export function quotationIsOverdueForCollections(q, todayIso) {
  const total = Number(q?.totalNgn ?? q?.total_ngn) || 0;
  const paid = Number(q?.paidNgn ?? q?.paid_ngn) || 0;
  if (isEffectivelyFullyPaid(paid, total)) return false;
  const receivable = accountingReceivableOutstandingNgn(total, paid, quotationWaivedBalanceNgn(q));
  const opsDue = effectiveOutstandingNgn(total, paid);
  if (receivable <= 0 && opsDue <= 0) return false;
  if (String(q?.paymentStatus || '').trim().toLowerCase() === 'paid') return false;
  const due = q?.dueDateISO ?? q?.due_date_iso;
  if (!due) return false;
  return String(due).slice(0, 10) < String(todayIso).slice(0, 10);
}
