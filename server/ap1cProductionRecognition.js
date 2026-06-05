/**
 * AP1c-3 — Policy v1 production recognition amounts (pure + DB sums from receipt metadata).
 */
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import {
  RECEIPT_POLICY_BASIS,
  sumReceiptPolicyMetaNgnForQuotation,
} from './receiptPolicyMetaOps.js';

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    try {
      const row = db
        .prepare(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
        )
        .get(name);
      return Boolean(row);
    } catch {
      return false;
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function sumAdvanceAppliedNgnForQuotation(db, quotationRef) {
  const qref = String(quotationRef || '').trim();
  if (!qref || !tableExists(db, 'ledger_entries')) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
       WHERE quotation_ref = ? AND type = 'ADVANCE_APPLIED'`
    )
    .get(qref);
  return Math.max(0, Math.round(Number(row?.s) || 0));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} [excludeJobId]
 */
export function sumPriorProductionRevenueRecognizedNgn(db, quotationRef, excludeJobId = '') {
  const qref = String(quotationRef || '').trim();
  if (!qref || !tableExists(db, 'gl_journal_entries')) return 0;
  const ex = String(excludeJobId || '').trim();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(jl.credit_ngn), 0) AS s
       FROM gl_journal_entries j
       INNER JOIN gl_journal_lines jl ON jl.journal_id = j.id
       INNER JOIN gl_accounts ga ON ga.id = jl.account_id AND ga.code = '4000'
       WHERE j.source_kind = 'PRODUCTION_RECOGNITION_GL'
         AND (
           j.memo LIKE ? OR EXISTS (
             SELECT 1 FROM production_jobs pj
             WHERE pj.id = j.source_id AND pj.quotation_ref = ?
           )
         )
         AND (? = '' OR j.source_id != ?)`
    )
    .get(`%(${qref})%`, qref, ex, ex);
  return Math.max(0, Math.round(Number(row?.s) || 0));
}

/**
 * @param {{
 *   earnedNgn: number,
 *   policyDepositNgn: number,
 *   advanceAppliedNgn: number,
 *   legacyBridgeNgn: number,
 *   legacyBridgeEnabled: boolean,
 * }} input
 */
export function computePolicyV1ProductionRecognitionParts(input) {
  const earnedNgn = Math.round(Number(input.earnedNgn) || 0);
  const policyDepositNgn = Math.round(Number(input.policyDepositNgn) || 0);
  const advanceAppliedNgn = Math.round(Number(input.advanceAppliedNgn) || 0);
  const legacyBridgeNgn = input.legacyBridgeEnabled
    ? Math.round(Number(input.legacyBridgeNgn) || 0)
    : 0;

  const release2500Ngn = Math.min(earnedNgn, policyDepositNgn + advanceAppliedNgn);
  const legacyBridgeAppliedNgn = Math.min(
    legacyBridgeNgn,
    Math.max(0, earnedNgn - release2500Ngn)
  );
  const arPartNgn = Math.max(0, earnedNgn - release2500Ngn - legacyBridgeAppliedNgn);

  return {
    earnedNgn,
    policyDepositNgn,
    advanceAppliedNgn,
    legacyBridgeNgn,
    legacyBridgeAppliedNgn,
    release2500Ngn,
    arPartNgn,
    policyBasis: 'policy_v1_production_release',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quotationRef: string,
 *   earnedNgn: number,
 *   totalNgn: number,
 *   excludeJobId?: string,
 *   flags?: ReturnType<typeof readFinanceFeatureFlags>,
 * }} input
 */
export function resolveProductionRecognitionAmounts(db, input) {
  const flags = input.flags || readFinanceFeatureFlags();
  const qref = String(input.quotationRef || '').trim();
  let earnedNgn = Math.round(Number(input.earnedNgn) || 0);
  const totalNgn = Math.round(Number(input.totalNgn) || 0);
  const excludeJobId = String(input.excludeJobId || '').trim();

  const prior = sumPriorProductionRevenueRecognizedNgn(db, qref, excludeJobId);
  const remainingCap = Math.max(0, totalNgn - prior);
  earnedNgn = Math.min(earnedNgn, remainingCap);

  if (!flags.accountingPolicyV1ProductionRelease) {
    const advanceAppliedNgn = sumAdvanceAppliedNgnForQuotation(db, qref);
    const release2500Ngn = Math.min(earnedNgn, advanceAppliedNgn);
    const arPartNgn = Math.max(0, earnedNgn - release2500Ngn);
    return {
      mode: 'legacy',
      earnedNgn,
      release2500Ngn,
      arPartNgn,
      advanceAppliedNgn,
      policyDepositNgn: 0,
      legacyBridgeNgn: 0,
      legacyBridgeAppliedNgn: 0,
      priorRecognizedNgn: prior,
    };
  }

  const policyDepositNgn = sumReceiptPolicyMetaNgnForQuotation(db, qref, {
    creditedAccountCode: '2500',
  });
  const advanceAppliedNgn = sumAdvanceAppliedNgnForQuotation(db, qref);
  const legacyBridgeNgn = flags.accountingPolicyV1LegacyBridge
    ? sumReceiptPolicyMetaNgnForQuotation(db, qref, {
        policyBasis: RECEIPT_POLICY_BASIS.LEGACY_AR,
        creditedAccountCode: '1200',
      })
    : 0;

  const parts = computePolicyV1ProductionRecognitionParts({
    earnedNgn,
    policyDepositNgn,
    advanceAppliedNgn,
    legacyBridgeNgn,
    legacyBridgeEnabled: flags.accountingPolicyV1LegacyBridge,
  });

  return {
    mode: 'policy_v1',
    priorRecognizedNgn: prior,
    ...parts,
  };
}
