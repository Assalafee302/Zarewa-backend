/**
 * Accounting Policy v1 — read-only payment / receivable presentation (AP1a).
 * Does not change posting, gates, or ledger math.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/accountingPolicyV1.js
 */
import {
  amountDueOnQuotationFromEntries,
  quotationHasCompletedProduction,
  receivableDueOnQuotationFromEntries,
} from './customerLedgerCore.js';
import { isEffectivelyFullyPaid } from './paymentOutstandingTolerance.js';

/** @typedef {'pre_production' | 'post_production'} QuotationPaymentPolicyPhase */
/** @typedef {'deposit_settled' | 'deposit_pending' | 'no_balance' | 'receivable' | 'settled'} QuotationBalanceLabel */

/**
 * @param {string} quotationRef
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number }>} [productionJobs]
 * @returns {QuotationPaymentPolicyPhase}
 */
export function quotationPaymentPolicyPhase(quotationRef, productionJobs = []) {
  return quotationHasCompletedProduction(quotationRef, productionJobs)
    ? 'post_production'
    : 'pre_production';
}

/**
 * @param {{ id: string, totalNgn?: number, paidNgn?: number }} q
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>} [productionJobs]
 */
export function quotationPaymentPolicySnapshot(q, productionJobs = []) {
  const id = String(q?.id || '').trim();
  const phase = quotationPaymentPolicyPhase(id, productionJobs);
  const totalNgn = Math.round(Number(q?.totalNgn) || 0);
  const paidNgn = Math.round(Number(q?.paidNgn) || 0);
  const legacyAmountDueNgn = amountDueOnQuotationFromEntries(null, q);
  const receivableNgn = receivableDueOnQuotationFromEntries(null, q, productionJobs);

  if (phase === 'pre_production') {
    /** @type {QuotationBalanceLabel} */
    const balanceLabel = isEffectivelyFullyPaid(paidNgn, totalNgn)
      ? 'deposit_settled'
      : legacyAmountDueNgn > 0
        ? 'deposit_pending'
        : 'no_balance';
    return {
      policyPhase: phase,
      totalNgn,
      paidNgn,
      depositOnAccountNgn: paidNgn,
      depositPendingNgn: legacyAmountDueNgn,
      receivableNgn: 0,
      amountDueNgn: legacyAmountDueNgn,
      balanceLabel,
      amountDueLegacyNote:
        'Before production completes, balance to pay is a deposit commitment — not accounts receivable.',
    };
  }

  /** @type {QuotationBalanceLabel} */
  const balanceLabel = receivableNgn > 0 ? 'receivable' : 'settled';
  return {
    policyPhase: phase,
    totalNgn,
    paidNgn,
    depositOnAccountNgn: 0,
    depositPendingNgn: 0,
    receivableNgn,
    amountDueNgn: receivableNgn,
    balanceLabel,
    amountDueLegacyNote:
      legacyAmountDueNgn !== receivableNgn
        ? 'After production, use receivableNgn (not pre-production deposit pending).'
        : null,
  };
}

/** Human-readable label for UI when Policy v1 labels are enabled. */
export function policyBalanceLabelText(balanceLabel) {
  switch (balanceLabel) {
    case 'deposit_settled':
      return 'Deposit on account (settled)';
    case 'deposit_pending':
      return 'Deposit pending';
    case 'receivable':
      return 'Receivable';
    case 'settled':
      return 'Settled';
    case 'no_balance':
      return 'No balance';
    default:
      return 'Balance';
  }
}
