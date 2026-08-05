/**
 * Quotation-scoped financial integrity recalculation — receipts, paid balance, refund caps.
 */
import { appendAuditLog, previewRefundRequest } from './controlOps.js';
import { reconcileSalesReceiptMirrorsForQuotation } from './writeOps.js';
import {
  normalizeRefundReasonCategoriesForApi,
  refundCategoriesAreEconomicFloorExempt,
} from '../shared/refundConstants.js';

/**
 * Open refunds whose amount exceeds the economic floor cap available to that refund
 * (cash in − floor value − other active refunds on the quote).
 *
 * Accepts either a full economicFloor summary, or a legacy numeric maxDefensibleRefundNgn.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {number | null | undefined | {
 *   maxDefensibleRefundNgn?: number | null,
 *   cashInNgn?: number,
 *   floorDeliveredValueNgn?: number,
 *   priorRefundedNgn?: number,
 *   incompleteFloorPricing?: boolean,
 * }} economicFloorOrMax
 */
export function listStaleOpenRefundsForQuotation(db, quotationRef, economicFloorOrMax) {
  const ref = String(quotationRef || '').trim();
  if (!ref || economicFloorOrMax == null) return [];

  const openRefunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, reason_category
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) IN ('pending', 'approved')`
    )
    .all(ref);

  const floorObj =
    typeof economicFloorOrMax === 'object' && economicFloorOrMax !== null ? economicFloorOrMax : null;
  const legacyMax =
    floorObj == null ? Math.round(Number(economicFloorOrMax) || 0) : null;

  if (floorObj && floorObj.maxDefensibleRefundNgn == null) return [];

  const hasCashFloor =
    floorObj &&
    floorObj.cashInNgn != null &&
    Number.isFinite(Number(floorObj.cashInNgn)) &&
    floorObj.floorDeliveredValueNgn != null &&
    Number.isFinite(Number(floorObj.floorDeliveredValueNgn));

  const cashIn = hasCashFloor ? Math.round(Number(floorObj.cashInNgn) || 0) : null;
  const floorValue = hasCashFloor ? Math.round(Number(floorObj.floorDeliveredValueNgn) || 0) : null;

  let otherActiveById = null;
  if (hasCashFloor) {
    const activeRows = db
      .prepare(
        `SELECT refund_id, amount_ngn FROM customer_refunds
         WHERE quotation_ref = ?
           AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
      )
      .all(ref);
    const totalActive = activeRows.reduce((s, r) => s + Math.round(Number(r.amount_ngn) || 0), 0);
    otherActiveById = new Map();
    for (const r of activeRows) {
      const id = String(r.refund_id);
      const amt = Math.round(Number(r.amount_ngn) || 0);
      otherActiveById.set(id, Math.max(0, totalActive - amt));
    }
  }

  const stale = [];
  for (const r of openRefunds) {
    const cats = normalizeRefundReasonCategoriesForApi(r.reason_category);
    if (refundCategoriesAreEconomicFloorExempt(cats)) continue;
    const amt = Math.round(Number(r.amount_ngn) || 0);
    let maxDef;
    if (hasCashFloor) {
      const others = otherActiveById.get(String(r.refund_id)) ?? 0;
      maxDef = Math.max(0, cashIn - floorValue - others);
    } else if (floorObj) {
      maxDef = Math.round(Number(floorObj.maxDefensibleRefundNgn) || 0);
    } else {
      maxDef = legacyMax;
    }
    if (amt > maxDef + 1) {
      stale.push({
        refundId: r.refund_id,
        status: r.status,
        amountNgn: amt,
        maxDefensibleRefundNgn: maxDef,
        reasonCategory: r.reason_category,
      });
    }
  }
  return stale;
}

/**
 * Preview + stale refund assessment without reconciling receipts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {{ excludeRefundId?: string | null }} [opts]
 */
export function assessQuotationRefundIntegrity(db, quotationRef, opts = {}) {
  const excludeRefundId = String(opts.excludeRefundId || '').trim() || null;
  const preview = previewRefundRequest(db, {
    quotationRef,
    excludeRefundId,
  });
  const economicFloor = preview.ok ? preview.preview?.economicFloor ?? null : null;
  const staleRefundWarnings = listStaleOpenRefundsForQuotation(db, quotationRef, economicFloor);
  return {
    ok: preview.ok,
    preview: preview.preview ?? null,
    economicFloor,
    categorySuggestedMaxNgn: preview.preview?.categorySuggestedMaxNgn ?? null,
    staleRefundWarnings,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {{ actor?: object, excludeRefundId?: string | null }} [opts]
 */
export function recalculateQuotationIntegrity(db, quotationRef, opts = {}) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: false, error: 'quotationRef is required.' };

  const quote = db.prepare(`SELECT id, paid_ngn, total_ngn FROM quotations WHERE id = ?`).get(ref);
  if (!quote) return { ok: false, error: 'Quotation not found.' };

  const beforePaid = Math.round(Number(quote.paid_ngn) || 0);
  const receiptReconcile = reconcileSalesReceiptMirrorsForQuotation(db, ref);
  if (!receiptReconcile.ok) return receiptReconcile;

  const afterRow = db.prepare(`SELECT paid_ngn, total_ngn FROM quotations WHERE id = ?`).get(ref);
  const afterPaid = Math.round(Number(afterRow?.paid_ngn) || 0);

  const excludeRefundId = String(opts.excludeRefundId || '').trim() || null;
  const preview = previewRefundRequest(db, { quotationRef: ref, excludeRefundId });
  const economicFloor = preview.ok ? preview.preview?.economicFloor ?? null : null;
  const categoryCaps = preview.ok ? preview.preview?.categorySuggestedMaxNgn ?? null : null;
  const staleRefundWarnings = listStaleOpenRefundsForQuotation(db, ref, economicFloor);

  const openRefunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, reason_category
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) IN ('pending', 'approved')`
    )
    .all(ref);

  return {
    ok: true,
    quotationRef: ref,
    receiptReconcile: {
      paidNgn: afterPaid,
      paidNgnBefore: beforePaid,
      paidNgnChanged: beforePaid !== afterPaid,
      upserted: receiptReconcile.upserted ?? 0,
      deletedMirrors: receiptReconcile.deletedMirrors ?? 0,
    },
    refundPreviewVersion: preview.ok ? preview.preview?.engineVersion : null,
    economicFloor,
    categorySuggestedMaxNgn: categoryCaps,
    openRefundsCount: openRefunds.length,
    staleRefundWarnings,
    recalculatedAtISO: new Date().toISOString(),
    actorUserId: opts.actor?.id ?? null,
  };
}

/**
 * After production or register changes, audit when open refunds exceed the live economic floor.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {{ actor?: object, trigger?: string, jobId?: string }} [opts]
 */
export function recordRefundIntegrityDriftAfterProductionChange(db, quotationRef, opts = {}) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true, drift: false, staleRefundWarnings: [] };

  const assessment = assessQuotationRefundIntegrity(db, ref);
  const stale = assessment.staleRefundWarnings || [];
  if (!stale.length) {
    return { ok: true, drift: false, staleRefundWarnings: [] };
  }

  const trigger = String(opts.trigger || 'production_change').trim() || 'production_change';
  appendAuditLog(db, {
    actor: opts.actor,
    action: 'refund.integrity_drift',
    entityKind: 'quotation',
    entityId: ref,
    note: `${stale.length} open refund(s) exceed the economic floor after ${trigger}. Recalculate integrity before approve or payout.`,
    details: {
      trigger,
      jobId: opts.jobId ? String(opts.jobId) : null,
      staleRefundWarnings: stale,
      economicFloor: assessment.economicFloor ?? null,
      recalculatedAtISO: new Date().toISOString(),
    },
  });

  return { ok: true, drift: true, staleRefundWarnings: stale };
}
