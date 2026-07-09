/**
 * Quotation-scoped financial integrity recalculation — receipts, paid balance, refund caps.
 */
import { appendAuditLog } from './controlOps.js';
import { reconcileSalesReceiptMirrorsForQuotation } from './writeOps.js';
import { previewRefundRequest } from './controlOps.js';

/**
 * Open refunds whose amount exceeds the economic floor cap.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {number | null | undefined} maxDefensibleRefundNgn
 */
export function listStaleOpenRefundsForQuotation(db, quotationRef, maxDefensibleRefundNgn) {
  const ref = String(quotationRef || '').trim();
  if (!ref || maxDefensibleRefundNgn == null) return [];
  const maxDef = Math.round(Number(maxDefensibleRefundNgn) || 0);
  const openRefunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, reason_category
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) IN ('pending', 'approved')`
    )
    .all(ref);
  const stale = [];
  for (const r of openRefunds) {
    const amt = Math.round(Number(r.amount_ngn) || 0);
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
 */
export function assessQuotationRefundIntegrity(db, quotationRef) {
  const preview = previewRefundRequest(db, { quotationRef });
  const economicFloor = preview.ok ? preview.preview?.economicFloor ?? null : null;
  const staleRefundWarnings = listStaleOpenRefundsForQuotation(
    db,
    quotationRef,
    economicFloor?.maxDefensibleRefundNgn
  );
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
 * @param {{ actor?: object }} [opts]
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

  const preview = previewRefundRequest(db, { quotationRef: ref });
  const economicFloor = preview.ok ? preview.preview?.economicFloor ?? null : null;
  const categoryCaps = preview.ok ? preview.preview?.categorySuggestedMaxNgn ?? null : null;
  const staleRefundWarnings = listStaleOpenRefundsForQuotation(
    db,
    ref,
    economicFloor?.maxDefensibleRefundNgn
  );

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
