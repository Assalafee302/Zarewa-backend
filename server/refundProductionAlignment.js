/**
 * Phase 11B/11C — align refund category suggestions with production job state on a quotation.
 */
import {
  REFUND_MD_APPROVAL_THRESHOLD_NGN,
  isBranchManagerApprovalAuthority,
  isExecutiveRoleKey,
} from '../shared/workspaceGovernance.js';
import {
  coilProducedMetersFromProductionJobs,
  jobActualMetersFromProductionJobs,
  producedMetersForUnproducedRefund,
} from '../shared/lib/refundCoilProducedMeters.js';
import { buildRefundProductionFulfillmentSummary } from '../shared/lib/refundProductionFulfillment.js';
import { quotedCoilSheetPoolMetresFromLines, quotedRoofingSheetMetresFromLines } from '../shared/lib/refundQuotationMetres.js';
import { refundCuttingListQuotationMetreIssues } from './cuttingListQuotationConsumptionOps.js';
import { isStoneMeterQuotationLinesJson } from './stoneInventory.js';

/** @type {Record<string, 'block' | 'acknowledge' | 'info'>} */
const SUBMIT_ACTION_BY_CODE = {
  cancellation_with_production: 'block',
  partial_production_cancellation: 'acknowledge',
  multi_category_overlap: 'block',
  multi_category_overlap_same_request: 'block',
  suggest_unproduced_meterage: 'info',
  unproduced_with_full_production: 'block',
  trim_blank_cl_soft_warning: 'acknowledge',
  trim_blank_cl_missing: 'block',
  cutting_list_trim_blank_missing: 'block',
  cutting_list_quotation_metre_mismatch: 'block',
  cutting_list_no_quoted_roofing_metres: 'block',
  cutting_list_missing_for_quotation: 'block',
};

/** Blockers that cannot be overridden with a manager note (double-count / cross-refund). */
const NON_OVERRIDABLE_ALIGNMENT_BLOCK_CODES = new Set([
  'multi_category_overlap',
  'multi_category_overlap_same_request',
]);

function parseReasonCategories(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* plain text */
  }
  return String(raw)
    .split(/[,;|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normCat(c) {
  return String(c || '')
    .trim()
    .toLowerCase();
}

function sumJobMeters(db, jobs, quote = null) {
  let planned = 0;
  let actual = 0;
  let hasCompleted = false;
  let hasCancelled = false;
  const terminalJobs = [];
  for (const j of jobs) {
    const st = String(j.status || '').trim().toLowerCase();
    if (st === 'completed') hasCompleted = true;
    if (st === 'cancelled') hasCancelled = true;
    planned += Number(j.planned_meters) || 0;
    actual += Number(j.actual_meters) || 0;
    if (st === 'completed' || st === 'cancelled') terminalJobs.push(j);
  }
  let isStoneMeterQuote = false;
  if (quote?.lines_json) {
    try {
      const j = JSON.parse(String(quote.lines_json));
      isStoneMeterQuote = isStoneMeterQuotationLinesJson(db, j);
    } catch {
      isStoneMeterQuote = false;
    }
  }
  const coilActual = coilProducedMetersFromProductionJobs(db, terminalJobs);
  const completedActual = jobActualMetersFromProductionJobs(jobs);
  const effectiveProduced = producedMetersForUnproducedRefund(db, jobs, {
    isStoneMeterQuote,
  });
  return { planned, actual, coilActual, effectiveProduced, isStoneMeterQuote, hasCompleted, hasCancelled };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function loadQuotationProductionContext(db, quotationRef, opts = {}) {
  const ref = String(quotationRef || '').trim();
  if (!ref) {
    return { jobs: [], refunds: [], quote: null };
  }
  const excludeRefundId = String(opts.excludeRefundId || '').trim();
  const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(ref) || null;
  const jobs = db
    .prepare(`SELECT * FROM production_jobs WHERE quotation_ref = ? ORDER BY created_at_iso`)
    .all(ref);
  const refunds = excludeRefundId
    ? db
        .prepare(
          `SELECT refund_id, status, amount_ngn, reason_category, requested_at_iso
           FROM customer_refunds
           WHERE quotation_ref = ?
             AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
             AND refund_id != ?
           ORDER BY requested_at_iso`
        )
        .all(ref, excludeRefundId)
    : db
        .prepare(
          `SELECT refund_id, status, amount_ngn, reason_category, requested_at_iso
           FROM customer_refunds
           WHERE quotation_ref = ?
             AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
           ORDER BY requested_at_iso`
        )
        .all(ref);
  return { jobs, refunds, quote };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string[] | string | null | undefined} [selectedCategories]
 * @param {{ excludeRefundId?: string | null }} [opts]
 */
export function refundProductionAlignmentWarnings(db, quotationRef, selectedCategories = [], opts = {}) {
  const { jobs, refunds, quote } = loadQuotationProductionContext(db, quotationRef, opts);
  const issues = [];
  const selected = new Set(
    (Array.isArray(selectedCategories) ? selectedCategories : parseReasonCategories(selectedCategories)).map(normCat)
  );
  const refundCats = new Set();
  for (const r of refunds) {
    for (const c of parseReasonCategories(r.reason_category)) {
      refundCats.add(normCat(c));
    }
  }
  for (const c of selected) refundCats.add(c);

  const { planned, actual, coilActual, effectiveProduced, hasCompleted, hasCancelled } = sumJobMeters(
    db,
    jobs,
    quote
  );
  const partialProduction =
    hasCompleted && planned > 0 && effectiveProduced > 0 && effectiveProduced < planned * 0.98;

  if (selected.has('order cancellation') && hasCompleted && effectiveProduced > 0) {
    issues.push({
      code: 'cancellation_with_production',
      severity: 'warning',
      title: 'Order cancellation vs production',
      message:
        'Production jobs show completed output on this quote. Consider Unproduced meterage instead of full Order cancellation.',
    });
  }

  if (partialProduction && selected.has('order cancellation')) {
    issues.push({
      code: 'partial_production_cancellation',
      severity: 'warning',
      title: 'Partial production',
      message: `Jobs produced ${Math.round(effectiveProduced)} m of ${Math.round(planned)} m planned — cancellation may over-refund.`,
    });
  }

  const currentCategories = (Array.isArray(selectedCategories)
    ? selectedCategories
    : parseReasonCategories(selectedCategories)
  )
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  const currentNorm = new Set(currentCategories.map(normCat));
  const priorCategories = [];
  for (const r of refunds) {
    for (const c of parseReasonCategories(r.reason_category)) {
      const label = String(c || '').trim();
      if (label && !priorCategories.includes(label)) priorCategories.push(label);
    }
  }
  const priorNorm = new Set(priorCategories.map(normCat));

  const currentHasOverpay = currentNorm.has('overpayment') || [...currentNorm].some((c) => c.includes('overpay'));
  const currentHasCancel =
    currentNorm.has('order cancellation') || [...currentNorm].some((c) => c.includes('order cancellation'));
  const currentHasUnproduced =
    currentNorm.has('unproduced meterage') || [...currentNorm].some((c) => c.includes('unproduced'));
  const priorHasOverpay = [...priorNorm].some((c) => c.includes('overpay'));
  const priorHasCancel = [...priorNorm].some((c) => c.includes('order cancellation'));
  const priorHasUnproduced = [...priorNorm].some((c) => c.includes('unproduced'));

  const sameRequestOverpayAndCancel = currentHasOverpay && currentHasCancel;
  const crossRefundOverlap =
    (priorHasOverpay && (currentHasCancel || currentHasUnproduced)) ||
    ((priorHasCancel || priorHasUnproduced) && currentHasOverpay);

  if (sameRequestOverpayAndCancel || crossRefundOverlap) {
    let message =
      'This quotation has Overpayment combined with cancellation/unproduced categories — verify amounts are not double-counted.';
    if (sameRequestOverpayAndCancel) {
      message =
        'This refund request combines Overpayment with Order cancellation on the same breakdown — these double-count cash received. Remove one category or split into separate refund requests.';
    } else if (crossRefundOverlap) {
      message =
        'A prior refund on this quotation overlaps with this request (Overpayment vs Order cancellation / Unproduced meterage). Resolve or reject the prior refund before submitting a conflicting category.';
    } else if (priorCategories.length && currentCategories.length) {
      message = `Prior refund(s) on this quote (${priorCategories.join(', ')}) overlap with this request (${currentCategories.join(', ')}). Overpayment must not be double-counted with Order cancellation or Unproduced meterage on the same quotation.`;
    } else if (priorCategories.length > 1) {
      message = `Multiple refund categories already exist on this quote (${priorCategories.join(', ')}). Verify Overpayment is not combined with Order cancellation or Unproduced meterage in a way that double-counts the same economic loss.`;
    }
    issues.push({
      code: sameRequestOverpayAndCancel ? 'multi_category_overlap_same_request' : 'multi_category_overlap',
      severity: 'error',
      title: 'Multi-category overlap',
      message,
      priorRefundCategories: priorCategories,
      currentRequestCategories: currentCategories,
      sameRequestOverpayAndCancel,
      crossRefundOverlap,
    });
  }

  const fulfillment = buildRefundProductionFulfillmentSummary(db, quote, jobs, {
    isStoneMeterQuote: sumJobMeters(db, jobs, quote).isStoneMeterQuote,
  });

  if (selected.has('unproduced meterage') && fulfillment.fullyProducedRoofing) {
    const offcutNote =
      fulfillment.offcutFgMeters > 0.001
        ? ` (${fulfillment.offcutFgMeters.toFixed(2)} m from offcut/accessories)`
        : '';
    const coilNote =
      fulfillment.coilProducedMeters > 0.001
        ? ` (${fulfillment.coilProducedMeters.toFixed(2)} m from coil)`
        : '';
    issues.push({
      code: 'unproduced_with_full_production',
      severity: 'error',
      title: 'No unproduced roofing metres',
      message: `Quotation is for ${fulfillment.quotedMeters.toFixed(2)} m roofing; production records ${fulfillment.producedMetersForUnproduced.toFixed(2)} m finished output${offcutNote || coilNote || ''}. Unproduced meterage refund is not applicable.`,
      productionFulfillment: fulfillment,
    });
  }

  if (hasCancelled && !hasCompleted && effectiveProduced <= 0 && !refundCats.has('unproduced meterage')) {
    issues.push({
      code: 'suggest_unproduced_meterage',
      severity: 'info',
      title: 'Suggested category',
      message: 'Cancelled jobs with no output typically map to Unproduced meterage rather than Overpayment.',
    });
  }

  for (const clIssue of refundCuttingListQuotationMetreIssues(db, quotationRef)) {
    const code = String(clIssue.code || '').trim();
    issues.push({
      code,
      severity: clIssue.severity === 'warning' ? 'warning' : 'error',
      title:
        code === 'trim_blank_cl_soft_warning'
          ? 'Trim blank note'
          : code === 'trim_blank_cl_missing'
            ? 'Trim blank missing on cutting list'
            : 'Cutting list vs quotation',
      message: clIssue.message,
      ...clIssue,
    });
  }

  return issues;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function suggestRefundCategoriesFromProduction(db, quotationRef) {
  const { jobs, refunds, quote } = loadQuotationProductionContext(db, quotationRef);
  const suggested = [];
  const { effectiveProduced, hasCompleted, hasCancelled } = sumJobMeters(db, jobs, quote);
  let stoneMeterQuote = false;
  try {
    stoneMeterQuote = quote?.lines_json
      ? isStoneMeterQuotationLinesJson(db, JSON.parse(String(quote.lines_json)))
      : false;
  } catch {
    stoneMeterQuote = false;
  }
  const quotedMeters = stoneMeterQuote
    ? quotedRoofingSheetMetresFromLines(quote?.lines_json ?? '')
    : quotedCoilSheetPoolMetresFromLines(quote?.lines_json ?? '');
  const total = Math.round(Number(quote?.total_ngn) || 0);
  const paid = Math.round(Number(quote?.paid_ngn) || 0);

  const refundedCats = new Set();
  for (const r of refunds) {
    for (const c of parseReasonCategories(r.reason_category)) {
      refundedCats.add(normCat(c));
    }
  }

  if (paid > total && total > 0 && !refundedCats.has('overpayment')) {
    suggested.push('Overpayment');
  }

  const unproducedMetres = Math.max(0, quotedMeters - effectiveProduced);
  if (
    quotedMeters > 0 &&
    unproducedMetres > 0.02 &&
    !refundedCats.has('unproduced meterage') &&
    (hasCancelled || hasCompleted)
  ) {
    suggested.push('Unproduced meterage');
  }

  if (hasCancelled && !hasCompleted && effectiveProduced <= 0 && !refundedCats.has('order cancellation')) {
    /* lower priority than unproduced */
  }

  return [...new Set(suggested)];
}

/**
 * @param {{ roleKey?: string, role?: string, role_key?: string } | null | undefined} actor
 */
export function actorMayOverrideProductionAlignmentBlock(actor) {
  const rk = String(actor?.roleKey ?? actor?.role_key ?? actor?.role ?? '')
    .trim()
    .toLowerCase();
  if (rk === 'admin') return true;
  if (isExecutiveRoleKey(rk)) return true;
  return isBranchManagerApprovalAuthority(rk);
}

/**
 * @param {Array<{ code?: string, severity?: string, title?: string, message?: string }>} issues
 */
export function enrichProductionAlignmentIssuesForSubmit(issues) {
  return (issues || []).map((issue) => ({
    ...issue,
    submitAction: SUBMIT_ACTION_BY_CODE[String(issue.code || '').trim()] || 'info',
  }));
}

/**
 * Phase 11C — enforce production alignment at refund submit (block / acknowledge / BM override).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string[] | string | null | undefined} selectedCategories
 * @param {{ actor?: object, acknowledgedCodes?: string[], overrideNote?: string }} [options]
 */
export function validateRefundProductionAlignmentAtSubmit(db, quotationRef, selectedCategories, options = {}) {
  const { actor, acknowledgedCodes = [], overrideNote = '', excludeRefundId = null } = options;
  const ackSet = new Set((acknowledgedCodes || []).map((c) => String(c).trim()).filter(Boolean));
  const override = String(overrideNote || '').trim();
  const mayOverride = actorMayOverrideProductionAlignmentBlock(actor);
  const issues = enrichProductionAlignmentIssuesForSubmit(
    refundProductionAlignmentWarnings(db, quotationRef, selectedCategories, { excludeRefundId })
  );

  const blocks = issues.filter((i) => i.submitAction === 'block');
  const needAck = issues.filter((i) => i.submitAction === 'acknowledge');

  for (const block of blocks) {
    if (NON_OVERRIDABLE_ALIGNMENT_BLOCK_CODES.has(String(block.code || '').trim())) {
      return {
        ok: false,
        code: 'PRODUCTION_ALIGNMENT_BLOCKED',
        error: block.message || block.title || 'Refund category conflicts with prior refunds on this quotation.',
        issues,
        blockedCode: block.code,
        requiresOverride: false,
      };
    }
    if (mayOverride && override.length >= 10) continue;
    return {
      ok: false,
      code: 'PRODUCTION_ALIGNMENT_BLOCKED',
      error: block.message || block.title || 'Refund category conflicts with production state.',
      issues,
      blockedCode: block.code,
      requiresOverride: mayOverride,
    };
  }

  for (const ack of needAck) {
    if (!ackSet.has(String(ack.code || '').trim())) {
      return {
        ok: false,
        code: 'PRODUCTION_ALIGNMENT_ACK_REQUIRED',
        error: `Acknowledge: ${ack.title || ack.message || 'production alignment warning'}.`,
        issues,
        requiresAcknowledgement: needAck.map((i) => i.code).filter(Boolean),
      };
    }
  }

  const overrideUsed = blocks.length > 0 && mayOverride && override.length >= 10;
  return {
    ok: true,
    issues,
    overrideUsed,
    overrideNote: overrideUsed ? override : '',
    acknowledgedCodes: [...ackSet],
  };
}

/**
 * @param {string | null | undefined} rawJson
 */
export function parseStoredProductionAlignmentAck(rawJson) {
  try {
    const raw = String(rawJson ?? '').trim();
    if (!raw) return { acknowledgedCodes: [], overrideUsed: false, overrideNote: '' };
    const j = JSON.parse(raw);
    return {
      acknowledgedCodes: Array.isArray(j.acknowledgedCodes)
        ? j.acknowledgedCodes.map((c) => String(c).trim()).filter(Boolean)
        : [],
      overrideUsed: Boolean(j.overrideUsed),
      overrideNote: String(j.overrideNote || '').trim(),
    };
  } catch {
    return { acknowledgedCodes: [], overrideUsed: false, overrideNote: '' };
  }
}

/**
 * @param {object} row - customer_refunds row
 * @param {object} payload - decision payload
 * @param {(raw: unknown) => string[]} normalizeCategories
 */
export function resolveRefundReasonCategoriesForDecision(row, payload, normalizeCategories) {
  const lines = Array.isArray(payload.calculationLines) ? payload.calculationLines : [];
  const fromLines = [
    ...new Set(
      lines
        .filter((l) => l?.include !== false)
        .map((l) => String(l?.category ?? '').trim())
        .filter(Boolean)
    ),
  ];
  if (fromLines.length) return fromLines;
  return normalizeCategories(row.reason_category);
}

/**
 * Merge submit-time and approval-time alignment acknowledgements for persistence.
 */
export function mergeProductionAlignmentAckJson(stored, validationResult, phase = 'approval') {
  if (!validationResult?.ok) return null;
  const codes = [
    ...new Set([
      ...(stored.acknowledgedCodes || []),
      ...(validationResult.acknowledgedCodes || []),
    ]),
  ];
  const overrideUsed = Boolean(stored.overrideUsed || validationResult.overrideUsed);
  const overrideNote = validationResult.overrideNote || stored.overrideNote || '';
  if (!codes.length && !overrideUsed) return null;
  try {
    return JSON.stringify({
      acknowledgedCodes: codes,
      overrideUsed,
      overrideNote: overrideUsed ? overrideNote : '',
      validatedAtISO: new Date().toISOString().slice(0, 19),
      phase,
    }).slice(0, 8000);
  } catch {
    return null;
  }
}

export { REFUND_MD_APPROVAL_THRESHOLD_NGN };
