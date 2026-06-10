/**
 * Manager queue inclusion rules — keep in sync with frontend src/lib/managementQueueFilters.js
 */
import { isEffectivelyFullyPaid } from './paymentOutstandingTolerance.js';

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

/** Draft cutting list blocked by the sub-70% payment rule (99.5% fully paid quotes are excluded). */
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

/** Collections follow-up — skip quotes treated as fully paid under the 99.5% rule. */
export function quotationIsOverdueForCollections(q, todayIso) {
  const total = Number(q?.totalNgn ?? q?.total_ngn) || 0;
  const paid = Number(q?.paidNgn ?? q?.paid_ngn) || 0;
  if (isEffectivelyFullyPaid(paid, total)) return false;
  if (String(q?.paymentStatus || '').trim().toLowerCase() === 'paid') return false;
  const due = q?.dueDateISO ?? q?.due_date_iso;
  if (!due) return false;
  return String(due).slice(0, 10) < String(todayIso).slice(0, 10);
}
