/**
 * Manager queue counts from workspace snapshot (mirrors buildManagementQueuesFromSnapshot filters).
 * Keep in sync: frontend src/lib/managementQueueCounts.js ↔ backend shared/lib/managementQueueCounts.js
 */
import {
  cuttingListInProductionGate,
  quotationIsFlaggedForAudit,
  quotationNeedsManagerClearance,
} from './managementQueueFilters.js';

/**
 * @param {object | null | undefined} snapshot
 */
export function getManagementQueueCounts(snapshot) {
  const quotations = Array.isArray(snapshot?.quotations) ? snapshot.quotations : [];
  const cuttingLists = Array.isArray(snapshot?.cuttingLists) ? snapshot.cuttingLists : [];
  const refunds = Array.isArray(snapshot?.refunds) ? snapshot.refunds : [];
  const paymentRequests = Array.isArray(snapshot?.paymentRequests) ? snapshot.paymentRequests : [];
  const productionJobs = Array.isArray(snapshot?.productionJobs) ? snapshot.productionJobs : [];

  const quoteById = new Map(quotations.map((q) => [q.id, q]));

  const signOff = quotations.filter((q) => quotationNeedsManagerClearance(q)).length;
  const flagged = quotations.filter((q) => quotationIsFlaggedForAudit(q)).length;
  const prodGate = cuttingLists.filter((cl) => cuttingListInProductionGate(cl, quoteById.get(cl.quotationRef))).length;

  const pendingRefunds = refunds.filter((r) => String(r.status) === 'Pending').length;

  const pendingExpenses = paymentRequests.filter(
    (pr) => String(pr.approvalStatus || '').toLowerCase() === 'pending'
  ).length;

  const qc = productionJobs.filter(
    (j) =>
      String(j.status) === 'Completed' &&
      !String(j.managerReviewSignedAtISO || '').trim() &&
      (Boolean(j.managerReviewRequired) ||
        j.conversionAlertState === 'High' ||
        j.conversionAlertState === 'Low')
  ).length;

  return { signOff, flagged, prodGate, pendingRefunds, pendingExpenses, qc };
}
