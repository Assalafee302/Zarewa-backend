import { createHash } from 'node:crypto';
import { accessoryFulfillmentSummaryForQuotation, normAccessoryNameKey } from './accessoryFulfillment.js';
import { actorId, actorName, userHasPermission } from './auth.js';
import { assertEntityBranchForWorkspaceWrite } from './branchScope.js';
import { DEFAULT_BRANCH_ID, getBranch } from './branches.js';
import {
  nextApprovalActionHumanId,
  nextAuditLogHumanId,
  nextExpenseHumanId,
  nextPaymentRequestHumanId,
  nextRefundHumanId,
} from './humanId.js';
import { mapLegacyExpenseCategoryToCanonical } from '../shared/expenseCategories.js';
import {
  actorMayApprovePaymentRequestCategory,
  CAPEX_MIN_ASSET_DESCRIPTION_LEN,
  resolveExpenseCategoryPolicyLimits,
  validateExpenseCategoryForTreasuryPayout,
  validateExpenseCategorySelection,
} from '../shared/expenseCategoryPolicy.js';
import { getExpenseCategoryLane } from '../shared/expenseCategoryLanes.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import {
  MIN_REFUND_QUOTATION_REMAINING_NGN,
  normalizeRefundReasonCategoriesForApi,
  quotationMeetsRefundPickerFloor,
  REFUND_AMOUNT_LINE_TOLERANCE_NGN,
  REFUND_PREVIEW_VERSION,
  REFUND_REASON_CATEGORY_VALUES,
  refundAmountExceedsEconomicFloorCap,
  refundFloorGatedAmountNgn,
  refundRequestIsEconomicFloorExempt,
} from '../shared/refundConstants.js';
import {
  isStoneFlatsheetQuotationLine,
  validateQuotationLineIntegrity,
} from '../shared/lib/stoneCoatedQuotationPolicy.js';
import { coilProducedMetersFromProductionJobs, jobOutputMetresForUnproducedRefund, producedMetersForUnproducedRefund } from '../shared/lib/refundCoilProducedMeters.js';
import { quotedCoilSheetPoolMetresFromLines, quotedRoofingSheetMetresFromLines } from '../shared/lib/refundQuotationMetres.js';
import {
  quotedCuttingListSheetPoolMetresFromProducts,
  quotedTrimFinishedMetresFromProducts,
  trimLinesBlendedPricePerMeterFromProducts,
} from '../shared/lib/cuttingListBlankConsumption.js';
import { roundCuttingListMetres2 } from '../shared/lib/refundCuttingListQuotationReconciliation.js';
import { buildRefundProductionFulfillmentSummary } from '../shared/lib/refundProductionFulfillment.js';
import {
  quotationBelowFloorExceptionApproved,
  quotationRefundBlockedPendingMdPriceConfirm,
} from '../shared/lib/quotationPriceException.js';
import {
  productionGateApprovalLevelForActor,
  productionGateOverrideDeniedMessage,
  productionGateOverrideNoteValid,
  PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN,
  userMayApproveProductionGate,
} from './productionGateAccess.js';
import {
  userMayPerformManagerQuotationClearance,
  userMayReleaseQuotationPaymentHold,
  userMayBlockQuotationRefunds,
  userMayWriteOffReceivableBadDebt,
} from '../shared/workspaceGovernance.js';
import {
  evaluateReceivableWriteOff,
  maxRoundOffWaiveNgn,
  RECEIVABLE_WRITEOFF_NOTE_MIN_LEN,
} from '../shared/lib/receivableWriteOffPolicy.js';
import { tryPostReceivableWriteOffGl } from './accountingReceivableWriteOffOps.js';
import {
  quotationRefundsBlocked,
  QUOTATION_REFUNDS_BLOCK_REASON_MIN_LEN,
} from '../shared/lib/quotationRefundsBlocked.js';
import {
  firstGaugeMmFromLabel,
  quotedGaugeLabelForSubstitutionComparison,
} from '../shared/lib/quotedGaugeForSubstitution.js';
import {
  quotationLineQtyNumber,
  quotationLineUnitPriceNumber,
} from '../shared/lib/quotationLineNumericForRefund.js';
import {
  actorMayApprovePaymentRequestAmount,
  actorMayApproveRefundAmount,
  isExecutiveRoleKey,
} from '../shared/workspaceGovernance.js';
import { isEffectivelyFullyPaid } from '../shared/lib/paymentOutstandingTolerance.js';
import { accountingReceivableOutstandingNgn, quotationWaivedBalanceNgn } from '../shared/lib/customerLedgerCore.js';
import { appendPaymentRequestTimelineToOfficeThreads } from './officePaymentRequestTimeline.js';
import { getOrgGovernanceLimits, getRefundStaffAllocationDeductionRate } from './orgPolicy.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';
import { backdateWarningForActedDate } from './backdateSignals.js';
import { resolvePriceListItemFloorNgn } from './pricingResolve.js';
import {
  quotationPricingAsAtIso,
  workbookFloorPerMeterAsOf,
  workbookFloorMinPerMeterAsOf,
  selectPriceListRowsAsOf,
} from './pricingAsOf.js';
import { pricingPolicyNumbersForServiceLine, resolveAliasForDesign } from './pricingPolicyResolve.js';
import { isStoneMeterQuotationLinesJson } from './stoneInventory.js';
import { stoneFlatsheetShortfallRefundSuggestions } from './stoneFlatsheetFulfillment.js';
import {
  buildRefundCategorySuggestedMaxNgn,
  quotationOverpaymentExcessNgn,
  quotationOverpaymentResidualNgn,
  overpaymentAlreadyRefundedNgn,
  quotationRefundHardCapNgn,
  quotationRemainingRefundableNgn,
  sumRefundCalculationLinesByCategoryNgn,
  validateRefundCalculationLinesNgn,
  validateRefundCategorySuggestedCapsNgn,
  validateRefundSameRequestOverlapCategoriesNgn,
} from '../shared/lib/refundQuotationMoney.js';
import {
  applyRefundStaffAllocationDeductions,
} from '../shared/lib/refundStaffAllocationDeduction.js';
import {
  unclearedReceiptFloatBySalesCustomerIds,
  unclearedTotalsMap,
} from './sales/refundClaimingStaffUnclearedReceipts.js';
import {
  buildDerivedRefundCategoryCapsNgn,
  mergeRefundCategoryCapsNgn,
} from '../shared/lib/refundCategoryDerivedCaps.js';
import { refundCuttingListQuotationMetreIssues } from './cuttingListQuotationConsumptionOps.js';
import { buildUnproducedMetresRefundLine, validateRefundCalculationLineArithmetic } from '../shared/lib/refundLineArithmetic.js';
import { refundPaymentIntegrityIssues } from './customerPaymentIntegrityOps.js';
import {
  emptyQuotationPaymentCashBreakdown,
  quotationPaymentCashBreakdown,
  quotationPaymentCashBreakdownByRef,
} from './quotationPaymentCash.js';
import { companionOverpayNgnByReceiptId } from '../shared/lib/customerLedgerCore.js';
import { receiptEffectiveCashNgn } from '../shared/lib/receiptClearance.js';
import {
  assertCashierMayNotApproveRefund,
  assertRefundApproverNotRequester,
} from './refundHandlers.js';
import {
  enrichProductionAlignmentIssuesForSubmit,
  mergeProductionAlignmentAckJson,
  parseStoredProductionAlignmentAck,
  refundProductionAlignmentWarnings,
  resolveRefundReasonCategoriesForDecision,
  suggestRefundCategoriesFromProduction,
  validateRefundProductionAlignmentAtSubmit,
} from './refundProductionAlignment.js';
import { loadActiveRefundShortfallCaps } from './refundPaidProductionEditGate.js';
import { QUANTITY_NETTED_REFUND_CATEGORIES } from '../shared/lib/refundPaidProductionCaps.js';
import {
  creditRefundToPartnerWalletTx,
  voidPartnerWalletCreditsForRefundTx,
} from './finance/partnerWalletCredit.js';
import { savedCustomerPayoutAccount } from './sales/customerPayoutAccount.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function refundLineAmountNgnFromPayload(line) {
  const raw = line?.amountNgn ?? line?.amount_ngn;
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? roundMoney(n) : 0;
}

/** Sum of included breakdown lines (`include !== false`). Matches RefundModal included-line rules. */
export function sumIncludedRefundCalculationLinesNgn(lines) {
  if (!Array.isArray(lines)) return 0;
  let s = 0;
  for (const l of lines) {
    if (l?.include === false) continue;
    s += refundLineAmountNgnFromPayload(l);
  }
  return roundMoney(s);
}

/** Parse calculation lines from approve payload or stored refund row. */
function normalizeRefundCalculationLineForStorage(line) {
  const label = String(line?.label ?? '').trim();
  const amountNgn = roundMoney(line?.amountNgn ?? line?.amount_ngn);
  if (!label || amountNgn <= 0) return null;
  const out = { label, amountNgn };
  const category = String(line?.category ?? '').trim();
  if (category) out.category = category;
  if (line?.include === false) out.include = false;
  else if (line?.include === true) out.include = true;
  const applies = line?.appliesToCategories;
  if (Array.isArray(applies) && applies.length) {
    out.appliesToCategories = applies.map((c) => String(c).trim()).filter(Boolean);
  }
  return out;
}

function enrichRefundCalculationLinesWithReasonCategories(lines, reasonCategoryRaw) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return list;
  if (list.some((l) => String(l?.category || '').trim())) return list;
  const cats = normalizeRefundReasonCategoriesForApi(reasonCategoryRaw);
  if (cats.length === 1 && list.length === 1) {
    return [{ ...list[0], category: cats[0], include: list[0]?.include !== false }];
  }
  if (cats.length === list.length) {
    return list.map((line, i) => ({
      ...line,
      category: cats[i],
      include: line?.include !== false,
    }));
  }
  return list;
}

export function parseRefundCalculationLinesFromRow(row, payloadLines) {
  if (Array.isArray(payloadLines) && payloadLines.length > 0) {
    return payloadLines
      .map((line) => normalizeRefundCalculationLineForStorage(line))
      .filter(Boolean);
  }
  try {
    const parsed = JSON.parse(String(row?.calculation_lines_json || '[]'));
    const lines = Array.isArray(parsed) ? parsed : [];
    return enrichRefundCalculationLinesWithReasonCategories(lines, row?.reason_category);
  } catch {
    return [];
  }
}

function actorMayBypassIncompleteRefundFloor(actor, hasPermission) {
  if (typeof hasPermission === 'function' && hasPermission('*')) return true;
  const rk = String(actor?.roleKey ?? actor?.role_key ?? actor?.role ?? '')
    .trim()
    .toLowerCase();
  if (rk === 'admin') return true;
  return isExecutiveRoleKey(rk);
}

/**
 * Active order-cancellation refund blocks new production on the quotation.
 */
export function assertQuotationProductionNotBlockedByRefund(db, quotationRef) {
  if (!quotationHasNonRejectedOrderCancellationRefund(db, quotationRef)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'ORDER_CANCELLATION_REFUND_BLOCKS_PRODUCTION',
    error:
      'An active order-cancellation refund exists on this quotation. Resolve or reject that refund before registering or completing production.',
  };
}

function sumRefundCalculationLinesForCategoriesNgn(lines, categories) {
  const set = new Set((categories || []).map((c) => String(c || '').trim()).filter(Boolean));
  if (!set.size) return 0;
  return sumIncludedRefundCalculationLinesNgn(
    (Array.isArray(lines) ? lines : []).filter((l) => {
      if (l?.include === false) return false;
      const cat = String(l?.category || '').trim();
      if (set.has(cat)) return true;
      const applies = Array.isArray(l?.appliesToCategories) ? l.appliesToCategories : [];
      return applies.some((c) => set.has(String(c || '').trim()));
    })
  );
}

function bundledTransportInstallServiceCapNgn(db, quotationRef, quote) {
  const quoteLines = collectQuotationServices(db, quotationRef, quote);
  for (const s of quoteLines) {
    const nl = serviceNameLower(s);
    if (!matchesTransportService(nl) || !matchesInstallationService(nl)) continue;
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    const amt = roundMoney(qty * unitPrice);
    if (amt > 0) return amt;
  }
  return 0;
}

/**
 * Bundled transport+installation service lines must not be double-refunded across separate requests.
 */
export function validateBundledTransportInstallCrossRequest(
  db,
  quotationRef,
  quote,
  requestedCategories,
  calculationLines,
  excludeRefundId = null
) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true };

  const bundledCap = bundledTransportInstallServiceCapNgn(db, ref, quote);
  if (bundledCap <= 0) return { ok: true };

  const requested = Array.isArray(requestedCategories) ? requestedCategories : [];
  const touchesBundled = requested.some(
    (c) => c === 'Transport issue' || c === 'Installation issue'
  );
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  const newTransport = sumRefundCalculationLinesForCategoriesNgn(lines, ['Transport issue']);
  const newInstall = sumRefundCalculationLinesForCategoriesNgn(lines, ['Installation issue']);
  if (!touchesBundled && newTransport <= 0 && newInstall <= 0) return { ok: true };

  const sameRequestBundledSplit = lines.some((l) => {
    const applies = Array.isArray(l?.appliesToCategories) ? l.appliesToCategories : [];
    return applies.includes('Transport issue') && applies.includes('Installation issue');
  });

  const existingRows = db
    .prepare(
      `SELECT refund_id, calculation_lines_json FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')${
           excludeRefundId ? ' AND refund_id != ?' : ''
         }`
    )
    .all(...(excludeRefundId ? [ref, excludeRefundId] : [ref]));

  let existingTransport = 0;
  let existingInstall = 0;
  for (const row of existingRows) {
    const stored = parseRefundCalculationLinesFromRow(row, null);
    existingTransport += sumRefundCalculationLinesForCategoriesNgn(stored, ['Transport issue']);
    existingInstall += sumRefundCalculationLinesForCategoriesNgn(stored, ['Installation issue']);
  }

  if (!sameRequestBundledSplit) {
    if (existingTransport > 0 && (newInstall > 0 || requested.includes('Installation issue'))) {
      return {
        ok: false,
        code: 'BUNDLED_SERVICE_CROSS_REFUND',
        error:
          'This quotation bundles transport and installation on one service line. A transport refund already exists — refund installation on the same request (split the bundled line) or reject the duplicate claim.',
      };
    }
    if (existingInstall > 0 && (newTransport > 0 || requested.includes('Transport issue'))) {
      return {
        ok: false,
        code: 'BUNDLED_SERVICE_CROSS_REFUND',
        error:
          'This quotation bundles transport and installation on one service line. An installation refund already exists — refund transport on the same request (split the bundled line) or reject the duplicate claim.',
      };
    }
  }

  const combined =
    existingTransport + existingInstall + newTransport + newInstall;
  if (combined > bundledCap + REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
    return {
      ok: false,
      code: 'BUNDLED_SERVICE_CAP_EXCEEDED',
      error: `Transport and installation refunds (₦${combined.toLocaleString(
        'en-NG'
      )}) cannot exceed the bundled service line on this quotation (₦${bundledCap.toLocaleString(
        'en-NG'
      )}).`,
    };
  }

  return { ok: true };
}

/**
 * Production alignment at payout — honour stored submit/approval acks; only re-block on hard blockers.
 * Excludes the refund being paid so it cannot conflict with itself as a "prior" refund.
 * @param {object | null | undefined} [refundRow] customer_refunds row (for production_alignment_ack_json)
 */
export function validateRefundProductionAlignmentAtPayout(db, quotationRef, reasonCategories, refundRow = null) {
  const excludeRefundId = String(refundRow?.refund_id || refundRow?.refundId || '').trim() || null;
  const issues = enrichProductionAlignmentIssuesForSubmit(
    refundProductionAlignmentWarnings(db, quotationRef, reasonCategories, { excludeRefundId })
  );
  const storedAlign = parseStoredProductionAlignmentAck(refundRow?.production_alignment_ack_json);
  const ackSet = new Set((storedAlign?.acknowledgedCodes || []).map((c) => String(c).trim()).filter(Boolean));
  const overrideOk =
    Boolean(storedAlign?.overrideUsed) && String(storedAlign?.overrideNote || '').trim().length >= 10;

  const fatal = issues.filter((i) => {
    const action = String(i.submitAction || '').trim();
    const code = String(i.code || '').trim();
    if (action === 'acknowledge') return !ackSet.has(code);
    if (action !== 'block') return false;
    if (code === 'multi_category_overlap' || code === 'multi_category_overlap_same_request') return true;
    return !overrideOk;
  });
  if (!fatal.length) return { ok: true, issues };
  const first = fatal[0];
  return {
    ok: false,
    code: 'REFUND_PRODUCTION_ALIGNMENT_PAYOUT',
    error:
      first.message ||
      first.title ||
      'Refund no longer aligns with current production. Reject or adjust the refund before payout.',
    issues: fatal,
  };
}

/**
 * Sum of non-rejected / non-cancelled refund amounts on a quotation.
 * Pass `excludeRefundId` when evaluating headroom for an existing request (approve / payout / integrity).
 */
export function quotationActiveRefundedTotalNgn(db, quotationRef, excludeRefundId = null) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return 0;
  const exclude = String(excludeRefundId || '').trim();
  const row = exclude
    ? db
        .prepare(
          `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM customer_refunds
           WHERE quotation_ref = ?
             AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
             AND refund_id != ?`
        )
        .get(ref, exclude)
    : db
        .prepare(
          `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM customer_refunds
           WHERE quotation_ref = ?
             AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
        )
        .get(ref);
  return roundMoney(row?.s ?? 0);
}


/**
 * Shared financial guards for refund approve and payout (live preview caps, economic floor, stale detection).
 */
export function validateRefundFinancialGuards(db, opts = {}) {
  const {
    quotationRef,
    refundId = null,
    amountNgn,
    calculationLines = [],
    reasonCategories = [],
    actor = null,
    hasPermission = () => false,
    phase = 'approve',
  } = opts;

  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true };

  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  if (!lines.length) {
    return {
      ok: false,
      code: 'REFUND_BREAKDOWN_REQUIRED',
      error:
        phase === 'pay'
          ? 'Refund payout requires calculation breakdown lines on file. Re-approve with a valid breakdown.'
          : 'Refund approval requires calculation breakdown lines. Open Sales to edit the breakdown.',
    };
  }

  const amt = roundMoney(amountNgn);
  if (amt <= 0) return { ok: false, error: 'Refund amount must be positive.' };

  const excludeId = String(refundId || '').trim() || null;
  const refundRow = excludeId
    ? db
        .prepare(
          `SELECT refund_id, production_alignment_ack_json, preview_snapshot_json, amount_ngn FROM customer_refunds WHERE refund_id = ?`
        )
        .get(excludeId)
    : null;
  const storedAlign = parseStoredProductionAlignmentAck(refundRow?.production_alignment_ack_json);
  const floorOverride = storedAlign?.economicFloorOverride;
  const floorOverrideHonoured =
    Boolean(floorOverride?.used) &&
    String(floorOverride?.note || '').trim().length >= 10 &&
    Math.abs(amt - roundMoney(floorOverride?.amountNgn ?? -1)) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN;

  const preview = previewRefundRequest(db, {
    quotationRef: ref,
    excludeRefundId: excludeId,
  });
  if (!preview.ok) return preview;

  const economicFloor = preview.preview?.economicFloor ?? null;
  const producedM = Number(economicFloor?.producedOutputMeters || 0);
  // Overpayment + quoted services are cash/service refunds — not gated by roofing floor ₦/m.
  const floorExempt = refundRequestIsEconomicFloorExempt({
    categories: reasonCategories,
    calculationLines: lines,
  });

  if (!floorExempt && economicFloor?.incompleteFloorPricing && producedM > 0.001) {
    if (!actorMayBypassIncompleteRefundFloor(actor, hasPermission) && !floorOverrideHonoured) {
      return {
        ok: false,
        code: 'REFUND_INCOMPLETE_FLOOR_PRICING',
        error: `Workbook floor ₦/m could not be resolved for ${producedM.toFixed(
          2
        )} m produced. Resolve material workbook pricing or escalate to MD/CEO before ${
          phase === 'pay' ? 'payout' : 'approval'
        }.`,
      };
    }
  }

  if (
    !floorOverrideHonoured &&
    refundAmountExceedsEconomicFloorCap({
      amountNgn: amt,
      calculationLines: lines,
      categories: reasonCategories,
      maxDefensibleRefundNgn: economicFloor?.maxDefensibleRefundNgn,
      overpaymentExcessNgn: preview.preview?.overpaymentExcessNgn,
      toleranceNgn: REFUND_AMOUNT_LINE_TOLERANCE_NGN,
    })
  ) {
    const gatedAmt = refundFloorGatedAmountNgn(lines);
    return {
      ok: false,
      code: 'REFUND_STALE_ECONOMIC_FLOOR',
      error: `Production-related refund amount (₦${gatedAmt.toLocaleString(
        'en-NG'
      )}) exceeds the current economic floor cap (₦${Number(
        economicFloor.maxDefensibleRefundNgn
      ).toLocaleString('en-NG')}) after ${producedM.toFixed(
        2
      )} m produced. Overpayment and quoted services are not counted against this cap. Production may have changed — recalculate integrity and adjust the refund.`,
    };
  }

  const totalRefundedExcluding = quotationActiveRefundedTotalNgn(db, ref, excludeId);

  const derivedCategoryMaxNgn = buildDerivedRefundCategoryCapsNgn({
    cashInNgn: quotationCashInNgn(db, ref),
    totalRefundedNgn: totalRefundedExcluding,
    economicFloor: floorExempt ? null : economicFloor,
  });
  const livePreviewCaps = buildRefundCategorySuggestedMaxNgn(preview.preview?.suggestedLines || []);

  const quoteRow = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(ref);
  const bundledCheck = validateBundledTransportInstallCrossRequest(
    db,
    ref,
    quoteRow,
    reasonCategories,
    lines,
    refundId
  );
  if (!bundledCheck.ok) return bundledCheck;

  const overlapCheck = validateRefundSameRequestOverlapCategoriesNgn(lines);
  if (!overlapCheck.ok) return overlapCheck;

  const capCheck = validateRefundCategorySuggestedCapsNgn({
    calculationLines: lines,
    categorySuggestedMaxNgn: livePreviewCaps,
    derivedCategoryMaxNgn,
    toleranceNgn: REFUND_AMOUNT_LINE_TOLERANCE_NGN,
  });
  if (!capCheck.ok) return capCheck;

  const overpayOnThis = roundMoney(sumRefundCalculationLinesByCategoryNgn(lines).Overpayment);
  const overpayResidualRaw = preview.preview?.overpaymentResidualNgn;
  const overpayResidual =
    overpayResidualRaw != null
      ? roundMoney(overpayResidualRaw)
      : roundMoney(preview.preview?.overpaymentExcessNgn);
  if (overpayOnThis > 0 && overpayOnThis > overpayResidual + REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
    return {
      ok: false,
      code: 'REFUND_OVERPAYMENT_ALREADY_SETTLED',
      error:
        overpayResidual <= 0
          ? 'Overpayment on this quotation is already fully refunded. Paying or approving this amount would double-pay the customer.'
          : `Only ₦${overpayResidual.toLocaleString('en-NG')} overpayment remains after prior refunds on this quotation.`,
    };
  }

  const lineArithmetic = validateRefundCalculationLineArithmetic(
    lines,
    REFUND_AMOUNT_LINE_TOLERANCE_NGN
  );
  if (!lineArithmetic.ok) return lineArithmetic;

  if (phase === 'pay') {
    const alignPay = validateRefundProductionAlignmentAtPayout(db, ref, reasonCategories, {
      ...(refundRow || {}),
      refund_id: excludeId || refundRow?.refund_id || null,
    });
    if (!alignPay.ok) return alignPay;
  }

  return { ok: true, preview, economicFloor, economicFloorOverrideHonoured: floorOverrideHonoured };
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value || 'null');
  } catch {
    return null;
  }
}

/**
 * Normalized product line name for comparing to master trim sheet names (sales “products” tab).
 * Trim/cladding lines use metre qty but are not coil-produced roofing sheet — exclude from unproduced-metre math.
 */
function normQuoteProductLineName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Matches `setup_quote_items` product rows except main roofing sheet metre lines (trim/accessories). Flat sheet is treated as main sheet metreage for refunds. Stone flatsheet is excluded separately (m² / sheet, not coil metres). */
const REFUND_NON_ROOFING_SHEET_PRODUCT_NAMES = new Set([
  'bargeboard',
  'top end',
  'gutter',
  'eaves angle',
  'eave angle',
  'wall flashing',
  'ridge cap',
  'capping',
  'bottom eaves',
  'fascia',
  'cladding',
  'offcut',
  'wall eaves',
  'crimp',
  'coil',
]);

function productLineIsTrimSheetNotRoofingMetres(line) {
  const n = normQuoteProductLineName(line?.name);
  if (!n) return false;
  return REFUND_NON_ROOFING_SHEET_PRODUCT_NAMES.has(n);
}

/** Stone flatsheet lines are m² / sheet pricing — never coil roofing metres for unproduced-metre preview. */
function productLineIsStoneFlatsheetNotRoofingMetres(line) {
  return isStoneFlatsheetQuotationLine(line?.name);
}

/** Blended ₦/m from **roofing sheet** product lines only (excludes eaves angle, ridge, gutter, etc.). */
function quotedRoofingSheetAmountPerMeter(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const rows = payload?.products;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const productRows = rows.filter(
    (line) =>
      !productLineIsTrimSheetNotRoofingMetres(line) &&
      !productLineIsStoneFlatsheetNotRoofingMetres(line) &&
      quotationLineQtyNumber(line) > 0 &&
      quotationLineUnitPriceNumber(line) > 0
  );
  const totalMeters = productRows.reduce((sum, line) => sum + quotationLineQtyNumber(line), 0);
  if (totalMeters <= 0) return null;
  const totalValue = productRows.reduce(
    (sum, line) => sum + quotationLineQtyNumber(line) * quotationLineUnitPriceNumber(line),
    0
  );
  return totalValue > 0 ? totalValue / totalMeters : null;
}

function quotedAmountPerMeter(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }
  const rows = payload?.products;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const productRows = rows.filter(
    (line) => quotationLineQtyNumber(line) > 0 && quotationLineUnitPriceNumber(line) > 0
  );
  const totalMeters = productRows.reduce((sum, line) => sum + quotationLineQtyNumber(line), 0);
  if (totalMeters <= 0) return null;
  const totalValue = productRows.reduce(
    (sum, line) => sum + quotationLineQtyNumber(line) * quotationLineUnitPriceNumber(line),
    0
  );
  return totalValue > 0 ? totalValue / totalMeters : null;
}

function quotationHasCompletedDelivery(db, quotationRef) {
  if (!quotationRef) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS x FROM deliveries
         WHERE quotation_ref = ?
           AND (
             TRIM(COALESCE(delivered_date_iso, '')) != ''
             OR LOWER(TRIM(COALESCE(status, ''))) IN ('delivered', 'completed')
             OR COALESCE(fulfillment_posted, 0) = 1
           )
         LIMIT 1`
      )
      .get(quotationRef);
    return Boolean(row);
  } catch {
    return false;
  }
}

function collectQuotationServices(db, quotationRef, quote) {
  const seen = new Set();
  /** @type {any[]} */
  const list = [];
  const pushService = (row) => {
    if (!row || typeof row !== 'object') return;
    const name = String(row?.name ?? row?.description ?? row?.itemName ?? '').trim();
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(row);
    if (!name && qty * unitPrice <= 0) return;
    const key = `${name.toLowerCase()}|${qty}|${unitPrice}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      ...row,
      name: name || String(row?.name ?? 'Service').trim() || 'Service',
      qty: qty || row?.qty,
      unitPrice: unitPrice || row?.unitPrice,
    });
  };
  try {
    const raw = quote?.lines_json;
    const j = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (Array.isArray(j?.services)) {
      for (const s of j.services) pushService(s);
    }
    // Some quotes store transport / labour as typed rows under products or flat lines arrays.
    for (const key of ['products', 'accessories', 'items', 'lines']) {
      if (!Array.isArray(j?.[key])) continue;
      for (const row of j[key]) {
        const t = String(row?.type ?? row?.itemType ?? row?.category ?? row?.lineType ?? '')
          .trim()
          .toLowerCase();
        if (t === 'service' || t === 'services') pushService(row);
      }
    }
  } catch {
    /* ignore parse errors */
  }
  if (list.length === 0 && quotationRef) {
    try {
      const rows = db
        .prepare(
          `SELECT name, qty, unit_price_ngn FROM quotation_lines
           WHERE quotation_id = ? AND LOWER(TRIM(COALESCE(category, ''))) IN ('services', 'service')
           ORDER BY sort_order`
        )
        .all(quotationRef);
      for (const r of rows) {
        pushService({
          id: `ql-${r.name}-${r.unit_price_ngn}`,
          name: r.name,
          qty: r.qty,
          unitPrice: r.unit_price_ngn,
        });
      }
    } catch {
      /* quotation_lines may be missing in some contexts */
    }
  }
  return list;
}

function serviceNameLower(line) {
  return String(line?.name ?? line?.description ?? '').trim().toLowerCase();
}

function serviceQtyAndUnitPriceNgn(line) {
  const qty = Number(String(line?.qty ?? line?.quantity ?? '').replace(/,/g, '')) || 0;
  let unit = 0;
  if (line?.unitPrice != null) unit = Number(String(line.unitPrice).replace(/,/g, '')) || 0;
  else if (line?.unit_price != null) unit = Number(String(line.unit_price).replace(/,/g, '')) || 0;
  else if (line?.unit_price_ngn != null) unit = Number(line.unit_price_ngn) || 0;
  let unitPrice = roundMoney(unit);
  let amt = roundMoney(qty * unitPrice);
  if (amt <= 0 && qty > 0) {
    const lump = roundMoney(
      Number(String(line?.value ?? line?.lineTotal ?? line?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
    if (lump > 0) unitPrice = roundMoney(lump / qty);
  } else if (amt <= 0) {
    const lump = roundMoney(
      Number(String(line?.value ?? line?.lineTotal ?? line?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
    if (lump > 0) return { qty: 1, unitPrice: lump };
  }
  return { qty, unitPrice: roundMoney(unitPrice) };
}

function quotationJsonLineAmountNgn(row) {
  const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
  const unit = roundMoney(
    Number(String(row?.unitPrice ?? row?.unit_price ?? row?.unit_price_ngn ?? '').replace(/,/g, '')) || 0
  );
  let amt = roundMoney(qty * unit);
  if (amt <= 0) {
    amt = roundMoney(
      Number(String(row?.value ?? row?.lineTotal ?? row?.line_total_ngn ?? '').replace(/,/g, '')) || 0
    );
  }
  return amt;
}

function sumQuotationLinesJsonFlexible(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      return 0;
    }
  }
  if (!payload || typeof payload !== 'object') return 0;
  let s = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = payload[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!String(row?.name ?? '').trim()) continue;
      s += quotationJsonLineAmountNgn(row);
    }
  }
  return roundMoney(s);
}

/** First product line with gauge + design/colour — for substitution list hints (quoted vs supplied gauge). */
function firstQuotedProductGaugeDesign(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      return null;
    }
  }
  const prods = payload?.products;
  if (!Array.isArray(prods)) return null;
  for (const p of prods) {
    if (!String(p?.name ?? '').trim()) continue;
    const gauge = String(
      p?.materialGauge ?? p?.material_gauge ?? p?.gauge ?? p?.gaugeLabel ?? ''
    ).trim();
    const design = String(
      p?.materialDesign ?? p?.design ?? p?.materialColor ?? p?.colour ?? p?.color ?? ''
    ).trim();
    if (gauge && design) return { gauge, design };
  }
  return null;
}

/** Ordered design/colour strings from quotation JSON for workbook keys (deduped). */
function quotedDesignCandidatesForSubstitution(linesJson, quotedGd) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return;
    const k = normKeyPriceList(t);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  if (quotedGd?.design) push(quotedGd.design);
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = null;
    }
  }
  if (payload && typeof payload === 'object') {
    push(payload.materialDesign);
    push(payload.materialColor);
    push(payload.materialColour);
    if (Array.isArray(payload.products)) {
      for (const p of payload.products) {
        push(p?.materialDesign ?? p?.design ?? p?.profile ?? p?.profileName);
        push(p?.materialColor ?? p?.colour ?? p?.color);
      }
    }
  }
  return out;
}

function normKeyPriceList(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Workbook / material sheet sync often stores `gauge_key` as numeric mm (`0.24`); coils use `0.24mm`.
 * Return normalized keys to try against `price_list_items.gauge_key`.
 */
function gaugeKeyLookupCandidates(gaugeRaw) {
  const seen = new Set();
  const add = (x) => {
    const k = normKeyPriceList(String(x ?? '').trim());
    if (k) seen.add(k);
  };
  const raw = String(gaugeRaw ?? '').trim();
  if (!raw) return [];
  add(raw);
  const mm = firstGaugeMmFromLabel(raw);
  if (mm != null && Number.isFinite(mm)) {
    add(`${mm}mm`);
    add(`${mm} mm`);
    add(String(mm));
  }
  return [...seen];
}

/** Published list ₦/m for gauge + design effective on {@link asAtIso} (quotation period). */
function listPricePerMeterFromGaugeDesign(db, gaugeRaw, designRaw, branchId, asAtIso) {
  const d = normKeyPriceList(designRaw);
  if (!d) return null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  const gaugeKeys = gaugeKeyLookupCandidates(gaugeRaw);
  if (!gaugeKeys.length) return null;

  for (const g of gaugeKeys) {
    try {
      const scored = resolvePriceListItemFloorNgn(db, {
        gaugeLabel: g,
        designLabel: d,
        colourName: d,
        profileName: '',
        materialTypeName: '',
        branchId: bid,
        asAtIso,
      });
      if (scored?.unitPricePerMeterNgn) return scored.unitPricePerMeterNgn;
    } catch {
      /* Floor resolver must not block legacy lookups. */
    }
  }
  return null;
}

/** Minimum list ₦/m for a gauge across designs, as at {@link asAtIso}. */
function listPricePerMeterMinForGaugeAcrossDesigns(db, gaugeRaw, branchId, asAtIso) {
  const gaugeKeys = gaugeKeyLookupCandidates(gaugeRaw);
  if (!gaugeKeys.length) return null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  const gaugeSet = new Set(gaugeKeys.map((g) => normKeyPriceList(g)));
  try {
    const collapsed = selectPriceListRowsAsOf(db.prepare(`SELECT * FROM price_list_items`).all(), asAtIso);
    let min = 0;
    for (const row of collapsed) {
      if (!gaugeSet.has(normKeyPriceList(row.gauge_key))) continue;
      const rb = row.branch_id != null && String(row.branch_id).trim() ? String(row.branch_id).trim() : null;
      if (bid && rb && rb !== bid) continue;
      const n = Math.round(Number(row.unit_price_per_meter_ngn) || 0);
      if (n > 0 && (min === 0 || n < min)) min = n;
    }
    return min > 0 ? min : null;
  } catch {
    return null;
  }
}

/** Standard coil workbook `gauge_mm` keys (aligned with material pricing sheet). */
const MATERIAL_SHEET_GAUGE_MM_KEYS = [
  '0.18',
  '0.20',
  '0.22',
  '0.24',
  '0.28',
  '0.30',
  '0.40',
  '0.45',
  '0.50',
  '0.55',
  '0.70',
];

/** Map physical coil label to `material_pricing_sheet_rows.gauge_mm`. */
function workbookGaugeMmKeyFromCoilLabel(coilGaugeRaw) {
  const mm = firstGaugeMmFromLabel(coilGaugeRaw);
  if (mm == null || !Number.isFinite(mm)) return null;
  for (const g of MATERIAL_SHEET_GAUGE_MM_KEYS) {
    if (Math.abs(parseFloat(g, 10) - mm) < 1e-4) return g;
  }
  return null;
}

/**
 * `alu` | `aluzinc` from coil lot / job product, else from FG `products` row (e.g. longspan on coil).
 */
function materialPricingMaterialKeyFromJob(db, job) {
  const jid = String(job?.job_id ?? '').trim();
  if (jid) {
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(NULLIF(TRIM(cl.product_id), ''), NULLIF(TRIM(pjc.product_id), '')) AS pid
           FROM production_job_coils pjc
           LEFT JOIN coil_lots cl ON cl.coil_no = pjc.coil_no
           WHERE pjc.job_id = ?
           ORDER BY pjc.sequence_no ASC, pjc.id ASC
           LIMIT 1`
        )
        .get(jid);
      const mk = materialPricingMaterialKeyFromProductId(db, String(row?.pid ?? '').trim());
      if (mk) return mk;
    } catch {
      /* ignore */
    }
  }
  return materialPricingMaterialKeyFromProductId(db, String(job?.product_id ?? '').trim());
}

function materialPricingMaterialKeyFromProductId(db, productId) {
  const pid = String(productId ?? '').trim();
  if (!pid) return null;
  if (pid === 'COIL-ALU') return 'alu';
  if (pid === 'PRD-102') return 'aluzinc';
  try {
    const row = db
      .prepare(`SELECT material_type, name, dashboard_attrs_json FROM products WHERE product_id = ? LIMIT 1`)
      .get(pid);
    const mt = String(row?.material_type || '').toLowerCase();
    const nm = String(row?.name || '').toLowerCase();
    let extra = {};
    try {
      extra = JSON.parse(row?.dashboard_attrs_json || '{}');
    } catch {
      extra = {};
    }
    const comb = `${mt} ${nm} ${String(extra.materialType || '').toLowerCase()}`;
    if (comb.includes('aluzinc') || comb.includes('ppgi') || comb.includes('galvan')) return 'aluzinc';
    if (comb.includes('alumin') || comb.includes('alu')) return 'alu';
  } catch {
    /* ignore */
  }
  return null;
}

/** Minimum ₦/m from material pricing workbook (excludes commission); branch required on sheet rows. */
function floorPricePerMeterFromMaterialPricingSheet(db, materialKey, gaugeMmKey, designKeyNorm, sheetBranchId, asAtIso) {
  return workbookFloorPerMeterAsOf(db, materialKey, gaugeMmKey, designKeyNorm, sheetBranchId, asAtIso);
}

function floorPricePerMeterMinForGaugeAcrossDesignsMaterial(db, materialKey, gaugeMmKey, sheetBranchId, asAtIso) {
  return workbookFloorMinPerMeterAsOf(db, materialKey, gaugeMmKey, sheetBranchId, asAtIso);
}

function workbookFloorPpmForQuotedGaugeDesign(db, materialKey, quotedGd, sheetBranchId, asAtIso) {
  if (!quotedGd || !materialKey) return null;
  const gk = workbookGaugeMmKeyFromCoilLabel(quotedGd.gauge);
  if (!gk) return null;
  for (const dKey of expandedDesignKeysForWorkbook(db, quotedGd.design)) {
    const f = floorPricePerMeterFromMaterialPricingSheet(db, materialKey, gk, dKey, sheetBranchId, asAtIso);
    if (f != null && f > 0) return f;
  }
  const blank = floorPricePerMeterFromMaterialPricingSheet(db, materialKey, gk, '', sheetBranchId, asAtIso);
  return blank != null && blank > 0 ? blank : null;
}

/**
 * True when quoted vs coil gauges are commercially different.
 * Tolerance only absorbs label noise (0.24 vs 0.240), not the usual 0.02mm gauge steps
 * (0.24 vs 0.22 must credit). Historical default of 0.02mm wrongly treated adjacent gauges as equal.
 */
function gaugesDifferBeyondTolerance(quotedLabel, producedLabel, tolMm = 0.005) {
  const a = firstGaugeMmFromLabel(quotedLabel);
  const b = firstGaugeMmFromLabel(producedLabel);
  if (a == null || b == null) return false;
  return Math.abs(a - b) > tolMm + 1e-9;
}

/**
 * Stable key so "0.22mm" and "0.22" group together for mixed-coil substitution.
 * @param {string} label
 */
function coilGaugeGroupKey(label) {
  const mm = firstGaugeMmFromLabel(label);
  if (mm == null) return String(label || '').trim().toLowerCase();
  return String(Math.round(mm * 1000) / 1000);
}

/**
 * Coil metres on a job grouped by physical gauge (one job can consume several rolls).
 * Metres come from `production_job_coils.meters_produced` — authoritative for gauge split.
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} jobId
 * @returns {{ gaugeLabel: string, meters: number }[]}
 */
function coilGaugeMeterGroupsFromJob(db, jobId) {
  const jid = String(jobId ?? '').trim();
  if (!jid) return [];
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(pjc.gauge_label), ''), NULLIF(TRIM(cl.gauge_label), '')) AS g,
                COALESCE(pjc.meters_produced, 0) AS meters
         FROM production_job_coils pjc
         LEFT JOIN coil_lots cl ON cl.coil_no = pjc.coil_no
         WHERE pjc.job_id = ?
         ORDER BY pjc.sequence_no ASC, pjc.id ASC`
      )
      .all(jid);
  } catch {
    return [];
  }
  /** @type {Map<string, { gaugeLabel: string, meters: number }>} */
  const byKey = new Map();
  for (const r of rows) {
    const g = String(r?.g ?? '').trim();
    if (!g) continue;
    const meters = Number(r?.meters) || 0;
    const key = coilGaugeGroupKey(g);
    if (!key) continue;
    const prev = byKey.get(key);
    if (prev) {
      prev.meters += meters;
    } else {
      byKey.set(key, { gaugeLabel: g, meters });
    }
  }
  return [...byKey.values()].map((g) => ({
    gaugeLabel: g.gaugeLabel,
    meters: Math.round((Number(g.meters) || 0) * 100) / 100,
  }));
}

/**
 * Physical coil gauge from job allocations (authoritative when steel came from a roll
 * whose gauge differs from the FG master product card — e.g. quoted 0.28, coil 0.24).
 * When a job has mixed gauges, returns the first labelled allocation (prefer
 * {@link coilGaugeMeterGroupsFromJob} for substitution / floor maths).
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} jobId
 */
function producedGaugeLabelFromJobCoils(db, jobId) {
  const groups = coilGaugeMeterGroupsFromJob(db, jobId);
  if (groups.length === 0) return '';
  const withMetres = groups.find((g) => (Number(g.meters) || 0) > 0);
  return String((withMetres || groups[0]).gaugeLabel || '').trim();
}

/** Include `pricing_profile_aliases` canonical design when resolving workbook rows. */
function expandedDesignKeysForWorkbook(db, designLabelRaw) {
  const seen = new Set();
  const out = [];
  const add = (s) => {
    const k = normKeyPriceList(String(s ?? '').trim());
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  add(designLabelRaw);
  const base = normKeyPriceList(String(designLabelRaw ?? '').trim());
  if (base) {
    try {
      const canon = resolveAliasForDesign(db, base);
      if (canon) add(canon);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Workbook **floor** ₦/m (material pricing `minimum_price_per_m_ngn`) for steel actually used:
 * **allocated coil gauge** + design/colour, then published list from `price_list_items` if no sheet row.
 * Pass `coilGaugeLabel` when a job has mixed gauges and each slice must be priced separately.
 * @returns {{ ppm: number, source: 'override' | 'workbook_floor' | 'price_list' } | null}
 *   null when there is no coil gauge on the job (caller treats as “cannot auto-price”).
 */
function listWorkbookPpmForJobAllocatedCoil(
  db,
  job,
  branchId,
  quotedGd,
  overrideSubPpm,
  linesJson = '',
  asAtIso,
  coilGaugeLabel = null
) {
  const ov = positiveNumber(overrideSubPpm);
  if (ov != null && ov > 0) return { ppm: ov, source: 'override' };
  const coilGauge =
    String(coilGaugeLabel ?? '').trim() || producedGaugeLabelFromJobCoils(db, job?.job_id);
  if (!coilGauge) return null;

  const sheetBranch = (branchId && String(branchId).trim()) || DEFAULT_BRANCH_ID;
  const materialKey = materialPricingMaterialKeyFromJob(db, job);
  const gaugeMmKey = workbookGaugeMmKeyFromCoilLabel(coilGauge);

  const tryFloorThenList = (dKeyRaw) => {
    const dKey = dKeyRaw != null ? normKeyPriceList(dKeyRaw) : '';
    if (materialKey && gaugeMmKey) {
      const f = floorPricePerMeterFromMaterialPricingSheet(db, materialKey, gaugeMmKey, dKey, sheetBranch, asAtIso);
      if (f != null && f > 0) return { ppm: f, source: 'workbook_floor' };
    }
    if (!dKey) return null;
    const list = listPricePerMeterFromGaugeDesign(db, coilGauge, dKey, branchId, asAtIso);
    if (list != null && list > 0) return { ppm: list, source: 'price_list' };
    return null;
  };

  for (const dRaw of quotedDesignCandidatesForSubstitution(linesJson, quotedGd)) {
    for (const dKey of expandedDesignKeysForWorkbook(db, dRaw)) {
      const v = tryFloorThenList(dKey);
      if (v != null && v.ppm > 0) return v;
    }
  }

  const pid = String(job?.product_id ?? '').trim();
  if (pid) {
    let row;
    try {
      row = db
        .prepare(
          `SELECT gauge, colour, material_type, dashboard_attrs_json FROM products WHERE product_id = ? LIMIT 1`
        )
        .get(pid);
    } catch {
      row = null;
    }
    if (row) {
      let extra = {};
      try {
        extra = JSON.parse(row.dashboard_attrs_json || '{}');
      } catch {
        extra = {};
      }
      const designFromProduct = String(
        row.colour || extra.colour || row.material_type || extra.materialType || extra.profile || ''
      ).trim();
      if (designFromProduct) {
        for (const dKey of expandedDesignKeysForWorkbook(db, designFromProduct)) {
          const v = tryFloorThenList(dKey);
          if (v != null && v.ppm > 0) return v;
        }
      }
    }
  }
  try {
    const cl = db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(pjc.colour), ''), NULLIF(TRIM(cl.colour), '')) AS c
         FROM production_job_coils pjc
         LEFT JOIN coil_lots cl ON cl.coil_no = pjc.coil_no
         WHERE pjc.job_id = ?
         ORDER BY pjc.sequence_no ASC, pjc.id ASC
         LIMIT 1`
      )
      .get(String(job?.job_id ?? '').trim());
    const col = String(cl?.c ?? '').trim();
    if (col) {
      for (const dKey of expandedDesignKeysForWorkbook(db, col)) {
        const viaLot = tryFloorThenList(dKey);
        if (viaLot != null && viaLot.ppm > 0) return viaLot;
      }
    }
  } catch {
    /* ignore */
  }
  if (materialKey && gaugeMmKey) {
    const blank = floorPricePerMeterFromMaterialPricingSheet(db, materialKey, gaugeMmKey, '', sheetBranch, asAtIso);
    if (blank != null && blank > 0) return { ppm: blank, source: 'workbook_floor' };
    const floorMin = floorPricePerMeterMinForGaugeAcrossDesignsMaterial(db, materialKey, gaugeMmKey, sheetBranch, asAtIso);
    if (floorMin != null && floorMin > 0) return { ppm: floorMin, source: 'workbook_floor' };
  }
  const minAcross = listPricePerMeterMinForGaugeAcrossDesigns(db, coilGauge, branchId, asAtIso);
  if (minAcross != null && minAcross > 0) return { ppm: minAcross, source: 'price_list' };
  return null;
}

/** @param {{ ppm: number, source: string } | null | undefined} lookup */
function ppmValueFromWorkbookLookup(lookup) {
  const n = lookup?.ppm;
  return n != null && n > 0 ? n : null;
}

/**
 * Minimum economic value delivered at workbook floor ₦/m — sanity check for refund requests.
 * When any completed job has metres but no resolvable ₦/m, `incompleteFloorPricing` is true and
 * `maxDefensibleRefundNgn` is null (missing ppm must not inflate the free-cash cap).
 * When MD already approved a below-floor price on the quotation, produced metres are valued at
 * min(workbook floor, quoted selling ₦/m) so the approved deal economics are not re-blocked on refund.
 * @returns {{
 *   producedOutputMeters: number,
 *   floorDeliveredValueNgn: number,
 *   maxDefensibleRefundNgn: number | null,
 *   priorRefundedNgn: number,
 *   cashInNgn: number,
 *   incompleteFloorPricing: boolean,
 *   usedPriceListFallback: boolean,
 *   honouredMdPriceException: boolean,
 *   quotedSellingPpmNgn: number | null,
 *   ppmSourceByJob: Record<string, string>,
 *   jobRows: { jobId: string, outputMeters: number, floorPpmNgn: number | null, floorValueNgn: number, ppmSource: string | null }[],
 * }}
 */
export function buildRefundEconomicFloorSummary(db, quote, productionJobs, opts = {}) {
  const cashInNgn = roundMoney(opts.cashInNgn ?? 0);
  const priorRefundedNgn = roundMoney(opts.priorRefundedNgn ?? 0);
  const pricingAsAtIso = opts.pricingAsAtIso ?? null;
  const overrideSubPpm = positiveNumber(opts.substitutePricePerMeterNgn);
  const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
  const quotedGd = firstQuotedProductGaugeDesign(quote?.lines_json);
  const linesJson = quote?.lines_json ?? '';

  const quotePriceExceptionShape = {
    mdPriceExceptionApprovedAtISO: quote?.md_price_exception_approved_at_iso ?? quote?.mdPriceExceptionApprovedAtISO,
    priceExceptionMdConfirmedAtISO:
      quote?.price_exception_md_confirmed_at_iso ?? quote?.priceExceptionMdConfirmedAtISO,
  };
  const mdPriceExceptionHonoured = quotationBelowFloorExceptionApproved(quotePriceExceptionShape);
  const quotedSellingPpmRaw =
    quotedRoofingSheetAmountPerMeter(linesJson) ?? quotedAmountPerMeter(linesJson);
  const quotedSellingPpmNgn =
    quotedSellingPpmRaw != null && quotedSellingPpmRaw > 0 ? Math.round(quotedSellingPpmRaw) : null;

  const jobRows = [];
  const ppmSourceByJob = {};
  let floorDeliveredValueNgn = 0;
  let incompleteFloorPricing = false;
  let usedPriceListFallback = false;
  let honouredMdPriceException = false;

  for (const j of productionJobs || []) {
    const st = String(j?.status ?? '').trim().toLowerCase();
    if (st !== 'completed') continue;
    const outputM = jobOutputMetresForUnproducedRefund(db, j);
    if (outputM <= 0) continue;
    const jobId = String(j.job_id ?? j.jobID ?? '').trim();
    const gaugeGroups = coilGaugeMeterGroupsFromJob(db, jobId).filter((g) => (Number(g.meters) || 0) > 0.001);
    const coilMetersSum = gaugeGroups.reduce((s, g) => s + (Number(g.meters) || 0), 0);

    /** @type {{ meters: number, coilGaugeLabel: string | null }[]} */
    const slices =
      coilMetersSum > 0.001
        ? [
            ...gaugeGroups.map((g) => ({ meters: Number(g.meters) || 0, coilGaugeLabel: g.gaugeLabel })),
            // Offcut / job actual above coil metres — value remainder without inventing a coil gauge.
            ...(outputM > coilMetersSum + 0.001
              ? [{ meters: outputM - coilMetersSum, coilGaugeLabel: null }]
              : []),
          ]
        : [{ meters: outputM, coilGaugeLabel: null }];

    // When job output is below coil sum (rare drift), scale coil slices down to outputM.
    const sliceMetersSum = slices.reduce((s, x) => s + x.meters, 0);
    const scale =
      coilMetersSum > 0.001 && outputM + 0.001 < coilMetersSum && sliceMetersSum > 0.001
        ? outputM / coilMetersSum
        : 1;

    let jobFloorValueNgn = 0;
    let jobFloorPpmNgn = null;
    let jobPpmSource = null;
    let jobIncomplete = false;
    const sliceRows = [];

    for (const slice of slices) {
      const sliceM = Math.round(slice.meters * scale * 100) / 100;
      if (sliceM <= 0.001) continue;
      const lookup = listWorkbookPpmForJobAllocatedCoil(
        db,
        j,
        branchId,
        quotedGd,
        overrideSubPpm,
        linesJson,
        pricingAsAtIso,
        slice.coilGaugeLabel
      );
      let floorPpmNgn = ppmValueFromWorkbookLookup(lookup) != null ? Math.round(lookup.ppm) : null;
      let ppmSource = floorPpmNgn != null ? String(lookup.source || '') : null;
      // Stone / offcut FG jobs often have no allocated coil workbook row — use quoted selling ₦/m
      // so incomplete pricing does not null the entire economic floor (and falsely block overpayment).
      if (floorPpmNgn == null && quotedSellingPpmNgn != null) {
        floorPpmNgn = quotedSellingPpmNgn;
        ppmSource = 'quoted_selling_fallback';
      }
      if (
        mdPriceExceptionHonoured &&
        quotedSellingPpmNgn != null &&
        floorPpmNgn != null &&
        quotedSellingPpmNgn < floorPpmNgn
      ) {
        floorPpmNgn = quotedSellingPpmNgn;
        ppmSource = 'md_approved_quoted_selling';
        honouredMdPriceException = true;
      }
      if (ppmSource === 'price_list') usedPriceListFallback = true;
      if (floorPpmNgn == null) jobIncomplete = true;
      const floorValueNgn = floorPpmNgn != null ? roundMoney(sliceM * floorPpmNgn) : 0;
      jobFloorValueNgn += floorValueNgn;
      if (jobFloorPpmNgn == null && floorPpmNgn != null) jobFloorPpmNgn = floorPpmNgn;
      if (!jobPpmSource && ppmSource) jobPpmSource = ppmSource;
      sliceRows.push({
        meters: roundMoney(sliceM),
        coilGaugeLabel: slice.coilGaugeLabel,
        floorPpmNgn,
        floorValueNgn,
        ppmSource,
      });
    }

    if (jobPpmSource) ppmSourceByJob[jobId] = jobPpmSource;
    if (jobIncomplete) incompleteFloorPricing = true;
    floorDeliveredValueNgn += jobFloorValueNgn;
    jobRows.push({
      jobId,
      outputMeters: roundMoney(outputM),
      floorPpmNgn: gaugeGroups.length > 1 ? null : jobFloorPpmNgn,
      floorValueNgn: roundMoney(jobFloorValueNgn),
      ppmSource: jobPpmSource,
      gaugeSlices: sliceRows.length > 1 ? sliceRows : undefined,
    });
  }

  floorDeliveredValueNgn = roundMoney(floorDeliveredValueNgn);
  // Incomplete ppm must not treat unpriced metres as free cash (would inflate the cap).
  const maxDefensibleRefundNgn = incompleteFloorPricing
    ? null
    : Math.max(0, roundMoney(cashInNgn - floorDeliveredValueNgn - priorRefundedNgn));
  const producedOutputMeters = roundMoney(jobRows.reduce((s, r) => s + (Number(r.outputMeters) || 0), 0));

  return {
    producedOutputMeters,
    floorDeliveredValueNgn,
    maxDefensibleRefundNgn,
    priorRefundedNgn,
    cashInNgn,
    incompleteFloorPricing,
    usedPriceListFallback,
    honouredMdPriceException,
    quotedSellingPpmNgn,
    ppmSourceByJob,
    jobRows,
  };
}

export { refundCuttingListQuotationMetreIssues } from './cuttingListQuotationConsumptionOps.js';

/** Drop duplicate refund data-quality rows (CL consumption is merged from two sources). */
export function dedupeRefundDataQualityIssues(issues) {
  const seen = new Set();
  return (issues || []).filter((iss) => {
    const code = String(iss?.code || '').trim();
    const message = String(iss?.message || '').trim();
    const key = code ? `${code}|${message}` : message;
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Quoted roofing gauge vs **allocated coil gauge** — workbook floor (material sheet) or list ₦/m must resolve when they differ.
 * @returns {{ code: string; message: string; jobId?: string; productId?: string }[]}
 */
export function refundSubstitutionDataQualityIssues(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return [];
  let quote;
  try {
    quote = db.prepare(`SELECT lines_json, branch_id, date_iso FROM quotations WHERE id = ?`).get(ref);
  } catch {
    return [];
  }
  if (!quote) return [];
  let productionJobs = [];
  try {
    productionJobs = db
      .prepare(
        `SELECT job_id, product_id, product_name, actual_meters, status FROM production_jobs
         WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')`
      )
      .all(ref);
  } catch {
    return [];
  }
  if (!productionJobs.length) return [];

  let linesPayloadForStone = parseJsonValue(quote?.lines_json);
  if (typeof linesPayloadForStone !== 'object' || !linesPayloadForStone) linesPayloadForStone = {};
  const stoneMeterQuote = isStoneMeterQuotationLinesJson(db, linesPayloadForStone);

  const quotedGaugeRaw = quotedGaugeLabelForSubstitutionComparison(quote?.lines_json ?? '');
  const quotedGdIssue = firstQuotedProductGaugeDesign(quote?.lines_json ?? '');
  const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
  const pricingAsAtIso = quotationPricingAsAtIso(quote);
  const issues = [];

  const hasPositiveMetres = productionJobs.some((j) => (Number(j.actual_meters) || 0) > 0);
  if (hasPositiveMetres && !quotedGaugeRaw) {
    issues.push({
      code: 'quoted_gauge_missing',
      message:
        'Substitution (gauge vs coil): quotation has no gauge on header or product lines — add gauge to compute automatic credit vs allocated coils.',
    });
  }

  if (quotedGaugeRaw) {
    for (const j of productionJobs) {
      const jobId = String(j.job_id ?? '').trim();
      const actualM = Number(j.actual_meters) || 0;
      const gaugeGroups = coilGaugeMeterGroupsFromJob(db, jobId).filter((g) => (Number(g.meters) || 0) > 0.001);
      const slices =
        gaugeGroups.length > 0
          ? gaugeGroups
          : actualM > 0
            ? [{ gaugeLabel: producedGaugeLabelFromJobCoils(db, jobId), meters: actualM }]
            : [];
      if (slices.length === 0) continue;

      for (const slice of slices) {
        const m = Number(slice.meters) || 0;
        if (m <= 0) continue;
        const coilGauge = String(slice.gaugeLabel || '').trim();
        if (!coilGauge) {
          if (!stoneMeterQuote) {
            issues.push({
              code: 'substitution_coil_gauge_missing',
              jobId: jobId || undefined,
              productId: String(j.product_id ?? '').trim() || undefined,
              message: `Job “${String(j.product_name || j.job_id).trim()}” has metres but no coil gauge on allocations — link coils so gauge vs quotation can be compared.`,
            });
          }
          continue;
        }
        if (!gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGauge)) continue;
        const lookup = listWorkbookPpmForJobAllocatedCoil(
          db,
          j,
          branchId,
          quotedGdIssue,
          null,
          quote?.lines_json ?? '',
          pricingAsAtIso,
          coilGauge
        );
        const ppm = ppmValueFromWorkbookLookup(lookup);
        if (ppm == null || ppm <= 0) {
          const pid = String(j.product_id ?? '').trim();
          issues.push({
            code: 'substitution_list_price',
            jobId: jobId || undefined,
            productId: pid || undefined,
            message: `Quoted gauge (${quotedGaugeRaw}) vs allocated coil (${coilGauge}) on job “${String(j.product_name || j.job_id).trim()}” (${m.toFixed(2)} m). No workbook price matched: the system prefers material_pricing_sheet_rows.minimum_price_per_m_ngn (coil gauge + design), then price_list_items. Add material pricing rows for the branch, or price_list_items with gauge_key ≈ coil gauge, or set substitutePricePerMeterNgn / workbook override in preview.`,
          });
        }
      }
    }
  }

  const ppmQuote = quotedAmountPerMeter(quote?.lines_json);
  if ((!ppmQuote || ppmQuote <= 0) && productionJobs.some((j) => (Number(j.actual_meters) || 0) > 0)) {
    issues.push({
      code: 'quoted_blend_rate',
      message:
        'Quotation has no product lines with qty × unit price, so blended ₦/m for substitution/unproduced hints may be missing. Add product lines or rely on manual amounts.',
    });
  }
  return issues;
}

function matchesTransportService(nameLower) {
  if (!nameLower) return false;
  return (
    nameLower.includes('transport') ||
    nameLower.includes('haulage') ||
    nameLower.includes('hauling') ||
    nameLower.includes('delivery') ||
    nameLower.includes('logistic') ||
    nameLower.includes('dispatch') ||
    nameLower.includes('freight') ||
    nameLower.includes('waybill')
  );
}

function matchesInstallationService(nameLower) {
  if (!nameLower) return false;
  return (
    nameLower.includes('install') ||
    nameLower.includes('fitting') ||
    nameLower.includes('erection') ||
    nameLower.includes('mounting')
  );
}

/** Only service exclusion from refund preview: corrugation is never suggested or counted as a refundable service line. */
function matchesCorrugationService(nameLower) {
  if (!nameLower) return false;
  const n = String(nameLower).replace(/\s+/g, ' ').trim();
  return n.includes('corrugation') || n.includes('currugation');
}

export function periodKeyFromDate(dateISO) {
  const raw = String(dateISO || '').trim();
  const base = raw || nowIso().slice(0, 10);
  const [year, month] = base.split('-');
  return `${year}-${month || '01'}`;
}

/**
 * Annex D: tamper-evident audit log (hash chain).
 * Each row stores `prev_hash` (the previous row's `row_hash`) and its own
 * `row_hash` = sha256 over the row's audit fields + prev_hash. Editing or
 * deleting any historic row breaks recomputation in `verifyAuditLogChain`.
 * All chain logic is best-effort: a hashing problem must never block the
 * underlying business write, so failures degrade to an unhashed row.
 */
const AUDIT_HASH_READY = new WeakSet();

function ensureAuditHashColumns(db) {
  if (AUDIT_HASH_READY.has(db)) return true;
  try {
    const cols = db.prepare(`PRAGMA table_info(audit_log)`).all().map((c) => c.name);
    if (!cols.includes('prev_hash')) db.exec(`ALTER TABLE audit_log ADD COLUMN prev_hash TEXT`);
    if (!cols.includes('row_hash')) db.exec(`ALTER TABLE audit_log ADD COLUMN row_hash TEXT`);
    AUDIT_HASH_READY.add(db);
    return true;
  } catch {
    return false;
  }
}

function computeAuditRowHash(fields, prevHash) {
  return createHash('sha256')
    .update(JSON.stringify([...fields, prevHash ?? null]))
    .digest('hex');
}

export function appendAuditLog(db, payload) {
  const id = nextAuditLogHumanId(db);
  const occurredAtISO = payload.occurredAtISO || nowIso();
  const fields = [
    id,
    occurredAtISO,
    actorId(payload.actor),
    actorName(payload.actor),
    payload.action,
    payload.entityKind ?? null,
    payload.entityId ?? null,
    payload.status ?? 'success',
    payload.note ?? '',
    payload.details ? JSON.stringify(payload.details) : null,
  ];
  if (ensureAuditHashColumns(db)) {
    try {
      const prev = db.prepare(`SELECT row_hash FROM audit_log ORDER BY occurred_at_iso DESC, id DESC LIMIT 1`).get();
      const prevHash = prev?.row_hash ?? null;
      const rowHash = computeAuditRowHash(fields, prevHash);
      db.prepare(
        `INSERT INTO audit_log (
          id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json, prev_hash, row_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(...fields, prevHash, rowHash);
      return id;
    } catch {
      // fall through to unhashed insert below
    }
  }
  db.prepare(
    `INSERT INTO audit_log (
      id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(...fields);
  return id;
}

/**
 * Recompute the audit hash chain. Rows written before the feature (row_hash NULL)
 * are counted as `unhashed` and skipped; the chain is verified from the first
 * hashed row onward.
 * @returns {{ chainOk: boolean, checked: number, unhashed: number, brokenAtId: string|null }}
 */
export function verifyAuditLogChain(db) {
  if (!ensureAuditHashColumns(db)) {
    return { chainOk: false, checked: 0, unhashed: 0, brokenAtId: null, error: 'Hash columns unavailable' };
  }
  const rows = db
    .prepare(
      `SELECT id, occurred_at_iso, actor_user_id, actor_name, action, entity_kind, entity_id, status, note, details_json, prev_hash, row_hash
       FROM audit_log ORDER BY occurred_at_iso ASC, id ASC`
    )
    .all();
  let checked = 0;
  let unhashed = 0;
  let lastHash = null;
  for (const r of rows) {
    if (r.row_hash == null) {
      unhashed += 1;
      continue;
    }
    const fields = [
      r.id,
      r.occurred_at_iso,
      r.actor_user_id,
      r.actor_name,
      r.action,
      r.entity_kind,
      r.entity_id,
      r.status,
      r.note,
      r.details_json,
    ];
    const linkOk = checked === 0 ? true : (r.prev_hash ?? null) === lastHash;
    const recomputed = computeAuditRowHash(fields, r.prev_hash ?? null);
    if (!linkOk || recomputed !== r.row_hash) {
      return { chainOk: false, checked, unhashed, brokenAtId: r.id };
    }
    lastHash = r.row_hash;
    checked += 1;
  }
  return { chainOk: true, checked, unhashed, brokenAtId: null };
}

export function recordApprovalAction(db, payload) {
  const id = nextApprovalActionHumanId(db);
  const actedAtISO = payload.actedAtISO || nowIso();
  db.prepare(
    `INSERT INTO approval_actions (
      id, entity_kind, entity_id, action, status, note, acted_at_iso, acted_by_user_id, acted_by_name
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    payload.entityKind,
    payload.entityId,
    payload.action,
    payload.status,
    payload.note ?? '',
    actedAtISO,
    actorId(payload.actor),
    actorName(payload.actor)
  );
  return id;
}

export function assertPeriodOpen(db, dateISO, contextLabel = 'Posting date') {
  const periodKey = periodKeyFromDate(dateISO);
  const row = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (row) {
    const note = row.reason ? ` Reason: ${row.reason}` : '';
    throw new Error(`${contextLabel} falls in locked period ${periodKey}.${note}`);
  }
  return periodKey;
}

export function lockAccountingPeriod(db, payload, actor) {
  const periodKey = periodKeyFromDate(payload.periodKey || payload.dateISO);
  const existing = db.prepare(`SELECT period_key FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (existing) return { ok: false, error: `Period ${periodKey} is already locked.` };
  const lockedAtISO = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO accounting_period_locks (
        period_key, locked_from_iso, locked_at_iso, locked_by_user_id, locked_by_name, reason
      ) VALUES (?,?,?,?,?,?)`
    ).run(
      periodKey,
      `${periodKey}-01`,
      lockedAtISO,
      actorId(actor),
      actorName(actor),
      String(payload.reason ?? '').trim()
    );
    appendAuditLog(db, {
      actor,
      action: 'period.lock',
      entityKind: 'accounting_period',
      entityId: periodKey,
      note: String(payload.reason ?? '').trim() || 'Accounting period locked',
      details: { periodKey },
    });
  })();
  return { ok: true, periodKey };
}

export function unlockAccountingPeriod(db, periodKey, actor, reason = '') {
  const row = db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(periodKey);
  if (!row) return { ok: false, error: 'Period lock not found.' };
  db.transaction(() => {
    db.prepare(`DELETE FROM accounting_period_locks WHERE period_key = ?`).run(periodKey);
    appendAuditLog(db, {
      actor,
      action: 'period.unlock',
      entityKind: 'accounting_period',
      entityId: periodKey,
      note: String(reason || '').trim() || 'Accounting period unlocked',
      details: { previousReason: row.reason ?? '' },
    });
  })();
  return { ok: true };
}


const MAX_PAYREQ_ATTACHMENT_B64_LEN = 4_500_000;

function normalizePaymentRequestLineItems(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) arr = raw.items;
  return arr
    .map((row) => {
      const item = String(row?.item ?? row?.description ?? '').trim();
      const unit = Number.parseFloat(String(row?.unit ?? row?.qty ?? '').replace(/,/g, ''));
      const unitPriceNgn = roundMoney(row?.unitPriceNgn ?? row?.unit_price_ngn ?? 0);
      let lineTotalNgn = roundMoney(row?.lineTotalNgn ?? row?.line_total_ngn ?? 0);
      const u = Number.isFinite(unit) ? unit : 0;
      if (!lineTotalNgn && u > 0 && unitPriceNgn >= 0) {
        lineTotalNgn = roundMoney(u * unitPriceNgn);
      }
      return { item, unit: u, unitPriceNgn, lineTotalNgn };
    })
    .filter((r) => r.item && r.unit > 0 && r.lineTotalNgn > 0);
}

function parsePaymentRequestAttachment(payload) {
  const att = payload?.attachment;
  if (!att || typeof att !== 'object') {
    return { name: '', mime: '', b64: '' };
  }
  const name = String(att.name ?? '').trim().slice(0, 240);
  const mime = String(att.mime ?? att.mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const b64 = String(att.dataBase64 ?? '').replace(/\s/g, '');
  return { name, mime, b64 };
}

function validatePaymentRequestExpenseCategory(db, actor, payload, expenseCategory, amountRequestedNgn, hasAttachment) {
  const policyLimits = resolveExpenseCategoryPolicyLimits(getOrgGovernanceLimits(db));
  return validateExpenseCategorySelection({
    actor,
    category: expenseCategory,
    amountNgn: amountRequestedNgn,
    description: payload.description,
    categoryJustification: payload.categoryJustification,
    hasAttachment,
    hasPermission: (p) => userHasPermission(actor, p),
    policyLimits,
  });
}

function expenseInsertColumns(db) {
  const base =
    'expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id';
  const hasLane = hasColumn(db, 'expenses', 'category_lane');
  return hasLane ? `${base}, category_lane` : base;
}

function expenseInsertPlaceholders(db) {
  const hasLane = hasColumn(db, 'expenses', 'category_lane');
  return hasLane ? '?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?';
}


export function insertPaymentRequest(db, payload, actor) {
  const providedRequestId = String(payload.requestID ?? '').trim();
  const requestDate = String(payload.requestDate ?? '').trim() || nowIso().slice(0, 10);
  const description = String(payload.description ?? '').trim() || '—';
  const requestReference = String(payload.requestReference ?? payload.reference ?? '').trim();
  const branchId = String(payload.workspaceBranchId ?? '').trim() || DEFAULT_BRANCH_ID;

  const lineItems = normalizePaymentRequestLineItems(payload.lineItems ?? payload.items);
  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const categoryJustification = String(payload.categoryJustification ?? '').trim();
  const payeeName = String(payload.payeeName ?? payload.payee_name ?? '').trim();
  const payeeAccountNo = String(payload.payeeAccountNo ?? payload.payee_account_no ?? '').trim();
  const payeeBankName = String(payload.payeeBankName ?? payload.payee_bank_name ?? '').trim();
  const { name: attName, mime: attMime, b64: attB64Raw } = parsePaymentRequestAttachment(payload);
  let attB64 = attB64Raw;
  if (attB64) {
    const allowed = attMime.startsWith('image/') || attMime === 'application/pdf';
    if (!allowed) {
      return { ok: false, error: 'Attachment must be a PDF or image file.' };
    }
    if (attB64.length > MAX_PAYREQ_ATTACHMENT_B64_LEN) {
      return { ok: false, error: 'Attachment is too large (max about 2.5 MB).' };
    }
  } else {
    attB64 = '';
  }

  const lineItemsJson = lineItems.length ? JSON.stringify(lineItems) : '';

  let legacyExpenseID = String(payload.expenseID ?? '').trim();
  let amountRequestedNgn = roundMoney(payload.amountRequestedNgn);

  if (lineItems.length > 0) {
    amountRequestedNgn = lineItems.reduce((s, x) => s + x.lineTotalNgn, 0);
    if (amountRequestedNgn <= 0) {
      return { ok: false, error: 'Line items must total a positive amount.' };
    }
    const catCheck = validatePaymentRequestExpenseCategory(
      db,
      actor,
      payload,
      expenseCategory,
      amountRequestedNgn,
      Boolean(attB64)
    );
    if (!catCheck.ok) return catCheck;
  } else {
    if (!legacyExpenseID) {
      return {
        ok: false,
        error:
          'Add at least one line with description, quantity, and unit price (or link an existing posted expense and amount).',
      };
    }
    if (amountRequestedNgn <= 0) {
      return { ok: false, error: 'Amount requested must be positive.' };
    }
    const expense = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(legacyExpenseID);
    if (!expense) return { ok: false, error: 'Linked expense was not found.' };
  }

  const maxAttempts = providedRequestId ? 1 : 3;
  let lastErr = null;
  const categoryLane = getExpenseCategoryLane(expenseCategory);
  for (let i = 0; i < maxAttempts; i += 1) {
    const requestID =
      providedRequestId ||
      (i === 0
        ? nextPaymentRequestHumanId(db, branchId)
        : `${nextPaymentRequestHumanId(db, branchId)}-${Math.random().toString(36).slice(2, 7)}`);
    try {
      assertPeriodOpen(db, requestDate, 'Payment request date');
      db.transaction(() => {
        let expenseIdForRow = legacyExpenseID;
        if (lineItems.length > 0) {
          let newExpId = nextExpenseHumanId(db, branchId);
          for (let k = 0; k < 8 && db.prepare(`SELECT 1 FROM expenses WHERE expense_id = ?`).get(newExpId); k += 1) {
            newExpId = nextExpenseHumanId(db, branchId);
          }
          db.prepare(
            `INSERT INTO expenses (${expenseInsertColumns(db)})
             VALUES (${expenseInsertPlaceholders(db)})`
          ).run(
            ...(hasColumn(db, 'expenses', 'category_lane')
              ? [
                  newExpId,
                  'Payment request (pending payout)',
                  amountRequestedNgn,
                  requestDate,
                  expenseCategory,
                  'Pending',
                  requestReference || requestID,
                  branchId,
                  categoryLane,
                ]
              : [
                  newExpId,
                  'Payment request (pending payout)',
                  amountRequestedNgn,
                  requestDate,
                  expenseCategory,
                  'Pending',
                  requestReference || requestID,
                  branchId,
                ])
          );
          expenseIdForRow = newExpId;
        }
        const prHasJustification = hasColumn(db, 'payment_requests', 'category_justification');
        const prHasPayee = hasColumn(db, 'payment_requests', 'payee_account_no');
        if (prHasJustification) {
          db.prepare(
            `INSERT INTO payment_requests (
              request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
              approved_by, approved_at_iso, approval_note,
              request_reference, line_items_json, attachment_name, attachment_mime, attachment_data_b64,
              category_justification
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            requestID,
            expenseIdForRow,
            amountRequestedNgn,
            requestDate,
            'Pending',
            description,
            '',
            '',
            '',
            requestReference || '',
            lineItemsJson || null,
            attName || '',
            attMime || '',
            attB64 || '',
            categoryJustification || null
          );
        } else {
          db.prepare(
            `INSERT INTO payment_requests (
              request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
              approved_by, approved_at_iso, approval_note,
              request_reference, line_items_json, attachment_name, attachment_mime, attachment_data_b64
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            requestID,
            expenseIdForRow,
            amountRequestedNgn,
            requestDate,
            'Pending',
            description,
            '',
            '',
            '',
            requestReference || '',
            lineItemsJson || null,
            attName || '',
            attMime || '',
            attB64 || ''
          );
        }
        if (prHasPayee) {
          db.prepare(
            `UPDATE payment_requests
             SET payee_name = ?, payee_account_no = ?, payee_bank_name = ?
             WHERE request_id = ?`
          ).run(payeeName || '', payeeAccountNo || '', payeeBankName || '', requestID);
        }
        appendAuditLog(db, {
          actor,
          action: 'payment_request.create',
          entityKind: 'payment_request',
          entityId: requestID,
          note: `Payment request ${requestID} submitted`,
          details: {
            expenseID: expenseIdForRow,
            amountRequestedNgn,
            lineItemCount: lineItems.length,
            hasAttachment: Boolean(attB64),
            hasPayeeAccount: Boolean(payeeAccountNo),
          },
        });
      })();
      return { ok: true, requestID };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (providedRequestId || !msg.includes('UNIQUE constraint failed: payment_requests.request_id')) {
        return { ok: false, error: msg };
      }
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr || 'Could not create payment request.') };
}

export function updatePaymentRequest(db, requestID, payload, actor) {
  const rid = String(requestID || '').trim();
  if (!rid) return { ok: false, error: 'Payment request ID is required.' };
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  const approvalStatus = String(row.approval_status || 'Pending').trim();
  if (!['Pending', 'Submitted', 'Awaiting approval', '', 'Rejected'].includes(approvalStatus)) {
    return { ok: false, error: 'Only pending or rejected requests can be edited.' };
  }

  const requestDate = String(payload.requestDate ?? row.request_date ?? '').trim() || nowIso().slice(0, 10);
  const description = String(payload.description ?? row.description ?? '').trim() || '—';
  const requestReference = String(payload.requestReference ?? payload.reference ?? row.request_reference ?? '').trim();
  const lineItems = normalizePaymentRequestLineItems(payload.lineItems ?? payload.items);
  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const categoryJustification = String(payload.categoryJustification ?? row.category_justification ?? '').trim();
  const payeeName = String(
    payload.payeeName ?? payload.payee_name ?? row.payee_name ?? ''
  ).trim();
  const payeeAccountNo = String(
    payload.payeeAccountNo ?? payload.payee_account_no ?? row.payee_account_no ?? ''
  ).trim();
  const payeeBankName = String(
    payload.payeeBankName ?? payload.payee_bank_name ?? row.payee_bank_name ?? ''
  ).trim();
  const { name: attName, mime: attMime, b64: attB64Raw } = parsePaymentRequestAttachment(payload);
  let attB64 = attB64Raw;
  if (attB64) {
    const allowed = attMime.startsWith('image/') || attMime === 'application/pdf';
    if (!allowed) {
      return { ok: false, error: 'Attachment must be a PDF or image file.' };
    }
    if (attB64.length > MAX_PAYREQ_ATTACHMENT_B64_LEN) {
      return { ok: false, error: 'Attachment is too large (max about 2.5 MB).' };
    }
  }

  if (!lineItems.length) {
    return { ok: false, error: 'Add at least one line with description, quantity, and unit price.' };
  }
  const amountRequestedNgn = lineItems.reduce((s, x) => s + x.lineTotalNgn, 0);
  if (amountRequestedNgn <= 0) {
    return { ok: false, error: 'Line items must total a positive amount.' };
  }
  const hasAttachment =
    Boolean(attB64) || Boolean(String(row.attachment_data_b64 || '').trim());
  const catCheck = validatePaymentRequestExpenseCategory(
    db,
    actor,
    payload,
    expenseCategory,
    amountRequestedNgn,
    hasAttachment
  );
  if (!catCheck.ok) return catCheck;
  const categoryLane = getExpenseCategoryLane(expenseCategory);
  const lineItemsJson = JSON.stringify(lineItems);
  const prHasJustification = hasColumn(db, 'payment_requests', 'category_justification');
  const prHasPayee = hasColumn(db, 'payment_requests', 'payee_account_no');
  const expHasLane = hasColumn(db, 'expenses', 'category_lane');

  try {
    assertPeriodOpen(db, requestDate, 'Payment request date');
    db.transaction(() => {
      if (prHasJustification) {
        db.prepare(
          `UPDATE payment_requests
           SET amount_requested_ngn = ?,
               request_date = ?,
               approval_status = 'Pending',
               description = ?,
               approved_by = '',
               approved_at_iso = '',
               approval_note = '',
               request_reference = ?,
               line_items_json = ?,
               attachment_name = ?,
               attachment_mime = ?,
               attachment_data_b64 = ?,
               category_justification = ?
           WHERE request_id = ?`
        ).run(
          amountRequestedNgn,
          requestDate,
          description,
          requestReference || '',
          lineItemsJson,
          attB64 ? attName : String(row.attachment_name || ''),
          attB64 ? attMime : String(row.attachment_mime || ''),
          attB64 ? attB64 : String(row.attachment_data_b64 || ''),
          categoryJustification || null,
          rid
        );
      } else {
        db.prepare(
          `UPDATE payment_requests
           SET amount_requested_ngn = ?,
               request_date = ?,
               approval_status = 'Pending',
               description = ?,
               approved_by = '',
               approved_at_iso = '',
               approval_note = '',
               request_reference = ?,
               line_items_json = ?,
               attachment_name = ?,
               attachment_mime = ?,
               attachment_data_b64 = ?
           WHERE request_id = ?`
        ).run(
          amountRequestedNgn,
          requestDate,
          description,
          requestReference || '',
          lineItemsJson,
          attB64 ? attName : String(row.attachment_name || ''),
          attB64 ? attMime : String(row.attachment_mime || ''),
          attB64 ? attB64 : String(row.attachment_data_b64 || ''),
          rid
        );
      }
      if (prHasPayee) {
        db.prepare(
          `UPDATE payment_requests
           SET payee_name = ?, payee_account_no = ?, payee_bank_name = ?
           WHERE request_id = ?`
        ).run(payeeName || '', payeeAccountNo || '', payeeBankName || '', rid);
      }

      const expenseId = String(row.expense_id || '').trim();
      if (expenseId) {
        if (expHasLane) {
          db.prepare(
            `UPDATE expenses
             SET amount_ngn = ?, date = ?, category = ?, category_lane = ?, reference = ?
             WHERE expense_id = ?`
          ).run(amountRequestedNgn, requestDate, expenseCategory, categoryLane, requestReference || rid, expenseId);
        } else {
          db.prepare(
            `UPDATE expenses
             SET amount_ngn = ?, date = ?, category = ?, reference = ?
             WHERE expense_id = ?`
          ).run(amountRequestedNgn, requestDate, expenseCategory, requestReference || rid, expenseId);
        }
      }

      appendAuditLog(db, {
        actor,
        action: 'payment_request.update',
        entityKind: 'payment_request',
        entityId: rid,
        note: `Payment request ${rid} edited`,
        details: {
          amountRequestedNgn,
          expenseCategory,
          lineItemCount: lineItems.length,
          approvalStatusBefore: approvalStatus || 'Pending',
        },
      });
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function decidePaymentRequest(db, requestID, payload, actor) {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(requestID);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  if (!['Pending', 'Submitted', 'Awaiting approval', ''].includes(String(row.approval_status || 'Pending'))) {
    return { ok: false, error: 'Only pending requests can be reviewed.' };
  }
  const status = String(payload.status ?? '').trim();
  if (!['Approved', 'Rejected'].includes(status)) {
    return { ok: false, error: 'Decision status must be Approved or Rejected.' };
  }
  const expenseRow = row.expense_id
    ? db.prepare(`SELECT category FROM expenses WHERE expense_id = ?`).get(row.expense_id)
    : null;
  const expenseCategory = String(expenseRow?.category ?? '');
  const amountRequestedNgn = roundMoney(row.amount_requested_ngn ?? 0);
  const govLimits = getOrgGovernanceLimits(db);
  if (
    status === 'Approved' &&
    !actorMayApprovePaymentRequestCategory(actor, expenseCategory, (p) => userHasPermission(actor, p))
  ) {
    return {
      ok: false,
      error: 'This expense category requires Finance or MD approval.',
    };
  }
  if (
    status === 'Approved' &&
    !actorMayApprovePaymentRequestAmount(
      actor,
      (p) => userHasPermission(actor, p),
      amountRequestedNgn,
      expenseCategory,
      govLimits
    )
  ) {
    const hi = govLimits.expenseExecutiveThresholdNgn;
    return {
      ok: false,
      error: `Non-refund expenses above ₦${hi.toLocaleString('en-NG')} require managing director approval (branch manager may approve at or below this threshold).`,
    };
  }
  const note = String(payload.note ?? '').trim();
  const actedAtISO = String(payload.actedAtISO ?? '').trim() || nowIso().slice(0, 10);
  const warnings = [];
  const bd = backdateWarningForActedDate(actedAtISO, 'Approval date');
  if (bd) warnings.push(bd);
  try {
    assertPeriodOpen(db, actedAtISO, 'Approval date');
    db.transaction(() => {
      db.prepare(
        `UPDATE payment_requests
         SET approval_status = ?, approved_by = ?, approved_at_iso = ?, approval_note = ?
         WHERE request_id = ?`
      ).run(status, actorName(actor), actedAtISO, note, requestID);
      recordApprovalAction(db, {
        actor,
        entityKind: 'payment_request',
        entityId: requestID,
        action: 'review',
        status: status.toLowerCase(),
        note,
        actedAtISO,
      });
      appendAuditLog(db, {
        actor,
        action: 'payment_request.review',
        entityKind: 'payment_request',
        entityId: requestID,
        note: note || `Payment request ${status.toLowerCase()}`,
        details: { status },
      });
    })();
    const actorLabel = actorName(actor);
    const notePart = note ? ` Note: ${note}` : '';
    appendPaymentRequestTimelineToOfficeThreads(
      db,
      requestID,
      status === 'Approved'
        ? `Accounts: payment request ${requestID} was approved by ${actorLabel}.${notePart}`
        : `Accounts: payment request ${requestID} was rejected by ${actorLabel}.${notePart}`
    );
    return { ok: true, warnings };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** GL debit preview for an approved/unpaid payment request (Finance pay screen). */
function hasApprovedHrLoanLink(db, requestId) {
  const prId = String(requestId || '').trim();
  if (!prId) return false;
  const rows = db
    .prepare(`SELECT payload_json FROM hr_requests WHERE kind = 'loan' AND status = 'approved'`)
    .all();
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.payload_json || '{}'));
      if (String(p.financePaymentRequestId || '') === prId) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

function buildPaymentRequestPayoutGatePreview(db, row) {
  const requestId = String(row.request_id || '').trim();
  const category = mapLegacyExpenseCategoryToCanonical(row.expense_category || 'Others');
  const lane = getExpenseCategoryLane(category);
  const assetDescription = String(row.expense_reference || row.description || '').trim();
  const hasAttachment = Boolean(String(row.attachment_data_b64 || '').trim());
  const hasHrLoanLink = hasApprovedHrLoanLink(db, requestId);

  const checks = [];
  const glCheck = validateExpenseCategoryForTreasuryPayout(category);
  checks.push({
    key: 'treasury_gl',
    label: 'Treasury GL route',
    ok: glCheck.ok,
    detail: glCheck.ok ? `Dr ${glCheck.glAccountCode}` : glCheck.error,
  });

  if (lane === 'capex') {
    checks.push({
      key: 'capex_description',
      label: 'Asset description',
      ok: assetDescription.length >= CAPEX_MIN_ASSET_DESCRIPTION_LEN,
      detail:
        assetDescription.length >= CAPEX_MIN_ASSET_DESCRIPTION_LEN
          ? 'Present on request'
          : `Need at least ${CAPEX_MIN_ASSET_DESCRIPTION_LEN} characters in description or reference`,
    });
    checks.push({
      key: 'capex_attachment',
      label: 'Supporting document',
      ok: hasAttachment,
      detail: hasAttachment ? 'Attachment on file' : 'Upload invoice or procurement document before payout',
    });
  }

  if (category === 'Staff loan') {
    checks.push({
      key: 'hr_loan_link',
      label: 'HR loan approved & linked',
      ok: hasHrLoanLink,
      detail: hasHrLoanLink
        ? 'Linked to approved HR loan'
        : 'Disburse only from an approved HR staff loan request',
    });
  }

  const ok = checks.every((c) => c.ok);
  const firstFail = checks.find((c) => !c.ok);
  return {
    ok,
    error: ok ? null : firstFail?.detail || firstFail?.label || 'Payout blocked by category policy.',
    checks,
    category,
    categoryLane: lane,
  };
}

export function getPaymentRequestGlPreview(db, requestId) {
  const rid = String(requestId || '').trim();
  if (!rid) return { ok: false, error: 'Payment request ID is required.' };
  const row = db
    .prepare(
      `SELECT pr.request_id, pr.amount_requested_ngn, pr.paid_amount_ngn, pr.description,
              pr.attachment_data_b64, e.category AS expense_category, e.reference AS expense_reference
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE pr.request_id = ?`
    )
    .get(rid);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  const category = mapLegacyExpenseCategoryToCanonical(row.expense_category || 'Others');
  const requestedNgn = roundMoney(row.amount_requested_ngn);
  const paidNgn = roundMoney(row.paid_amount_ngn);
  const remainingNgn = Math.max(0, requestedNgn - paidNgn);
  const { accountCode, isEquity, isCapex } = glAccountForExpenseCategory(category, { capexAsAsset: true });
  const lane = getExpenseCategoryLane(category);
  const payoutGate = buildPaymentRequestPayoutGatePreview(db, row);
  return {
    ok: true,
    requestID: rid,
    expenseCategory: category,
    categoryLane: lane,
    amountRequestedNgn: requestedNgn,
    paidAmountNgn: paidNgn,
    remainingNgn,
    gl: {
      debitAccountCode: accountCode,
      creditSide: 'Treasury cash',
      isEquity,
      isCapex,
    },
    payoutGate,
  };
}

/**
 * Finance may reclassify category on approved, unpaid payment requests (before treasury payout).
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestID
 * @param {{ expenseCategory?: string; categoryJustification?: string }} payload
 * @param {object | null} actor
 */
export function reclassifyPaymentRequestCategory(db, requestID, payload, actor) {
  const rid = String(requestID || '').trim();
  if (!rid) return { ok: false, error: 'Payment request ID is required.' };
  if (!userHasPermission(actor, 'finance.approve') && !userHasPermission(actor, '*')) {
    return { ok: false, error: 'finance.approve is required to reclassify expense category.' };
  }

  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(rid);
  if (!row) return { ok: false, error: 'Payment request not found.' };

  const approvalStatus = String(row.approval_status || '').trim();
  if (approvalStatus !== 'Approved') {
    return { ok: false, error: 'Only approved requests awaiting payout can be reclassified.' };
  }
  const paidNgn = roundMoney(row.paid_amount_ngn);
  if (paidNgn > 0) {
    return { ok: false, error: 'Cannot reclassify after treasury payout — reverse payout first.' };
  }

  const expenseCategory = String(payload.expenseCategory ?? payload.category ?? '').trim();
  const categoryJustification = String(
    payload.categoryJustification ?? row.category_justification ?? ''
  ).trim();
  const amountRequestedNgn = roundMoney(row.amount_requested_ngn);
  const hasAttachment = Boolean(String(row.attachment_data_b64 || '').trim());

  const catCheck = validateExpenseCategorySelection({
    actor,
    category: expenseCategory,
    amountNgn: amountRequestedNgn,
    description: row.description,
    categoryJustification,
    hasAttachment,
    hasPermission: (p) => userHasPermission(actor, p),
    policyLimits: resolveExpenseCategoryPolicyLimits(getOrgGovernanceLimits(db)),
  });
  if (!catCheck.ok) return catCheck;

  const categoryLane = getExpenseCategoryLane(expenseCategory);
  const expenseId = String(row.expense_id || '').trim();
  const priorCategory = expenseId
    ? String(db.prepare(`SELECT category FROM expenses WHERE expense_id = ?`).get(expenseId)?.category || '')
    : '';

  try {
    db.transaction(() => {
      const prHasJustification = hasColumn(db, 'payment_requests', 'category_justification');
      if (prHasJustification) {
        db.prepare(`UPDATE payment_requests SET category_justification = ? WHERE request_id = ?`).run(
          categoryJustification || null,
          rid
        );
      }
      if (expenseId) {
        const expHasLane = hasColumn(db, 'expenses', 'category_lane');
        if (expHasLane) {
          db.prepare(
            `UPDATE expenses SET category = ?, category_lane = ? WHERE expense_id = ?`
          ).run(expenseCategory, categoryLane, expenseId);
        } else {
          db.prepare(`UPDATE expenses SET category = ? WHERE expense_id = ?`).run(expenseCategory, expenseId);
        }
      }
      appendAuditLog(db, {
        actor,
        action: 'payment_request.reclassify_category',
        entityKind: 'payment_request',
        entityId: rid,
        note: `Category ${priorCategory || '—'} → ${expenseCategory}`,
        details: {
          priorCategory,
          expenseCategory,
          categoryLane,
        },
      });
    })();
    return { ok: true, expenseCategory, categoryLane };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function cancelApprovedPaymentRequestBeforePay(db, requestID, payload, actor) {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE request_id = ?`).get(requestID);
  if (!row) return { ok: false, error: 'Payment request not found.' };
  if (String(row.approval_status || '').trim() !== 'Approved') {
    return { ok: false, error: 'Only approved requests can be cancelled from payout queue.' };
  }
  const paidAmountNgn = roundMoney(row.paid_amount_ngn);
  if (paidAmountNgn > 0) {
    return { ok: false, error: 'This request already has payout entries and cannot be cancelled.' };
  }
  const note = String(payload.note ?? '').trim();
  const actedAtISO = String(payload.actedAtISO ?? '').trim() || nowIso().slice(0, 10);
  try {
    assertPeriodOpen(db, actedAtISO, 'Payment request cancellation date');
    db.transaction(() => {
      db.prepare(
        `UPDATE payment_requests
         SET approval_status = 'Cancelled',
             approval_note = ?,
             paid_amount_ngn = 0,
             paid_at_iso = '',
             paid_by = ''
         WHERE request_id = ?`
      ).run(note, requestID);
      appendAuditLog(db, {
        actor,
        action: 'payment_request.cancel_before_pay',
        entityKind: 'payment_request',
        entityId: requestID,
        note: note || `Payment request ${requestID} cancelled before payout`,
        details: { previousStatus: 'Approved', paidAmountNgn },
      });
    })();
    const actorLabel = actorName(actor);
    const notePart = note ? ` Note: ${note}` : '';
    appendPaymentRequestTimelineToOfficeThreads(
      db,
      requestID,
      `Accounts: payment request ${requestID} was cancelled before payout by ${actorLabel}.${notePart}`
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function quotationHasUnclearedReceipts(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sales_receipts
       WHERE quotation_ref = ?
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed', 'cleared', 'confirmed'))
         AND (finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '')`
    )
    .get(qid);
  return Number(row?.c) > 0;
}

function normalizeRefundSplitRows(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map((r) => {
      const kindRaw = String(r?.recipientKind ?? r?.recipient_kind ?? '').trim().toLowerCase();
      const staffId = String(
        r?.recipientAssociatedStaffID ?? r?.recipient_associated_staff_id ?? ''
      ).trim();
      const customerId = String(
        r?.recipientCustomerID ?? r?.recipient_customer_id ?? r?.recipientId ?? ''
      ).trim();
      const amountNgn = roundMoney(r?.amountNgn ?? r?.amount_ngn);
      const note = String(r?.note ?? '').trim();
      const companyCutWaived = Boolean(
        r?.companyCutWaived === true || r?.company_cut_waived === true || r?.waiveCompanyCut === true
      );
      const companyCutWaiverNote = String(
        r?.companyCutWaiverNote ?? r?.company_cut_waiver_note ?? ''
      ).trim();
      const asStaff =
        kindRaw === 'associated_staff' ||
        kindRaw === 'staff' ||
        (Boolean(staffId) && !customerId);
      if (asStaff) {
        const id = staffId || customerId;
        return {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: id,
          recipientCustomerID: '',
          amountNgn,
          note,
          companyCutWaived,
          companyCutWaiverNote,
        };
      }
      return {
        recipientKind: 'customer',
        recipientCustomerID: customerId,
        recipientAssociatedStaffID: '',
        amountNgn,
        note,
        companyCutWaived,
        companyCutWaiverNote,
      };
    })
    .filter(
      (r) =>
        r.amountNgn > 0 &&
        ((r.recipientKind === 'associated_staff' && r.recipientAssociatedStaffID) ||
          (r.recipientKind === 'customer' && r.recipientCustomerID))
    );
}

function savedAssociatedStaffPayoutAccount(db, staffId) {
  const id = String(staffId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, name, staff_type, status, bank_account_name, bank_name, bank_account_no
       FROM associated_staff WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  if (String(row.status || 'Active').trim().toLowerCase() !== 'active') return null;
  const bankAccountNo = String(row.bank_account_no || '').trim();
  const bankName = String(row.bank_name || '').trim();
  const bankAccountName = String(row.bank_account_name || '').trim();
  if (!bankAccountNo || !bankName) return null;
  return {
    partyKind: 'associated_staff',
    partyId: id,
    partyName: String(row.name || '').trim(),
    payeeName: bankAccountName || String(row.name || '').trim(),
    payeeAccountNo: bankAccountNo,
    payeeBankName: bankName,
    staffType: String(row.staff_type || '').trim(),
  };
}

function resolveRefundSplitPayoutAccount(db, split) {
  if (String(split?.recipientKind || '').trim() === 'associated_staff') {
    return savedAssociatedStaffPayoutAccount(db, split.recipientAssociatedStaffID);
  }
  return savedCustomerPayoutAccount(db, split.recipientCustomerID);
}

export function insertRefundRequest(db, payload, actor, branchId = DEFAULT_BRANCH_ID) {
  const customerID = String(payload.customerID ?? '').trim();
  const amountNgn = roundMoney(payload.amountNgn);
  if (!customerID) return { ok: false, error: 'Customer is required.' };
  if (amountNgn <= 0) return { ok: false, error: 'Refund amount must be positive.' };
  const refundID = nextRefundHumanId(db, String(branchId || DEFAULT_BRANCH_ID).trim());
  const requestedAtISO = String(payload.requestedAtISO ?? '').trim() || nowIso();
  let submitAlignmentResult = null;
  let economicFloorOverrideAtCreate = null;
  try {
    assertPeriodOpen(db, requestedAtISO, 'Refund request date');
    const quotationRef = String(payload.quotationRef ?? '').trim();
    const product = String(payload.product ?? '').trim() || '—';
    const requestedCats = normalizeRefundReasonCategoriesForApi(payload.reasonCategory);
    if (requestedCats.length === 0) {
      return { ok: false, error: 'Select at least one refund reason category.' };
    }

    const requestedSplits = normalizeRefundSplitRows(payload.refundSplits ?? payload.splitDistributions);
    const splitTotalNgn = requestedSplits.reduce((s, r) => s + roundMoney(r.amountNgn), 0);
    if (requestedSplits.length > 0 && Math.abs(splitTotalNgn - amountNgn) > REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
      return {
        ok: false,
        error: `Split total (₦${splitTotalNgn.toLocaleString('en-NG')}) must equal refund amount (₦${amountNgn.toLocaleString('en-NG')}).`,
      };
    }
    const associatedStaffPolicyEnabled = /^(1|true|yes|on)$/i.test(
      String(process.env.ZAREWA_ASSOCIATED_STAFF_POLICY_V1 || '0')
    );
    const providedPayeeName = String(payload.payeeName ?? payload.payee_name ?? '').trim();
    const providedPayeeAccountNo = String(payload.payeeAccountNo ?? payload.payee_account_no ?? '').trim();
    const providedPayeeBankName = String(payload.payeeBankName ?? payload.payee_bank_name ?? '').trim();
    const customerSavedPayee = savedCustomerPayoutAccount(db, customerID);

    const resolvedSplits = [];
    for (const split of requestedSplits) {
      const acct = resolveRefundSplitPayoutAccount(db, split);
      if (!acct) {
        const who =
          split.recipientKind === 'associated_staff'
            ? `Associated staff ${split.recipientAssociatedStaffID || ''}`
            : `Customer ${split.recipientCustomerID || ''}`;
        return {
          ok: false,
          error: `${who.trim()} has no saved bank details. Update that profile before allocating payout.`,
        };
      }
      resolvedSplits.push({ ...split, payoutAccount: acct });
    }

    const mayWaiveStaffCut = actorMayBypassIncompleteRefundFloor(actor);
    const splitsWithWaiverAuth = resolvedSplits.map((s) => {
      if (!s.companyCutWaived) return { ...s, companyCutWaived: false, companyCutWaiverNote: '' };
      if (!mayWaiveStaffCut) {
        return { ...s, companyCutWaived: false, companyCutWaiverNote: '' };
      }
      const note = String(s.companyCutWaiverNote || '').trim();
      if (note.length < 8) {
        return {
          __waiverError: true,
          error:
            'Admin/MD company-cut waiver requires a short reason (at least 8 characters) on each waived staff/transporter/installer line.',
        };
      }
      return { ...s, companyCutWaived: true, companyCutWaiverNote: note };
    });
    const waiverErr = splitsWithWaiverAuth.find((s) => s?.__waiverError);
    if (waiverErr) return { ok: false, error: waiverErr.error };

    const splitsForStore = applyRefundStaffAllocationDeductions(splitsWithWaiverAuth, customerID, {
      deductionRate: getRefundStaffAllocationDeductionRate(db),
      unclearedByCustomerId: unclearedTotalsMap(
        unclearedReceiptFloatBySalesCustomerIds(
          db,
          splitsWithWaiverAuth.map((s) => s.recipientCustomerID).filter(Boolean)
        )
      ),
      honorCompanyCutWaiver: true,
    });

    // No customer bank: full amount must be allocated to transport/install staff and/or claiming staff.
    if (!customerSavedPayee) {
      if (splitsForStore.length === 0) {
        return {
          ok: false,
          error:
            'Customer has no bank on file. Allocate transport/installation to associated staff and any remainder to claiming staff (profiles with bank details).',
        };
      }
      if (Math.abs(splitTotalNgn - amountNgn) > REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
        return {
          ok: false,
          error: `When the customer has no bank, payout allocation (₦${splitTotalNgn.toLocaleString('en-NG')}) must equal the refund amount (₦${amountNgn.toLocaleString('en-NG')}).`,
        };
      }
    } else if (
      associatedStaffPolicyEnabled &&
      splitsForStore.length > 0 &&
      Math.abs(splitTotalNgn - amountNgn) > REFUND_AMOUNT_LINE_TOLERANCE_NGN
    ) {
      return {
        ok: false,
        error: `Split total (₦${splitTotalNgn.toLocaleString('en-NG')}) must equal refund amount (₦${amountNgn.toLocaleString('en-NG')}).`,
      };
    }

    const primaryPayee =
      splitsForStore.length > 0 ? splitsForStore[0].payoutAccount : customerSavedPayee;
    let payeeName = String(primaryPayee?.payeeName || '').trim();
    let payeeAccountNo = String(primaryPayee?.payeeAccountNo || '').trim();
    let payeeBankName = String(primaryPayee?.payeeBankName || '').trim();
    if (!resolvedSplits.length && !customerSavedPayee) {
      payeeName = providedPayeeName;
      payeeAccountNo = providedPayeeAccountNo;
      payeeBankName = providedPayeeBankName;
    }
    if (!payeeName || !payeeAccountNo || !payeeBankName) {
      return {
        ok: false,
        error:
          'Pay to: beneficiary bank details required — save them on the customer profile, or allocate to staff with bank details.',
      };
    }
    if (
      customerSavedPayee &&
      !resolvedSplits.length &&
      (providedPayeeName || providedPayeeAccountNo || providedPayeeBankName) &&
      (providedPayeeName !== customerSavedPayee.payeeName ||
        providedPayeeAccountNo !== customerSavedPayee.payeeAccountNo ||
        providedPayeeBankName !== customerSavedPayee.payeeBankName)
    ) {
      return {
        ok: false,
        error: 'Payee must match the customer account saved in company records.',
      };
    }

    const calcLinesRaw = Array.isArray(payload.calculationLines) ? payload.calculationLines : [];
    const lineSumNgn = sumIncludedRefundCalculationLinesNgn(calcLinesRaw);
    if (Math.abs(lineSumNgn - amountNgn) > REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
      return {
        ok: false,
        error: `Requested refund amount (₦${amountNgn.toLocaleString(
          'en-NG'
        )}) must match the sum of included breakdown lines (₦${lineSumNgn.toLocaleString(
          'en-NG'
        )}). Adjust line amounts or use Apply total.`,
      };
    }

    const lineArithmetic = validateRefundCalculationLineArithmetic(
      calcLinesRaw,
      REFUND_AMOUNT_LINE_TOLERANCE_NGN
    );
    if (!lineArithmetic.ok) return lineArithmetic;

    if (quotationRef) {
      if (quotationHasUnclearedReceipts(db, quotationRef)) {
        return {
          ok: false,
          code: 'RECEIPT_CLEARANCE_REQUIRED',
          error:
            'All customer receipts on this quotation must be cleared by Finance (cashier/accountant) before a refund can be requested.',
        };
      }

      const quoteIntegrityRow = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(quotationRef);
      let quoteLinesJson = {};
      try {
        quoteLinesJson = JSON.parse(String(quoteIntegrityRow?.lines_json || '{}'));
      } catch {
        quoteLinesJson = {};
      }
      const lineIntegrity = validateQuotationLineIntegrity(quoteLinesJson);
      if (!lineIntegrity.ok) {
        return {
          ok: false,
          code: lineIntegrity.code || 'QUOTATION_LINE_INTEGRITY',
          error: `${lineIntegrity.error} Fix the quotation in Sales before requesting a refund, or run Settings → Governance → Quotation line integrity audit.`,
        };
      }

      const existingRefunds = db.prepare(
        `SELECT reason_category FROM customer_refunds
         WHERE quotation_ref = ? AND status IN ('Pending', 'Approved')`
      ).all(quotationRef);

      for (const row of existingRefunds) {
        try {
          const cats = JSON.parse(row.reason_category || '[]');
          const alreadyRefunded = Array.isArray(cats) ? cats : [row.reason_category];
          const intersection = requestedCats.filter(c => alreadyRefunded.includes(c));
          if (intersection.length > 0) {
            return { ok: false, error: `A refund request for category "${intersection[0]}" already exists for this quotation.` };
          }
        } catch {
          if (requestedCats.includes(row.reason_category)) {
            return { ok: false, error: `A refund request for category "${row.reason_category}" already exists for this quotation.` };
          }
        }
      }

      if (requestedCats.includes('Order cancellation') && quotationHasCompletedDelivery(db, quotationRef)) {
        return {
          ok: false,
          error: 'Order cancellation is not allowed after material has been delivered for this quotation.',
        };
      }
      if (
        requestedCats.includes('Order cancellation') &&
        requestedCats.includes('Overpayment')
      ) {
        return {
          ok: false,
          error:
            'Overpayment and Order cancellation cannot appear on the same refund request — they double-count cash received.',
        };
      }
      if (
        requestedCats.includes('Order cancellation') &&
        requestedCats.includes('Unproduced meterage')
      ) {
        return {
          ok: false,
          error:
            'Order cancellation and Unproduced meterage cannot appear together — cancellation already covers unpaid product.',
        };
      }
      if (
        requestedCats.includes('Order cancellation') &&
        (requestedCats.includes('Transport issue') ||
          requestedCats.includes('Installation issue') ||
          requestedCats.includes('Additional services'))
      ) {
        return {
          ok: false,
          error:
            'Order cancellation already covers the job. Remove transport/installation/additional services, or remove Order cancellation to claim those lines only.',
        };
      }
      if (requestedCats.includes('Unproduced meterage') && quotationHasCompletedDelivery(db, quotationRef)) {
        return {
          ok: false,
          error: 'Unproduced meterage refunds are not allowed after material has been delivered for this quotation.',
        };
      }
      if (requestedCats.includes('Unproduced meterage')) {
        const previewBlock = previewRefundRequest(db, { quotationRef });
        const pf = previewBlock.preview?.productionFulfillment;
        if (pf?.fullyProducedRoofing) {
          return {
            ok: false,
            code: 'UNPRODUCED_NOT_APPLICABLE',
            error: `Unproduced meterage refund is not allowed: ${pf.quotedMeters.toFixed(2)} m was quoted and ${pf.producedMetersForUnproduced.toFixed(2)} m was produced${pf.offcutFgMeters > 0.001 ? ` (${pf.offcutFgMeters.toFixed(2)} m from offcut/accessories)` : ''}.`,
          };
        }
      }

      const commissionRefundSum = calcLinesRaw
        .filter((l) => String(l.category || '').trim() === 'Customer commission')
        .reduce((s, l) => s + roundMoney(l.amountNgn), 0);
      if (commissionRefundSum > 0) {
        const quoteRow = db.prepare(`SELECT date_iso FROM quotations WHERE id = ?`).get(quotationRef);
        const { maxNgn } = maxCustomerCommissionRefundNgn(db, quotationRef, quotationPricingAsAtIso(quoteRow));
        if (commissionRefundSum > maxNgn) {
          return {
            ok: false,
            error: `Customer commission refund (₦${commissionRefundSum.toLocaleString(
              'en-NG'
            )}) exceeds the maximum allowed (₦${maxNgn.toLocaleString(
              'en-NG'
            )}) for this quotation given minimum selling prices and refundable headroom.`,
          };
        }
      }
      if (requestedCats.includes('Customer commission') && commissionRefundSum <= 0) {
        return {
          ok: false,
          error: 'Customer commission is selected but no calculation line carries a positive amount for that category.',
        };
      }

      const quoteRowForBundled = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationRef);
      const bundledSubmit = validateBundledTransportInstallCrossRequest(
        db,
        quotationRef,
        quoteRowForBundled,
        requestedCats,
        calcLinesRaw,
        null
      );
      if (!bundledSubmit.ok) return bundledSubmit;

      const elig = quotationMeetsRefundEligibility(db, quotationRef);
      if (!elig.ok) return elig;
      if (elig.mdReviewPending) {
        return {
          ok: false,
          code: 'MD_PRICE_EXCEPTION_CONFIRM_REQUIRED',
          error: elig.mdReviewError,
        };
      }
      const previewForCaps = previewRefundRequest(db, {
        quotationRef,
        includeCustomerCommission: requestedCats.includes('Customer commission'),
      });
      const economicFloorAtCreate = previewForCaps.ok ? previewForCaps.preview?.economicFloor ?? null : null;
      const producedAtCreate = Number(economicFloorAtCreate?.producedOutputMeters || 0);
      const mayBypassFloor = actorMayBypassIncompleteRefundFloor(actor, (p) => userHasPermission(actor, p));
      const floorOverrideNote = String(
        payload.productionAlignmentOverrideNote ??
          payload.productionAlignmentOverride ??
          payload.economicFloorOverrideNote ??
          ''
      ).trim();
      const floorExemptAtCreate = refundRequestIsEconomicFloorExempt({
        categories: requestedCats,
        calculationLines: calcLinesRaw,
      });
      if (
        !floorExemptAtCreate &&
        economicFloorAtCreate?.incompleteFloorPricing &&
        producedAtCreate > 0.001
      ) {
        if (!mayBypassFloor) {
          return {
            ok: false,
            code: 'REFUND_INCOMPLETE_FLOOR_PRICING',
            error: `Workbook floor ₦/m could not be resolved for ${producedAtCreate.toFixed(
              2
            )} m produced. Resolve material workbook pricing or escalate to MD/CEO before creating this refund.`,
          };
        }
        if (floorOverrideNote.length < 10) {
          return {
            ok: false,
            code: 'REFUND_INCOMPLETE_FLOOR_PRICING',
            error:
              'Workbook floor ₦/m could not be resolved for produced jobs. MD/admin must enter an override note (min 10 characters) to create this refund — it will carry through approval and payout.',
          };
        }
        economicFloorOverrideAtCreate = {
          used: true,
          note: floorOverrideNote,
          amountNgn,
          maxDefensibleAtCreate: null,
          incompleteFloorPricing: true,
          atISO: nowIso(),
        };
      }
      const maxDefensibleAtCreate = economicFloorAtCreate?.maxDefensibleRefundNgn;
      const floorGatedAtCreate = refundFloorGatedAmountNgn(calcLinesRaw);
      if (
        refundAmountExceedsEconomicFloorCap({
          amountNgn,
          calculationLines: calcLinesRaw,
          categories: requestedCats,
          maxDefensibleRefundNgn: maxDefensibleAtCreate,
          overpaymentExcessNgn: previewForCaps.preview?.overpaymentExcessNgn,
          toleranceNgn: REFUND_AMOUNT_LINE_TOLERANCE_NGN,
        })
      ) {
        if (mayBypassFloor && floorOverrideNote.length >= 10) {
          economicFloorOverrideAtCreate = {
            used: true,
            note: floorOverrideNote,
            amountNgn,
            maxDefensibleAtCreate: Number(maxDefensibleAtCreate),
            atISO: nowIso(),
          };
        } else {
          return {
            ok: false,
            code: 'REFUND_EXCEEDS_ECONOMIC_FLOOR',
            error: `Production-related refund amount (₦${floorGatedAtCreate.toLocaleString(
              'en-NG'
            )}) exceeds the economic floor cap (₦${Number(maxDefensibleAtCreate).toLocaleString(
              'en-NG'
            )}) after ${producedAtCreate.toFixed(
              2
            )} m produced at workbook minimum ₦/m (cash in minus floor delivered value, after prior refunds). Overpayment and quoted services are not counted against this cap.${
              mayBypassFloor
                ? ' MD/admin may override with a note (min 10 characters) in the Branch manager / MD override field.'
                : ''
            }`,
            maxDefensibleRefundNgn: Number(maxDefensibleAtCreate),
          };
        }
      }
      const categorySuggestedMaxNgn = previewForCaps.ok
        ? buildRefundCategorySuggestedMaxNgn(previewForCaps.preview?.suggestedLines)
        : {};
      const derivedCategoryMaxNgn = buildDerivedRefundCategoryCapsNgn({
        cashInNgn: elig.cashInNgn,
        totalRefundedNgn: elig.totalRefundedNgn,
        economicFloor: floorExemptAtCreate ? null : economicFloorAtCreate,
      });
      const lineValidation = validateRefundCalculationLinesNgn({
        cashInNgn: elig.cashInNgn,
        quoteTotalNgn: elig.quoteTotalNgn,
        totalRefundedNgn: elig.totalRefundedNgn,
        calculationLines: calcLinesRaw,
        categorySuggestedMaxNgn,
        derivedCategoryMaxNgn,
        toleranceNgn: REFUND_AMOUNT_LINE_TOLERANCE_NGN,
      });
      if (!lineValidation.ok) return lineValidation;
      if (amountNgn > lineValidation.hardCapNgn) {
        return {
          ok: false,
          error: `Refund amount (₦${amountNgn.toLocaleString('en-NG')}) exceeds cash received on this quotation after prior refunds (max ₦${lineValidation.hardCapNgn.toLocaleString('en-NG')}).`,
        };
      }

      const alignment = validateRefundProductionAlignmentAtSubmit(db, quotationRef, requestedCats, {
        actor,
        acknowledgedCodes: payload.productionAlignmentAcknowledgedCodes ?? payload.productionAlignmentAcknowledged ?? [],
        overrideNote: payload.productionAlignmentOverrideNote ?? payload.productionAlignmentOverride ?? '',
      });
      if (!alignment.ok) return alignment;
      submitAlignmentResult = alignment;
    }

    let quotationCustomerName = '';
    if (quotationRef) {
      const qRow = db.prepare(`SELECT customer_name FROM quotations WHERE id = ?`).get(quotationRef);
      quotationCustomerName = String(qRow?.customer_name ?? '').trim();
    }

    const reasonCategory = JSON.stringify(requestedCats);

    let productionAlignmentAckJson = null;
    if (
      (submitAlignmentResult?.ok &&
        (submitAlignmentResult.acknowledgedCodes?.length || submitAlignmentResult.overrideUsed)) ||
      economicFloorOverrideAtCreate?.used
    ) {
      try {
        const ackPayload = {
          acknowledgedCodes: submitAlignmentResult?.acknowledgedCodes || [],
          overrideUsed: Boolean(submitAlignmentResult?.overrideUsed),
          overrideNote: submitAlignmentResult?.overrideNote || '',
          validatedAtISO: nowIso(),
        };
        if (economicFloorOverrideAtCreate?.used) {
          ackPayload.economicFloorOverride = economicFloorOverrideAtCreate;
        }
        productionAlignmentAckJson = JSON.stringify(ackPayload).slice(0, 8000);
      } catch {
        productionAlignmentAckJson = null;
      }
    }

    let previewSnapshotJson = null;
    if (payload.previewSnapshot != null && typeof payload.previewSnapshot === 'object') {
      try {
        const snap = {
          ...payload.previewSnapshot,
          engineVersion: REFUND_PREVIEW_VERSION,
        };
        previewSnapshotJson = JSON.stringify(snap).slice(0, 120_000);
      } catch {
        previewSnapshotJson = null;
      }
    }

    db.transaction(() => {
      db.prepare(
        `INSERT INTO customer_refunds (
          refund_id, customer_id, customer_name, quotation_ref, cutting_list_ref, product, reason_category, reason,
          amount_ngn, calculation_lines_json, split_distributions_json, suggested_lines_json, preview_snapshot_json, production_alignment_ack_json, calculation_notes, status, requested_by, requested_by_user_id, requested_at_iso,
          approval_date, approved_by, approved_amount_ngn, manager_comments, paid_amount_ngn, paid_at_iso, paid_by, payment_note,
          payee_name, payee_account_no, payee_bank_name, branch_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        refundID,                                                                                                  // refund_id
        customerID,                                                                                                // customer_id
        String(payload.customer ?? payload.customerName ?? quotationCustomerName ?? '').trim(),                    // customer_name
        quotationRef,                                                                                              // quotation_ref
        String(payload.cuttingListRef ?? '').trim(),                                                               // cutting_list_ref
        product,                                                                                                   // product
        reasonCategory,                                                                                            // reason_category
        String(payload.reason ?? '').trim(),                                                                       // reason
        amountNgn,                                                                                                 // amount_ngn
        JSON.stringify(payload.calculationLines || []),                                                            // calculation_lines_json
        JSON.stringify(
          splitsForStore.length > 0
            ? splitsForStore.map((r) => ({
                recipientKind: r.recipientKind,
                recipientCustomerID: r.recipientCustomerID || undefined,
                recipientAssociatedStaffID: r.recipientAssociatedStaffID || undefined,
                amountNgn: roundMoney(r.amountNgn),
                companyDeductionNgn: roundMoney(r.companyDeductionNgn),
                netPayoutNgn: roundMoney(r.netPayoutNgn ?? r.amountNgn),
                deductionRate: Number(r.deductionRate) || 0,
                unclearedReceiptHoldNgn: roundMoney(r.unclearedReceiptHoldNgn),
                unclearedReceiptOffsetNgn: roundMoney(r.unclearedReceiptOffsetNgn),
                payoutHeldForUnclearedReceipts: Boolean(r.payoutHeldForUnclearedReceipts),
                companyCutWaived: Boolean(r.companyCutWaived),
                companyCutWaiverNote: String(r.companyCutWaiverNote || '').trim() || undefined,
                note: r.note,
                payoutAccount: {
                  payeeName: r.payoutAccount.payeeName,
                  payeeBankName: r.payoutAccount.payeeBankName,
                  payeeAccountNo: r.payoutAccount.payeeAccountNo,
                  partyKind: r.payoutAccount.partyKind,
                  partyId: r.payoutAccount.partyId,
                  partyName: r.payoutAccount.partyName,
                },
              }))
            : []
        ),                                                                                                         // split_distributions_json
        JSON.stringify(payload.suggestedLines || payload.calculationLines || []),                                  // suggested_lines_json
        previewSnapshotJson,                                                                                       // preview_snapshot_json
        productionAlignmentAckJson,                                                                                // production_alignment_ack_json
        String(payload.calculationNotes ?? '').trim(),                                                             // calculation_notes
        'Pending',                                                                                                 // status
        actorName(actor),                                                                                          // requested_by
        actorId(actor),                                                                                            // requested_by_user_id
        requestedAtISO,                                                                                            // requested_at_iso
        '',                                                                                                        // approval_date
        '',                                                                                                        // approved_by
        0,                                                                                                         // approved_amount_ngn
        '',                                                                                                        // manager_comments
        0,                                                                                                         // paid_amount_ngn
        '',                                                                                                        // paid_at_iso
        '',                                                                                                        // paid_by
        '',                                                                                                        // payment_note
        payeeName,                                                                                                 // payee_name
        payeeAccountNo,                                                                                            // payee_account_no
        payeeBankName,                                                                                             // payee_bank_name
        String(branchId || DEFAULT_BRANCH_ID).trim()                                                               // branch_id
      );
      appendAuditLog(db, {
        actor,
        action: 'refund.create',
        entityKind: 'refund',
        entityId: refundID,
        note: `Refund request ${refundID} submitted`,
        details: { amountNgn, customerID },
      });
      if (productionAlignmentAckJson) {
        try {
          const ack = JSON.parse(productionAlignmentAckJson);
          if (ack.overrideUsed) {
            appendAuditLog(db, {
              actor,
              action: 'refund.production_alignment.override',
              entityKind: 'refund',
              entityId: refundID,
              note: ack.overrideNote || 'Production alignment override at submit',
              details: { acknowledgedCodes: ack.acknowledgedCodes || [] },
            });
          }
        } catch {
          /* optional */
        }
      }
    })();
    return { ok: true, refundID };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function decideRefundRequest(db, refundID, payload, actor) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundID);
  if (!row) return { ok: false, error: 'Refund request not found.' };
  if (String(row.status || 'Pending') !== 'Pending') {
    return { ok: false, error: 'Only pending refunds can be reviewed.' };
  }
  const hasPerm = (p) => userHasPermission(actor, p);
  const cashierGate = assertCashierMayNotApproveRefund(actor, hasPerm);
  if (!cashierGate.ok) return { ok: false, error: cashierGate.error };
  const segApprove = assertRefundApproverNotRequester(row, actor, hasPerm);
  if (!segApprove.ok) return { ok: false, error: segApprove.error };
  const status = String(payload.status ?? '').trim();
  if (!['Approved', 'Rejected'].includes(status)) {
    return { ok: false, error: 'Decision status must be Approved or Rejected.' };
  }
  const actedAtISO = String(payload.approvalDate ?? '').trim() || nowIso().slice(0, 10);
  const requestedAmountNgn = roundMoney(row.amount_ngn);
  const creditAppliedNgn = roundMoney(row.credit_applied_ngn);
  const leftoverAfterCreditNgn = Math.max(0, requestedAmountNgn - creditAppliedNgn);
  const creditDest = String(row.credit_applied_to_quotation_ref || '').trim();
  const defaultApproveNgn = creditAppliedNgn > 0 ? leftoverAfterCreditNgn : requestedAmountNgn;
  const approvedAmountNgn =
    status === 'Approved'
      ? roundMoney(payload.approvedAmountNgn ?? defaultApproveNgn)
      : 0;
  if (status === 'Approved' && creditAppliedNgn > 0 && leftoverAfterCreditNgn <= 0) {
    return {
      ok: false,
      error: creditDest
        ? `₦${creditAppliedNgn.toLocaleString('en-NG')} was already applied to ${creditDest}. Nothing is left to approve for cash payout.`
        : `₦${creditAppliedNgn.toLocaleString('en-NG')} was already applied to a receipt. Nothing is left to approve for cash payout.`,
    };
  }
  if (status === 'Approved' && creditAppliedNgn > 0 && approvedAmountNgn > leftoverAfterCreditNgn) {
    return {
      ok: false,
      error: `₦${creditAppliedNgn.toLocaleString('en-NG')} was already applied${
        creditDest ? ` to ${creditDest}` : ' to a receipt'
      }. Approve at most ₦${leftoverAfterCreditNgn.toLocaleString('en-NG')} leftover.`,
    };
  }
  let comment = String(payload.managerComments ?? payload.note ?? '').trim();
  if (!comment && status === 'Approved' && creditAppliedNgn > 0) {
    comment = `₦${creditAppliedNgn.toLocaleString('en-NG')} was already applied${
      creditDest ? ` to ${creditDest}` : ' to a receipt'
    }. Approving leftover cash of ₦${approvedAmountNgn.toLocaleString('en-NG')}.`;
  }
  if (status === 'Approved' && approvedAmountNgn <= 0) {
    return { ok: false, error: 'Approved refund amount must be positive.' };
  }
  const qrefApprove = String(row.quotation_ref ?? '').trim();
  if (status === 'Approved' && qrefApprove) {
    const qBlock = db
      .prepare(`SELECT refunds_blocked_at_iso, refunds_blocked_reason FROM quotations WHERE id = ?`)
      .get(qrefApprove);
    if (quotationRefundsBlocked(qBlock)) {
      const why = String(qBlock?.refunds_blocked_reason ?? '').trim();
      return {
        ok: false,
        error: why
          ? `Refunds are permanently blocked on this quotation: ${why}`
          : 'Refunds are permanently blocked on this quotation.',
        refundsBlocked: true,
      };
    }
  }
  if (status === 'Approved') {
    const linesForGuard = parseRefundCalculationLinesFromRow(
      row,
      Array.isArray(payload.calculationLines) ? payload.calculationLines : null
    );
    if (!linesForGuard.length) {
      return {
        ok: false,
        code: 'REFUND_BREAKDOWN_REQUIRED',
        error: 'Refund approval requires calculation breakdown lines. Open Sales to edit the breakdown.',
      };
    }
    const lineSumApprove = sumIncludedRefundCalculationLinesNgn(linesForGuard);
    const lineMatchesApproved =
      Math.abs(lineSumApprove - approvedAmountNgn) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN;
    const lineMatchesRequestedWithCredit =
      creditAppliedNgn > 0 &&
      Math.abs(lineSumApprove - requestedAmountNgn) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN;
    if (!lineMatchesApproved && !lineMatchesRequestedWithCredit) {
      return {
        ok: false,
        error: `Approved amount (₦${approvedAmountNgn.toLocaleString(
          'en-NG'
        )}) must match the sum of included breakdown lines (₦${lineSumApprove.toLocaleString(
          'en-NG'
        )})${
          creditAppliedNgn > 0
            ? `, or the original request (₦${requestedAmountNgn.toLocaleString('en-NG')}) after refund fund was used.`
            : '.'
        }`,
      };
    }
    const decisionCats = resolveRefundReasonCategoriesForDecision(
      row,
      payload,
      normalizeRefundReasonCategoriesForApi
    );
    if (qrefApprove) {
      const financial = validateRefundFinancialGuards(db, {
        quotationRef: qrefApprove,
        refundId: refundID,
        amountNgn: approvedAmountNgn,
        calculationLines: linesForGuard,
        reasonCategories: decisionCats,
        actor,
        hasPermission: (p) => userHasPermission(actor, p),
        phase: 'approve',
      });
      if (!financial.ok) return financial;
    }
  }
  if (status === 'Approved' && approvedAmountNgn > requestedAmountNgn) {
    return {
      ok: false,
      error: `Approved amount (₦${approvedAmountNgn.toLocaleString('en-NG')}) cannot exceed the requested amount (₦${requestedAmountNgn.toLocaleString('en-NG')}).`,
    };
  }
  const govLimitsR = getOrgGovernanceLimits(db);
  if (
    status === 'Approved' &&
    !actorMayApproveRefundAmount(actor, (p) => userHasPermission(actor, p), approvedAmountNgn, govLimitsR)
  ) {
    const hi = govLimitsR.refundExecutiveThresholdNgn;
    return {
      ok: false,
      error: `Refunds above ₦${hi.toLocaleString('en-NG')} require MD/CEO-level approval (or administrator).`,
    };
  }
  const refundWarnings = [];
  const bdR = backdateWarningForActedDate(actedAtISO, 'Refund approval date');
  if (bdR) refundWarnings.push(bdR);
  const qref = String(row.quotation_ref ?? '').trim();
  let approvalAlignmentAckJson = null;
  let approvalAlignmentOverrideIsNew = false;
  if (status === 'Approved' && qref) {
    const cashInNgn = quotationCashInNgn(db, qref);
    const sumRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM customer_refunds
         WHERE quotation_ref = ? AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled') AND refund_id != ?`
      )
      .get(qref, refundID);
    const sumOthersNgn = roundMoney(sumRow?.s ?? 0);
    const maxApprovableNgn = quotationRefundHardCapNgn({
      cashInNgn,
      totalRefundedNgn: sumOthersNgn,
    });
    if (approvedAmountNgn > maxApprovableNgn) {
      return {
        ok: false,
        error: `Approved amount exceeds quotation refundable headroom (max ₦${maxApprovableNgn.toLocaleString('en-NG')} for this request given other open refunds on the same quotation).`,
      };
    }

    const decisionCats = resolveRefundReasonCategoriesForDecision(row, payload, normalizeRefundReasonCategoriesForApi);
    const storedAlign = parseStoredProductionAlignmentAck(row.production_alignment_ack_json);
    const payloadAck = payload.productionAlignmentAcknowledgedCodes ?? payload.productionAlignmentAcknowledged ?? [];
    const mergedAck = [
      ...new Set([
        ...storedAlign.acknowledgedCodes,
        ...(Array.isArray(payloadAck) ? payloadAck.map((c) => String(c).trim()).filter(Boolean) : []),
      ]),
    ];
    const approvalOverrideNote = String(
      payload.productionAlignmentOverrideNote ?? payload.productionAlignmentOverride ?? ''
    ).trim();
    approvalAlignmentOverrideIsNew = approvalOverrideNote.length >= 10;
    const effectiveOverride =
      approvalOverrideNote || (storedAlign.overrideUsed ? storedAlign.overrideNote : '');
    const alignment = validateRefundProductionAlignmentAtSubmit(db, qref, decisionCats, {
      actor,
      acknowledgedCodes: mergedAck,
      overrideNote: effectiveOverride,
      excludeRefundId: refundID,
    });
    if (!alignment.ok) return alignment;
    approvalAlignmentAckJson = mergeProductionAlignmentAckJson(storedAlign, alignment, 'approval');
  }
  try {
    assertPeriodOpen(db, actedAtISO, 'Refund approval date');
    db.transaction(() => {
      const calcLinesRaw = payload.calculationLines;
      let calculationLinesJson = null;
      if (status === 'Approved' && Array.isArray(calcLinesRaw) && calcLinesRaw.length > 0) {
        const normalized = calcLinesRaw
          .map((line) => normalizeRefundCalculationLineForStorage(line))
          .filter(Boolean);
        if (normalized.length) calculationLinesJson = JSON.stringify(normalized);
      }
      const calcNotes =
        status === 'Approved' && payload.calculationNotes !== undefined && payload.calculationNotes !== null
          ? String(payload.calculationNotes).trim()
          : null;
      const suggestedRaw = payload.suggestedLines;
      let suggestedLinesJson = null;
      if (status === 'Approved' && Array.isArray(suggestedRaw) && suggestedRaw.length > 0) {
        const normalized = suggestedRaw
          .map((line) => normalizeRefundCalculationLineForStorage(line))
          .filter(Boolean);
        if (normalized.length) suggestedLinesJson = JSON.stringify(normalized);
      }
      if (calculationLinesJson != null || calcNotes != null || suggestedLinesJson != null) {
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?, approval_date = ?, approved_by = ?, approved_by_user_id = ?, approved_amount_ngn = ?, manager_comments = ?,
               calculation_lines_json = COALESCE(?, calculation_lines_json),
               calculation_notes = COALESCE(?, calculation_notes),
               suggested_lines_json = COALESCE(?, suggested_lines_json),
               production_alignment_ack_json = COALESCE(?, production_alignment_ack_json)
           WHERE refund_id = ?`
        ).run(
          status,
          actedAtISO,
          actorName(actor),
          actorId(actor),
          approvedAmountNgn,
          comment,
          calculationLinesJson,
          calcNotes,
          suggestedLinesJson,
          approvalAlignmentAckJson,
          refundID
        );
      } else {
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?, approval_date = ?, approved_by = ?, approved_by_user_id = ?, approved_amount_ngn = ?, manager_comments = ?,
               production_alignment_ack_json = COALESCE(?, production_alignment_ack_json)
           WHERE refund_id = ?`
        ).run(
          status,
          actedAtISO,
          actorName(actor),
          actorId(actor),
          approvedAmountNgn,
          comment,
          approvalAlignmentAckJson,
          refundID
        );
      }
      recordApprovalAction(db, {
        actor,
        entityKind: 'refund',
        entityId: refundID,
        action: 'review',
        status: status.toLowerCase(),
        note: comment,
        actedAtISO,
      });
      appendAuditLog(db, {
        actor,
        action: 'refund.review',
        entityKind: 'refund',
        entityId: refundID,
        note: comment || `Refund ${status.toLowerCase()}`,
        details: { status, approvedAmountNgn, creditAppliedNgn, leftoverAfterCreditNgn, creditDest },
      });
      if (approvalAlignmentAckJson && approvalAlignmentOverrideIsNew) {
        try {
          const ack = JSON.parse(approvalAlignmentAckJson);
          appendAuditLog(db, {
            actor,
            action: 'refund.production_alignment.override',
            entityKind: 'refund',
            entityId: refundID,
            note: ack.overrideNote || 'Production alignment override at approval',
            details: { phase: 'approval', acknowledgedCodes: ack.acknowledgedCodes || [] },
          });
        } catch {
          /* optional */
        }
      }
      if (cashierGate.adminTrial || segApprove.adminTrial) {
        appendAuditLog(db, {
          actor,
          action: 'refund.dual_control.admin_trial',
          entityKind: 'refund',
          entityId: refundID,
          note: 'Admin trial exception: refund approval bypassed segregation-of-duties check.',
          details: { bypass: segApprove.bypass || 'admin_trial' },
        });
        recordApprovalAction(db, {
          actor,
          entityKind: 'refund',
          entityId: refundID,
          action: 'dual_control_bypass',
          status: 'admin_trial',
          note: 'Admin trial exception on refund approval.',
          actedAtISO,
        });
      }
      if (status === 'Approved' && qref) {
        const qClearRow = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get(qref);
        if (qClearRow && !String(qClearRow.manager_cleared_at_iso || '').trim()) {
          const clearedAt = new Date().toISOString();
          db.prepare(
            `UPDATE quotations
             SET manager_cleared_at_iso = ?, manager_flagged_at_iso = NULL, manager_flag_reason = NULL
             WHERE id = ?`
          ).run(clearedAt, qref);
          appendAuditLog(db, {
            actor,
            action: 'quotation.auto_clear_on_refund_approval',
            entityKind: 'quotation',
            entityId: qref,
            note: `Quotation manager-cleared when refund ${refundID} was approved.`,
            details: { refundID },
          });
        }
      }
      if (status === 'Approved' && approvedAmountNgn > 0) {
        const freshForWallet = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundID);
        const walletCredit = creditRefundToPartnerWalletTx(db, freshForWallet || row, {
          approvedAmountNgn,
          actor,
        });
        if (!walletCredit.ok) {
          throw new Error(walletCredit.error || 'Partner wallet credit failed.');
        }
        if (!walletCredit.skipped && Array.isArray(walletCredit.credits) && walletCredit.credits.length) {
          appendAuditLog(db, {
            actor,
            action: 'partner_wallet.credit',
            entityKind: 'refund',
            entityId: refundID,
            note: `Refund ${refundID} credited to partner wallet for cashier withdrawal.`,
            details: {
              credits: walletCredit.credits,
              approvedAmountNgn,
            },
          });
        }
      }
    })();
    return { ok: true, warnings: refundWarnings };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function cancelApprovedRefundBeforePay(db, refundID, payload, actor) {
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundID);
  if (!row) return { ok: false, error: 'Refund request not found.' };
  if (String(row.status || '').trim() !== 'Approved') {
    return { ok: false, error: 'Only approved refunds can be cancelled from payout queue.' };
  }
  const paidAmountNgn = roundMoney(row.paid_amount_ngn);
  if (paidAmountNgn > 0) {
    return { ok: false, error: 'This refund already has payout entries and cannot be cancelled.' };
  }
  const note = String(payload.note ?? payload.managerComments ?? '').trim();
  const actedAtISO = String(payload.actedAtISO ?? '').trim() || nowIso().slice(0, 10);
  try {
    assertPeriodOpen(db, actedAtISO, 'Refund cancellation date');
    db.transaction(() => {
      const voided = voidPartnerWalletCreditsForRefundTx(db, refundID);
      if (!voided.ok) throw new Error(voided.error || 'Could not void partner wallet credits.');
      db.prepare(
        `UPDATE customer_refunds
         SET status = 'Cancelled',
             manager_comments = ?,
             paid_amount_ngn = 0,
             paid_at_iso = '',
             paid_by = '',
             payment_note = ''
         WHERE refund_id = ?`
      ).run(note, refundID);
      appendAuditLog(db, {
        actor,
        action: 'refund.cancel_before_pay',
        entityKind: 'refund',
        entityId: refundID,
        note: note || `Refund ${refundID} cancelled before payout`,
        details: { previousStatus: 'Approved', paidAmountNgn },
      });
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Explains substitution preview per production job (gauge on quotation vs gauge on allocated coil; workbook ₦/m).
 * Used when `payload.substitutionDiagnosis` is true — not returned over HTTP by default callers.
 */
function buildSubstitutionJobDiagnosis(db, quote, productionJobs, pricePerMeter, overrideSubPpm, pricingAsAtIso) {
  const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
  const quotedGd = firstQuotedProductGaugeDesign(quote?.lines_json);
  const quotedGaugeRaw = quotedGaugeLabelForSubstitutionComparison(quote?.lines_json ?? '');
  const jobs = [];
  for (const j of productionJobs) {
    const jobLabel = String(j.product_name || j.job_id || 'Production job').trim();
    const actualM = Number(j.actual_meters) || 0;
    const gaugeGroups = coilGaugeMeterGroupsFromJob(db, j.job_id);
    const positiveGroups = gaugeGroups.filter((g) => (Number(g.meters) || 0) > 0.001);
    const slices =
      positiveGroups.length > 0
        ? positiveGroups
        : [{ gaugeLabel: producedGaugeLabelFromJobCoils(db, j.job_id), meters: actualM }];

    for (const slice of slices) {
      const coilGaugeRaw = String(slice.gaugeLabel || '').trim();
      const m = Number(slice.meters) || 0;

      let outcome = 'UNKNOWN';
      let producedPpm = null;
      let deltaPpm = null;

      if (!quotedGaugeRaw) {
        outcome = 'SKIP_NO_QUOTED_GAUGE — add gauge on quotation header or product lines.';
      } else if (m <= 0) {
        outcome =
          'SKIP_ZERO_ACTUAL_METRES — no coil metres_produced / job.actual_meters for this gauge slice.';
      } else if (!coilGaugeRaw) {
        outcome =
          'SKIP_NO_COIL_GAUGE — production_job_coils / coil_lots have no gauge for this job; allocate coils with gauge labels.';
      } else if (!gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGaugeRaw)) {
        outcome =
          'SKIP_SAME_GAUGE — coil gauge matches quoted gauge within noise tolerance; no substitution credit.';
      } else if (!pricePerMeter) {
        outcome =
          'SKIP_NO_QUOTED_BLENDED_PPM — no roofing-sheet blended ₦/m from product lines (need qty × unitPrice), and no pricePerMeterNgn override.';
      } else {
        const lookup = listWorkbookPpmForJobAllocatedCoil(
          db,
          j,
          branchId,
          quotedGd,
          overrideSubPpm,
          quote?.lines_json ?? '',
          pricingAsAtIso,
          coilGaugeRaw
        );
        const ppm = ppmValueFromWorkbookLookup(lookup);
        producedPpm = ppm;
        if (ppm == null || ppm <= 0) {
          outcome =
            'SKIP_NO_WORKBOOK_PRICE — no material pricing floor row or price_list_items match for this coil gauge + design/colour (or pass substitutePricePerMeterNgn).';
        } else {
          deltaPpm = pricePerMeter - ppm;
          if (deltaPpm <= 0) {
            outcome = `SKIP_NON_POSITIVE_DELTA — quoted blended ₦/m (${Math.round(pricePerMeter)}) is not above workbook floor/list for coil (${ppm}).`;
          } else {
            outcome = `CREDIT — quoted ${quotedGaugeRaw} vs coil ${coilGaugeRaw}: Δ ${Math.round(deltaPpm)} ₦/m × ${m} m`;
          }
        }
      }

      jobs.push({
        jobId: j.job_id,
        jobLabel,
        productName: j.product_name ?? '',
        productId: j.product_id ?? '',
        jobStatus: j.status ?? '',
        actualMetersOnJobRow: actualM,
        coilMetersThisGauge: m,
        quotedGaugeLabelForSubstitution: quotedGaugeRaw || null,
        coilGaugeFromAllocations: coilGaugeRaw || null,
        gaugeDiffersBeyondTolerance0p02mm: Boolean(
          quotedGaugeRaw && coilGaugeRaw && gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGaugeRaw)
        ),
        // Alias kept for older diagnosis consumers; same check as gaugeDiffersBeyondTolerance0p02mm.
        gaugeDiffersBeyondNoiseTolerance: Boolean(
          quotedGaugeRaw && coilGaugeRaw && gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGaugeRaw)
        ),
        shouldEnterSubstitutionCreditPath: Boolean(
          quotedGaugeRaw &&
            coilGaugeRaw &&
            m > 0 &&
            gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGaugeRaw) &&
            pricePerMeter
        ),
        quotedBlendedPpmRounded: pricePerMeter != null ? Math.round(pricePerMeter) : null,
        producedListPpm: producedPpm,
        deltaPpm: deltaPpm != null ? Math.round(deltaPpm) : null,
        outcome,
      });
    }
  }
  return {
    substitutionModel: 'quoted_gauge_vs_coil_gauge_workbook_per_allocation',
    pricingAsAtIso,
    quotedGaugeLabelForSubstitution: quotedGaugeRaw || null,
    firstQuotedProductGaugeDesign: quotedGd,
    branchId,
    jobs,
  };
}

export function previewRefundRequest(db, payload) {
  const quotationRef = String(payload.quotationRef ?? '').trim();
  const quote = quotationRef
    ? db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quotationRef)
    : null;

  const warnings = [];
  if (quotationRef && quotationHasUnclearedReceipts(db, quotationRef)) {
    warnings.push(
      'One or more receipts on this quotation are pending Finance clearance. Clear them on Finance & accounts before requesting a refund.'
    );
  }
  if (
    quote &&
    quotationRefundBlockedPendingMdPriceConfirm({
      bmPriceExceptionApprovedAtISO: quote.bm_price_exception_approved_at_iso,
      priceExceptionMdReviewRequired: quote.price_exception_md_review_required,
      priceExceptionMdConfirmedAtISO: quote.price_exception_md_confirmed_at_iso,
      mdPriceExceptionApprovedAtISO: quote.md_price_exception_approved_at_iso,
    })
  ) {
    warnings.push(
      'Below-floor pricing was approved by the Managing Director or an administrator. The Managing Director must confirm that exception after production before any customer refund.'
    );
  }

  const customerID = String(payload.customerID ?? quote?.customer_id ?? '').trim();
  if (!customerID && !quotationRef) return { ok: false, error: 'Customer or Quotation is required.' };

  const receipts = quotationRef
    ? db
        .prepare(
          `SELECT * FROM sales_receipts WHERE quotation_ref = ?
           AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
        )
        .all(quotationRef)
    : [];

  const overpayRow =
    quotationRef &&
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
         WHERE type = 'OVERPAY_ADVANCE' AND quotation_ref = ?`
      )
      .get(quotationRef);
  const overpayAdvanceNgn = roundMoney(overpayRow?.s ?? 0);

  const productionJobs = quotationRef
    ? db
        .prepare(
          `SELECT * FROM production_jobs WHERE quotation_ref = ?
           AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')`
        )
        .all(quotationRef)
    : [];
  const hasCancelledProductionJob = productionJobs.some(
    (j) => String(j.status || '').trim().toLowerCase() === 'cancelled'
  );
  const includeCustomerCommission = Boolean(payload.includeCustomerCommission);

  const existingRefunds = quotationRef
    ? db
        .prepare(
          `SELECT * FROM customer_refunds WHERE quotation_ref = ? AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
        )
        .all(quotationRef)
    : [];

  const refundedCategories = new Set();
  const openRefundedCategories = new Set();
  existingRefunds.forEach((r) => {
    const status = String(r.status || '')
      .trim()
      .toLowerCase();
    const isOpen = status === 'pending' || status === 'approved';
    try {
      const cats = JSON.parse(r.reason_category || '[]');
      if (Array.isArray(cats)) {
        cats.forEach((c) => {
          refundedCategories.add(c);
          if (isOpen) openRefundedCategories.add(c);
        });
      } else {
        refundedCategories.add(r.reason_category);
        if (isOpen) openRefundedCategories.add(r.reason_category);
      }
    } catch {
      refundedCategories.add(r.reason_category);
      if (isOpen) openRefundedCategories.add(r.reason_category);
    }
  });

  /** Paid accessory/stone shortfalls may reopen only for unpaid qty delta; other categories stay hard-blocked once Paid. */
  const hardBlockedCategories = new Set();
  for (const cat of refundedCategories) {
    if (QUANTITY_NETTED_REFUND_CATEGORIES.has(cat)) {
      if (openRefundedCategories.has(cat)) hardBlockedCategories.add(cat);
    } else {
      hardBlockedCategories.add(cat);
    }
  }

  let paidRefundsOnQuotationNgn = 0;
  let priorRefundsOnQuotationNgn = 0;
  const priorRefundsOnQuotation = existingRefunds.map((r) => {
    const amountNgn = roundMoney(r.amount_ngn);
    const paidAmountNgn = roundMoney(r.paid_amount_ngn);
    const status = String(r.status || '').trim();
    priorRefundsOnQuotationNgn += amountNgn;
    if (status.toLowerCase() === 'paid' || paidAmountNgn > 0) {
      paidRefundsOnQuotationNgn += paidAmountNgn > 0 ? paidAmountNgn : amountNgn;
    }
    return {
      refundId: r.refund_id,
      status,
      amountNgn,
      paidAmountNgn,
      reasonCategory: r.reason_category,
    };
  });
  paidRefundsOnQuotationNgn = roundMoney(paidRefundsOnQuotationNgn);
  priorRefundsOnQuotationNgn = roundMoney(priorRefundsOnQuotationNgn);

  const cashBreakdown = quotationRef ? quotationPaymentCashBreakdown(db, quotationRef) : null;
  const paidOnQuoteNgn =
    cashBreakdown?.receiptAllocatedSumNgn ??
    receipts.reduce((sum, row) => sum + roundMoney(row.amount_ngn), 0);
  const cashInNgn = cashBreakdown
    ? cashBreakdown.cashInNgn
    : roundMoney(paidOnQuoteNgn + overpayAdvanceNgn);
  const receiptCashNgn = cashBreakdown?.receiptCashNgn ?? paidOnQuoteNgn;
  const quoteTotalNgn = roundMoney(quote?.total_ngn);
  const pricingAsAtIso = quotationPricingAsAtIso(quote);
  const excludeRefundIdForOverpay = String(payload.excludeRefundId ?? payload.refundId ?? '').trim() || null;
  const overpayAlreadyRefundedNgn = overpaymentAlreadyRefundedNgn(
    existingRefunds,
    excludeRefundIdForOverpay
  );
  const overpaymentResidualNgn = quotationOverpaymentResidualNgn({
    cashInNgn,
    quoteTotalNgn,
    overpaymentAlreadyRefundedNgn: overpayAlreadyRefundedNgn,
  });
  if (overpaymentResidualNgn <= 0) {
    hardBlockedCategories.add('Overpayment');
  } else {
    hardBlockedCategories.delete('Overpayment');
  }

  let linesPayloadForUnproduced = {};
  try {
    linesPayloadForUnproduced = JSON.parse(String(quote?.lines_json || '{}'));
  } catch {
    linesPayloadForUnproduced = {};
  }
  const stoneMeterQuoteForUnproduced = isStoneMeterQuotationLinesJson(db, linesPayloadForUnproduced);

  // Quoted vs Actual Produced (optional payload overrides for tools/tests)
  const quotedMetersFromQuote = stoneMeterQuoteForUnproduced
    ? quotedRoofingSheetMetresFromLines(quote?.lines_json ?? '')
    : quotedCoilSheetPoolMetresFromLines(quote?.lines_json ?? '');
  const actualMetersFromJobs = productionJobs.reduce((sum, j) => sum + (Number(j.actual_meters) || 0), 0);
  const coilProducedMetersFromJobs = coilProducedMetersFromProductionJobs(db, productionJobs);
  const quotedMetersOverride = positiveNumber(payload.quotedMeters);
  const actualMetersOverride = positiveNumber(payload.actualMeters);
  const coilProducedMetersOverride = positiveNumber(payload.coilProducedMeters);
  const quotedMeters =
    quotedMetersOverride != null ? Math.max(0, roundMoney(quotedMetersOverride)) : quotedMetersFromQuote;
  const actualMeters =
    actualMetersOverride != null ? Math.max(0, roundMoney(actualMetersOverride)) : actualMetersFromJobs;
  const coilProducedMeters =
    coilProducedMetersOverride != null
      ? Math.max(0, roundMoney(coilProducedMetersOverride))
      : coilProducedMetersFromJobs;
  const producedMetersForUnproduced =
    coilProducedMetersOverride != null
      ? Math.max(0, roundMoney(coilProducedMetersOverride))
      : actualMetersOverride != null
        ? Math.max(0, roundMoney(actualMetersOverride))
        : producedMetersForUnproducedRefund(db, productionJobs, {
            isStoneMeterQuote: stoneMeterQuoteForUnproduced,
          });
  const productionFulfillment = buildRefundProductionFulfillmentSummary(db, quote, productionJobs, {
    isStoneMeterQuote: stoneMeterQuoteForUnproduced,
    quotedMeters,
    producedMetersForUnproduced,
  });

  const suggestedLines = [];
  const materialDelivered = quotationRef ? quotationHasCompletedDelivery(db, quotationRef) : false;
  const blockedRefundCategories = [];
  if (materialDelivered) {
    blockedRefundCategories.push('Order cancellation');
    blockedRefundCategories.push('Unproduced meterage');
    warnings.push(
      'Material has been marked delivered for this quotation; order cancellation and unproduced-meterage refunds are not allowed.'
    );
  }
  if (productionFulfillment.fullyProducedRoofing && !hasCancelledProductionJob) {
    if (!blockedRefundCategories.includes('Unproduced meterage')) {
      blockedRefundCategories.push('Unproduced meterage');
    }
    const srcParts = [];
    if (productionFulfillment.coilProducedMeters > 0.001) {
      srcParts.push(`${productionFulfillment.coilProducedMeters.toFixed(2)} m from coil`);
    }
    if (productionFulfillment.offcutFgMeters > 0.001) {
      srcParts.push(`${productionFulfillment.offcutFgMeters.toFixed(2)} m from offcut/accessories`);
    }
    warnings.push(
      `Quoted ${productionFulfillment.quotedMeters.toFixed(2)} m roofing is fully produced (${productionFulfillment.producedMetersForUnproduced.toFixed(2)} m output${srcParts.length ? `: ${srcParts.join(', ')}` : ''}) — unproduced meterage refund does not apply.`
    );
  }

  const derivedPricePerMeter =
    quotedRoofingSheetAmountPerMeter(quote?.lines_json) ?? quotedAmountPerMeter(quote?.lines_json);
  const pricePerMeter = positiveNumber(payload.pricePerMeterNgn) || derivedPricePerMeter;

  if (quotationRef) {
    const substitutionPreviewWarningCodes = new Set([
      'substitution_list_price',
      'substitution_coil_gauge_missing',
      'quoted_gauge_missing',
      'quoted_blend_rate',
    ]);
    for (const iss of refundSubstitutionDataQualityIssues(db, quotationRef)) {
      if (substitutionPreviewWarningCodes.has(iss.code)) warnings.push(iss.message);
    }
    for (const iss of refundPaymentIntegrityIssues(db, quotationRef)) {
      warnings.push(iss.message);
    }
    for (const iss of refundCuttingListQuotationMetreIssues(db, quotationRef)) {
      warnings.push(iss.message);
    }
  }

  const requestedPpm = positiveNumber(payload.pricePerMeterNgn);
  if (derivedPricePerMeter && requestedPpm && derivedPricePerMeter > 0) {
    const diffPct = (Math.abs(requestedPpm - derivedPricePerMeter) / derivedPricePerMeter) * 100;
    if (diffPct > 5) {
      warnings.push(
        `Provided price/meter deviates by more than 5% from quotation-implied rate (≈₦${Math.round(derivedPricePerMeter).toLocaleString('en-NG')}).`
      );
    }
  }

  // 1. Overpayment Auto-detection (RECEIPT total + OVERPAY_ADVANCE from split-till posting)
  // Cancelled jobs use Order cancellation for the full cash path — do not also suggest
  // Overpayment (same cash headroom; stacking exceeds the hard cap).
  const overpaymentExcessNgn = quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn });
  if (
    !hasCancelledProductionJob &&
    !hardBlockedCategories.has('Overpayment') &&
    overpaymentResidualNgn > 0
  ) {
    suggestedLines.push({
      label: `Overpayment on ${quotationRef || 'quotation'}`,
      amountNgn: overpaymentResidualNgn,
      category: 'Overpayment',
    });
  }

  // 1b. Customer commission — only when explicitly requested; capped by minimum selling ₦/m and remaining refundable.
  if (
    includeCustomerCommission &&
    quotationRef &&
    !hardBlockedCategories.has('Customer commission') &&
    cashInNgn > 0 &&
    quote?.lines_json
  ) {
    const el = quotationMeetsRefundEligibility(db, quotationRef);
    if (el.ok) {
      const { maxNgn, warnings: commissionWarnings } = maxCustomerCommissionRefundNgn(db, quotationRef, pricingAsAtIso);
      for (const w of commissionWarnings) {
        warnings.push(w);
      }
      if (maxNgn >= 1) {
        suggestedLines.push({
          label: `Customer commission / agreed price concession (recommended vs quoted, capped by minimum selling ₦/m): up to ₦${maxNgn.toLocaleString('en-NG')}`,
          amountNgn: maxNgn,
          category: 'Customer commission',
        });
      }
    }
  }

  // 2. Quoted vs produced shortfall (not the same as order cancellation — see eligible categories)
  if (quotedMeters > 0 && pricePerMeter) {
    const unproducedPotential = Math.max(0, quotedMeters - producedMetersForUnproduced);
    if (
      unproducedPotential > 0 &&
      !hardBlockedCategories.has('Unproduced meterage') &&
      !materialDelivered
    ) {
      const unproducedLine = buildUnproducedMetresRefundLine(unproducedPotential, pricePerMeter);
      suggestedLines.push({
        label: unproducedLine.label,
        amountNgn: unproducedLine.amountNgn,
        category: 'Unproduced meterage',
      });
    }
  }

  const quotedTrimFinishedM = quotedTrimFinishedMetresFromProducts(quote?.lines_json ?? '');
  const trimPricePerMeter = trimLinesBlendedPricePerMeterFromProducts(quote?.lines_json ?? '');
  if (
    quotedTrimFinishedM > 0.001 &&
    trimPricePerMeter > 0 &&
    !hardBlockedCategories.has('Unproduced meterage') &&
    !materialDelivered
  ) {
    const poolQuoted = stoneMeterQuoteForUnproduced
      ? quotedRoofingSheetMetresFromLines(quote?.lines_json ?? '')
      : quotedCuttingListSheetPoolMetresFromProducts(quote?.lines_json ?? '');
    let trimUnproducedM = quotedTrimFinishedM;
    if (poolQuoted > 0.001) {
      const sheetShortfall = Math.max(0, poolQuoted - producedMetersForUnproduced);
      const ratio = Math.min(1, sheetShortfall / poolQuoted);
      trimUnproducedM = roundCuttingListMetres2(quotedTrimFinishedM * ratio);
    } else if (producedMetersForUnproduced > 0.001) {
      trimUnproducedM = 0;
    }
    if (trimUnproducedM > 0.001) {
      const trimLine = buildUnproducedMetresRefundLine(trimUnproducedM, trimPricePerMeter, { trim: true });
      suggestedLines.push({
        label: trimLine.label,
        amountNgn: trimLine.amountNgn,
        category: 'Unproduced meterage',
      });
    }
  }

  if (
    !stoneMeterQuoteForUnproduced &&
    coilProducedMeters > 0 &&
    producedMetersForUnproduced > coilProducedMeters + 0.001
  ) {
    const offcutFgM = roundMoney(producedMetersForUnproduced - coilProducedMeters);
    warnings.push(
      `${offcutFgM.toFixed(2)} m of finished output was from offcut/accessories in addition to ${coilProducedMeters.toFixed(2)} m from coil — both count toward unproduced-meterage refund math.`
    );
  }

  // 3. Service refunds — transport / installation / other quoted services (bending, labour, etc.)
  const quoteLines = collectQuotationServices(db, quotationRef, quote);
  const miscServiceLines = [];
  for (const s of quoteLines) {
    const nl = serviceNameLower(s);
    if (matchesCorrugationService(nl)) continue;
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    const amt = roundMoney(qty * unitPrice);
    if (amt <= 0) continue;

    const isTransport = matchesTransportService(nl);
    const isInstall = matchesInstallationService(nl);

    if (isTransport && isInstall) {
      const needTransport = !hardBlockedCategories.has('Transport issue');
      const needInstall = !hardBlockedCategories.has('Installation issue');
      const appliesToCategories = [];
      if (needTransport) appliesToCategories.push('Transport issue');
      if (needInstall) appliesToCategories.push('Installation issue');
      if (appliesToCategories.length > 0) {
        suggestedLines.push({
          label: `Transport & installation service: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
          amountNgn: amt,
          category: 'Transport issue',
          appliesToCategories,
        });
        warnings.push(
          'This quotation bundles transport and installation on one line; adjust amounts or add manual lines if refunding only part of the bundle.'
        );
      }
      continue;
    }
    if (isTransport) {
      if (!hardBlockedCategories.has('Transport issue')) {
        suggestedLines.push({
          label: `Unclaimed transport: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
          amountNgn: amt,
          category: 'Transport issue',
        });
      }
      // Never reclassify blocked transport under Additional services (would double-suggest).
      continue;
    }
    if (isInstall) {
      if (!hardBlockedCategories.has('Installation issue')) {
        suggestedLines.push({
          label: `Unclaimed installation: ${String(s?.name ?? 'Service').trim() || 'Service'}`,
          amountNgn: amt,
          category: 'Installation issue',
        });
      }
      continue;
    }
    miscServiceLines.push({ name: String(s?.name ?? 'Service').trim() || 'Service', amt });
  }

  if (miscServiceLines.length && !hardBlockedCategories.has('Additional services')) {
    const totalMisc = roundMoney(miscServiceLines.reduce((sum, x) => sum + x.amt, 0));
    if (totalMisc > 0) {
      const names = miscServiceLines.map((x) => x.name);
      suggestedLines.push({
        label: `Quoted additional services (e.g. bending, labour): ${names.join('; ')} — ₦${totalMisc.toLocaleString('en-NG')} total`,
        amountNgn: totalMisc,
        category: 'Additional services',
      });
    }
  }

  if (quotationRef && !hardBlockedCategories.has('Accessory shortfall')) {
    const accSummary = accessoryFulfillmentSummaryForQuotation(db, quotationRef);
    const shortfallCaps = loadActiveRefundShortfallCaps(db, quotationRef);
    for (const a of accSummary) {
      const sf = Math.max(0, Number(a.shortfall) || 0);
      const alreadyQty =
        shortfallCaps.accessoryShortfallByKey.get(normAccessoryNameKey(a.name)) || 0;
      const netSf = Math.max(0, sf - alreadyQty);
      if (netSf <= 0) continue;
      const up = Math.round(Number(a.unitPriceNgn) || 0);
      const amountNgn = roundMoney(netSf * up);
      if (amountNgn <= 0) continue;
      const paidNote = alreadyQty > 0 ? ` — ${alreadyQty} already refunded` : '';
      suggestedLines.push({
        label: `Accessory shortfall: ${a.name} (${netSf} × ₦${up.toLocaleString('en-NG')})${paidNote}`,
        amountNgn,
        category: 'Accessory shortfall',
      });
    }
  }

  if (quotationRef && quote?.lines_json && !hardBlockedCategories.has('Stone flatsheet shortfall')) {
    const shortfallCaps = loadActiveRefundShortfallCaps(db, quotationRef);
    for (const s of stoneFlatsheetShortfallRefundSuggestions(db, quotationRef, quote.lines_json)) {
      const m2 = Number(s.shortfallM2) || 0;
      const key = `${normAccessoryNameKey(s.name)}|${s.lengthM}`;
      const alreadyM2 = shortfallCaps.stoneShortfallM2ByKey.get(key) || 0;
      const netM2 = Math.max(0, m2 - alreadyM2);
      if (netM2 <= 0) continue;
      const unitR = Math.round(Number(s.unitPriceNgn) || 0);
      const amountNgn =
        unitR > 0
          ? roundMoney(netM2 * unitR)
          : roundMoney((Number(s.amountNgn) || 0) * (m2 > 0 ? netM2 / m2 : 0));
      if (amountNgn <= 0) continue;
      const pcs = Number(s.shortfallPcs) || 0;
      const netPcs = m2 > 0 ? Math.round((pcs * (netM2 / m2)) * 100) / 100 : pcs;
      const nm = String(s.name || 'Stone flatsheet').trim();
      const paidNote = alreadyM2 > 0 ? ` — ${alreadyM2.toFixed(2)} m² already refunded` : '';
      suggestedLines.push({
        label: `Stone flatsheet shortfall: ${nm} (${Number(netPcs).toFixed(2)} × ${s.lengthM} m) — ${netM2.toFixed(2)} m²${paidNote}`,
        amountNgn,
        category: 'Stone flatsheet shortfall',
      });
    }
  }

  if (quote && quotationRef && !hardBlockedCategories.has('Calculation error')) {
    const lineSum = sumQuotationLinesJsonFlexible(quote.lines_json);
    if (lineSum > 0) {
      const diff = roundMoney(quoteTotalNgn - lineSum);
      if (Math.abs(diff) >= 1) {
        suggestedLines.push({
          label: `Quotation total vs line-item sum (${diff > 0 ? 'header higher' : 'lines higher'} by ₦${Math.abs(diff).toLocaleString('en-NG')})`,
          amountNgn: Math.abs(diff),
          category: 'Calculation error',
        });
      }
    }
  }

  /**
   * Substitution (simplified): **quotation gauge** vs **allocated coil gauge** (per coil metres when mixed).
   * Credit = max(0, quoted blended ₦/m − workbook **floor** ₦/m for coil gauge + design as at **quotation date**,
   * else published list from `price_list_items`) × metres for each thinner-gauge allocation.
   * Does not use job product name or FG card gauge for the comparison trigger.
   */
  const substitutionPerMeterBreakdown = [];
  if (quotationRef && !hardBlockedCategories.has('Substitution Difference') && productionJobs.length) {
    let linesPayloadForSub = parseJsonValue(quote?.lines_json);
    if (typeof linesPayloadForSub !== 'object' || !linesPayloadForSub) linesPayloadForSub = {};
    const stoneMeterQuoteForSub = isStoneMeterQuotationLinesJson(db, linesPayloadForSub);
    const branchId = quote?.branch_id != null ? String(quote.branch_id).trim() || null : null;
    const sheetBranch = (branchId && String(branchId).trim()) || DEFAULT_BRANCH_ID;
    const overrideSubPpm = positiveNumber(payload.substitutePricePerMeterNgn);
    const quotedGd = firstQuotedProductGaugeDesign(quote?.lines_json);
    const ctxJob =
      productionJobs.find((jj) => (Number(jj.actual_meters) || 0) > 0) || productionJobs[0] || null;
    const mkQuotedCtx = ctxJob ? materialPricingMaterialKeyFromJob(db, ctxJob) : null;
    let quotedFloorPpm = null;
    let quotedListPpm = null;
    if (quotedGd) {
      quotedFloorPpm =
        mkQuotedCtx != null
          ? workbookFloorPpmForQuotedGaugeDesign(db, mkQuotedCtx, quotedGd, sheetBranch, pricingAsAtIso)
          : null;
      quotedListPpm = quotedFloorPpm;
      if (quotedListPpm == null || quotedListPpm <= 0) {
        quotedListPpm = listPricePerMeterFromGaugeDesign(db, quotedGd.gauge, quotedGd.design, branchId, pricingAsAtIso);
      }
    }
    const quotedGaugeRaw = quotedGaugeLabelForSubstitutionComparison(quote?.lines_json ?? '');
    let totalCredit = 0;
    let anyGaugeVsCoilCase = false;
    const missingListPriceLabels = [];
    const missingCoilGaugeLabels = [];
    let noPositiveDelta = false;

    if (
      productionJobs.some((j) => (Number(j.actual_meters) || 0) > 0) &&
      !quotedGaugeRaw &&
      !stoneMeterQuoteForSub
    ) {
      warnings.push(
        'Substitution (gauge vs coil): quotation has no gauge on header or product lines — add gauge to compute automatic credit.'
      );
    }

    for (const j of productionJobs) {
      const jobLabel = String(j.product_name || j.job_id || 'Production job').trim();
      if (!quotedGaugeRaw) continue;

      const actualM = Number(j.actual_meters) || 0;
      const gaugeGroups = coilGaugeMeterGroupsFromJob(db, j.job_id).filter(
        (g) => (Number(g.meters) || 0) > 0.001
      );
      // Prefer per-coil metres so mixed gauges (e.g. 0.24 + 0.22 on one job) each get credit.
      // Fall back to job.actual_meters only when allocations have no metres_produced.
      const slices =
        gaugeGroups.length > 0
          ? gaugeGroups.map((g) => ({ meters: Number(g.meters) || 0, coilGauge: g.gaugeLabel }))
          : actualM > 0
            ? [{ meters: actualM, coilGauge: producedGaugeLabelFromJobCoils(db, j.job_id) }]
            : [];
      if (slices.length === 0) continue;

      for (const slice of slices) {
        const m = Number(slice.meters) || 0;
        if (m <= 0) continue;
        const coilGauge = String(slice.coilGauge || '').trim();
        if (!coilGauge) {
          if (!stoneMeterQuoteForSub) {
            missingCoilGaugeLabels.push(jobLabel);
          }
          continue;
        }
        if (!gaugesDifferBeyondTolerance(quotedGaugeRaw, coilGauge)) {
          continue;
        }

        anyGaugeVsCoilCase = true;

        const producedLookup = listWorkbookPpmForJobAllocatedCoil(
          db,
          j,
          branchId,
          quotedGd,
          overrideSubPpm,
          quote?.lines_json ?? '',
          pricingAsAtIso,
          coilGauge
        );
        const producedPpm = ppmValueFromWorkbookLookup(producedLookup);
        if (producedPpm == null || producedPpm <= 0) {
          missingListPriceLabels.push(`${jobLabel} (${coilGauge})`);
          continue;
        }

        // Floor-to-floor when both workbook floors exist; else customer blended ₦/m vs coil floor/list.
        let creditPpm;
        let quotedPricePerMeterNgn;
        if (quotedFloorPpm != null && quotedFloorPpm > 0 && producedPpm > 0) {
          creditPpm = Math.max(0, quotedFloorPpm - producedPpm);
          quotedPricePerMeterNgn = Math.round(quotedFloorPpm);
        } else if (pricePerMeter) {
          creditPpm = Math.max(0, pricePerMeter - producedPpm);
          quotedPricePerMeterNgn = Math.round(pricePerMeter);
        } else {
          continue;
        }

        if (creditPpm <= 0) {
          noPositiveDelta = true;
          continue;
        }

        const credit = roundMoney(creditPpm * m);
        totalCredit += credit;
        substitutionPerMeterBreakdown.push({
          jobId: j.job_id,
          productName: String(j.product_name || '').trim(),
          meters: m,
          quotedPricePerMeterNgn,
          producedListPricePerMeterNgn: producedPpm,
          quotedGaugeDesignLabel:
            quotedGd != null ? `${quotedGd.gauge} / ${quotedGd.design}` : null,
          quotedListPricePerMeterNgn: quotedListPpm != null && quotedListPpm > 0 ? quotedListPpm : null,
          quotedFloorPricePerMeterNgn:
            quotedFloorPpm != null && quotedFloorPpm > 0 ? Math.round(quotedFloorPpm) : null,
          deltaPerMeterNgn: Math.round(creditPpm),
          creditNgn: credit,
          quotedGaugeForComparison: quotedGaugeRaw,
          coilGaugeFromAllocations: coilGauge,
          creditBasis:
            quotedFloorPpm != null && quotedFloorPpm > 0 ? 'floor_to_floor' : 'blended_to_coil_floor',
        });
      }
    }

    if (anyGaugeVsCoilCase || missingCoilGaugeLabels.length > 0) {
      const fmtN = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;
      const hasFloorToFloor = substitutionPerMeterBreakdown.some((b) => b.creditBasis === 'floor_to_floor');
      const canPrice =
        Boolean(pricePerMeter) || (quotedFloorPpm != null && quotedFloorPpm > 0);
      let label;
      if (substitutionPerMeterBreakdown.length > 0) {
        const parts = substitutionPerMeterBreakdown.map(
          (b) =>
            `${b.meters.toFixed(2)}m × ${fmtN(b.deltaPerMeterNgn)}/m (quote ${b.quotedGaugeForComparison || 'gauge'} vs coil ${b.coilGaugeFromAllocations || '—'}; ${String(b.productName || 'job').trim()})`
        );
        const fromRate = hasFloorToFloor
          ? `${fmtN(quotedFloorPpm)}/m quoted workbook floor`
          : `${fmtN(pricePerMeter)}/m blended quote`;
        label = `Substitution credit (quoted ${quotedGaugeRaw} vs thinner coil; ${fromRate} minus workbook floor coil rate × metres): ${parts.join('; ')}`;
      } else if (!canPrice) {
        label =
          'Gauge on quotation differs from allocated coil gauge — add product lines with qty and unitPrice to derive quoted ₦/m, or enter credit manually';
      } else if (missingCoilGaugeLabels.length > 0) {
        label = `Quoted gauge ${quotedGaugeRaw} vs coil: missing coil gauge on job(s) — allocate coils with gauge, or enter credit manually`;
      } else {
        label =
          'Quoted gauge vs coil: no automatic credit (add workbook row for coil gauge + design, set substitutePricePerMeterNgn, or enter amount manually)';
      }
      suggestedLines.push({
        label,
        amountNgn: totalCredit,
        category: 'Substitution Difference',
      });
      if (!canPrice) {
        warnings.push(
          'Substitution: cannot compute per-metre delta without a quotation blended ₦/m (product lines with qty and unitPrice) or quoted workbook floor, or pass pricePerMeterNgn in preview.'
        );
      } else if (missingCoilGaugeLabels.length > 0 && !overrideSubPpm) {
        const uniq = [...new Set(missingCoilGaugeLabels)];
        warnings.push(
          `Substitution: no coil gauge on allocations for: ${uniq.join(', ')}. Link production coils so workbook lookup can use the actual roll gauge.`
        );
      } else if (missingListPriceLabels.length > 0 && !overrideSubPpm) {
        const uniq = [...new Set(missingListPriceLabels)];
        warnings.push(
          `Substitution: could not resolve workbook ₦/m for coil on: ${uniq.join(', ')}. Add material_pricing_sheet_rows (minimum ₦/m) for the branch and coil gauge, or price_list_items where gauge_key matches the coil gauge and design_key matches quotation/FG/coil colour (or pass substitutePricePerMeterNgn when calling preview).`
        );
      }
      if (noPositiveDelta && substitutionPerMeterBreakdown.length === 0 && canPrice && !missingListPriceLabels.length) {
        warnings.push(
          'Substitution: workbook floor or list rate for the coil is not below the quoted floor/blended ₦/m — per-metre delta credit is zero.'
        );
      }
    }
  }

  if (existingRefunds.length > 0) {
    const totalExisting = existingRefunds.reduce((sum, r) => sum + r.amount_ngn, 0);
    warnings.push(`There are ${existingRefunds.length} existing refund(s) for this quotation totaling ₦${totalExisting.toLocaleString()}.`);
  }

  const manualAdj = roundMoney(payload.manualAdjustmentNgn);
  if (manualAdj > 0) {
    suggestedLines.push({
      label: 'Manual adjustment',
      amountNgn: manualAdj,
      category: 'Other',
    });
  }

  let remainingRefundableNgn = null;
  let refundHardCapNgn = null;
  if (quotationRef) {
    const el = quotationMeetsRefundEligibility(db, quotationRef);
    if (el.ok) {
      refundHardCapNgn = quotationRefundHardCapNgn({
        cashInNgn: cashInNgn,
        totalRefundedNgn: el.totalRefundedNgn,
      });
      remainingRefundableNgn = quotationRemainingRefundableNgn({
        cashInNgn: cashInNgn,
        quoteTotalNgn,
        totalRefundedNgn: el.totalRefundedNgn,
        suggestedLines,
      });
    }
  }

  if (
    quotationRef &&
    overpaymentExcessNgn > 0 &&
    quoteTotalNgn > 0 &&
    !hasCancelledProductionJob
  ) {
    if (overpaymentResidualNgn <= 0) {
      warnings.push(
        `Original overpayment was ₦${overpaymentExcessNgn.toLocaleString('en-NG')}, but it is already fully covered by prior refunds on this quotation (residual ₦0). Do not create another Overpayment refund.`
      );
    } else {
      warnings.push(
        `Overpayment (₦${overpaymentResidualNgn.toLocaleString('en-NG')} still refundable of ₦${overpaymentExcessNgn.toLocaleString('en-NG')} cash above quote). Other refund categories are separate reasons with their own calculated amounts; combined total cannot exceed cash received on this quotation (₦${(refundHardCapNgn ?? cashInNgn).toLocaleString('en-NG')} after prior refunds).`
      );
    }
  }

  const cappedSuggestedLines = suggestedLines;
  const categorySuggestedMaxNgn = buildRefundCategorySuggestedMaxNgn(cappedSuggestedLines);

  const suggestedAmountNgn = cappedSuggestedLines.reduce(
    (sum, line) => sum + roundMoney(line.amountNgn),
    0
  );

  const suggestedPositiveCategories = new Set(
    suggestedLines
      .filter((l) => roundMoney(l.amountNgn) > 0)
      .map((l) => String(l.category || '').trim())
      .filter(Boolean)
  );
  const suggestedAnyCategories = new Set(
    suggestedLines.map((l) => String(l.category || '').trim()).filter(Boolean)
  );

  const hasTransportServiceLine = quoteLines.some((s) => {
    const nl = serviceNameLower(s);
    if (matchesCorrugationService(nl)) return false;
    if (!matchesTransportService(nl)) return false;
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    return roundMoney(qty * unitPrice) > 0;
  });
  const hasInstallationServiceLine = quoteLines.some((s) => {
    const nl = serviceNameLower(s);
    if (matchesCorrugationService(nl)) return false;
    if (!matchesInstallationService(nl)) return false;
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    return roundMoney(qty * unitPrice) > 0;
  });
  const hasAnyServiceLine = quoteLines.some((s) => {
    const nl = serviceNameLower(s);
    if (matchesCorrugationService(nl)) return false;
    const { qty, unitPrice } = serviceQtyAndUnitPriceNgn(s);
    return roundMoney(qty * unitPrice) > 0;
  });

  const eligibleRefundCategories = [];
  for (const cat of REFUND_REASON_CATEGORY_VALUES) {
    if (hardBlockedCategories.has(cat)) continue;
    if (blockedRefundCategories.includes(cat)) continue;
    if (cat === 'Order cancellation') {
      if (hasCancelledProductionJob) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Unproduced meterage') {
      if (suggestedPositiveCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Overpayment') {
      if (
        suggestedPositiveCategories.has(cat) ||
        (overpaymentExcessNgn > 0)
      ) {
        eligibleRefundCategories.push(cat);
      }
      continue;
    }
    if (cat === 'Transport issue') {
      if (suggestedPositiveCategories.has(cat) || hasTransportServiceLine) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Installation issue') {
      if (suggestedPositiveCategories.has(cat) || hasInstallationServiceLine) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Additional services') {
      if (suggestedPositiveCategories.has(cat) || hasAnyServiceLine) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Accessory shortfall') {
      if (suggestedPositiveCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Stone flatsheet shortfall') {
      if (suggestedPositiveCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Calculation error') {
      if (suggestedPositiveCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Substitution Difference') {
      if (suggestedAnyCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Customer commission') {
      if (suggestedPositiveCategories.has(cat)) eligibleRefundCategories.push(cat);
      continue;
    }
    if (cat === 'Other') {
      if (remainingRefundableNgn != null && remainingRefundableNgn > 0) eligibleRefundCategories.push(cat);
    }
  }

  let substitutionDiagnosis = null;
  if (Boolean(payload.substitutionDiagnosis) && quotationRef && quote) {
    let cuttingLists = [];
    try {
      cuttingLists = db
        .prepare(`SELECT * FROM cutting_lists WHERE quotation_ref = ? ORDER BY date_iso DESC`)
        .all(quotationRef);
    } catch {
      cuttingLists = [];
    }
    const lj = String(quote.lines_json || '');
    substitutionDiagnosis = {
      quotationId: quotationRef,
      customerId: quote.customer_id,
      customerName: quote.customer_name,
      quotationStatus: quote.status,
      paymentStatus: quote.payment_status,
      totalNgn: quote.total_ngn,
      paidNgn: quote.paid_ngn,
      branchId: quote.branch_id,
      linesJsonChars: lj.length,
      linesJsonPreview: lj.length > 6000 ? `${lj.slice(0, 6000)}…` : lj,
      materialDelivered,
      blockedRefundCategoriesSnapshot: [...blockedRefundCategories],
      substitutionCategoryAlreadyInRefund: hardBlockedCategories.has('Substitution Difference'),
      receipts: (() => {
        const ledgerRows = db.prepare(`SELECT * FROM ledger_entries WHERE quotation_ref = ?`).all(quotationRef);
        const companion = companionOverpayNgnByReceiptId(
          ledgerRows.map((row) => ({
            id: row.id,
            type: row.type,
            amountNgn: row.amount_ngn,
            bankReference: row.bank_reference,
            note: row.note,
          }))
        );
        return receipts.map((r) => {
          const rid = String(r.id || '');
          const lid = r.ledger_entry_id != null ? String(r.ledger_entry_id) : '';
          const extra = companion.get(rid) || (lid ? companion.get(lid) : 0) || 0;
          return {
            id: r.id,
            amountNgn: receiptEffectiveCashNgn(
              {
                amountNgn: r.amount_ngn,
                financeReconciliationSavedAtISO: r.finance_reconciliation_saved_at_iso,
                bankReceivedAmountNgn: r.bank_received_amount_ngn,
              },
              { companionOverpayNgn: extra }
            ),
            status: r.status,
            dateIso: r.date_iso,
          };
        });
      })(),
      cuttingLists,
      refunds: existingRefunds.map((r) => ({
        refundId: r.refund_id,
        status: r.status,
        amountNgn: r.amount_ngn,
        reasonCategory: r.reason_category,
      })),
      terminalProductionJobCount: productionJobs.length,
      previewPricePerMeterUsed: pricePerMeter != null ? Math.round(pricePerMeter) : null,
      blendedRoofingSheetPpmOnly: (() => {
        const x = quotedRoofingSheetAmountPerMeter(quote?.lines_json);
        return x != null ? Math.round(x) : null;
      })(),
      blendedAllProductLinesPpm: (() => {
        const x = quotedAmountPerMeter(quote?.lines_json);
        return x != null ? Math.round(x) : null;
      })(),
      substitution: buildSubstitutionJobDiagnosis(
        db,
        quote,
        productionJobs,
        pricePerMeter,
        positiveNumber(payload.substitutePricePerMeterNgn),
        pricingAsAtIso
      ),
      substitutionPerMeterBreakdown,
      suggestedLinesSubstitution: suggestedLines.filter((l) => l.category === 'Substitution Difference'),
      warningsSubstitutionRelated: warnings.filter(
        (w) => /substitution/i.test(w) || /gauge/i.test(w) || /list ₦\/m/i.test(w)
      ),
      dataQualityIssues: dedupeRefundDataQualityIssues([
        ...refundSubstitutionDataQualityIssues(db, quotationRef),
        ...refundPaymentIntegrityIssues(db, quotationRef),
        ...refundCuttingListQuotationMetreIssues(db, quotationRef),
        ...refundProductionAlignmentWarnings(db, quotationRef, payload.reasonCategory, {
          excludeRefundId: String(payload.excludeRefundId ?? payload.refundId ?? '').trim() || null,
        }),
      ]),
    };
  }

  const productionSuggestedCategories = suggestRefundCategoriesFromProduction(db, quotationRef);
  const alignmentIssues = enrichProductionAlignmentIssuesForSubmit(
    refundProductionAlignmentWarnings(db, quotationRef, payload.reasonCategory, {
      excludeRefundId: String(payload.excludeRefundId ?? payload.refundId ?? '').trim() || null,
    })
  );
  for (const issue of alignmentIssues) {
    if (issue.message && !warnings.includes(issue.message)) {
      warnings.push(issue.message);
    }
  }

  let economicFloor = null;
  if (quotationRef && quote) {
    const excludeRefundId = String(payload.excludeRefundId ?? payload.refundId ?? '').trim() || null;
    const priorRefundedNgn = quotationActiveRefundedTotalNgn(db, quotationRef, excludeRefundId);
    economicFloor = buildRefundEconomicFloorSummary(db, quote, productionJobs, {
      cashInNgn,
      priorRefundedNgn,
      pricingAsAtIso,
      substitutePricePerMeterNgn: positiveNumber(payload.substitutePricePerMeterNgn),
    });
    if (economicFloor.incompleteFloorPricing) {
      warnings.push(
        'Economic floor check: workbook floor ₦/m could not be resolved for all produced jobs — production-related refunds need MD/admin override or workbook pricing. Overpayment-only refunds are not blocked by this check.'
      );
    }
    if (economicFloor.honouredMdPriceException) {
      warnings.push(
        'Economic floor uses MD-approved quoted selling ₦/m (below workbook minimum) — refund headroom matches the approved deal price.'
      );
    }
    if (economicFloor.usedPriceListFallback) {
      warnings.push(
        'Economic floor check: some rates from published list (workbook floor missing).'
      );
    }
    const suggestedForFloor = suggestedLines.map((l) => ({ ...l, include: true }));
    if (
      refundAmountExceedsEconomicFloorCap({
        amountNgn: suggestedAmountNgn,
        calculationLines: suggestedForFloor,
        categories: suggestedLines.filter((l) => roundMoney(l.amountNgn) > 0).map((l) => l.category),
        maxDefensibleRefundNgn: economicFloor.maxDefensibleRefundNgn,
        overpaymentExcessNgn: overpaymentExcessNgn,
        toleranceNgn: REFUND_AMOUNT_LINE_TOLERANCE_NGN,
      })
    ) {
      const gatedSuggested = refundFloorGatedAmountNgn(suggestedForFloor);
      warnings.push(
        `Production-related refund preview ₦${gatedSuggested.toLocaleString('en-NG')} exceeds the economic floor cap ₦${Number(economicFloor.maxDefensibleRefundNgn).toLocaleString('en-NG')} (cash in minus floor value of ${economicFloor.producedOutputMeters.toFixed(2)} m produced at workbook minimum ₦/m, after prior refunds). Overpayment and quoted services are not counted against this cap.${
          economicFloor.honouredMdPriceException
            ? ''
            : ' If MD already approved below-floor pricing on this quote, confirm the MD price exception is on file; otherwise MD/admin may override at create with a note.'
        }`
      );
    }
  }

  let derivedCategoryMaxNgn = {};
  if (quotationRef && quote && economicFloor) {
    const excludeRefundId = String(payload.excludeRefundId ?? payload.refundId ?? '').trim() || null;
    derivedCategoryMaxNgn = buildDerivedRefundCategoryCapsNgn({
      cashInNgn,
      totalRefundedNgn: quotationActiveRefundedTotalNgn(db, quotationRef, excludeRefundId),
      economicFloor,
    });
  }
  const effectiveCategorySuggestedMaxNgn = mergeRefundCategoryCapsNgn(
    categorySuggestedMaxNgn,
    derivedCategoryMaxNgn
  );

  let finalSuggestedLines = [...cappedSuggestedLines];
  const orderCancelDerivedCap = roundMoney(effectiveCategorySuggestedMaxNgn['Order cancellation'] || 0);
  if (
    hasCancelledProductionJob &&
    !hardBlockedCategories.has('Order cancellation') &&
    orderCancelDerivedCap > 0
  ) {
    // Cancelled jobs: Order cancellation is the whole-job cash path. Do not also auto-suggest
    // overpayment / unproduced / quoted services — that double-counts the same paid headroom.
    const orderCancelExcludes = new Set([
      'Overpayment',
      'Unproduced meterage',
      'Transport issue',
      'Installation issue',
      'Additional services',
      'Accessory shortfall',
      'Stone flatsheet shortfall',
      'Substitution Difference',
    ]);
    const removed = finalSuggestedLines.filter((l) =>
      orderCancelExcludes.has(String(l.category || '').trim())
    );
    finalSuggestedLines = finalSuggestedLines.filter(
      (l) => !orderCancelExcludes.has(String(l.category || '').trim())
    );
    const cancelIdx = finalSuggestedLines.findIndex(
      (l) => String(l.category || '').trim() === 'Order cancellation'
    );
    if (cancelIdx >= 0) {
      // Full cash path after stripping overpayment/itemized lines.
      finalSuggestedLines[cancelIdx] = {
        ...finalSuggestedLines[cancelIdx],
        label: 'Order cancellation (capped after economic floor)',
        amountNgn: orderCancelDerivedCap,
        category: 'Order cancellation',
      };
    } else {
      finalSuggestedLines.push({
        label: 'Order cancellation (capped after economic floor)',
        amountNgn: orderCancelDerivedCap,
        category: 'Order cancellation',
      });
    }
    if (removed.some((l) => roundMoney(l.amountNgn) > 0) || overpaymentResidualNgn > 0) {
      warnings.push(
        'Cancelled production on this quotation: preview uses Order cancellation only (full refundable cash, including any overpayment above quote). Overpayment and itemized unproduced/transport/installation/service lines were omitted to avoid double-counting — add them manually only if you are not claiming full cancellation.'
      );
    }
  }
  const finalSuggestedAmountNgn = finalSuggestedLines.reduce(
    (sum, line) => sum + roundMoney(line.amountNgn),
    0
  );

  const openProductionJobRow = quotationRef ? quotationHasOpenProductionJob(db, quotationRef) : null;
  const refundEligibility =
    quotationRef && quote ? quotationMeetsRefundEligibility(db, quotationRef, quote) : { ok: false };
  if (openProductionJobRow) {
    const openMsg = `Finish or cancel production job ${openProductionJobRow.job_id} (${openProductionJobRow.st}) before submitting a refund.`;
    if (!warnings.some((w) => String(w).includes(openProductionJobRow.job_id))) {
      warnings.unshift(openMsg);
    }
  }

  return {
    ok: true,
    preview: {
      customerID,
      customerName: quote?.customer_name ?? '',
      quotationRef,
      quoteTotalNgn,
      paidOnQuoteNgn,
      overpayAdvanceNgn: cashBreakdown?.netOverpayLedgerNgn ?? overpayAdvanceNgn,
      quotationCashInNgn: cashInNgn,
      receiptCashNgn,
      overpaymentExcessNgn,
      overpaymentResidualNgn,
      overpaymentAlreadyRefundedNgn: overpayAlreadyRefundedNgn,
      remainingRefundableNgn,
      refundHardCapNgn,
      quotedMeters,
      actualMeters,
      coilProducedMeters,
      producedMetersForUnproduced,
      stoneMeterQuote: stoneMeterQuoteForUnproduced,
      productionFulfillment,
      pricePerMeterNgn: pricePerMeter ? Math.round(pricePerMeter) : null,
      pricingAsAtIso,
      substitutePricePerMeterNgn: positiveNumber(payload.substitutePricePerMeterNgn),
      substitutionPerMeterBreakdown,
      suggestedAmountNgn: finalSuggestedAmountNgn,
      suggestedLines: finalSuggestedLines,
      categorySuggestedMaxNgn: effectiveCategorySuggestedMaxNgn,
      derivedCategoryMaxNgn,
      warnings,
      alreadyRefundedCategories: Array.from(refundedCategories),
      paidRefundsOnQuotationNgn,
      priorRefundsOnQuotationNgn,
      priorRefundsOnQuotation,
      blockedRefundCategories,
      eligibleRefundCategories,
      productionSuggestedCategories,
      productionAlignmentIssues: alignmentIssues,
      economicFloor,
      hasCancelledProductionJob,
      openProductionJob: openProductionJobRow
        ? { jobId: openProductionJobRow.job_id, status: openProductionJobRow.st }
        : null,
      refundEligibilityOk: Boolean(refundEligibility.ok),
      refundEligibilityError: refundEligibility.ok
        ? null
        : String(refundEligibility.error || '').trim() || null,
      ...(substitutionDiagnosis ? { substitutionDiagnosis } : {}),
    },
  };
}

function parseRefundReasonCategoryList(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* stored as plain text */
  }
  const s = String(raw).trim();
  return s ? [s] : [];
}

function refundReasonCategoriesIncludeOrderCancellation(reasonCategoryField) {
  return parseRefundReasonCategoryList(reasonCategoryField).some(
    (c) => String(c).trim().toLowerCase() === 'order cancellation'
  );
}

/**
 * Any refund that still counts toward quotation rules (not rejected / not cancel-before-pay)
 * whose categories include “Order cancellation”. Production must not proceed while this is on file.
 */
export function quotationHasNonRejectedOrderCancellationRefund(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return false;
  const rows = db
    .prepare(
      `SELECT reason_category FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
    )
    .all(ref);
  return rows.some((r) => refundReasonCategoriesIncludeOrderCancellation(r.reason_category));
}

/** True when any production row for the quote is not in a terminal state (Completed / Cancelled). */
function quotationHasOpenProductionJob(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return null;
  return db
    .prepare(
      `SELECT job_id,
              CASE WHEN TRIM(COALESCE(status, '')) = '' THEN 'Planned' ELSE TRIM(status) END AS st
       FROM production_jobs
       WHERE quotation_ref = ?
         AND LOWER(
           CASE WHEN TRIM(COALESCE(status, '')) = '' THEN 'planned' ELSE TRIM(LOWER(status)) END
         ) NOT IN ('completed', 'cancelled')
       LIMIT 1`
    )
    .get(ref);
}

/**
 * Total cash received on this quotation only: booked paid on the quote plus any split-till
 * overpayment credit still parked on this quote (not other jobs or unrelated customer balance).
 */
export function quotationCashInNgn(db, quotationRef) {
  return quotationPaymentCashBreakdown(db, quotationRef).cashInNgn;
}

/**
 * Single-quotation checks aligned with {@link getEligibleRefundQuotations} listing rules, plus
 * remaining headroom from cash on this quote minus quote total (when overpaid) or cash minus refunds.
 */
export function quotationMeetsRefundEligibility(db, quotationRef, existingRow = null) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return { ok: false, error: 'Quotation reference is required.' };
  const q =
    existingRow ??
    db
      .prepare(
        `SELECT id, paid_ngn, total_ngn, status,
                bm_price_exception_approved_at_iso, price_exception_md_review_required,
                price_exception_md_confirmed_at_iso, md_price_exception_approved_at_iso,
                refunds_blocked_at_iso, refunds_blocked_reason
         FROM quotations WHERE id = ?`
      )
      .get(ref);
  if (!q) return { ok: false, error: 'Quotation not found.' };
  if (quotationRefundsBlocked(q)) {
    const why = String(q.refunds_blocked_reason ?? '').trim();
    return {
      ok: false,
      error: why
        ? `Refunds are permanently blocked on this quotation: ${why}`
        : 'Refunds are permanently blocked on this quotation.',
      refundsBlocked: true,
    };
  }
  const paidNgn = roundMoney(q.paid_ngn);
  const cashInNgn = quotationCashInNgn(db, ref);
  const quoteTotalNgn = roundMoney(q.total_ngn);
  if (cashInNgn <= 0 && paidNgn <= 0) {
    return { ok: false, error: 'This quotation has no recorded payment toward a refund.' };
  }
  const totalRefundedNgn = quotationActiveRefundedTotalNgn(db, ref);
  const remainingNgn = quotationRefundHardCapNgn({
    cashInNgn,
    totalRefundedNgn,
  });
  if (remainingNgn <= 0) {
    return {
      ok: false,
      error: 'Refundable balance on this quotation is fully covered by existing refund requests.',
    };
  }
  const isVoid = String(q.status || '').trim().toLowerCase() === 'void';
  const openJob = quotationHasOpenProductionJob(db, ref);
  if (openJob) {
    return {
      ok: false,
      error: `Finish or cancel production job ${openJob.job_id} (${openJob.st}) before requesting a refund.`,
    };
  }
  const hadClosedProduction = db
    .prepare(
      `SELECT 1 FROM production_jobs
       WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')
       LIMIT 1`
    )
    .get(ref);
  if (!hadClosedProduction && !isVoid) {
    return {
      ok: false,
      error:
        'Refund requests are only allowed after production is completed or cancelled, or for a paid void quotation.',
    };
  }
  const priceEx = {
    bmPriceExceptionApprovedAtISO: q.bm_price_exception_approved_at_iso,
    priceExceptionMdReviewRequired: q.price_exception_md_review_required,
    priceExceptionMdConfirmedAtISO: q.price_exception_md_confirmed_at_iso,
    mdPriceExceptionApprovedAtISO: q.md_price_exception_approved_at_iso,
  };
  if (quotationRefundBlockedPendingMdPriceConfirm(priceEx)) {
    return {
      ok: false,
      mdReviewPending: true,
      mdReviewError:
        'This quotation is below the material pricing workbook floor. The Managing Director or an administrator must approve the below-floor price exception before a cutting list, production, or customer refund can proceed.',
    };
  }
  return {
    ok: true,
    paidNgn,
    cashInNgn,
    quoteTotalNgn,
    totalRefundedNgn,
    remainingNgn,
    overpaymentExcessNgn: quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn }),
  };
}

/**
 * Maximum “customer commission” refund: (recommended − quoted) × metres per line, capped so the implied
 * effective selling ₦/m after refund would not fall below {@link pricingPolicyNumbersForServiceLine} minAllowed.
 */
export function maxCustomerCommissionRefundNgn(db, quotationRef, pricingAsAtIsoOverride) {
  const ref = String(quotationRef ?? '').trim();
  const warnings = [];
  if (!ref) return { maxNgn: 0, warnings };
  const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(ref);
  if (!quote?.lines_json) return { maxNgn: 0, warnings };
  const el = quotationMeetsRefundEligibility(db, ref);
  if (!el.ok) return { maxNgn: 0, warnings };
  const branchId = quote.branch_id != null ? String(quote.branch_id).trim() || null : null;
  const pricingAsAtIso =
    pricingAsAtIsoOverride != null && String(pricingAsAtIsoOverride).trim()
      ? String(pricingAsAtIsoOverride).trim().slice(0, 10)
      : quotationPricingAsAtIso(quote);
  const headerCtx = { asAtIso: pricingAsAtIso };
  let linesParsed;
  try {
    linesParsed = typeof quote.lines_json === 'string' ? JSON.parse(quote.lines_json) : quote.lines_json;
  } catch {
    return { maxNgn: 0, warnings };
  }
  const lines = [...(linesParsed?.products || []), ...(linesParsed?.services || [])];
  let totalConcession = 0;
  for (const line of lines) {
    const rec = Number(line?.recommendedPricePerMeter);
    const up = Number(line?.unitPrice ?? line?.unitPriceNgn ?? line?.pricePerMeter ?? 0);
    const m = Number(line?.qty ?? line?.meters ?? line?.qtyMeters ?? 0);
    if (!Number.isFinite(rec) || rec <= 0 || !Number.isFinite(up) || !Number.isFinite(m) || m <= 0) continue;
    if (up >= rec - 0.001) continue;
    const rawConcession = roundMoney((rec - up) * m);
    const nums = pricingPolicyNumbersForServiceLine(db, line, branchId, headerCtx);
    const minAllowed = nums.minAllowed;
    let capped = rawConcession;
    if (minAllowed != null && Number.isFinite(minAllowed)) {
      if (up <= minAllowed + 0.001) {
        capped = 0;
      } else {
        const maxByFloor = roundMoney(Math.max(0, (up - minAllowed) * m));
        if (maxByFloor + 0.01 < rawConcession) {
          capped = maxByFloor;
          warnings.push(
            `Customer commission capped: refund cannot imply an effective price below the minimum allowed ₦/m (≈₦${Math.round(minAllowed).toLocaleString('en-NG')}/m) for a quoted line.`
          );
        }
      }
    }
    totalConcession += capped;
  }
  totalConcession = roundMoney(totalConcession);
  const amountNgn = roundMoney(Math.min(totalConcession, Math.max(0, el.remainingNgn)));
  return { maxNgn: amountNgn, warnings };
}

const UNPRODUCED_LIST_METRES_FLOOR = 0.02;

function parseRefundReasonCategoriesLocal(reasonCategory) {
  try {
    const cats = JSON.parse(reasonCategory || '[]');
    if (Array.isArray(cats)) {
      return cats.map((c) => String(c || '').trim()).filter(Boolean);
    }
  } catch {
    /* plain string */
  }
  const s = String(reasonCategory || '').trim();
  return s ? [s] : [];
}

/**
 * Categories that preview would hard-block for a new request (paid/open non–qty-netted claims).
 * @param {Array<object>} refunds
 */
function hardBlockedRefundCategoriesFromPrior(refunds) {
  const refundedCategories = new Set();
  const openRefundedCategories = new Set();
  for (const r of Array.isArray(refunds) ? refunds : []) {
    const status = String(r.status || '')
      .trim()
      .toLowerCase();
    if (status === 'rejected' || status === 'cancelled') continue;
    const isOpen = status === 'pending' || status === 'approved';
    for (const c of parseRefundReasonCategoriesLocal(r.reason_category ?? r.reasonCategory)) {
      refundedCategories.add(c);
      if (isOpen) openRefundedCategories.add(c);
    }
  }
  const hardBlocked = new Set();
  for (const cat of refundedCategories) {
    if (QUANTITY_NETTED_REFUND_CATEGORIES.has(cat)) {
      if (openRefundedCategories.has(cat)) hardBlocked.add(cat);
    } else {
      hardBlocked.add(cat);
    }
  }
  return hardBlocked;
}

/** Batch prior active refunds for pick-list residual / category blocks. */
function activeRefundRowsByQuotationRef(db, quoteIds) {
  const map = new Map();
  const ids = (Array.isArray(quoteIds) ? quoteIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT quotation_ref, refund_id, reason_category, amount_ngn, paid_amount_ngn,
              credit_applied_ngn, calculation_lines_json, status
       FROM customer_refunds
       WHERE quotation_ref IN (${placeholders})
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
    )
    .all(...ids);
  for (const r of rows) {
    const qid = String(r.quotation_ref || '').trim();
    if (!map.has(qid)) map.set(qid, []);
    map.get(qid).push(r);
  }
  return map;
}

/** Quotations with completed / posted delivery — order cancellation & unproduced are blocked. */
function deliveredQuotationIdSet(db, quoteIds) {
  const out = new Set();
  const ids = (Array.isArray(quoteIds) ? quoteIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT quotation_ref AS id FROM deliveries
         WHERE quotation_ref IN (${placeholders})
           AND (
             TRIM(COALESCE(delivered_date_iso, '')) != ''
             OR LOWER(TRIM(COALESCE(status, ''))) IN ('delivered', 'completed')
             OR COALESCE(fulfillment_posted, 0) = 1
           )`
      )
      .all(...ids);
    for (const r of rows) {
      const id = String(r.id || '').trim();
      if (id) out.add(id);
    }
  } catch {
    /* deliveries table optional in some test stubs */
  }
  return out;
}

/**
 * Cheap pick-list hint — never runs {@link previewRefundRequest}. Selecting a row still loads the full preview.
 * Honours overpayment residual, already-claimed categories, and delivered-material blocks so paid /
 * exhausted quotes do not linger in the Sales refund search list.
 * @returns {{ categories: string[], suggestedPreviewAmountNgn: number } | null}
 */
function refundPickerListHint(db, row, jobs, {
  overpayExcess,
  remainingNgn,
  cashInNgn = null,
  quoteTotalNgn = null,
  priorRefunds = [],
  materialDelivered = false,
}) {
  const remaining = roundMoney(remainingNgn);
  if (remaining < MIN_REFUND_QUOTATION_REMAINING_NGN) return null;

  const hardBlocked = hardBlockedRefundCategoriesFromPrior(priorRefunds);
  if (materialDelivered) {
    hardBlocked.add('Order cancellation');
    hardBlocked.add('Unproduced meterage');
  }

  const quoteTotal = roundMoney(quoteTotalNgn != null ? quoteTotalNgn : row.total_ngn);
  const cashIn =
    cashInNgn != null && Number.isFinite(Number(cashInNgn))
      ? roundMoney(cashInNgn)
      : roundMoney(overpayExcess) + quoteTotal;
  const overpayResidual = quotationOverpaymentResidualNgn({
    cashInNgn: cashIn,
    quoteTotalNgn: quoteTotal,
    overpaymentAlreadyRefundedNgn: overpaymentAlreadyRefundedNgn(priorRefunds),
  });
  // Prefer residual overpay when still available (works after other-category refunds too).
  if (overpayResidual >= MIN_REFUND_QUOTATION_REMAINING_NGN && !hardBlocked.has('Overpayment')) {
    return {
      categories: ['Overpayment'],
      suggestedPreviewAmountNgn: Math.min(overpayResidual, remaining),
    };
  }

  const isVoid = String(row.status || '').trim().toLowerCase() === 'void';
  const closedJobs = Array.isArray(jobs) ? jobs : [];
  const hasCancelledJob = closedJobs.some(
    (j) => String(j.status || '').trim().toLowerCase() === 'cancelled'
  );
  if ((isVoid || hasCancelledJob) && !hardBlocked.has('Order cancellation')) {
    return {
      categories: ['Order cancellation'],
      suggestedPreviewAmountNgn: remaining,
    };
  }
  // Cancelled / void quotes with Order cancellation already claimed have no other cheap claim.
  if (isVoid || hasCancelledJob) return null;

  let linesPayload = {};
  try {
    linesPayload = JSON.parse(String(row.lines_json || '{}'));
  } catch {
    linesPayload = {};
  }
  let stoneMeterQuote = false;
  try {
    stoneMeterQuote = isStoneMeterQuotationLinesJson(db, linesPayload);
  } catch {
    stoneMeterQuote = false;
  }
  const fulfillment = buildRefundProductionFulfillmentSummary(db, row, closedJobs, {
    isStoneMeterQuote: stoneMeterQuote,
  });
  if (
    fulfillment.unproducedMetres > UNPRODUCED_LIST_METRES_FLOOR &&
    !fulfillment.fullyProducedRoofing &&
    !hardBlocked.has('Unproduced meterage')
  ) {
    return {
      categories: ['Unproduced meterage'],
      suggestedPreviewAmountNgn: remaining,
    };
  }
  return null;
}

function closedProductionJobsByQuotationRef(db, quoteIds) {
  const map = new Map();
  const ids = (Array.isArray(quoteIds) ? quoteIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM production_jobs
       WHERE quotation_ref IN (${placeholders})
         AND LOWER(TRIM(COALESCE(status, ''))) IN ('completed', 'cancelled')`
    )
    .all(...ids);
  for (const job of rows) {
    const qid = String(job.quotation_ref || '').trim();
    if (!qid) continue;
    if (!map.has(qid)) map.set(qid, []);
    map.get(qid).push(job);
  }
  return map;
}

/**
 * Returns quotations with money at risk (paid in), room left to refund, and production closed out:
 * at least one job in `Completed` or `Cancelled`, or a paid `Void` quotation (sales-side cancellation).
 * Order must be effectively fully paid when total is set ({@link isEffectivelyFullyPaid}).
 * The pick list never runs {@link previewRefundRequest}. Obvious overpayments (residual), void/cancelled jobs
 * (when Order cancellation is not already claimed), and unproduced metres are classified cheaply so finished
 * under-produced jobs stay visible. Quotes with only exhausted / delivered-blocked claims are omitted.
 * Rows include `cash_in_ngn`, `remaining_ngn`, and `suggested_preview_amount_ngn` for the picker UI.
 *
 * Listing path batches cash-in and closed production jobs for SQL candidates and never scans
 * an unbounded quotation table — candidate pool is hard-capped even when limits are omitted.
 * @param {{ candidateLimit?: number; resultLimit?: number }} [opts]
 */
export function getEligibleRefundQuotations(db, opts = {}) {
  const candidateLimit = Math.max(0, Math.min(250, Math.floor(Number(opts.candidateLimit) || 0)));
  const resultLimit = Math.max(0, Math.min(200, Math.floor(Number(opts.resultLimit) || 0)));
  // Always bound the candidate scan — unlimited used to walk every paid closed quote and was very slow.
  const effectiveCandidateLimit = candidateLimit > 0 ? candidateLimit : 250;
  const sql = `
    SELECT q.id, q.customer_id, q.customer_name, q.date_iso, q.total_ngn, q.paid_ngn, q.status,
           q.handled_by, q.branch_id, q.lines_json,
           q.bm_price_exception_approved_at_iso, q.price_exception_md_review_required,
           q.price_exception_md_confirmed_at_iso, q.md_price_exception_approved_at_iso,
           q.refunds_blocked_at_iso, q.refunds_blocked_reason,
      COALESCE((
        SELECT SUM(amount_ngn) FROM customer_refunds
        WHERE quotation_ref = q.id AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
      ), 0) AS total_refunded
    FROM quotations q
    WHERE q.paid_ngn > 0
      AND TRIM(COALESCE(q.refunds_blocked_at_iso, '')) = ''
      AND NOT EXISTS (
        SELECT 1 FROM production_jobs j2
        WHERE j2.quotation_ref = q.id
          AND LOWER(
            CASE WHEN TRIM(COALESCE(j2.status, '')) = '' THEN 'planned' ELSE TRIM(LOWER(j2.status)) END
          ) NOT IN ('completed', 'cancelled')
      )
      AND (
        EXISTS (
          SELECT 1 FROM production_jobs j
          WHERE j.quotation_ref = q.id
            AND LOWER(TRIM(COALESCE(j.status, ''))) IN ('completed', 'cancelled')
        )
        OR TRIM(COALESCE(q.status, '')) = 'Void'
      )
    ORDER BY q.date_iso DESC
    LIMIT ${effectiveCandidateLimit}
  `;
  const rows = db.prepare(sql).all();

  // Cheap SQL-row filters before any cash / preview work.
  const candidates = [];
  for (const row of rows) {
    if (quotationRefundsBlocked(row)) continue;
    const total = roundMoney(row.total_ngn);
    const paid = roundMoney(row.paid_ngn);
    if (total > 0 && !isEffectivelyFullyPaid(paid, total)) continue;
    if (
      quotationRefundBlockedPendingMdPriceConfirm({
        bmPriceExceptionApprovedAtISO: row.bm_price_exception_approved_at_iso,
        priceExceptionMdReviewRequired: row.price_exception_md_review_required,
        priceExceptionMdConfirmedAtISO: row.price_exception_md_confirmed_at_iso,
        mdPriceExceptionApprovedAtISO: row.md_price_exception_approved_at_iso,
      })
    ) {
      continue;
    }
    candidates.push(row);
  }

  const cashByRef = quotationPaymentCashBreakdownByRef(
    db,
    candidates.map((r) => r.id)
  );
  const jobsByRef = closedProductionJobsByQuotationRef(
    db,
    candidates.map((r) => r.id)
  );
  const priorRefundsByRef = activeRefundRowsByQuotationRef(
    db,
    candidates.map((r) => r.id)
  );
  const deliveredIds = deliveredQuotationIdSet(
    db,
    candidates.map((r) => r.id)
  );

  const out = [];
  for (const row of candidates) {
    const cash = cashByRef.get(row.id) || emptyQuotationPaymentCashBreakdown();
    const cashInNgn = roundMoney(cash.cashInNgn);
    const paidNgn = roundMoney(row.paid_ngn);
    if (cashInNgn <= 0 && paidNgn <= 0) continue;

    const totalRefundedNgn = roundMoney(row.total_refunded);
    const remainingNgn = quotationRefundHardCapNgn({ cashInNgn, totalRefundedNgn });
    if (remainingNgn < MIN_REFUND_QUOTATION_REMAINING_NGN) continue;

    const quoteTotalNgn = roundMoney(row.total_ngn);
    const overpayExcess = quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn });
    const hint = refundPickerListHint(db, row, jobsByRef.get(row.id) || [], {
      overpayExcess,
      remainingNgn,
      cashInNgn,
      quoteTotalNgn,
      priorRefunds: priorRefundsByRef.get(row.id) || [],
      materialDelivered: deliveredIds.has(String(row.id || '').trim()),
    });
    if (!hint) continue;
    const pickRow = {
      ...row,
      eligible_refund_categories: hint.categories,
      suggested_preview_amount_ngn: hint.suggestedPreviewAmountNgn,
      cash_in_ngn: cashInNgn,
      remaining_ngn: remainingNgn,
    };
    if (!quotationMeetsRefundPickerFloor(pickRow)) continue;
    out.push(pickRow);
    if (resultLimit > 0 && out.length >= resultLimit) break;
  }
  return out;
}

function positiveNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [preferred]
 * @param {string} [workspaceBranchId]
 */
function resolveTreasuryAccountBranchId(db, preferred, workspaceBranchId) {
  const wb = String(workspaceBranchId || '').trim();
  const raw = String(preferred || wb || '').trim();
  if (raw && raw !== 'ALL') {
    const br = getBranch(db, raw);
    if (br?.id) return br.id;
  }
  if (wb && wb !== 'ALL') {
    const br = getBranch(db, wb);
    if (br?.id) return br.id;
  }
  return DEFAULT_BRANCH_ID;
}

function actorMayAssignTreasuryBranch(actor) {
  const rk = String(actor?.roleKey || '').trim().toLowerCase();
  return rk === 'admin' || rk === 'md' || rk === 'ceo';
}

export function upsertTreasuryAccount(db, payload, actor) {
  const name = String(payload.name ?? '').trim();
  if (!name) return { ok: false, error: 'Account name is required.' };
  const balance = roundMoney(payload.balance);
  const hasOpeningKey = Object.prototype.hasOwnProperty.call(payload, 'openingBalanceNgn');
  let openingBalanceNgn;
  if (payload.id && !hasOpeningKey) {
    const ex = db
      .prepare(`SELECT opening_balance_ngn FROM treasury_accounts WHERE id = ?`)
      .get(Number(payload.id));
    openingBalanceNgn = roundMoney(ex?.opening_balance_ngn);
  } else {
    openingBalanceNgn = hasOpeningKey ? roundMoney(payload.openingBalanceNgn) : balance;
  }
  const accountOfficerName = String(payload.accountOfficerName ?? '').trim();
  const accountOfficerPhone = String(payload.accountOfficerPhone ?? '').trim();
  const bankBranch = String(payload.bankBranch ?? '').trim();
  const sortCodeOrSwift = String(payload.sortCodeOrSwift ?? '').trim();
  const notes = String(payload.notes ?? '').trim();
  let savedId = null;
  try {
    db.transaction(() => {
      const branchId = resolveTreasuryAccountBranchId(
        db,
        payload.branchId,
        payload.workspaceBranchId
      );
      const mayReassignBranch =
        actorMayAssignTreasuryBranch(actor) &&
        Object.prototype.hasOwnProperty.call(payload, 'branchId') &&
        String(payload.branchId ?? '').trim();
      if (payload.id) {
        const existing = db
          .prepare(`SELECT branch_id FROM treasury_accounts WHERE id = ?`)
          .get(Number(payload.id));
        if (!existing) throw new Error('Treasury account not found.');
        if (!mayReassignBranch) {
          const gate = assertEntityBranchForWorkspaceWrite(
            actor,
            existing.branch_id,
            payload.workspaceBranchId,
            Boolean(payload.workspaceViewAll)
          );
          if (!gate.ok) throw new Error(gate.error);
        }
        if (mayReassignBranch) {
          db.prepare(
            `UPDATE treasury_accounts
             SET name = ?, bank_name = ?, balance = ?, opening_balance_ngn = ?, type = ?, acc_no = ?,
                 account_officer_name = ?, account_officer_phone = ?, bank_branch = ?, sort_code_or_swift = ?, notes = ?,
                 branch_id = ?
             WHERE id = ?`
          ).run(
            name,
            String(payload.bankName ?? '').trim(),
            balance,
            openingBalanceNgn,
            String(payload.type ?? 'Bank').trim() || 'Bank',
            String(payload.accNo ?? '').trim() || 'N/A',
            accountOfficerName,
            accountOfficerPhone,
            bankBranch,
            sortCodeOrSwift,
            notes,
            branchId,
            Number(payload.id)
          );
        } else {
          db.prepare(
            `UPDATE treasury_accounts
             SET name = ?, bank_name = ?, balance = ?, opening_balance_ngn = ?, type = ?, acc_no = ?,
                 account_officer_name = ?, account_officer_phone = ?, bank_branch = ?, sort_code_or_swift = ?, notes = ?
             WHERE id = ?`
          ).run(
            name,
            String(payload.bankName ?? '').trim(),
            balance,
            openingBalanceNgn,
            String(payload.type ?? 'Bank').trim() || 'Bank',
            String(payload.accNo ?? '').trim() || 'N/A',
            accountOfficerName,
            accountOfficerPhone,
            bankBranch,
            sortCodeOrSwift,
            notes,
            Number(payload.id)
          );
        }
      } else {
        db.prepare(
          `INSERT INTO treasury_accounts (name, bank_name, balance, opening_balance_ngn, type, acc_no, account_officer_name, account_officer_phone, bank_branch, sort_code_or_swift, notes, branch_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          name,
          String(payload.bankName ?? '').trim(),
          balance,
          openingBalanceNgn,
          String(payload.type ?? 'Bank').trim() || 'Bank',
          String(payload.accNo ?? '').trim() || 'N/A',
          accountOfficerName,
          accountOfficerPhone,
          bankBranch,
          sortCodeOrSwift,
          notes,
          branchId
        );
      }
      const row = payload.id
        ? db.prepare(`SELECT * FROM treasury_accounts WHERE id = ?`).get(Number(payload.id))
        : db.prepare(`SELECT * FROM treasury_accounts ORDER BY id DESC LIMIT 1`).get();
      savedId = row?.id ?? null;
      appendAuditLog(db, {
        actor,
        action: payload.id ? 'treasury_account.update' : 'treasury_account.create',
        entityKind: 'treasury_account',
        entityId: String(row?.id ?? payload.id ?? ''),
        note: `${name} saved in treasury controls`,
        details: { balance, openingBalanceNgn },
      });
    })();
    return { ok: true, id: savedId };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function deleteTreasuryAccount(db, accountId, actor) {
  const rk = String(actor?.roleKey || '').toLowerCase();
  if (!['admin', 'md', 'ceo'].includes(rk)) {
    return { ok: false, error: 'Only Admin, Managing Director, or CEO may delete treasury accounts.' };
  }

  const id = Number(accountId);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'Invalid account id.' };
  const exists = db.prepare(`SELECT id, name, balance FROM treasury_accounts WHERE id = ?`).get(id);
  if (!exists) return { ok: false, error: 'Account not found.' };

  const totalAccounts = Number(db.prepare(`SELECT COUNT(*) AS c FROM treasury_accounts`).get()?.c) || 0;
  if (totalAccounts <= 1) {
    return { ok: false, error: 'Cannot delete the last remaining treasury account.' };
  }

  const bal = roundMoney(exists.balance);
  if (bal !== 0) {
    return {
      ok: false,
      error:
        'Cannot delete while the book balance is non-zero. Transfer funds out or correct the balance to exactly ₦0 before removal.',
    };
  }

  const tm = db.prepare(`SELECT COUNT(*) AS c FROM treasury_movements WHERE treasury_account_id = ?`).get(id);
  if (Number(tm?.c) > 0) {
    return {
      ok: false,
      error:
        'Cannot delete: this account has treasury movement history. Removal is blocked even if the running balance was adjusted manually.',
    };
  }
  const br = db
    .prepare(`SELECT COUNT(*) AS c FROM bank_reconciliation_lines WHERE treasury_account_id = ?`)
    .get(id);
  if (Number(br?.c) > 0) {
    return {
      ok: false,
      error: 'Cannot delete: one or more bank reconciliation lines are tied to this treasury account.',
    };
  }
  const ibl = db
    .prepare(
      `SELECT COUNT(*) AS c FROM inter_branch_loans WHERE from_treasury_account_id = ? OR to_treasury_account_id = ?`
    )
    .get(id, id);
  if (Number(ibl?.c) > 0) {
    return { ok: false, error: 'Cannot delete: inter-branch loan records reference this account.' };
  }
  const ibr = db
    .prepare(
      `SELECT COUNT(*) AS c FROM inter_branch_loan_repayments WHERE from_treasury_account_id = ? OR to_treasury_account_id = ?`
    )
    .get(id, id);
  if (Number(ibr?.c) > 0) {
    return { ok: false, error: 'Cannot delete: inter-branch repayments reference this account.' };
  }

  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM treasury_accounts WHERE id = ?`).run(id);
      appendAuditLog(db, {
        actor,
        action: 'treasury_account.delete',
        entityKind: 'treasury_account',
        entityId: String(id),
        note: `Treasury account removed: ${String(exists.name || '')}`,
      });
    })();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function reviewQuotation(db, quoteId, payload, actor) {
  const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(quoteId);
  if (!row) return { ok: false, error: 'Quotation not found.' };

  const decision = String(payload.decision ?? '').trim(); // clear, flag, approve_production, release_payments, waive_balance, write_off_receivable
  const note = String(payload.note ?? '').trim();
  const writeOffCategory = String(payload.category ?? payload.writeOffCategory ?? 'bad_debt').trim();
  const now = new Date().toISOString();

  if (decision === 'clear' || decision === 'flag' || decision === 'waive_balance') {
    if (!userMayPerformManagerQuotationClearance(actor)) {
      return {
        ok: false,
        error: 'Quotation clearance requires Branch Manager, Managing Director, or Administrator authority.',
        code: 'FORBIDDEN',
      };
    }
  }
  if (decision === 'write_off_receivable') {
    if (!userMayWriteOffReceivableBadDebt(actor)) {
      return {
        ok: false,
        error: 'Material receivable write-off requires Managing Director or Administrator authority.',
        code: 'FORBIDDEN',
      };
    }
  }
  if (decision === 'release_payments') {
    if (!userMayReleaseQuotationPaymentHold(actor)) {
      return {
        ok: false,
        error: 'Releasing payment holds requires Managing Director or Administrator authority.',
        code: 'FORBIDDEN',
      };
    }
  }

  const paid = Math.round(Number(row.paid_ngn) || 0);
  const total = Math.round(Number(row.total_ngn) || 0);
  const priorWaived = quotationWaivedBalanceNgn(row);
  const receivable = accountingReceivableOutstandingNgn(total, paid, priorWaived);
  const writeOffEval = evaluateReceivableWriteOff(total, paid, priorWaived);

  if (decision === 'clear') {
    if (total > 0 && receivable > 0 && !isEffectivelyFullyPaid(paid, total)) {
      return {
        ok: false,
        error: `Cannot clear: quotation still has balance due (paid ₦${paid.toLocaleString('en-NG')} of ₦${total.toLocaleString('en-NG')}). Customer must pay to at least 99.5% before clearance, or MD must write off the balance.`,
      };
    }
  }

  if (decision === 'waive_balance') {
    if (writeOffEval.kind !== 'round_off') {
      return {
        ok: false,
        error:
          writeOffEval.blockReason ||
          'Round-off waiver only applies to small balances within the 99.5% payment tolerance (max ₦5,000). Material balances require MD write-off.',
      };
    }
  }

  if (decision === 'write_off_receivable') {
    if (receivable <= 0) {
      return { ok: false, error: 'This quotation has no receivable balance to write off.' };
    }
    if (writeOffEval.kind === 'round_off') {
      return {
        ok: false,
        error: 'This balance qualifies as a small round-off — Branch Manager should use Clear as paid, not MD write-off.',
      };
    }
    if (note.length < RECEIVABLE_WRITEOFF_NOTE_MIN_LEN) {
      return {
        ok: false,
        error: `Write-off reason required (at least ${RECEIVABLE_WRITEOFF_NOTE_MIN_LEN} characters).`,
      };
    }
  }

  let waivedAmountNgn = 0;
  let writeOffCategoryApplied = '';
  try {
    db.transaction(() => {
      const persistWaive = (amount, category, waiveNote) => {
        const amt = Math.round(Number(amount) || 0);
        if (amt <= 0) return;
        waivedAmountNgn = amt;
        writeOffCategoryApplied = category;
        db.prepare(
          `UPDATE quotations
           SET payment_balance_waived_ngn = ?,
               payment_balance_waived_at_iso = ?,
               payment_balance_waived_by_user_id = ?,
               payment_balance_waived_by_name = ?,
               payment_balance_waive_note = ?,
               manager_cleared_at_iso = COALESCE(manager_cleared_at_iso, ?),
               manager_flagged_at_iso = NULL,
               manager_flag_reason = NULL
           WHERE id = ?`
        ).run(
          priorWaived + amt,
          now,
          actorId(actor),
          actorName(actor),
          waiveNote || null,
          now,
          quoteId
        );
        try {
          tryPostReceivableWriteOffGl(db, {
            quotationRef: quoteId,
            amountNgn: amt,
            entryDateISO: now.slice(0, 10),
            branchId: row.branch_id || null,
            createdByUserId: actorId(actor),
            category,
            memo: waiveNote || `${category} — ${quoteId}`,
          });
        } catch (glErr) {
          console.warn('[receivable-write-off-gl]', glErr);
        }
      };

      if (decision === 'waive_balance') {
        persistWaive(writeOffEval.waivableNgn, 'round_off', note || 'Round-off within payment tolerance');
      } else if (decision === 'write_off_receivable') {
        const category =
          writeOffCategory === 'settlement' && writeOffEval.kind === 'settlement'
            ? 'settlement'
            : 'bad_debt';
        persistWaive(receivable, category, note);
      } else if (decision === 'clear') {
        if (receivable > 0 && isEffectivelyFullyPaid(paid, total)) {
          const autoWaive = maxRoundOffWaiveNgn(total, paid, priorWaived);
          if (autoWaive > 0) {
            persistWaive(autoWaive, 'round_off', note || 'Auto round-off on manager clearance');
          }
        }
        db.prepare(
          `UPDATE quotations 
           SET manager_cleared_at_iso = ?, manager_flagged_at_iso = NULL, manager_flag_reason = NULL 
           WHERE id = ?`
        ).run(now, quoteId);
      } else if (decision === 'release_payments') {
        db.prepare(
          `UPDATE quotations 
           SET manager_cleared_at_iso = NULL, manager_flagged_at_iso = NULL, manager_flag_reason = NULL 
           WHERE id = ?`
        ).run(quoteId);
      } else if (decision === 'flag') {
        db.prepare(
          `UPDATE quotations 
           SET manager_flagged_at_iso = ?, manager_flag_reason = ?, manager_cleared_at_iso = NULL 
           WHERE id = ?`
        ).run(now, note, quoteId);
      } else if (decision === 'approve_production') {
        const total = Math.round(Number(row.total_ngn) || 0);
        const paid = Math.round(Number(row.paid_ngn) || 0);
        if (!userMayApproveProductionGate(actor, paid)) {
          throw new Error(productionGateOverrideDeniedMessage(paid));
        }
        if (!productionGateOverrideNoteValid(note)) {
          throw new Error(
            `Production override reason required (at least ${PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN} characters).`
          );
        }
        const paidFraction = total > 0 ? paid / total : paid > 0 ? 1 : 0;
        const approvalLevel = productionGateApprovalLevelForActor(actor);
        db.prepare(
          `UPDATE quotations 
           SET manager_production_approved_at_iso = ?,
               manager_production_approved_by_user_id = ?,
               manager_production_approved_by_name = ?,
               manager_production_approval_note = ?,
               manager_production_paid_fraction_at_approval = ?,
               manager_production_approval_level = ?
           WHERE id = ?`
        ).run(
          now,
          actorId(actor),
          actorName(actor),
          note || null,
          paidFraction,
          approvalLevel,
          quoteId
        );
        recordApprovalAction(db, {
          actor,
          entityKind: 'quotation',
          entityId: quoteId,
          action: 'production_gate_override',
          status: 'approved',
          note: note || (paid > 0 ? 'BM production gate override' : 'MD zero-payment production gate override'),
          actedAtISO: now.slice(0, 10),
        });
      } else {
        throw new Error('Invalid manager decision.');
      }

      appendAuditLog(db, {
        actor,
        action: `quotation.${decision}`,
        entityKind: 'quotation',
        entityId: quoteId,
        note: `Manager ${decision} action on ${quoteId}`,
        details: {
          note,
          decision,
          waivedAmountNgn: waivedAmountNgn || undefined,
          writeOffCategory: writeOffCategoryApplied || undefined,
        },
      });
    })();
    if (decision === 'waive_balance' || decision === 'write_off_receivable') {
      return { ok: true, waivedAmountNgn, writeOffCategory: writeOffCategoryApplied || undefined };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function setQuotationRefundsBlocked(db, quoteId, payload, actor) {
  if (!userMayBlockQuotationRefunds(actor)) {
    return {
      ok: false,
      error: 'Blocking refunds requires Managing Director or Administrator authority.',
      code: 'FORBIDDEN',
    };
  }
  const id = String(quoteId ?? '').trim();
  if (!id) return { ok: false, error: 'Quotation id is required.' };
  const row = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Quotation not found.' };

  const unblock = payload.blocked === false || payload.blocked === 0 || payload.unblock === true;
  const reason = String(payload.reason ?? payload.note ?? '').trim();
  const now = new Date().toISOString();

  if (!unblock) {
    if (reason.length < QUOTATION_REFUNDS_BLOCK_REASON_MIN_LEN) {
      return {
        ok: false,
        error: `A reason of at least ${QUOTATION_REFUNDS_BLOCK_REASON_MIN_LEN} characters is required when blocking refunds.`,
      };
    }
    if (quotationRefundsBlocked(row)) {
      return { ok: false, error: 'Refunds are already blocked on this quotation.' };
    }
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE quotations
           SET refunds_blocked_at_iso = ?,
               refunds_blocked_by_user_id = ?,
               refunds_blocked_by_name = ?,
               refunds_blocked_reason = ?
           WHERE id = ?`
        ).run(now, actorId(actor), actorName(actor), reason, id);
        appendAuditLog(db, {
          actor,
          action: 'quotation.refunds_block',
          entityKind: 'quotation',
          entityId: id,
          note: reason,
          details: { blockedAtISO: now },
        });
      })();
      return {
        ok: true,
        blocked: true,
        refundsBlockedAtISO: now,
        refundsBlockedReason: reason,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  if (!quotationRefundsBlocked(row)) {
    return { ok: false, error: 'Refunds are not blocked on this quotation.' };
  }
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE quotations
         SET refunds_blocked_at_iso = NULL,
             refunds_blocked_by_user_id = NULL,
             refunds_blocked_by_name = NULL,
             refunds_blocked_reason = NULL
         WHERE id = ?`
      ).run(id);
      appendAuditLog(db, {
        actor,
        action: 'quotation.refunds_unblock',
        entityKind: 'quotation',
        entityId: id,
        note: reason || 'Refunds unblocked',
        details: { priorReason: row.refunds_blocked_reason || null },
      });
    })();
    return { ok: true, blocked: false };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

