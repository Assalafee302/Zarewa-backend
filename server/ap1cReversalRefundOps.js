/**
 * AP1c-4 — receipt reversal account resolution and refund GL policy hints.
 */
import { quotationHasCompletedProduction } from '../shared/lib/customerLedgerCore.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { listProductionJobs } from './readModel.js';
import {
  findReceiptGlCreditedAccountFromLines,
  getReceiptPolicyMetaByLedgerEntryId,
  loadJournalLinesForReceiptMeta,
  RECEIPT_POLICY_BASIS,
  receiptPolicyMetaTableExists,
  sumLegacyBridgeReceiptMetaNgn,
  sumPolicyV1DepositReceiptMetaNgn,
} from './receiptPolicyMetaOps.js';

/** @typedef {'1200' | '2500'} ReversalAccountCode */
/** @typedef {'metadata' | 'journal_inference' | 'legacy_default'} ReversalAccountSource */

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    try {
      const row = db
        .prepare(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
        )
        .get(name);
      return Boolean(row);
    } catch {
      return false;
    }
  }
}

function ap1cPostingFlagsActive(flags = readFinanceFeatureFlags()) {
  return (
    flags.accountingPolicyV1ReceiptGl ||
    flags.accountingPolicyV1ProductionRelease ||
    flags.accountingPolicyV1LegacyBridge
  );
}

/**
 * Resolve Dr account for receipt GL reversal (must mirror original Cr).
 * @param {import('better-sqlite3').Database} db
 * @param {string} originalReceiptLedgerId
 */
export function resolveReceiptReversalAccountFromMetaOrJournalLines(db, originalReceiptLedgerId) {
  const lid = String(originalReceiptLedgerId || '').trim();
  if (!lid) {
    return {
      ok: false,
      reasonCode: 'missing_ledger_entry_id',
      message: 'Cannot safely determine original credited account for receipt reversal.',
    };
  }

  const meta = getReceiptPolicyMetaByLedgerEntryId(db, lid);
  const metaCode = String(meta?.credited_account_code || '').trim();
  if (metaCode === '2500' || metaCode === '1200') {
    return {
      ok: true,
      accountCode: /** @type {ReversalAccountCode} */ (metaCode),
      source: 'metadata',
      warning: null,
      policyBasis: meta.policy_basis,
    };
  }

  let journalId = null;
  if (tableExists(db, 'gl_journal_entries')) {
    const j = db
      .prepare(
        `SELECT id FROM gl_journal_entries
         WHERE source_kind = 'CUSTOMER_RECEIPT_GL' AND source_id = ? LIMIT 1`
      )
      .get(lid);
    journalId = j?.id ? String(j.id) : null;
  }

  if (journalId) {
    const lines = loadJournalLinesForReceiptMeta(db, journalId);
    const { creditedAccountCode } = findReceiptGlCreditedAccountFromLines(lines);
    if (creditedAccountCode === '2500' || creditedAccountCode === '1200') {
      return {
        ok: true,
        accountCode: creditedAccountCode,
        source: 'journal_inference',
        warning: meta
          ? null
          : 'Receipt policy metadata missing; reversal account taken from original journal lines.',
        policyBasis: null,
      };
    }
  }

  if (!ap1cPostingFlagsActive()) {
    return {
      ok: true,
      accountCode: '1200',
      source: 'legacy_default',
      warning:
        'AP1c posting flags are off; receipt reversal uses Dr 1200 (legacy default). Enable AP1c and ensure metadata for Policy v1 receipts.',
      policyBasis: null,
    };
  }

  return {
    ok: false,
    reasonCode: 'missing_receipt_policy_meta',
    message:
      'Cannot safely determine original credited account for receipt reversal. Head of Accounts manual review required.',
  };
}

/**
 * Classify customer refund payout GL (deposit reduction vs post-production revenue review).
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quotationRef?: string | null,
 *   customerId?: string | null,
 *   refundId?: string | null,
 * }} ctx
 */
export function evaluateRefundPayoutGlPolicy(db, ctx = {}) {
  const qref = String(ctx.quotationRef || '').trim();
  const out = {
    glTreatment: 'deposit_2500',
    needsRevenueReview: false,
    needsManualReview: false,
    note: 'Refund payout GL: Dr 2500 / Cr 1000 (customer deposit / advance pool).',
  };

  if (!qref) return out;

  const jobs = listProductionJobs(db, 'ALL').filter(
    (j) => String(j.quotationRef || '').trim() === qref
  );
  const hasProduction = quotationHasCompletedProduction(qref, jobs);

  if (!hasProduction) {
    out.note = 'Refund before production completion on quote — reduces deposit (2500), not revenue.';
    return out;
  }

  const policyDeposits = sumPolicyV1DepositReceiptMetaNgn(db, qref);
  const legacyBridge = sumLegacyBridgeReceiptMetaNgn(db, qref);
  const hasProductionGl =
    tableExists(db, 'gl_journal_entries') &&
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM gl_journal_entries j
           INNER JOIN production_jobs pj ON pj.job_id = j.source_id AND pj.quotation_ref = ?
           WHERE j.source_kind = 'PRODUCTION_RECOGNITION_GL' LIMIT 1`
        )
        .get(qref)
    );

  if (hasProductionGl && legacyBridge <= 0 && policyDeposits <= 0) {
    out.needsRevenueReview = true;
    out.note =
      'Post-production refund on quote with revenue recognition — treasury payout uses 2500 GL only; revenue/AR correction may require manual journals (no automatic Dr 4000 in AP1c-4).';
  } else if (hasProductionGl) {
    out.needsRevenueReview = true;
    out.note =
      'Post-production refund — payout reduces 2500; review AR/revenue if refund exceeds remaining deposit and legacy bridge coverage.';
  }

  return out;
}

/**
 * Read-only AP1c-4 reversal/refund diagnostic counts.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
export function countAp1cReversalRefundDiagnostics(db, branchScope = 'ALL') {
  const out = {
    receiptReversalsMissingResolvableMetaCount: 0,
    refundPayoutsRevenueReviewCount: 0,
    depositRefundsBeforeProductionCount: 0,
    legacyReceiptReversalManualReviewCount: 0,
    mixedLegacyAp1cRefundRiskCount: 0,
  };

  if (!tableExists(db, 'gl_journal_entries')) return out;

  const journals = db
    .prepare(
      `SELECT j.id AS journal_id, j.source_id AS ledger_entry_id
       FROM gl_journal_entries j
       WHERE j.source_kind = 'CUSTOMER_RECEIPT_GL'`
    )
    .all();

  for (const j of journals) {
    const lid = String(j.ledger_entry_id || '').trim();
    if (!lid) continue;
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, lid);
    if (!resolved.ok) out.receiptReversalsMissingResolvableMetaCount += 1;
    const meta = getReceiptPolicyMetaByLedgerEntryId(db, lid);
    if (
      meta?.policy_basis === RECEIPT_POLICY_BASIS.LEGACY_AR &&
      meta.credited_account_code === '1200'
    ) {
      out.legacyReceiptReversalManualReviewCount += 1;
    }
  }

  if (!tableExists(db, 'customer_refunds')) return out;

  const br =
    branchScope !== 'ALL' && tableExists(db, 'customer_refunds')
      ? ` AND branch_id = ? `
      : '';
  const brArgs = branchScope !== 'ALL' ? [branchScope] : [];

  const refunds = db
    .prepare(
      `SELECT refund_id, quotation_ref, customer_id, status, paid_amount_ngn, approved_amount_ngn
       FROM customer_refunds
       WHERE TRIM(COALESCE(status,'')) IN ('Approved','Paid')
         AND COALESCE(approved_amount_ngn, amount_ngn, 0) > 0 ${br}`
    )
    .all(...brArgs);

  const jobsByQuote = new Map();
  if (tableExists(db, 'production_jobs')) {
    for (const j of listProductionJobs(db, branchScope)) {
      const ref = String(j.quotationRef || '').trim();
      if (!ref) continue;
      if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
      jobsByQuote.get(ref).push(j);
    }
  }

  for (const r of refunds) {
    const qref = String(r.quotation_ref || '').trim();
    if (!qref) continue;
    const jobs = jobsByQuote.get(qref) || [];
    const evald = evaluateRefundPayoutGlPolicy(db, {
      quotationRef: qref,
      customerId: r.customer_id,
      refundId: r.refund_id,
    });
    if (!quotationHasCompletedProduction(qref, jobs)) {
      out.depositRefundsBeforeProductionCount += 1;
    } else if (evald.needsRevenueReview) {
      out.refundPayoutsRevenueReviewCount += 1;
    }
    const legacy = sumLegacyBridgeReceiptMetaNgn(db, qref);
    const v1dep = sumPolicyV1DepositReceiptMetaNgn(db, qref);
    if (legacy > 0 && v1dep > 0) out.mixedLegacyAp1cRefundRiskCount += 1;
  }

  return out;
}
