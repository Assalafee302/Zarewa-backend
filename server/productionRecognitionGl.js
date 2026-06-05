/**
 * Auto GL when production completes (earn revenue from customer advances + AR) and COGS vs RM inventory.
 * AP1c-3: when ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE=1, release policy deposits + advances; optional legacy bridge.
 * @param {import('better-sqlite3').Database} db
 */

import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { resolveProductionRecognitionAmounts } from './ap1cProductionRecognition.js';
import { postBalancedJournalTx } from './glOps.js';

function parseQuotedProductMeters(linesJson) {
  let lines = linesJson;
  if (typeof lines === 'string') {
    try {
      lines = JSON.parse(lines || '{}');
    } catch {
      lines = {};
    }
  }
  if (!lines || typeof lines !== 'object') return 0;
  const products = lines.products;
  if (!Array.isArray(products)) return 0;
  let m = 0;
  for (const p of products) {
    m += Number(String(p?.qty ?? '').replace(/,/g, '')) || 0;
  }
  return m;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   jobID: string;
 *   quotationRef: string;
 *   actualMeters: number;
 *   totalCogsNgn: number;
 *   completedAtISO: string;
 *   branchId?: string | null;
 *   createdByUserId?: string | null;
 * }} payload
 */
export function tryPostProductionRecognitionGlTx(db, payload) {
  const jobId = String(payload.jobID || '').trim();
  const qref = String(payload.quotationRef || '').trim();
  if (!jobId || !qref) return { ok: true, skipped: true, reason: 'missing_job_or_quote' };

  const qrow = db.prepare(`SELECT total_ngn, lines_json FROM quotations WHERE id = ?`).get(qref);
  if (!qrow) return { ok: true, skipped: true, reason: 'quotation_not_found' };

  const totalNgn = Math.round(Number(qrow.total_ngn) || 0);
  const quotedMeters = parseQuotedProductMeters(qrow.lines_json);
  const actualMeters = Number(payload.actualMeters) || 0;
  if (totalNgn <= 0 || actualMeters <= 0) return { ok: true, skipped: true, reason: 'no_amount_or_meters' };

  const denom = quotedMeters > 0 ? quotedMeters : actualMeters;
  const rawEarned = totalNgn * (actualMeters / denom);
  const rawEarnedNgn = Math.min(totalNgn, Math.max(0, Math.round(rawEarned)));
  if (rawEarnedNgn <= 0) return { ok: true, skipped: true, reason: 'zero_earned' };

  const flags = readFinanceFeatureFlags();
  const amounts = resolveProductionRecognitionAmounts(db, {
    quotationRef: qref,
    earnedNgn: rawEarnedNgn,
    totalNgn,
    excludeJobId: jobId,
    flags,
  });

  const earnedNgn = amounts.earnedNgn;
  if (earnedNgn <= 0) return { ok: true, skipped: true, reason: 'capped_to_quote_total' };

  const release2500 = amounts.release2500Ngn;
  const arPart = amounts.arPartNgn;
  const legacyBridgeApplied = amounts.legacyBridgeAppliedNgn ?? 0;

  const entryDate = String(payload.completedAtISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { ok: false, error: 'Invalid completion date for production GL.' };
  }

  const memoSuffix =
    amounts.mode === 'policy_v1'
      ? ` AP1v1 rel2500=${release2500} ar=${arPart} bridge=${legacyBridgeApplied}`
      : '';
  const revLines = [];
  if (release2500 > 0) revLines.push({ accountCode: '2500', debitNgn: release2500, memo: jobId });
  if (arPart > 0) revLines.push({ accountCode: '1200', debitNgn: arPart, memo: jobId });
  revLines.push({ accountCode: '4000', creditNgn: earnedNgn, memo: jobId });

  const rev = postBalancedJournalTx(db, {
    entryDateISO: entryDate,
    memo: `Production revenue ${jobId} (${qref})${memoSuffix}`,
    sourceKind: 'PRODUCTION_RECOGNITION_GL',
    sourceId: jobId,
    branchId: payload.branchId ?? null,
    createdByUserId: payload.createdByUserId ?? null,
    lines: revLines,
  });
  if (!rev.ok && !rev.duplicate) return rev;
  if (rev.duplicate) {
    return {
      ok: true,
      duplicate: true,
      earnedNgn,
      releaseFrom2500Ngn: release2500,
      arDebitNgn: arPart,
      legacyBridgeAppliedNgn: legacyBridgeApplied,
      recognitionMode: amounts.mode,
      cogsNgn: 0,
      revenueJournalId: rev.journalId ?? null,
      cogsJournalId: null,
    };
  }

  const totalCogs = Math.round(Number(payload.totalCogsNgn) || 0);
  let cogs = { ok: true, skipped: true };
  if (totalCogs > 0) {
    cogs = postBalancedJournalTx(db, {
      entryDateISO: entryDate,
      memo: `Production COGS ${jobId}`,
      sourceKind: 'PRODUCTION_COGS_GL',
      sourceId: jobId,
      branchId: payload.branchId ?? null,
      createdByUserId: payload.createdByUserId ?? null,
      lines: [
        { accountCode: '5000', debitNgn: totalCogs, memo: jobId },
        { accountCode: '1300', creditNgn: totalCogs, memo: jobId },
      ],
    });
    if (!cogs.ok && !cogs.duplicate) return cogs;
  }

  return {
    ok: true,
    earnedNgn,
    releaseFrom2500Ngn: release2500,
    arDebitNgn: arPart,
    legacyBridgeAppliedNgn: legacyBridgeApplied,
    policyDepositNgn: amounts.policyDepositNgn ?? 0,
    advanceAppliedNgn: amounts.advanceAppliedNgn ?? 0,
    recognitionMode: amounts.mode,
    cogsNgn: totalCogs,
    revenueJournalId: rev.journalId ?? null,
    cogsJournalId: cogs.journalId ?? null,
    duplicate: Boolean(rev.duplicate),
    skipped: false,
  };
}
