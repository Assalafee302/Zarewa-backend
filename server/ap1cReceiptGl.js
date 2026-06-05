/**
 * AP1c-2 — Policy v1 customer receipt GL credit account selection.
 */
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { inferProductionCompletedAtReceipt } from './receiptPolicyMetaOps.js';
import { listProductionJobs } from './readModel.js';

/** @typedef {'1200' | '2500'} ReceiptGlCreditAccount */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quotationRef?: string | null,
 *   entryDateISO?: string | null,
 *   receiptAtISO?: string | null,
 * }} ctx
 * @returns {ReceiptGlCreditAccount}
 */
export function resolveCustomerReceiptGlCreditAccount(db, ctx = {}) {
  const flags = readFinanceFeatureFlags();
  if (!flags.accountingPolicyV1ReceiptGl) return '1200';

  const qref = String(ctx.quotationRef || '').trim();
  if (!qref) return '1200';

  const receiptAt = ctx.receiptAtISO || ctx.entryDateISO || '';
  const jobs = listProductionJobs(db, 'ALL').filter(
    (j) => String(j.quotationRef || j.quotation_ref || '').trim() === qref
  );
  const prodComplete = inferProductionCompletedAtReceipt(qref, receiptAt, jobs);
  if (prodComplete === true) return '1200';
  return '2500';
}
