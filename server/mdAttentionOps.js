/**
 * Unified MD / executive attention inbox — scored queue across management work types.
 */
import { listManagementItems } from './readModel.js';
import { listPendingEditApprovals } from './editApproval.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { buildPendingApprovalsReport, buildProductionStatusReport } from './operationalReportsOps.js';

function daysSince(iso) {
  const s = String(iso || '').trim();
  if (!s) return 999;
  const t = Date.parse(s.length <= 10 ? `${s}T12:00:00` : s);
  if (Number.isNaN(t)) return 999;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function pushItem(out, row) {
  out.push(row);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function listMdAttentionInbox(db, branchScope = 'ALL') {
  const limits = getOrgGovernanceLimits(db);
  const expenseHi = limits.expenseExecutiveThresholdNgn;
  const refundHi = limits.refundExecutiveThresholdNgn;
  const raw = listManagementItems(db, branchScope);
  const items = [];

  for (const q of raw.pendingClearance || []) {
    const amt = Number(q.total_ngn) || 0;
    const paid = Number(q.paid_ngn) || 0;
    const age = daysSince(q.date_iso);
    const reasons = ['Paid quotation not manager-cleared'];
    if (paid < amt * 0.7) reasons.push('Below 70% paid with cutting list risk');
    if (amt >= expenseHi) reasons.push('High order value');
    if (age >= 7) reasons.push('Aging 7+ days');
    pushItem(items, {
      id: `clearance:${q.id}`,
      kind: 'clearance',
      priority: 70 + (amt >= expenseHi ? 15 : 0) + Math.min(age, 14),
      quotationRef: q.id,
      title: q.id,
      subtitle: q.customer_name || 'Customer',
      amountNgn: amt,
      atIso: q.date_iso,
      branchId: q.branch_id || '',
      reasons,
      row: q,
    });
  }

  for (const q of raw.flagged || []) {
    const amt = Number(q.total_ngn) || 0;
    pushItem(items, {
      id: `flagged:${q.id}`,
      kind: 'flagged',
      priority: 92,
      quotationRef: q.id,
      title: q.id,
      subtitle: q.manager_flag_reason || q.customer_name || 'Flagged',
      amountNgn: amt,
      atIso: q.manager_flagged_at_iso,
      branchId: q.branch_id || '',
      reasons: ['Manager flagged for audit', String(q.manager_flag_reason || '').trim()].filter(Boolean),
      row: q,
    });
  }

  for (const cl of raw.productionOverrides || []) {
    const pct = Number(cl.total_ngn) > 0 ? Math.round((Number(cl.paid_ngn) / Number(cl.total_ngn)) * 100) : 0;
    pushItem(items, {
      id: `production_gate:${cl.quotation_ref || cl.id}`,
      kind: 'production',
      priority: 78,
      quotationRef: cl.quotation_ref || '',
      cuttingListId: cl.id,
      title: cl.quotation_ref || cl.id,
      subtitle: `${cl.customer_name || 'Customer'} · CL ${cl.id}`,
      amountNgn: Number(cl.total_ngn) || 0,
      atIso: null,
      branchId: cl.branch_id || '',
      reasons: [`Production blocked — ${pct}% paid on quote`, 'Cutting list still draft'],
      row: cl,
    });
  }

  for (const j of raw.pendingConversionReviews || []) {
    const st = String(j.conversion_alert_state || '').trim().toUpperCase();
    pushItem(items, {
      id: `conversion:${j.job_id}`,
      kind: 'conversions',
      priority: 65 + (st === 'HIGH' || st === 'LOW' ? 12 : 0) + (j.manager_review_required ? 8 : 0),
      quotationRef: j.quotation_ref || '',
      jobId: j.job_id,
      title: j.job_id,
      subtitle: `${j.customer_name || ''} · ${j.product_name || 'Job'}`,
      amountNgn: null,
      atIso: j.completed_at_iso,
      branchId: j.branch_id || '',
      reasons: [
        'Conversion review required',
        st ? `Conversion ${st}` : null,
        j.manager_review_required ? 'Manager review flag' : null,
      ].filter(Boolean),
      row: j,
    });
  }

  for (const r of raw.pendingRefunds || []) {
    const amt = Number(r.amount_ngn) || 0;
    pushItem(items, {
      id: `refund:${r.refund_id}`,
      kind: 'refunds',
      priority: 74 + (amt >= refundHi ? 12 : 0),
      quotationRef: r.quotation_ref || '',
      refundId: r.refund_id,
      title: r.refund_id,
      subtitle: `${r.customer_name || ''} · ${r.reason_category || 'Refund'}`,
      amountNgn: amt,
      atIso: r.requested_at_iso,
      branchId: r.branch_id || '',
      reasons: ['Pending refund approval', amt >= refundHi ? 'Above executive refund threshold' : null].filter(Boolean),
      row: r,
    });
  }

  for (const p of raw.pendingExpenses || []) {
    const amt = Number(p.amount_requested_ngn) || 0;
    pushItem(items, {
      id: `payment:${p.request_id}`,
      kind: 'payments',
      priority: 76 + (amt >= expenseHi ? 14 : 0),
      requestId: p.request_id,
      title: p.request_id,
      subtitle: p.description || p.expense_category || 'Payment request',
      amountNgn: amt,
      atIso: p.request_date,
      branchId: p.branch_id || '',
      reasons: ['Pending payment approval', amt >= expenseHi ? 'Large payment' : null].filter(Boolean),
      row: p,
    });
  }

  for (const m of raw.pendingMaterialIncidents || []) {
    pushItem(items, {
      id: `material:${m.id}`,
      kind: 'material',
      priority: 62,
      title: m.id,
      subtitle: `${m.incident_type || 'Incident'} · ${m.gauge_label || ''} ${m.colour || ''}`.trim(),
      amountNgn: null,
      atIso: m.date_iso,
      branchId: m.branch_id || '',
      reasons: ['Material exception awaiting approval'],
      row: m,
    });
  }

  for (const e of listPendingEditApprovals(db, 80)) {
    const ek = String(e.entityKind || '').trim();
    const eid = String(e.entityId || '').trim();
    pushItem(items, {
      id: `edit:${e.id}`,
      kind: 'edit_approvals',
      priority: 82,
      quotationRef: ek === 'quotation' ? eid : '',
      poId: ek === 'purchase_order' ? eid : '',
      title: `${ek} ${eid}`.trim(),
      subtitle: `Edit by ${e.requestedByDisplay || e.requestedByUserId || 'user'}`,
      amountNgn: null,
      atIso: e.requestedAtISO,
      branchId: e.branchId || '',
      reasons: ['Second approval required before save'],
      row: e,
    });
  }

  const opsPending = buildPendingApprovalsReport(db, branchScope);
  for (const w of opsPending.dualControlWarnings || []) {
    pushItem(items, {
      id: `dual_control:${w.refundId}:${w.kind}`,
      kind: 'governance',
      priority: 88,
      refundId: w.refundId,
      title: w.refundId,
      subtitle: w.message || 'Dual-control segregation warning',
      amountNgn: null,
      atIso: null,
      branchId: '',
      reasons: ['Dual-control segregation', w.kind === 'same_requester_approver' ? 'Requester = approver' : 'Approver = payer'],
      row: w,
    });
  }

  const prodStatus = buildProductionStatusReport(db, branchScope);
  for (const pg of prodStatus.paymentGateExceptions || []) {
    pushItem(items, {
      id: `payment_gate:${pg.jobId}`,
      kind: 'governance',
      priority: 80,
      quotationRef: pg.quotationRef || '',
      jobId: pg.jobId,
      title: pg.quotationRef || pg.jobId,
      subtitle: `Completed job · ${pg.paidPct ?? '?'}% paid · no BM production override`,
      amountNgn: null,
      atIso: null,
      branchId: '',
      reasons: ['Payment gate breach on completed production'],
      row: pg,
    });
  }

  items.sort((a, b) => b.priority - a.priority || String(b.atIso || '').localeCompare(String(a.atIso || '')));

  const summary = {
    total: items.length,
    byKind: items.reduce((acc, it) => {
      acc[it.kind] = (acc[it.kind] || 0) + 1;
      return acc;
    }, {}),
  };

  return { ok: true, branchScope, summary, items };
}
