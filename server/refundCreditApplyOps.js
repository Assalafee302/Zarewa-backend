/**
 * Apply refund fund (overpay / eligible refund) onto a new quotation.
 * Applied amounts become OVERPAY_APPLIED on the target (counts as paid, no sales receipt → no bank clearance).
 * That slice is not refundable again. Leftover stays on the source for normal refund payout.
 */

import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  REFUND_CREDIT_CONFIRMATION_STATUS,
  REFUND_CREDIT_LEDGER_REF_PREFIX,
  REFUND_CREDIT_REVERSED_STATUS,
  REFUND_CREDIT_REVERSE_LEDGER_REF_PREFIX,
  allocateRefundCreditAcrossSources,
  planRefundCreditApplyAmount,
  refundBlocksExternalCreditOnQuotation,
  refundCategoriesAreOverpaymentOnly,
  refundCreditOpenAmountFromStoredRefund,
  refundCreditOpenAmountNgn,
  refundCreditUnavailableReason,
  refundIsEligibleCreditSource,
  refundIsEligibleCreditSourceKind,
} from '../shared/lib/refundCreditApply.js';
import { amountDueOnQuotationFromEntries } from '../shared/lib/customerLedgerCore.js';
import { assertPeriodOpen, appendAuditLog } from './controlOps.js';
import {
  insertLedgerRows,
  overpayCreditRemainingOnQuotationDb,
  syncQuotationPaidFromLedger,
} from './writeOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function actorId(actor) {
  return actor?.id != null ? String(actor.id) : null;
}

function actorName(actor) {
  return String(actor?.displayName || actor?.username || '').trim() || 'System';
}

function parseRefundCats(row) {
  let calculationLines = [];
  try {
    calculationLines = JSON.parse(row.calculation_lines_json || '[]');
  } catch {
    calculationLines = [];
  }
  return {
    reasonCategory: row.reason_category,
    calculationLines,
    status: row.status,
    amountNgn: roundMoney(row.amount_ngn),
    approvedAmountNgn: roundMoney(row.approved_amount_ngn),
    paidAmountNgn: roundMoney(row.paid_amount_ngn),
    creditAppliedNgn: roundMoney(row.credit_applied_ngn),
  };
}

function mapRefundRowToCreditShape(row) {
  const parsed = parseRefundCats(row);
  return {
    refundID: row.refund_id,
    customerID: row.customer_id,
    quotationRef: row.quotation_ref,
    ...parsed,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerId
 * @param {string} targetQuotationRef
 * @param {{ branchId?: string }} [opts]
 */
export function listEligibleRefundCredits(db, customerId, targetQuotationRef, _opts = {}) {
  const cid = String(customerId || '').trim();
  const target = String(targetQuotationRef || '').trim();
  if (!cid || !target) {
    return { ok: false, error: 'customerID and targetQuotationRef are required.', sources: [], totalAvailableNgn: 0 };
  }
  const cust = db.prepare(`SELECT customer_id, name FROM customers WHERE customer_id = ?`).get(cid);
  if (!cust) return { ok: false, error: 'Customer not found.', sources: [], totalAvailableNgn: 0 };
  const targetQ = db
    .prepare(`SELECT id, customer_id, total_ngn, paid_ngn, branch_id FROM quotations WHERE id = ?`)
    .get(target);
  if (!targetQ) return { ok: false, error: 'Target quotation not found.', sources: [], totalAvailableNgn: 0 };
  if (String(targetQ.customer_id || '').trim() !== cid) {
    return { ok: false, error: 'Quotation does not belong to this customer.', sources: [], totalAvailableNgn: 0 };
  }

  const targetDueNgn = amountDueOnQuotationFromEntries(null, {
    id: target,
    totalNgn: targetQ.total_ngn,
    paidNgn: targetQ.paid_ngn,
  });

  const quotes = db
    .prepare(
      `SELECT id, total_ngn, paid_ngn, date_iso FROM quotations
       WHERE customer_id = ?
       ORDER BY date_iso ASC, id ASC`
    )
    .all(cid);

  const refunds = db
    .prepare(
      `SELECT cr.* FROM customer_refunds cr
       LEFT JOIN quotations q ON q.id = cr.quotation_ref
       WHERE (cr.customer_id = ? OR q.customer_id = ?)
         AND cr.status IN ('Pending', 'Approved')
       ORDER BY cr.requested_at_iso ASC, cr.refund_id ASC`
    )
    .all(cid, cid);

  /** @type {Array<object>} */
  const sources = [];
  /** @type {Array<object>} */
  const unavailableSources = [];

  const refundsByQuote = new Map();
  for (const row of refunds) {
    const qref = String(row.quotation_ref || '').trim();
    const shape = mapRefundRowToCreditShape(row);
    const open = refundCreditOpenAmountFromStoredRefund(row);
    const overpayOnly = refundCategoriesAreOverpaymentOnly(shape.reasonCategory, shape.calculationLines);
    if (!qref) {
      unavailableSources.push({
        id: `refund:${shape.refundID || 'missing-quote'}`,
        refundId: shape.refundID,
        sourceQuotationRef: '',
        availableNgn: open,
        status: shape.status,
        overpaymentOnly: overpayOnly,
        reason: 'Refund is not linked to a quotation — cannot apply as credit.',
      });
      continue;
    }
    if (!refundsByQuote.has(qref)) refundsByQuote.set(qref, []);
    refundsByQuote.get(qref).push(row);

    const kindEligible = refundIsEligibleCreditSourceKind(shape);
    const eligible = kindEligible && open > 0;
    if (eligible) {
      sources.push({
        id: `refund:${shape.refundID}`,
        kind: 'refund',
        refundId: shape.refundID,
        sourceQuotationRef: qref,
        availableNgn: open,
        requiresApproval: false,
        status: shape.status,
        overpaymentOnly: overpayOnly,
        sameQuotation: qref === target,
        label: overpayOnly
          ? `Refund fund ${shape.refundID} on ${qref}`
          : `Approved refund ${shape.refundID} on ${qref}`,
        recommendation:
          qref === target
            ? `Use up to ₦${open.toLocaleString('en-NG')} from this quotation’s refund fund; leftover stays refundable here.`
            : `Use up to ₦${open.toLocaleString('en-NG')} from refund fund ${shape.refundID}; leftover stays refundable on ${qref}.`,
      });
    } else {
      const reason =
        !qref && shape.refundID
          ? 'Refund is not linked to a quotation — cannot apply as credit.'
          : refundCreditUnavailableReason(shape, open, kindEligible);
      unavailableSources.push({
        id: `refund:${shape.refundID || qref}`,
        refundId: shape.refundID,
        sourceQuotationRef: qref,
        availableNgn: open,
        status: shape.status,
        overpaymentOnly: overpayOnly,
        reason,
      });
    }
  }

  /** Open overpay-refund credit already counted per source quotation (avoid double-counting ledger pool). */
  const overpayRefundOpenByQuote = new Map();
  for (const src of sources) {
    if (src.kind !== 'refund' || !src.overpaymentOnly) continue;
    const qid = String(src.sourceQuotationRef || '').trim();
    if (!qid) continue;
    overpayRefundOpenByQuote.set(qid, roundMoney((overpayRefundOpenByQuote.get(qid) || 0) + src.availableNgn));
  }

  for (const q of quotes) {
    const qid = String(q.id || '').trim();
    const active = refundsByQuote.get(qid) || [];
    const blockingOtherPending = active.some((row) => {
      const shape = mapRefundRowToCreditShape(row);
      if (String(row.status) !== 'Pending') return false;
      return !refundCategoriesAreOverpaymentOnly(shape.reasonCategory, shape.calculationLines);
    });

    const overpayRem = overpayCreditRemainingOnQuotationDb(db, cid, qid);
    const refundOpenOnQuote = overpayRefundOpenByQuote.get(qid) || 0;
    const ledgerExcess = Math.max(0, overpayRem - refundOpenOnQuote);
    if (ledgerExcess > 0 && !blockingOtherPending) {
      sources.push({
        id: `overpay:${qid}`,
        kind: 'overpay',
        refundId: null,
        sourceQuotationRef: qid,
        availableNgn: ledgerExcess,
        requiresApproval: false,
        status: null,
        overpaymentOnly: true,
        sameQuotation: qid === target,
        label: `Refund fund (overpayment) on ${qid}`,
        recommendation: `Use up to ₦${ledgerExcess.toLocaleString('en-NG')} from refund fund on ${qid}; leftover stays refundable there.`,
      });
    }
  }

  const totalAvailableNgn = sources.reduce((s, x) => s + roundMoney(x.availableNgn), 0);
  const plan = planRefundCreditApplyAmount({
    targetDueNgn,
    availableNgn: totalAvailableNgn,
    requestedNgn: null,
  });

  return {
    ok: true,
    customerID: cid,
    customerName: cust.name,
    targetQuotationRef: target,
    targetDueNgn,
    totalAvailableNgn,
    recommendedApplyNgn: plan.applyNgn,
    remainderDueAfterRecommendNgn: plan.remainderDueNgn,
    leftoverCreditAfterRecommendNgn: plan.leftoverCreditNgn,
    sources,
    unavailableSources,
    statusReportLabel: REFUND_CREDIT_CONFIRMATION_STATUS,
  };
}

function nextApplicationId() {
  return `RCA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   customerID: string,
 *   targetQuotationRef: string,
 *   amountNgn?: number | null,
 *   sourceIds?: string[] | null,
 *   dateISO?: string,
 *   actor?: object,
 *   branchId?: string,
 * }} payload
 */
export function applyRefundCreditToQuotation(db, payload) {
  const cid = String(payload?.customerID || '').trim();
  const target = String(payload?.targetQuotationRef || '').trim();
  if (!cid || !target) return { ok: false, error: 'customerID and targetQuotationRef are required.' };

  const listed = listEligibleRefundCredits(db, cid, target, { branchId: payload.branchId });
  if (!listed.ok) return listed;
  if (!listed.sources.length || listed.totalAvailableNgn <= 0) {
    return { ok: false, error: 'No refund fund available for this customer.' };
  }

  let sources = listed.sources;
  const wanted = Array.isArray(payload.sourceIds)
    ? payload.sourceIds.map((s) => String(s || '').trim()).filter(Boolean)
    : null;
  if (wanted && wanted.length) {
    const set = new Set(wanted);
    sources = sources.filter((s) => set.has(s.id));
    if (!sources.length) return { ok: false, error: 'Selected credit source(s) are not available.' };
  }

  const availableNgn = sources.reduce((s, x) => s + roundMoney(x.availableNgn), 0);
  const plan = planRefundCreditApplyAmount({
    targetDueNgn: listed.targetDueNgn,
    availableNgn,
    requestedNgn: payload.amountNgn,
  });
  if (!plan.ok) return { ok: false, error: plan.error };

  const postingDay =
    String(payload.dateISO || '').trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, postingDay, 'Refund credit apply date');
  } catch (pe) {
    return { ok: false, error: String(pe?.message || pe), code: 'PERIOD_LOCKED' };
  }

  const targetGate = db
    .prepare(`SELECT manager_cleared_at_iso, manager_flagged_at_iso, branch_id FROM quotations WHERE id = ?`)
    .get(target);
  if (targetGate?.manager_cleared_at_iso) {
    return { ok: false, error: `Quotation ${target} has been cleared by manager and is closed for further payments.` };
  }
  if (targetGate?.manager_flagged_at_iso) {
    return { ok: false, error: `Quotation ${target} is flagged by manager for review and is closed for further payments.` };
  }
  const targetActiveRefunds = db
    .prepare(
      `SELECT refund_id FROM customer_refunds WHERE quotation_ref = ? AND status IN ('Pending', 'Approved')`
    )
    .all(target);
  const consumingRefundIds = new Set(
    sources.filter((s) => s.kind === 'refund' && s.refundId).map((s) => String(s.refundId))
  );
  const blockingTargetRefund = targetActiveRefunds.find(
    (row) =>
      !consumingRefundIds.has(String(row.refund_id)) && refundBlocksExternalCreditOnQuotation(row)
  );
  if (blockingTargetRefund) {
    return {
      ok: false,
      error: `Quotation ${target} has an active refund request (${blockingTargetRefund.refund_id}) and cannot receive credit from another job.`,
    };
  }

  const { allocations } = allocateRefundCreditAcrossSources(sources, plan.applyNgn);
  if (!allocations.length) return { ok: false, error: 'Nothing to apply.' };

  const bid =
    String(payload.branchId || targetGate?.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const atIso = `${postingDay}T12:00:00.000Z`;
  const customerName = String(listed.customerName || '').trim() || null;
  const actor = payload.actor || null;

  try {
    const runApply = () => {
      const appliedRows = [];
      let appliedTotal = 0;
      const allowRefundQuotes = new Set();

      for (const alloc of allocations) {
        const src = sources.find((s) => s.id === alloc.id);
        if (!src) throw new Error(`Credit source ${alloc.id} missing.`);
        const amt = roundMoney(alloc.amountNgn);
        if (amt <= 0) continue;

        const appId = nextApplicationId();
        const refToken = `${REFUND_CREDIT_LEDGER_REF_PREFIX}${appId}`;
        const sourceQ = String(src.sourceQuotationRef || '').trim();
        if (sourceQ) allowRefundQuotes.add(sourceQ);

        const ledgerRows = [];
        // Reduce per-quote overpay pool on the source when present (keeps leftover refundable math honest).
        const sourceOverpay = sourceQ ? overpayCreditRemainingOnQuotationDb(db, cid, sourceQ) : 0;
        const reverseOverpay = Math.min(amt, sourceOverpay);
        if (reverseOverpay > 0 && sourceQ) {
          ledgerRows.push({
            type: 'OVERPAY_REVERSAL',
            customerID: cid,
            customerName,
            amountNgn: reverseOverpay,
            quotationRef: sourceQ,
            paymentMethod: 'Internal',
            bankReference: refToken,
            createdByUserId: actorId(actor),
            createdByName: actorName(actor),
            note: `${REFUND_CREDIT_CONFIRMATION_STATUS}: move ₦${reverseOverpay.toLocaleString('en-NG')} overpay from ${sourceQ} toward ${target}.`,
            atISO: atIso,
          });
        }

        ledgerRows.push({
          type: 'OVERPAY_APPLIED',
          customerID: cid,
          customerName,
          amountNgn: amt,
          quotationRef: target,
          paymentMethod: 'Internal',
          bankReference: refToken,
          createdByUserId: actorId(actor),
          createdByName: actorName(actor),
          note: `${REFUND_CREDIT_CONFIRMATION_STATUS}: ₦${amt.toLocaleString('en-NG')} applied to ${target} from ${
            src.refundId || sourceQ || 'credit'
          } (not bank clearance).`,
          atISO: atIso,
        });

        insertLedgerRows(db, ledgerRows, bid, {
          allowActiveRefundQuotationRefs: allowRefundQuotes,
        });

        if (src.kind === 'refund' && src.refundId) {
          const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(src.refundId);
          if (!fresh) throw new Error(`Refund ${src.refundId} not found.`);
          const shape = mapRefundRowToCreditShape(fresh);
          if (!refundIsEligibleCreditSource(shape)) {
            throw new Error(`Refund ${src.refundId} is no longer eligible for credit apply.`);
          }
          const open = refundCreditOpenAmountFromStoredRefund(fresh);
          if (amt > open) throw new Error(`Refund ${src.refundId} open balance is only ₦${open.toLocaleString('en-NG')}.`);

          const overpayOnly = refundCategoriesAreOverpaymentOnly(
            shape.reasonCategory,
            shape.calculationLines
          );
          const paidFresh = roundMoney(fresh.paid_amount_ngn);
          const priorApplied = roundMoney(fresh.credit_applied_ngn);
          const nextCredit = priorApplied + amt;
          const requested = roundMoney(fresh.amount_ngn);
          const leftoverAfter = Math.max(0, requested - nextCredit);
          const wasPending = String(fresh.status) === 'Pending';
          let nextPaid = paidFresh;
          let approvedFresh = roundMoney(fresh.approved_amount_ngn);
          let nextStatus;
          if (wasPending) {
            // Confirmation may use pending overpay fund; leftover stays Pending for the manager.
            nextPaid = paidFresh;
            approvedFresh = leftoverAfter <= 0 ? nextCredit : 0;
            nextStatus = leftoverAfter <= 0 ? 'Paid' : 'Pending';
            if (leftoverAfter <= 0) nextPaid = nextCredit;
          } else {
            nextPaid = paidFresh + amt;
            if (overpayOnly && approvedFresh <= 0) {
              approvedFresh = requested;
            }
            if (approvedFresh <= 0) {
              approvedFresh = requested;
            }
            nextStatus = nextPaid >= approvedFresh ? 'Paid' : 'Approved';
          }
          const noteBit =
            leftoverAfter > 0 && wasPending
              ? `${REFUND_CREDIT_CONFIRMATION_STATUS}: ₦${amt.toLocaleString('en-NG')} applied to ${target}. ₦${leftoverAfter.toLocaleString('en-NG')} still awaits approval for cash payout.`
              : `${REFUND_CREDIT_CONFIRMATION_STATUS}: ₦${amt.toLocaleString('en-NG')} applied to ${target}`;
          const prevNote = String(fresh.payment_note || '').trim();
          const paymentNote = prevNote ? `${prevNote} · ${noteBit}` : noteBit;

          db.prepare(
            `UPDATE customer_refunds
             SET status = ?,
                 approved_amount_ngn = ?,
                 paid_amount_ngn = ?,
                 paid_at_iso = ?,
                 paid_by = ?,
                 paid_by_user_id = ?,
                 payment_note = ?,
                 credit_applied_ngn = ?,
                 credit_applied_to_quotation_ref = ?,
                 credit_confirmation_status = ?
             WHERE refund_id = ?`
          ).run(
            nextStatus,
            approvedFresh,
            nextPaid,
            leftoverAfter <= 0 || !wasPending ? atIso : fresh.paid_at_iso,
            leftoverAfter <= 0 || !wasPending ? actorName(actor) : fresh.paid_by,
            leftoverAfter <= 0 || !wasPending ? actorId(actor) : fresh.paid_by_user_id,
            paymentNote,
            nextCredit,
            target,
            REFUND_CREDIT_CONFIRMATION_STATUS,
            src.refundId
          );
        }

        db.prepare(
          `INSERT INTO refund_credit_applications (
             application_id, customer_id, target_quotation_ref, source_quotation_ref, refund_id,
             kind, amount_ngn, status, ledger_bank_reference, created_at_iso,
             created_by_user_id, created_by_name, branch_id
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          appId,
          cid,
          target,
          sourceQ || null,
          src.refundId || null,
          src.kind,
          amt,
          REFUND_CREDIT_CONFIRMATION_STATUS,
          refToken,
          atIso,
          actorId(actor),
          actorName(actor),
          bid
        );

        appendAuditLog(db, {
          actor,
          action: 'ledger.apply_refund_credit',
          entityKind: 'refund_credit_application',
          entityId: appId,
          note: `${REFUND_CREDIT_CONFIRMATION_STATUS}: ₦${amt.toLocaleString('en-NG')} → ${target}`,
          details: {
            customerID: cid,
            targetQuotationRef: target,
            sourceQuotationRef: sourceQ,
            refundId: src.refundId || null,
            kind: src.kind,
            amountNgn: amt,
            leftoverOnSourceNgn: alloc.leftoverOnSourceNgn,
          },
        });

        appliedRows.push({
          applicationId: appId,
          kind: src.kind,
          refundId: src.refundId || null,
          sourceQuotationRef: sourceQ,
          amountNgn: amt,
          leftoverOnSourceNgn: alloc.leftoverOnSourceNgn,
          status: REFUND_CREDIT_CONFIRMATION_STATUS,
          ledgerBankReference: refToken,
        });
        appliedTotal += amt;
      }

      syncQuotationPaidFromLedger(db, target);
      for (const row of appliedRows) {
        if (row.sourceQuotationRef) syncQuotationPaidFromLedger(db, row.sourceQuotationRef);
      }

      const qAfter = db.prepare(`SELECT total_ngn, paid_ngn, payment_status FROM quotations WHERE id = ?`).get(target);
      return {
        appliedNgn: appliedTotal,
        applications: appliedRows,
        targetPaidNgn: roundMoney(qAfter?.paid_ngn),
        targetPaymentStatus: qAfter?.payment_status || null,
        remainderDueNgn: Math.max(0, roundMoney(qAfter?.total_ngn) - roundMoney(qAfter?.paid_ngn)),
      };
    };
    const result = payload.alreadyInTransaction ? runApply() : db.transaction(runApply)();

    return {
      ok: true,
      ...result,
      status: REFUND_CREDIT_CONFIRMATION_STATUS,
      customerID: cid,
      targetQuotationRef: target,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function refundTreasuryPaidNgn(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE
           WHEN type = 'REFUND_PAYOUT' THEN amount_ngn
           WHEN type = 'REFUND_PAYOUT_REVERSAL_IN' THEN -amount_ngn
           ELSE 0
         END
       ), 0) AS s
       FROM treasury_movements
       WHERE source_kind = 'REFUND' AND source_id = ?`
    )
    .get(rid);
  return Math.max(0, roundMoney(row?.s));
}

/**
 * Undo a mistaken refund-fund apply: restore the source refund, take paid credit off the target quote.
 * Requires finance.reverse. Does not reverse till/bank receipts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} applicationId
 * @param {{ actor?: object, note?: string, dateISO?: string, alreadyInTransaction?: boolean }} [payload]
 */
export function reverseRefundCreditApplication(db, applicationId, payload = {}) {
  const appId = String(applicationId || '').trim();
  if (!appId) return { ok: false, error: 'applicationId is required.' };

  const app = db.prepare(`SELECT * FROM refund_credit_applications WHERE application_id = ?`).get(appId);
  if (!app) return { ok: false, error: 'Refund fund application not found.' };
  const status = String(app.status || '').trim();
  if (status === REFUND_CREDIT_REVERSED_STATUS) {
    return { ok: false, error: 'This refund fund apply has already been reversed.', code: 'ALREADY_REVERSED' };
  }

  const amt = roundMoney(app.amount_ngn);
  if (amt <= 0) return { ok: false, error: 'Application amount is missing.' };

  const postingDay =
    String(payload.dateISO || '').trim().slice(0, 10) || new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, postingDay, 'Refund credit reverse date');
  } catch (pe) {
    return { ok: false, error: String(pe?.message || pe), code: 'PERIOD_LOCKED' };
  }

  const actor = payload.actor || null;
  const atIso = `${postingDay}T12:00:00.000Z`;
  const originalRef = String(app.ledger_bank_reference || '').trim();
  const reverseRef = `${REFUND_CREDIT_REVERSE_LEDGER_REF_PREFIX}${appId}`;
  const target = String(app.target_quotation_ref || '').trim();
  const sourceQ = String(app.source_quotation_ref || '').trim();
  const refundId = String(app.refund_id || '').trim();
  const bid = String(app.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const noteBit = String(payload.note || '').trim();

  const already = originalRef
    ? db
        .prepare(
          `SELECT id FROM ledger_entries WHERE bank_reference = ? LIMIT 1`
        )
        .get(reverseRef)
    : db.prepare(`SELECT id FROM ledger_entries WHERE bank_reference = ? LIMIT 1`).get(reverseRef);
  if (already) {
    return { ok: false, error: 'This refund fund apply has already been reversed.', code: 'ALREADY_REVERSED' };
  }

  try {
    const runReverse = () => {
      const originals = originalRef
        ? db.prepare(`SELECT * FROM ledger_entries WHERE bank_reference = ? ORDER BY id ASC`).all(originalRef)
        : [];
      const customerName =
        originals[0]?.customer_name ||
        db.prepare(`SELECT name FROM customers WHERE customer_id = ?`).get(app.customer_id)?.name ||
        null;

      const compensating = [];
      if (originals.length) {
        for (const row of originals) {
          compensating.push({
            type: row.type,
            customerID: row.customer_id,
            customerName: row.customer_name || customerName,
            amountNgn: -roundMoney(row.amount_ngn),
            quotationRef: row.quotation_ref || '',
            paymentMethod: row.payment_method || 'Internal',
            bankReference: reverseRef,
            createdByUserId: actorId(actor),
            createdByName: actorName(actor),
            note: `Reverse refund fund ${appId}: ₦${amt.toLocaleString('en-NG')} off ${target}${
              noteBit ? ` — ${noteBit}` : ''
            }.`,
            atISO: atIso,
          });
        }
      } else if (target) {
        compensating.push({
          type: 'OVERPAY_APPLIED',
          customerID: app.customer_id,
          customerName,
          amountNgn: -amt,
          quotationRef: target,
          paymentMethod: 'Internal',
          bankReference: reverseRef,
          createdByUserId: actorId(actor),
          createdByName: actorName(actor),
          note: `Reverse refund fund ${appId}: ₦${amt.toLocaleString('en-NG')} off ${target}${
            noteBit ? ` — ${noteBit}` : ''
          }.`,
          atISO: atIso,
        });
      }

      if (compensating.length) {
        insertLedgerRows(db, compensating, bid, { bypassQuotationPaymentLocks: true });
      }

      if (refundId) {
        const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(refundId);
        if (!fresh) throw new Error(`Refund ${refundId} not found.`);
        const shape = mapRefundRowToCreditShape(fresh);
        const overpayOnly = refundCategoriesAreOverpaymentOnly(
          shape.reasonCategory,
          shape.calculationLines
        );
        const requested = roundMoney(fresh.amount_ngn);
        const priorCredit = roundMoney(fresh.credit_applied_ngn);
        if (amt > priorCredit + 1) {
          throw new Error(
            `Refund ${refundId} only has ₦${priorCredit.toLocaleString('en-NG')} credit applied; cannot reverse ₦${amt.toLocaleString('en-NG')}.`
          );
        }
        const nextCredit = Math.max(0, priorCredit - amt);
        const treasuryPaid = refundTreasuryPaidNgn(db, refundId);
        const paidNow = roundMoney(fresh.paid_amount_ngn);
        const creditSittingInPaid = Math.max(0, paidNow - treasuryPaid);
        const nextPaid = treasuryPaid + Math.max(0, creditSittingInPaid - amt);
        let nextApproved = roundMoney(fresh.approved_amount_ngn);
        if (nextApproved > 0) {
          nextApproved = Math.min(requested, nextApproved + amt);
        }

        let nextStatus;
        if (nextPaid > 0 && nextApproved > 0 && nextPaid >= nextApproved) {
          nextStatus = 'Paid';
        } else if (nextApproved > 0 || String(fresh.status) === 'Approved' || String(fresh.status) === 'Paid') {
          nextStatus = nextPaid > 0 && nextApproved <= 0 ? 'Approved' : nextApproved > 0 ? 'Approved' : 'Pending';
          if (overpayOnly && nextApproved <= 0 && nextPaid <= 0) nextStatus = 'Pending';
        } else {
          nextStatus = 'Pending';
        }
        if (overpayOnly && nextPaid <= 0 && nextCredit <= 0 && nextApproved <= 0) {
          nextStatus = 'Pending';
        }

        const remainingApps = db
          .prepare(
            `SELECT target_quotation_ref FROM refund_credit_applications
             WHERE refund_id = ? AND application_id != ? AND TRIM(COALESCE(status, '')) != ?
             ORDER BY created_at_iso DESC, application_id DESC`
          )
          .all(refundId, appId, REFUND_CREDIT_REVERSED_STATUS);
        const nextDest =
          nextCredit > 0 ? String(remainingApps[0]?.target_quotation_ref || '').trim() || null : null;

        const reverseNote = `Reversed refund fund ${appId}: ₦${amt.toLocaleString('en-NG')} taken off ${target}.`;
        const prevNote = String(fresh.payment_note || '').trim();
        const paymentNote = prevNote ? `${prevNote} · ${reverseNote}` : reverseNote;

        const clearPaidMeta = nextPaid <= 0;
        db.prepare(
          `UPDATE customer_refunds
           SET status = ?,
               approved_amount_ngn = ?,
               paid_amount_ngn = ?,
               paid_at_iso = ?,
               paid_by = ?,
               paid_by_user_id = ?,
               payment_note = ?,
               credit_applied_ngn = ?,
               credit_applied_to_quotation_ref = ?,
               credit_confirmation_status = ?
           WHERE refund_id = ?`
        ).run(
          nextStatus,
          nextApproved,
          nextPaid,
          clearPaidMeta ? null : fresh.paid_at_iso,
          clearPaidMeta ? null : fresh.paid_by,
          clearPaidMeta ? null : fresh.paid_by_user_id,
          paymentNote,
          nextCredit,
          nextDest,
          nextCredit > 0 ? REFUND_CREDIT_CONFIRMATION_STATUS : null,
          refundId
        );
      }

      db.prepare(`UPDATE refund_credit_applications SET status = ? WHERE application_id = ?`).run(
        REFUND_CREDIT_REVERSED_STATUS,
        appId
      );

      if (target) syncQuotationPaidFromLedger(db, target);
      if (sourceQ && sourceQ !== target) syncQuotationPaidFromLedger(db, sourceQ);

      appendAuditLog(db, {
        actor,
        action: 'ledger.reverse_refund_credit',
        entityKind: 'refund_credit_application',
        entityId: appId,
        note: `Reversed ₦${amt.toLocaleString('en-NG')} refund fund off ${target}`,
        details: {
          customerID: app.customer_id,
          targetQuotationRef: target,
          sourceQuotationRef: sourceQ || null,
          refundId: refundId || null,
          amountNgn: amt,
          note: noteBit || null,
        },
      });

      const qAfter = target
        ? db.prepare(`SELECT total_ngn, paid_ngn, payment_status FROM quotations WHERE id = ?`).get(target)
        : null;
      return {
        applicationId: appId,
        amountNgn: amt,
        targetQuotationRef: target,
        sourceQuotationRef: sourceQ || null,
        refundId: refundId || null,
        targetPaidNgn: roundMoney(qAfter?.paid_ngn),
        targetPaymentStatus: qAfter?.payment_status || null,
      };
    };

    const result = payload.alreadyInTransaction ? runReverse() : db.transaction(runReverse)();
    return { ok: true, status: REFUND_CREDIT_REVERSED_STATUS, ...result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [customerId]
 * @param {string | 'ALL'} [branchScope]
 */
export function listRefundCreditApplications(db, customerId = '', branchScope = 'ALL', opts = {}) {
  const cid = String(customerId || '').trim();
  const target = String(opts.targetQuotationRef || '').trim();
  const args = [];
  let sql = `SELECT * FROM refund_credit_applications WHERE 1=1`;
  if (cid) {
    sql += ` AND customer_id = ?`;
    args.push(cid);
  }
  if (target) {
    sql += ` AND target_quotation_ref = ?`;
    args.push(target);
  }
  if (branchScope && branchScope !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(String(branchScope));
  }
  sql += ` ORDER BY created_at_iso DESC, application_id DESC`;
  return db.prepare(sql).all(...args).map((row) => ({
    applicationId: row.application_id,
    customerID: row.customer_id,
    targetQuotationRef: row.target_quotation_ref,
    sourceQuotationRef: row.source_quotation_ref,
    refundId: row.refund_id,
    kind: row.kind,
    amountNgn: roundMoney(row.amount_ngn),
    status: row.status || REFUND_CREDIT_CONFIRMATION_STATUS,
    ledgerBankReference: row.ledger_bank_reference,
    createdAtISO: row.created_at_iso,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    branchId: row.branch_id,
  }));
}
