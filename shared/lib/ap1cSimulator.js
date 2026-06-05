/**
 * AP1c — pure Policy v1 GL simulators (read-only; no posting).
 */
import {
  firstProductionDateISO,
  quotationHasCompletedProduction,
} from './customerLedgerCore.js';

/** @typedef {'2500' | '1200'} Ap1cCreditAccountCode */
/** @typedef {'pre_production' | 'post_production'} Ap1cReceiptProductionPhase */

function toIsoDateOnly(iso) {
  const s = String(iso || '').trim();
  if (!s) return '';
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/**
 * Whether production was complete at receipt time (by earliest completed job date).
 * @param {string} quotationRef
 * @param {string} receiptAtISO
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>} productionJobs
 */
export function productionStatusAtReceipt(quotationRef, receiptAtISO, productionJobs = []) {
  const receiptDay = toIsoDateOnly(receiptAtISO);
  const firstProd = firstProductionDateISO(quotationRef, productionJobs);
  if (!firstProd) return 'pre_production';
  if (!receiptDay) {
    return quotationHasCompletedProduction(quotationRef, productionJobs)
      ? 'post_production'
      : 'pre_production';
  }
  return receiptDay >= firstProd ? 'post_production' : 'pre_production';
}

/**
 * Policy v1 credit account for a customer receipt at treasury post time.
 * @param {{
 *   quotationRef?: string,
 *   receiptAtISO?: string,
 *   productionJobs?: Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>,
 * }} input
 */
export function simulateReceiptCreditAccount(input) {
  const qref = String(input?.quotationRef || '').trim();
  const jobs = input?.productionJobs || [];
  if (!qref) {
    return {
      ok: false,
      warning: 'missing_quotation_ref',
      policyCreditAccount: null,
      productionPhaseAtReceipt: null,
    };
  }
  const phase = productionStatusAtReceipt(qref, input?.receiptAtISO, jobs);
  /** @type {Ap1cCreditAccountCode} */
  const policyCreditAccount = phase === 'post_production' ? '1200' : '2500';
  return {
    ok: true,
    quotationRef: qref,
    productionPhaseAtReceipt: phase,
    policyCreditAccount,
    policyCreditLabel: policyCreditAccount === '2500' ? 'Customer deposits' : 'Accounts receivable',
  };
}

/**
 * Classify an existing receipt GL vs Policy v1 basis.
 * @param {{
 *   receipt?: { amountNgn?: number, quotationRef?: string, atISO?: string, dateISO?: string },
 *   journalLines?: Array<{ accountCode?: string, creditNgn?: number, debitNgn?: number }>,
 *   productionJobs?: Array<{ status?: string, quotationRef?: string, actualMeters?: number, completedAtISO?: string, endDateISO?: string }>,
 * }} input
 */
export function classifyReceiptGlPolicyBasis(input) {
  const receipt = input?.receipt || {};
  const qref = String(receipt.quotationRef || '').trim();
  const amt = Math.round(Number(receipt.amountNgn) || 0);
  const receiptAtISO = receipt.atISO || receipt.dateISO || '';
  const jobs = input?.productionJobs || [];
  const lines = input?.journalLines || [];

  const sim = simulateReceiptCreditAccount({ quotationRef: qref, receiptAtISO, productionJobs: jobs });
  if (!sim.ok) {
    return { ok: false, warning: sim.warning, amountNgn: amt };
  }

  let actualCreditAccount = null;
  let actualCreditNgn = 0;
  for (const ln of lines) {
    const code = String(ln.accountCode || '').trim();
    const cr = Math.round(Number(ln.creditNgn) || 0);
    if (cr > 0 && (code === '1200' || code === '2500')) {
      actualCreditAccount = code;
      actualCreditNgn = Math.max(actualCreditNgn, cr);
    }
  }
  if (actualCreditNgn <= 0 && amt > 0) actualCreditNgn = amt;

  const policyCreditAccount = sim.policyCreditAccount;
  const isLegacyPreProd1200 =
    sim.productionPhaseAtReceipt === 'pre_production' && actualCreditAccount === '1200';
  const mismatch =
    actualCreditAccount != null &&
    policyCreditAccount != null &&
    actualCreditAccount !== policyCreditAccount;

  return {
    ok: true,
    quotationRef: qref,
    amountNgn: amt,
    productionPhaseAtReceipt: sim.productionPhaseAtReceipt,
    policyCreditAccount,
    actualCreditAccount,
    actualCreditNgn,
    mismatch,
    isLegacyPreProd1200,
    legacyBridgeNgn: isLegacyPreProd1200 ? actualCreditNgn || amt : 0,
    expected2500InsteadOf1200Ngn:
      isLegacyPreProd1200 ? actualCreditNgn || amt : mismatch && policyCreditAccount === '2500' ? actualCreditNgn || amt : 0,
  };
}

/**
 * Simulate production recognition under current vs AP1c Policy v1 rules.
 * @param {{
 *   quotationRef?: string,
 *   earnedNgn?: number,
 *   advanceAppliedNgn?: number,
 *   policyDepositsNgn?: number,
 *   legacyBridgeNgn?: number,
 *   productionJobs?: Array<{ status?: string, quotationRef?: string, actualMeters?: number }>,
 * }} input
 */
export function simulateProductionRecognition(input) {
  const earned = Math.round(Number(input?.earnedNgn) || 0);
  const advance = Math.round(Number(input?.advanceAppliedNgn) || 0);
  const deposits = Math.round(Number(input?.policyDepositsNgn) || 0);
  const bridge = Math.round(Number(input?.legacyBridgeNgn) || 0);
  const qref = String(input?.quotationRef || '').trim();

  if (earned <= 0) {
    return {
      ok: false,
      warning: 'zero_or_missing_earned',
      quotationRef: qref || null,
    };
  }

  const currentRelease2500Ngn = Math.min(earned, advance);
  const currentArDebitNgn = Math.max(0, earned - currentRelease2500Ngn);

  const expectedRelease2500Ngn = Math.min(earned, deposits + advance);
  const expectedArDebitNgn = Math.max(0, earned - expectedRelease2500Ngn - bridge);

  const releaseGapNgn = Math.max(0, expectedRelease2500Ngn - currentRelease2500Ngn);
  const potentialArOverstatementNgn = Math.max(0, currentArDebitNgn - expectedArDebitNgn);
  const potentialDepositUnderstatementNgn = releaseGapNgn;

  const productionDuplicateRisk =
    bridge > 0 && currentArDebitNgn > 0 && currentArDebitNgn >= bridge;

  return {
    ok: true,
    quotationRef: qref,
    earnedNgn: earned,
    advanceAppliedNgn: advance,
    policyDepositsNgn: deposits,
    legacyBridgeNgn: bridge,
    currentRelease2500Ngn,
    currentArDebitNgn,
    expectedRelease2500Ngn,
    expectedArDebitNgn,
    releaseGapNgn,
    potentialArOverstatementNgn,
    potentialDepositUnderstatementNgn,
    productionDuplicateRisk,
    revenueCreditNgn: earned,
  };
}

/**
 * Aggregate legacy bridge + policy deposits for a quotation from receipt classifications.
 * @param {Array<ReturnType<classifyReceiptGlPolicyBasis>>} receiptClasses
 */
export function sumLegacyBridgeFromReceiptClasses(receiptClasses) {
  let legacyBridgeNgn = 0;
  let policyDepositsNgn = 0;
  let hasLegacyPreProd1200 = false;
  let hasPolicyAlignedReceipt = false;
  for (const c of receiptClasses || []) {
    if (!c?.ok) continue;
    legacyBridgeNgn += Math.round(Number(c.legacyBridgeNgn) || 0);
    if (c.productionPhaseAtReceipt === 'pre_production' && !c.isLegacyPreProd1200) {
      policyDepositsNgn += Math.round(Number(c.amountNgn) || 0);
    }
    if (c.actualCreditAccount === '2500' || c.policyCreditAccount === '2500') {
      hasPolicyAlignedReceipt = true;
    }
    if (c.isLegacyPreProd1200) hasLegacyPreProd1200 = true;
  }
  return {
    legacyBridgeNgn,
    policyDepositsNgn,
    mixedLegacyAndPolicyReceipt: hasLegacyPreProd1200 && hasPolicyAlignedReceipt,
  };
}
