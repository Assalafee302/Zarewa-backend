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
      kind: 'price_exception_bm_legacy',
      atISO: quote.bm_price_exception_approved_at_iso,
      label: 'Legacy BM price exception (superseded)',
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
