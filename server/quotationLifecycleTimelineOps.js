/**
 * Phase 11B — quote lifecycle timeline for manager oversight.
 */
import { metreVarianceExceedsThreshold } from '../shared/lib/productionMetreVariance.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 */
export function buildQuotationLifecycleTimeline(db, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return { ok: false, error: 'quotationId is required.' };
  const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(id);
  if (!quote) return { ok: false, error: 'Quotation not found.' };

  const events = [];

  events.push({
    kind: 'quotation',
    atISO: quote.date_iso || quote.created_at_iso || '',
    label: 'Quotation created',
    detail: quote.customer_name || '',
    actor: quote.handled_by || null,
  });

  if (quote.md_price_exception_approved_at_iso) {
    events.push({
      kind: 'price_exception_md',
      atISO: quote.md_price_exception_approved_at_iso,
      label: 'MD below-floor price approved',
      detail: null,
      actor: null,
    });
  } else if (quote.price_exception_md_confirmed_at_iso) {
    events.push({
      kind: 'price_exception_md',
      atISO: quote.price_exception_md_confirmed_at_iso,
      label: 'MD below-floor price approved',
      detail: null,
      actor: null,
    });
  }
  if (quote.bm_price_exception_approved_at_iso) {
    events.push({
      kind: 'price_exception_bm',
      atISO: quote.bm_price_exception_approved_at_iso,
      label: 'Branch manager below-floor price approved',
      detail: null,
      actor: null,
    });
  }
  if (quote.manager_production_approved_at_iso) {
    events.push({
      kind: 'production_gate_override',
      atISO: quote.manager_production_approved_at_iso,
      label: 'BM production gate override',
      detail: quote.manager_production_approval_note || null,
      actor: quote.manager_production_approved_by_name || null,
    });
  }

  const cuttingLists = db
    .prepare(`SELECT id, status, date_iso, handled_by FROM cutting_lists WHERE quotation_ref = ? ORDER BY date_iso`)
    .all(id);
  for (const cl of cuttingLists) {
    events.push({
      kind: 'cutting_list',
      atISO: cl.date_iso || '',
      label: `Cutting list ${cl.status || 'Draft'}`,
      detail: cl.id,
      actor: cl.handled_by || null,
    });
  }

  const jobs = db
    .prepare(
      `SELECT job_id, status, created_at_iso, completed_at_iso, operator_name, planned_meters, actual_meters, conversion_alert_state
       FROM production_jobs WHERE quotation_ref = ? ORDER BY created_at_iso`
    )
    .all(id);
  for (const j of jobs) {
    events.push({
      kind: 'production_job',
      atISO: j.completed_at_iso || j.created_at_iso || '',
      label: `Production ${j.status}`,
      detail: j.job_id,
      actor: j.operator_name || null,
      meta: {
        plannedMeters: j.planned_meters,
        actualMeters: j.actual_meters,
        conversionAlertState: j.conversion_alert_state,
        varianceFlag: metreVarianceExceedsThreshold(j.planned_meters, j.actual_meters),
      },
    });
  }

  const refunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, requested_at_iso, approval_date, paid_at_iso, requested_by, approved_by, paid_by
       FROM customer_refunds WHERE quotation_ref = ? ORDER BY requested_at_iso`
    )
    .all(id);
  for (const r of refunds) {
    events.push({
      kind: 'refund',
      atISO: r.requested_at_iso || '',
      label: `Refund ${r.status}`,
      detail: `${r.refund_id} · ₦${Number(r.amount_ngn || 0).toLocaleString('en-NG')}`,
      actor: r.requested_by || null,
    });
    if (r.approval_date && r.status !== 'Pending') {
      events.push({
        kind: 'refund_approval',
        atISO: r.approval_date,
        label: `Refund ${r.status === 'Rejected' ? 'rejected' : 'approved'}`,
        detail: r.refund_id,
        actor: r.approved_by || null,
      });
    }
    if (r.paid_at_iso) {
      events.push({
        kind: 'refund_payout',
        atISO: r.paid_at_iso,
        label: 'Refund paid',
        detail: r.refund_id,
        actor: r.paid_by || null,
      });
    }
  }

  try {
    const treasury = db
      .prepare(
        `SELECT posted_at_iso, amount_ngn, reference, created_by FROM treasury_movements
         WHERE source_kind = 'REFUND' AND source_id IN (
           SELECT refund_id FROM customer_refunds WHERE quotation_ref = ?
         )
         ORDER BY posted_at_iso`
      )
      .all(id);
    for (const tm of treasury) {
      events.push({
        kind: 'treasury_payout',
        atISO: tm.posted_at_iso || '',
        label: 'Treasury refund payout',
        detail: tm.reference || null,
        actor: tm.created_by || null,
        meta: { amountNgn: tm.amount_ngn },
      });
    }
  } catch {
    /* treasury optional */
  }

  events.sort((a, b) => String(a.atISO).localeCompare(String(b.atISO)));

  return {
    ok: true,
    quotationId: id,
    customerName: quote.customer_name,
    events,
  };
}

function stageDone(done, label, detail = null) {
  return { key: label, label, status: done ? 'done' : 'pending', detail };
}

function stageBlocked(label, detail) {
  return { key: label, label, status: 'blocked', detail: detail || null };
}

function stageCurrent(label, detail = null) {
  return { key: label, label, status: 'current', detail };
}

/**
 * Compact transaction-stage checklist for Sales refund search (“why isn’t this quote in the list?”).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationId
 * @param {{
 *   meetsBackendRules?: boolean,
 *   wouldAppearInFreshDropdown?: boolean,
 *   wouldAppearInRefundQuotationDropdown?: boolean,
 *   blockingReasons?: string[],
 *   remainingRefundableNgn?: number | null,
 * }} [opts]
 */
export function buildQuotationRefundTransactionStages(db, quotationId, opts = {}) {
  const id = String(quotationId || '').trim();
  if (!id) return { ok: false, error: 'quotationId is required.' };
  const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get(id);
  if (!quote) return { ok: false, error: 'Quotation not found.' };

  const paidNgn = Math.round(Number(quote.paid_ngn) || 0);
  const totalNgn = Math.round(Number(quote.total_ngn) || 0);
  let receipts = [];
  try {
    receipts = db
      .prepare(
        `SELECT id, status, amount_ngn, finance_reconciliation_saved_at_iso
         FROM sales_receipts WHERE quotation_ref = ? ORDER BY date_iso ASC`
      )
      .all(id);
  } catch {
    receipts = [];
  }
  const cleared = receipts.filter(
    (r) =>
      String(r.finance_reconciliation_saved_at_iso || '').trim() ||
      /cleared|confirmed/i.test(String(r.status || ''))
  );
  let cutting = null;
  try {
    cutting = db
      .prepare(`SELECT id, status FROM cutting_lists WHERE quotation_ref = ? ORDER BY date_iso DESC LIMIT 1`)
      .get(id);
  } catch {
    cutting = null;
  }
  const jobs = db
    .prepare(
      `SELECT job_id,
              CASE WHEN TRIM(COALESCE(status, '')) = '' THEN 'Planned' ELSE TRIM(status) END AS st
       FROM production_jobs WHERE quotation_ref = ? ORDER BY job_id ASC`
    )
    .all(id);
  const openJob = jobs.find((j) => !/^(completed|cancelled)$/i.test(String(j.st || '')));
  const closedDone = jobs.some((j) => /^(completed|cancelled)$/i.test(String(j.st || '')));
  const refunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, credit_applied_ngn, paid_amount_ngn
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')
       ORDER BY requested_at_iso DESC`
    )
    .all(id);
  const activeRefunds = refunds;
  let creditOutNgn = 0;
  try {
    const creditAppliedOut = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE source_quotation_ref = ?
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')`
      )
      .get(id);
    creditOutNgn = Math.round(Number(creditAppliedOut?.s) || 0);
  } catch {
    creditOutNgn = 0;
  }

  /** @type {Array<{ key: string, label: string, status: string, detail: string | null }>} */
  const stages = [];
  stages.push(stageDone(true, 'Quotation created', quote.status || null));

  if (paidNgn > 0 || receipts.length) {
    const payDetail = `Paid ₦${paidNgn.toLocaleString('en-NG')}${
      totalNgn > 0 ? ` of ₦${totalNgn.toLocaleString('en-NG')}` : ''
    }; ${receipts.length} receipt(s)${cleared.length ? `, ${cleared.length} cleared` : ''}`;
    stages.push(stageDone(true, 'Customer payment', payDetail));
  } else {
    stages.push(stageBlocked('Customer payment', 'No payment recorded — refund picker requires cash on the quote.'));
  }

  if (cutting) {
    stages.push(stageDone(true, 'Cutting list', `${cutting.id} (${cutting.status || 'Draft'})`));
  } else {
    stages.push(stageDone(false, 'Cutting list', 'No cutting list yet (optional for some refund paths).'));
  }

  if (openJob) {
    stages.push(
      stageBlocked(
        'Production',
        `Job ${openJob.job_id} is still ${openJob.st} — finish or cancel before a refund request.`
      )
    );
  } else if (closedDone || String(quote.status || '').trim().toLowerCase() === 'void') {
    stages.push(
      stageDone(
        true,
        'Production closed',
        String(quote.status || '').trim().toLowerCase() === 'void'
          ? 'Void quotation'
          : jobs.map((j) => `${j.job_id}:${j.st}`).join(', ')
      )
    );
  } else {
    stages.push(
      stageBlocked(
        'Production closed',
        'No completed/cancelled production job (and not Void) — refund requests are not allowed yet.'
      )
    );
  }

  if (activeRefunds.length) {
    const summary = activeRefunds
      .slice(0, 3)
      .map((r) => {
        const credit = Math.round(Number(r.credit_applied_ngn) || 0);
        const creditBit = credit > 0 ? `, ₦${credit.toLocaleString('en-NG')} applied as fund` : '';
        return `${r.refund_id} ${r.status} ₦${Math.round(Number(r.amount_ngn) || 0).toLocaleString('en-NG')}${creditBit}`;
      })
      .join('; ');
    stages.push(
      stageCurrent(
        'Prior refunds on file',
        `${activeRefunds.length} active refund(s): ${summary}. Not shown in the fresh selector — search this quotation id for any leftover claim.`
      )
    );
  } else if (creditOutNgn > 0) {
    stages.push(
      stageCurrent(
        'Refund fund already applied out',
        `₦${creditOutNgn.toLocaleString('en-NG')} overpay credit already applied to another receipt. Search this quotation for leftover headroom.`
      )
    );
  } else {
    stages.push(stageDone(false, 'Prior refunds on file', 'No active refund yet — eligible for the fresh selector when other rules pass.'));
  }

  const freshOk = opts.wouldAppearInFreshDropdown === true;
  const anyOk = opts.wouldAppearInRefundQuotationDropdown === true;
  if (freshOk) {
    stages.push(stageDone(true, 'Refund picker', 'Appears in the fresh refund quotation selector.'));
  } else if (anyOk) {
    stages.push(
      stageCurrent(
        'Refund picker',
        'Has a possible extra / follow-up refund — search by quotation id (not in the default fresh list).'
      )
    );
  } else if (opts.meetsBackendRules === false || (Array.isArray(opts.blockingReasons) && opts.blockingReasons.length)) {
    const why = (opts.blockingReasons || []).filter(Boolean).join(' · ') || 'Does not meet refund listing rules.';
    stages.push(stageBlocked('Refund picker', why));
  } else {
    stages.push(stageBlocked('Refund picker', 'Not currently listed for a new refund request.'));
  }

  const current =
    [...stages].reverse().find((s) => s.status === 'blocked' || s.status === 'current') ||
    stages[stages.length - 1];

  return {
    ok: true,
    quotationId: id,
    currentStage: current
      ? { key: current.key, label: current.label, status: current.status, detail: current.detail }
      : null,
    stages,
    priorRefundCount: activeRefunds.length,
    creditAppliedOutNgn: creditOutNgn,
    freshRefundOpportunity: activeRefunds.length === 0 && creditOutNgn <= 0,
  };
}
