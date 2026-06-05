/**
 * AP1b+ — Policy v1 delivery payment/release gate (warn or enforce via env).
 */
import { isEffectivelyFullyPaid } from '../shared/lib/paymentOutstandingTolerance.js';
import { quotationHasCompletedProduction } from '../shared/lib/customerLedgerCore.js';
import { listProductionJobs } from './readModel.js';
import { quotationHasUnclearedReceipts } from './writeOps.js';

/** @typedef {'off' | 'warn' | 'enforce'} DeliveryPaymentGateMode */

/**
 * @returns {DeliveryPaymentGateMode}
 */
export function readDeliveryPaymentGateMode() {
  const raw = String(process.env.DELIVERY_PAYMENT_GATE || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return 'off';
  if (raw === 'enforce' || raw === 'strict' || raw === 'block') return 'enforce';
  return 'warn';
}

/**
 * Policy v6: block delivery release unless quote is fully paid (credit/override handled separately).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {Array<{ status?: string, quotationRef?: string, actualMeters?: number }>} [productionJobs]
 */
export function evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, productionJobs = []) {
  const ref = String(quotationRef || '').trim();
  if (!ref) {
    return { wouldBlock: false, reason: 'no_quotation', balanceNgn: 0, policyPhase: 'unknown' };
  }
  const q = db.prepare(`SELECT id, total_ngn, paid_ngn FROM quotations WHERE id = ?`).get(ref);
  if (!q) {
    return { wouldBlock: false, reason: 'quotation_not_found', balanceNgn: 0, policyPhase: 'unknown' };
  }
  const total = Math.round(Number(q.total_ngn) || 0);
  const paid = Math.round(Number(q.paid_ngn) || 0);
  if (isEffectivelyFullyPaid(paid, total)) {
    return { wouldBlock: false, reason: 'fully_paid', balanceNgn: 0, policyPhase: 'settled' };
  }
  const balanceNgn = Math.max(0, total - paid);
  const postProd = quotationHasCompletedProduction(ref, productionJobs);
  return {
    wouldBlock: true,
    reason: postProd ? 'unpaid_after_production' : 'unpaid_balance',
    balanceNgn,
    policyPhase: postProd ? 'post_production' : 'pre_production',
    totalNgn: total,
    paidNgn: paid,
  };
}

/** @deprecated Use evaluateQuotationPaymentForDeliveryRelease — kept for AP1a diagnostics import path. */
export function deliveryReleaseWouldBeBlockedForQuotation(db, quotationRef, productionJobs = []) {
  const r = evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, productionJobs);
  return { blocked: r.wouldBlock, reason: r.reason, balanceNgn: r.balanceNgn };
}

function envFlagOn(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function mdOverrideAllowed(actor) {
  if (!envFlagOn('ALLOW_MD_DELIVERY_OVERRIDE')) return false;
  const rk = String(actor?.roleKey || actor?.role || '').toLowerCase();
  return rk === 'md' || rk === 'admin';
}

function strictFinanceClearanceRequired() {
  const raw = String(process.env.DELIVERY_PAYMENT_GATE_STRICT_FINANCE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   deliveryId?: string;
 *   quotationRef?: string;
 *   actor?: { id?: string; roleKey?: string; displayName?: string } | null;
 *   mdOverride?: boolean;
 *   mdOverrideReason?: string;
 *   acknowledgePolicyWarning?: boolean;
 * }} opts
 */
export function evaluateDeliveryPaymentRelease(db, opts = {}) {
  const mode = readDeliveryPaymentGateMode();
  const deliveryId = String(opts.deliveryId || '').trim();
  let quotationRef = String(opts.quotationRef || '').trim();
  if (deliveryId && !quotationRef) {
    const row = db.prepare(`SELECT quotation_ref, status FROM deliveries WHERE id = ?`).get(deliveryId);
    quotationRef = String(row?.quotation_ref || '').trim();
  }

  const base = {
    ok: true,
    mode,
    deliveryId: deliveryId || null,
    quotationRef: quotationRef || null,
    wouldBlock: false,
    allowed: true,
    code: 'DELIVERY_RELEASE_OK',
    message: 'Delivery release allowed.',
  };

  if (mode === 'off' || !quotationRef) {
    return base;
  }

  const branchScope = 'ALL';
  const productionJobs = listProductionJobs(db, branchScope);
  const pay = evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, productionJobs);

  if (!pay.wouldBlock) {
    return { ...base, reason: pay.reason, policyPhase: pay.policyPhase };
  }

  const mdOverride =
    Boolean(opts.mdOverride) &&
    mdOverrideAllowed(opts.actor) &&
    String(opts.mdOverrideReason || '').trim().length >= 3;

  if (mdOverride) {
    return {
      ...base,
      wouldBlock: false,
      allowed: true,
      code: 'DELIVERY_RELEASE_MD_OVERRIDE',
      message: 'MD override — delivery allowed despite outstanding balance.',
      reason: pay.reason,
      balanceNgn: pay.balanceNgn,
      policyPhase: pay.policyPhase,
      mdOverride: true,
    };
  }

  let financePending = false;
  if (strictFinanceClearanceRequired() && quotationHasUnclearedReceipts(db, quotationRef)) {
    financePending = true;
  }

  const balanceLabel = formatNgn(pay.balanceNgn);
  let message = `Policy v1: quotation ${quotationRef} has ₦${balanceLabel} outstanding. Full payment or approved credit is required before delivery release.`;
  if (pay.policyPhase === 'pre_production') {
    message = `Policy v1: quotation ${quotationRef} is not fully paid (₦${balanceLabel} remaining on account). Delivery release requires full payment or approved credit.`;
  }
  if (financePending) {
    message += ' One or more receipts are still pending finance clearance.';
  }

  const gate = {
    ok: mode !== 'enforce',
    mode,
    deliveryId: deliveryId || null,
    quotationRef,
    wouldBlock: true,
    allowed: mode === 'warn' && Boolean(opts.acknowledgePolicyWarning),
    code: mode === 'enforce' ? 'DELIVERY_PAYMENT_GATE_BLOCKED' : 'DELIVERY_PAYMENT_GATE_WARNING',
    message,
    reason: pay.reason,
    balanceNgn: pay.balanceNgn,
    policyPhase: pay.policyPhase,
    financePendingClearance: financePending,
    requiresAcknowledgement: mode === 'warn',
  };

  if (mode === 'warn') {
    gate.ok = true;
    gate.allowed = true;
    gate.warningOnly = true;
  } else {
    gate.ok = false;
    gate.allowed = false;
  }

  return gate;
}

/** @param {ReturnType<typeof evaluateDeliveryPaymentRelease>} gate */
export function deliveryGateShouldBlockMutation(gate) {
  if (!gate || gate.mode !== 'enforce') return false;
  if (gate.mdOverride) return false;
  return Boolean(gate.wouldBlock);
}

function formatNgn(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-NG');
}
