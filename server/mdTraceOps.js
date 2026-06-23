/**
 * MD Trace — stratified daily transaction samples with A→Z timelines.
 */
import { getBranch } from './branches.js';
import { branchWhere } from './readModel.js';

function hashSeed(input) {
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickIndex(seed, key, length) {
  if (!length) return -1;
  return hashSeed(`${seed}:${key}`) % length;
}

function branchLabel(db, branchId) {
  if (!branchId) return '—';
  const b = getBranch(db, branchId);
  return b?.name || branchId;
}

function step(label, detail, atIso = null, docRef = null) {
  return {
    step: label,
    detail: String(detail || '').trim() || '—',
    atIso: atIso ? String(atIso).slice(0, 19) : null,
    docRef: docRef ? String(docRef).trim() : null,
  };
}

function outcomeFromSteps(steps, statusHint) {
  const st = String(statusHint || '').toLowerCase();
  if (st.includes('reject') || st.includes('cancel')) return 'exception';
  if (steps.every((s) => s.detail && s.detail !== '—')) return 'complete';
  return 'partial';
}

function sampleSalesChain(db, branchScope, seed) {
  const bq = branchWhere(db, 'quotations', branchScope);
  const rows = db
    .prepare(
      `SELECT id, customer_name, total_ngn, paid_ngn, date_iso, branch_id, status
       FROM quotations
       WHERE COALESCE(paid_ngn, 0) > 0 ${bq.sql}
       ORDER BY date_iso DESC LIMIT 80`
    )
    .all(...bq.args);
  const idx = pickIndex(seed, 'sales', rows.length);
  if (idx < 0) return null;
  const q = rows[idx];
  const qid = String(q.id || '').trim();
  const receipt = db
    .prepare(
      `SELECT receipt_id, amount_ngn, date_iso, bank_confirmed_at_iso
       FROM sales_receipts WHERE quotation_ref = ? ORDER BY date_iso DESC LIMIT 1`
    )
    .get(qid);
  const cl = db
    .prepare(`SELECT id, status FROM cutting_lists WHERE quotation_ref = ? ORDER BY id DESC LIMIT 1`)
    .get(qid);
  const job = db
    .prepare(
      `SELECT job_id, status, completed_at_iso FROM production_jobs WHERE quotation_ref = ? ORDER BY completed_at_iso DESC LIMIT 1`
    )
    .get(qid);

  const steps = [
    step('A · Quote created', `${qid} · ${q.customer_name || 'Customer'}`, q.date_iso, qid),
    step(
      'B · Customer paid',
      receipt
        ? `${receipt.receipt_id || 'Receipt'} · ₦${Math.round(Number(receipt.amount_ngn) || 0).toLocaleString('en-NG')}`
        : `Paid ₦${Math.round(Number(q.paid_ngn) || 0).toLocaleString('en-NG')} on quote`,
      receipt?.date_iso || q.date_iso,
      receipt?.receipt_id || qid
    ),
    step(
      'C · Cutting list',
      cl ? `${cl.id} · ${cl.status || 'draft'}` : 'No cutting list yet',
      null,
      cl?.id || null
    ),
    step(
      'D · Production',
      job ? `${job.job_id} · ${job.status || '—'}` : 'Not on production floor',
      job?.completed_at_iso || null,
      job?.job_id || null
    ),
    step(
      'E · Outcome',
      job?.status === 'Completed'
        ? 'Job completed'
        : cl
          ? 'Awaiting / in production'
          : 'Commercial only',
      job?.completed_at_iso || receipt?.date_iso || q.date_iso,
      qid
    ),
  ];

  return {
    domain: 'sales',
    domainLabel: 'Sales chain',
    entityRef: qid,
    title: qid,
    subtitle: q.customer_name || 'Customer',
    branchId: q.branch_id || '',
    branchName: branchLabel(db, q.branch_id),
    amountNgn: Math.round(Number(q.total_ngn) || 0),
    outcome: outcomeFromSteps(steps, job?.status),
    timeline: steps,
  };
}

function sampleReceipt(db, branchScope, seed) {
  const bq = branchWhere(db, 'sales_receipts', branchScope);
  const rows = db
    .prepare(
      `SELECT receipt_id, quotation_ref, amount_ngn, date_iso, branch_id, bank_confirmed_at_iso
       FROM sales_receipts WHERE 1=1 ${bq.sql}
       ORDER BY date_iso DESC LIMIT 60`
    )
    .all(...bq.args);
  const idx = pickIndex(seed, 'receipt', rows.length);
  if (idx < 0) return null;
  const r = rows[idx];
  const confirmed = r.bank_confirmed_at_iso ? 'Bank confirmed' : 'Awaiting bank confirmation';
  const steps = [
    step('A · Receipt posted', r.receipt_id, r.date_iso, r.receipt_id),
    step('B · Linked quote', r.quotation_ref || '—', r.date_iso, r.quotation_ref),
    step('C · Cash in', `₦${Math.round(Number(r.amount_ngn) || 0).toLocaleString('en-NG')}`, r.date_iso),
    step('D · Bank match', confirmed, r.bank_confirmed_at_iso || null),
    step('E · Outcome', r.bank_confirmed_at_iso ? 'Confirmed in treasury' : 'Pending confirmation', r.bank_confirmed_at_iso || r.date_iso),
  ];
  return {
    domain: 'collections',
    domainLabel: 'Collections',
    entityRef: r.receipt_id,
    title: r.receipt_id,
    subtitle: r.quotation_ref || 'Receipt',
    branchId: r.branch_id || '',
    branchName: branchLabel(db, r.branch_id),
    amountNgn: Math.round(Number(r.amount_ngn) || 0),
    outcome: r.bank_confirmed_at_iso ? 'complete' : 'partial',
    timeline: steps,
  };
}

function sampleProcurement(db, branchScope, seed) {
  const bq = branchWhere(db, 'purchase_orders', branchScope);
  const rows = db
    .prepare(
      `SELECT po_id, supplier_name, status, order_date_iso, branch_id, supplier_paid_ngn
       FROM purchase_orders WHERE 1=1 ${bq.sql}
       ORDER BY order_date_iso DESC LIMIT 50`
    )
    .all(...bq.args);
  const idx = pickIndex(seed, 'procurement', rows.length);
  if (idx < 0) return null;
  const po = rows[idx];
  const poid = String(po.po_id || '').trim();
  const steps = [
    step('A · PO created', `${poid} · ${po.supplier_name || 'Supplier'}`, po.order_date_iso, poid),
    step('B · Status', po.status || '—', po.order_date_iso, poid),
    step('C · Commitment', `₦${Math.round(Number(po.supplier_paid_ngn) || 0).toLocaleString('en-NG')}`, po.order_date_iso),
    step('D · Branch', branchLabel(db, po.branch_id), null, po.branch_id),
    step('E · Outcome', String(po.status || '').toLowerCase().includes('received') ? 'Received' : 'Open pipeline', po.order_date_iso),
  ];
  return {
    domain: 'procurement',
    domainLabel: 'Procurement',
    entityRef: poid,
    title: poid,
    subtitle: po.supplier_name || 'Supplier',
    branchId: po.branch_id || '',
    branchName: branchLabel(db, po.branch_id),
    amountNgn: Math.round(Number(po.supplier_paid_ngn) || 0),
    outcome: String(po.status || '').toLowerCase().includes('received') ? 'complete' : 'partial',
    timeline: steps,
  };
}

function sampleProduction(db, branchScope, seed) {
  const bq = branchWhere(db, 'production_jobs', branchScope);
  const rows = db
    .prepare(
      `SELECT job_id, quotation_ref, status, completed_at_iso, branch_id, product_name
       FROM production_jobs
       WHERE TRIM(LOWER(COALESCE(status,''))) = 'completed' ${bq.sql}
       ORDER BY completed_at_iso DESC LIMIT 50`
    )
    .all(...bq.args);
  const idx = pickIndex(seed, 'production', rows.length);
  if (idx < 0) return null;
  const j = rows[idx];
  const steps = [
    step('A · Job', j.job_id, j.completed_at_iso, j.job_id),
    step('B · Quote', j.quotation_ref || '—', null, j.quotation_ref),
    step('C · Product', j.product_name || '—', null),
    step('D · Completed', j.completed_at_iso || '—', j.completed_at_iso),
    step('E · Outcome', 'Factory output recorded', j.completed_at_iso, j.job_id),
  ];
  return {
    domain: 'operations',
    domainLabel: 'Production',
    entityRef: j.job_id,
    title: j.job_id,
    subtitle: j.product_name || j.quotation_ref || 'Job',
    branchId: j.branch_id || '',
    branchName: branchLabel(db, j.branch_id),
    amountNgn: null,
    outcome: 'complete',
    timeline: steps,
  };
}

function samplePaymentRequest(db, branchScope, seed) {
  const bq = branchWhere(db, 'expenses', branchScope);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT pr.request_id, pr.amount_requested_ngn, pr.approval_status, pr.request_date, pr.description, e.branch_id
         FROM payment_requests pr
         LEFT JOIN expenses e ON e.expense_id = pr.expense_id
         WHERE TRIM(LOWER(COALESCE(pr.approval_status,''))) = 'approved' ${bq.sql.replace(/branch_id/g, 'e.branch_id')}
         ORDER BY pr.request_date DESC LIMIT 40`
      )
      .all(...bq.args);
  } catch {
    rows = [];
  }
  const idx = pickIndex(seed, 'payment', rows.length);
  if (idx < 0) return null;
  const p = rows[idx];
  const steps = [
    step('A · Request', p.request_id, p.request_date, p.request_id),
    step('B · Purpose', (p.description || 'Payment').slice(0, 120), p.request_date),
    step('C · Approved', p.approval_status || 'Approved', p.request_date),
    step('D · Amount', `₦${Math.round(Number(p.amount_requested_ngn) || 0).toLocaleString('en-NG')}`, p.request_date),
    step('E · Outcome', 'Ready for finance payout', p.request_date, p.request_id),
  ];
  return {
    domain: 'finance',
    domainLabel: 'Finance',
    entityRef: p.request_id,
    title: p.request_id,
    subtitle: (p.description || 'Payment request').slice(0, 80),
    branchId: p.branch_id || '',
    branchName: branchLabel(db, p.branch_id),
    amountNgn: Math.round(Number(p.amount_requested_ngn) || 0),
    outcome: 'complete',
    timeline: steps,
  };
}

function sampleException(db, branchScope, seed) {
  const bq = branchWhere(db, 'customer_refunds', branchScope);
  const rows = db
    .prepare(
      `SELECT refund_id, quotation_ref, amount_ngn, status, requested_at_iso, branch_id, reason_category
       FROM customer_refunds WHERE 1=1 ${bq.sql}
       ORDER BY requested_at_iso DESC LIMIT 40`
    )
    .all(...bq.args);
  const idx = pickIndex(seed, 'exception', rows.length);
  if (idx < 0) return null;
  const r = rows[idx];
  const steps = [
    step('A · Refund requested', r.refund_id, r.requested_at_iso, r.refund_id),
    step('B · Quote', r.quotation_ref || '—', r.requested_at_iso, r.quotation_ref),
    step('C · Reason', r.reason_category || '—', r.requested_at_iso),
    step('D · Status', r.status || 'Pending', r.requested_at_iso),
    step('E · Outcome', String(r.status || '').toLowerCase().includes('paid') ? 'Paid out' : 'In approval pipeline', r.requested_at_iso),
  ];
  return {
    domain: 'governance',
    domainLabel: 'Exception',
    entityRef: r.refund_id,
    title: r.refund_id,
    subtitle: r.reason_category || 'Refund',
    branchId: r.branch_id || '',
    branchName: branchLabel(db, r.branch_id),
    amountNgn: Math.round(Number(r.amount_ngn) || 0),
    outcome: String(r.status || '').toLowerCase().includes('reject') ? 'exception' : 'partial',
    timeline: steps,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string; dateISO?: string; shuffleNonce?: string }} opts
 */
export function buildMdTracePack(db, opts = {}) {
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const dateISO = String(opts.dateISO || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const seed = `${dateISO}:${branchScope}:${String(opts.shuffleNonce || '').trim()}`;

  const builders = [
    sampleSalesChain,
    sampleReceipt,
    sampleProcurement,
    sampleProduction,
    samplePaymentRequest,
    sampleException,
  ];

  const samples = [];
  for (const fn of builders) {
    try {
      const row = fn(db, branchScope, seed);
      if (row) samples.push(row);
    } catch {
      /* optional tables */
    }
  }

  return {
    ok: true,
    dateISO,
    branchScope,
    seedLabel: opts.shuffleNonce ? 'shuffled' : 'daily',
    generatedAtIso: new Date().toISOString(),
    sampleCount: samples.length,
    samples,
    notes: [
      'Samples are stratified by domain — one story per area per day.',
      'Use shuffle for a fresh set; daily seed is stable until midnight.',
    ],
  };
}
