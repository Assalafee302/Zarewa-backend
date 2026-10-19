/**
 * "Needs attention" rules — one definition per flag, shared by server and frontend.
 * Frontend copy via `npm run sync:shared` → src/shared/lib/attentionRules.js
 *
 * Each rule owns:
 *   - the sentence shown on the row, in the banner and in the bell (built from the record's own numbers),
 *   - the evidence shown beside the sentence (quote vs paid, who approved vs who paid, …),
 *   - the field to highlight on the opened record,
 *   - the actions that clear it,
 *   - the deep link that opens the record on that problem.
 *
 * Which records get flagged is still decided where it always was (server/mdAttentionOps.js, the cashier
 * desk queues, the reports exception queue). This file only says what is wrong, in words, from those records,
 * so a row, its banner and any count/badge can never disagree.
 */
import { EXPENSE_MD_APPROVAL_THRESHOLD_NGN, REFUND_MD_APPROVAL_THRESHOLD_NGN } from '../workspaceGovernance.js';

/* ------------------------------------------------------------------ formatting */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** ₦1,408,453 — integer naira, fixed format (no locale dependency). */
export function attentionNgn(v) {
  const n = Math.round(num(v));
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '−' : ''}₦${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Lagos calendar day (UTC+1, no DST) of an ISO date or timestamp → "YYYY-MM-DD". */
function lagosYmd(iso) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  return new Date(t + 3600_000).toISOString().slice(0, 10);
}

/** "16 Oct" (adds the year when it is not the current year). */
export function attentionDay(iso, nowIso) {
  const ymd = lagosYmd(iso);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const nowY = Number(lagosYmd(nowIso || new Date().toISOString()).slice(0, 4));
  return `${d} ${MONTHS[m - 1]}${y !== nowY ? ` ${y}` : ''}`;
}

/** Whole Lagos days between `iso` and now; null when the date is unknown. */
export function attentionAgeDays(iso, nowIso) {
  const a = lagosYmd(iso);
  const b = lagosYmd(nowIso || new Date().toISOString());
  if (!a || !b) return null;
  return Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000));
}

/** "today" / "1 day" / "11 days"; '' when unknown. */
export function attentionAgeLabel(days) {
  if (days == null) return '';
  if (days === 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

const pct = (part, whole) => (num(whole) > 0 ? Math.round((num(part) / num(whole)) * 100) : 0);
const clean = (v) => String(v ?? '').trim();
const pick = (...vals) => {
  for (const v of vals) {
    const s = clean(v);
    if (s) return s;
  }
  return '';
};
const pickNum = (...vals) => {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const quote = (s) => `“${clean(s)}”`;
/** " — 3 days" when the age is known. */
const waited = (f) => (f.ageDays == null ? '' : f.ageDays === 0 ? ' — since today' : ` — ${attentionAgeLabel(f.ageDays)}`);

function parseReasonCategories(raw) {
  if (Array.isArray(raw)) return raw.map(clean).filter(Boolean);
  const s = clean(raw);
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(clean).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return s.split(/[,;]/).map(clean).filter(Boolean);
}

/* ------------------------------------------------------------------ groups + actions */

/** MD list groups, in display order. */
export const ATTENTION_GROUPS = {
  controls: 'Control breaches',
  refunds: 'Refunds',
  cash_out: 'Payments & withdrawals',
  sales: 'Quotes & pricing',
  production: 'Production',
  people: 'Payroll, overtime & staff credit',
  stock: 'Stock',
  edits: 'Edits waiting for second approval',
  cash_in: 'Receipts',
  office: 'Memos & other work',
};

/** Clearing actions. `kind: 'decide'` = the record's own decision control; `kind: 'link'` = go somewhere else. */
export const ATTENTION_ACTIONS = {
  approve: { label: 'Approve', kind: 'decide' },
  reject: { label: 'Reject', kind: 'decide' },
  clear: { label: 'Clear', kind: 'decide' },
  flag: { label: 'Flag', kind: 'decide' },
  override: { label: 'Allow production', kind: 'decide' },
  sign_off: { label: 'Sign off', kind: 'decide' },
  acknowledge: { label: 'Acknowledge with note', kind: 'decide' },
  fix: { label: 'Fix', kind: 'link' },
  assign: { label: 'Assign Branch Manager', kind: 'link' },
  open: { label: 'Open record', kind: 'link' },
  ask_cashier: { label: 'Ask cashier', kind: 'link' },
  pay: { label: 'Pay', kind: 'link' },
};

/* ------------------------------------------------------------------ rules */

/**
 * @typedef {{ label: string, value: string, tone?: 'bad' | 'ok' | 'muted' }} AttentionEvidence
 * @typedef {{
 *   group: keyof typeof ATTENTION_GROUPS,
 *   label: string,
 *   severity: 'critical' | 'warning' | 'info',
 *   focus: string,
 *   actions: (keyof typeof ATTENTION_ACTIONS)[],
 *   message: (f: object) => string,
 *   evidence: (f: object) => AttentionEvidence[],
 * }} AttentionRule
 */

/** @type {Record<string, AttentionRule>} */
export const ATTENTION_RULES = {
  /* ---- quotes */
  quote_overpaid: {
    group: 'sales',
    label: 'Paid above the quote',
    severity: 'critical',
    focus: 'paid',
    actions: ['clear', 'flag'],
    message: (f) =>
      `Paid ${attentionNgn(f.paidNgn)} against a ${attentionNgn(f.totalNgn)} quote — ${attentionNgn(f.paidNgn - f.totalNgn)} above`,
    evidence: (f) => [
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
      { label: 'Paid', value: attentionNgn(f.paidNgn), tone: 'bad' },
      { label: 'Above quote', value: attentionNgn(f.paidNgn - f.totalNgn), tone: 'bad' },
    ],
  },
  quote_not_cleared: {
    group: 'sales',
    label: 'Paid quote not cleared',
    severity: 'warning',
    focus: 'paid',
    actions: ['clear', 'flag'],
    message: (f) =>
      `${f.quotationRef}: ${attentionNgn(f.paidNgn)} paid of ${attentionNgn(f.totalNgn)} (${pct(f.paidNgn, f.totalNgn)}%) and not yet cleared by a manager${waited(f)}`,
    evidence: (f) => [
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
      { label: 'Paid', value: `${attentionNgn(f.paidNgn)} (${pct(f.paidNgn, f.totalNgn)}%)` },
      { label: 'Quote date', value: attentionDay(f.atIso, f.nowIso) || '—' },
    ],
  },
  quote_below_production_gate: {
    group: 'sales',
    label: 'Below 70% paid',
    severity: 'warning',
    focus: 'paid',
    actions: ['clear', 'flag'],
    message: (f) =>
      `Only ${pct(f.paidNgn, f.totalNgn)}% paid (${attentionNgn(f.paidNgn)} of ${attentionNgn(f.totalNgn)}) — 70% is needed before production`,
    evidence: (f) => [
      { label: 'Paid', value: `${attentionNgn(f.paidNgn)} (${pct(f.paidNgn, f.totalNgn)}%)`, tone: 'bad' },
      { label: '70% of quote', value: attentionNgn(Math.ceil(f.totalNgn * 0.7)) },
      { label: 'Short of 70%', value: attentionNgn(Math.max(0, Math.ceil(f.totalNgn * 0.7) - f.paidNgn)), tone: 'bad' },
    ],
  },
  quote_high_value: {
    group: 'sales',
    label: 'Large order',
    severity: 'info',
    focus: 'total',
    actions: ['clear', 'flag'],
    message: (f) =>
      `Quote ${attentionNgn(f.totalNgn)} is at or above the ${attentionNgn(f.thresholdNgn)} executive limit`,
    evidence: (f) => [
      { label: 'Quote total', value: attentionNgn(f.totalNgn), tone: 'bad' },
      { label: 'Executive limit', value: attentionNgn(f.thresholdNgn) },
    ],
  },
  quote_below_floor: {
    group: 'sales',
    label: 'Below floor price',
    severity: 'warning',
    focus: 'price',
    actions: ['approve', 'reject'],
    message: (f) => {
      const worst = f.worstLine;
      const where = worst
        ? `${worst.name} quoted ${attentionNgn(worst.quotedPerMeter)}/m vs floor ${attentionNgn(worst.floorPerMeter)}/m (${attentionNgn(worst.floorPerMeter - worst.quotedPerMeter)}/m below)`
        : 'priced below the floor';
      const more = f.belowLineCount > 1 ? ` and ${f.belowLineCount - 1} more line${f.belowLineCount > 2 ? 's' : ''}` : '';
      return `${f.quotationRef}: ${where}${more}; ${attentionNgn(f.paidNgn)} already paid — needs BM or MD approval${waited(f)}`;
    },
    evidence: (f) => [
      ...(f.belowLines || []).slice(0, 3).map((l) => ({
        label: l.name,
        value: `${attentionNgn(l.quotedPerMeter)}/m vs floor ${attentionNgn(l.floorPerMeter)}/m`,
        tone: 'bad',
      })),
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
      { label: 'Paid', value: attentionNgn(f.paidNgn) },
    ],
  },
  quote_flagged: {
    group: 'controls',
    label: 'Flagged for audit',
    severity: 'critical',
    focus: 'flag',
    actions: ['clear'],
    message: (f) =>
      `${f.quotationRef} flagged for audit${f.atIso ? ` on ${attentionDay(f.atIso, f.nowIso)}` : ''}: ${f.flagReason ? quote(f.flagReason) : 'no reason given'}${waited(f)}`,
    evidence: (f) => [
      { label: 'Reason', value: f.flagReason || '—', tone: 'bad' },
      { label: 'Flagged on', value: attentionDay(f.atIso, f.nowIso) || '—' },
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
    ],
  },

  /* ---- production */
  production_held_unpaid: {
    group: 'production',
    label: 'Cutting list held — under 70% paid',
    severity: 'warning',
    focus: 'paid',
    actions: ['override', 'open'],
    message: (f) =>
      `Cutting list ${f.cuttingListId} for ${f.quotationRef} is held: ${pct(f.paidNgn, f.totalNgn)}% paid (${attentionNgn(f.paidNgn)} of ${attentionNgn(f.totalNgn)}) — ${attentionNgn(Math.max(0, Math.ceil(f.totalNgn * 0.7) - f.paidNgn))} more needed for 70%`,
    evidence: (f) => [
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
      { label: 'Paid', value: `${attentionNgn(f.paidNgn)} (${pct(f.paidNgn, f.totalNgn)}%)`, tone: 'bad' },
      { label: 'Needed for 70%', value: attentionNgn(Math.ceil(f.totalNgn * 0.7)) },
    ],
  },
  production_gate_breach: {
    group: 'controls',
    label: 'Produced before 70% paid',
    severity: 'critical',
    focus: 'paid',
    actions: ['override', 'open'],
    message: (f) =>
      `Job ${f.jobId} completed${f.atIso ? ` ${attentionDay(f.atIso, f.nowIso)}` : ''} with only ${f.paidPct ?? pct(f.paidNgn, f.totalNgn)}% paid (${attentionNgn(f.paidNgn)} of ${attentionNgn(f.totalNgn)}) and no manager override — ${attentionNgn(f.outstandingNgn ?? f.totalNgn - f.paidNgn)} outstanding`,
    evidence: (f) => [
      { label: 'Quote total', value: attentionNgn(f.totalNgn) },
      { label: 'Paid', value: `${attentionNgn(f.paidNgn)} (${f.paidPct ?? pct(f.paidNgn, f.totalNgn)}%)`, tone: 'bad' },
      { label: 'Outstanding', value: attentionNgn(f.outstandingNgn ?? f.totalNgn - f.paidNgn), tone: 'bad' },
      { label: 'Completed', value: attentionDay(f.atIso, f.nowIso) || '—' },
    ],
  },
  conversion_unsigned: {
    group: 'production',
    label: 'Conversion check not signed',
    severity: 'warning',
    focus: 'conversion',
    actions: ['sign_off'],
    message: (f) => {
      const made =
        f.actualMeters > 0 && f.actualKg > 0
          ? `made ${Math.round(f.actualMeters).toLocaleString('en-US')} m from ${Math.round(f.actualKg).toLocaleString('en-US')} kg (${(f.actualKg / f.actualMeters).toFixed(2)} kg/m)`
          : f.actualMeters > 0
            ? `made ${Math.round(f.actualMeters).toLocaleString('en-US')} m`
            : 'completed';
      const state = f.alertState ? ` — conversion ${f.alertState}` : ' — manager review required';
      return `Job ${f.jobId}${f.quotationRef ? ` (${f.quotationRef})` : ''} ${made}${state}, not signed off${waited(f)}`;
    },
    evidence: (f) => [
      { label: 'Metres made', value: f.actualMeters > 0 ? `${Math.round(f.actualMeters)} m` : '—' },
      { label: 'Coil used', value: f.actualKg > 0 ? `${Math.round(f.actualKg)} kg` : '—' },
      { label: 'Conversion', value: f.alertState || 'Review required', tone: 'bad' },
      ...(f.varianceReason ? [{ label: 'Reason given', value: f.varianceReason }] : []),
    ],
  },

  /* ---- refunds */
  refund_pending: {
    group: 'refunds',
    label: 'Refund waiting for approval',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Refund ${attentionNgn(f.amountNgn)} to ${f.customer || 'customer'}${f.reasons.length ? ` (${f.reasons.join(', ')})` : ''} requested ${attentionDay(f.atIso, f.nowIso) || '—'} is waiting for approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
      { label: 'Reason', value: f.reasons.join(', ') || '—' },
      { label: 'Quotation', value: f.quotationRef || '—' },
      { label: 'Requested', value: attentionDay(f.atIso, f.nowIso) || '—' },
    ],
  },
  refund_above_limit: {
    group: 'refunds',
    label: 'Above executive refund limit',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `${attentionNgn(f.amountNgn)} is above the ${attentionNgn(f.thresholdNgn)} refund limit — MD/CEO must approve`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn), tone: 'bad' },
      { label: 'Limit', value: attentionNgn(f.thresholdNgn) },
    ],
  },
  refund_md_discount: {
    group: 'refunds',
    label: 'MD discount refund',
    severity: 'warning',
    focus: 'reason',
    actions: ['approve', 'reject'],
    message: () => 'Reason includes an MD discount — only MD/CEO can approve',
    evidence: (f) => [{ label: 'Reason', value: f.reasons.join(', ') || '—', tone: 'bad' }],
  },
  refund_unpaid: {
    group: 'refunds',
    label: 'Approved refund not paid',
    severity: 'warning',
    focus: 'amount',
    actions: ['pay', 'open'],
    message: (f) =>
      `Refund ${attentionNgn(f.amountNgn)} approved ${attentionDay(f.atIso, f.nowIso) || '—'} is still unpaid${waited(f)}`,
    evidence: (f) => [
      { label: 'Approved amount', value: attentionNgn(f.amountNgn) },
      { label: 'Approved on', value: attentionDay(f.atIso, f.nowIso) || '—' },
      { label: 'Approved by', value: f.approvedBy || '—' },
      ...(f.paidNgn != null ? [{ label: 'Paid', value: attentionNgn(f.paidNgn), tone: 'bad' }] : []),
    ],
  },
  customer_open_refund: {
    group: 'refunds',
    label: 'Customer has an open refund',
    severity: 'warning',
    focus: 'amount',
    actions: ['open'],
    message: (f) => {
      const rs = f.refunds || [];
      const one = rs.length === 1 ? rs[0] : null;
      const what = one
        ? `refund ${one.refundId} ${attentionNgn(one.openNgn)} ${
            one.status === 'Pending'
              ? 'waiting for approval'
              : `approved${one.approvedAtIso ? ` ${attentionDay(one.approvedAtIso, f.nowIso)}` : ''} and unpaid`
          }`
        : `${rs.length} open refunds totalling ${attentionNgn(rs.reduce((t, r) => t + num(r.openNgn), 0))}`;
      const credit = f.creditNgn > 0 ? ` plus ${attentionNgn(f.creditNgn)} unused overpayment credit` : '';
      return `${f.customer || 'This customer'} has ${what}${credit} — check this receipt is not the same money`;
    },
    evidence: (f) => [
      ...(f.refunds || []).slice(0, 3).map((r) => ({
        label: r.refundId,
        value: `${attentionNgn(r.openNgn)} · ${r.status === 'Pending' ? 'pending' : 'unpaid'}`,
        tone: 'bad',
      })),
      ...(f.creditNgn > 0 ? [{ label: 'Unused credit', value: attentionNgn(f.creditNgn), tone: 'bad' }] : []),
    ],
  },
  overpay_credit_unused: {
    group: 'refunds',
    label: 'Overpayment credit not used',
    severity: 'info',
    focus: 'amount',
    actions: ['open'],
    message: (f) =>
      `Overpayment credit ${attentionNgn(f.amountNgn)} is on the customer's ledger — not applied to a quote or refunded`,
    evidence: (f) => [{ label: 'Credit on ledger', value: attentionNgn(f.amountNgn), tone: 'bad' }],
  },
  same_requester_approver: {
    group: 'controls',
    label: 'Requested and approved by the same person',
    severity: 'critical',
    focus: 'people',
    actions: ['acknowledge', 'open'],
    message: (f) =>
      `Refund ${f.refundId} ${attentionNgn(f.amountNgn)} was requested and approved by the same person (${f.approvedBy || f.requestedBy || 'unknown'})`,
    evidence: (f) => [
      { label: 'Requested by', value: f.requestedBy || '—', tone: 'bad' },
      { label: 'Approved by', value: f.approvedBy || '—', tone: 'bad' },
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
    ],
  },
  same_approver_payer: {
    group: 'controls',
    label: 'Approved and paid by the same person',
    severity: 'critical',
    focus: 'people',
    actions: ['acknowledge', 'open'],
    message: (f) =>
      `Refund ${f.refundId} ${attentionNgn(f.amountNgn)} was approved and paid by the same person (${f.paidBy || f.approvedBy || 'unknown'})`,
    evidence: (f) => [
      { label: 'Approved by', value: f.approvedBy || '—', tone: 'bad' },
      { label: 'Paid by', value: f.paidBy || '—', tone: 'bad' },
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
    ],
  },

  /* ---- cash out */
  payment_request_pending: {
    group: 'cash_out',
    label: 'Payment request waiting',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Payment request ${attentionNgn(f.amountNgn)}${f.description ? ` for ${quote(f.description)}` : ''}${f.category ? ` (${f.category})` : ''} requested ${attentionDay(f.atIso, f.nowIso) || '—'} is waiting for approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
      { label: 'Category', value: f.category || '—' },
      { label: 'Payee', value: f.payee || '—' },
      { label: 'Attachment', value: f.attachmentPresent ? 'Yes' : 'None', tone: f.attachmentPresent ? 'ok' : 'muted' },
    ],
  },
  payment_request_above_limit: {
    group: 'cash_out',
    label: 'Above executive expense limit',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) => `${attentionNgn(f.amountNgn)} is above the ${attentionNgn(f.thresholdNgn)} executive expense limit`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn), tone: 'bad' },
      { label: 'Limit', value: attentionNgn(f.thresholdNgn) },
    ],
  },
  register_withdrawal_pending: {
    group: 'cash_out',
    label: 'Register withdrawal waiting',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Register withdrawal ${attentionNgn(f.amountNgn)} to ${f.party || 'party'} requested ${attentionDay(f.atIso, f.nowIso) || '—'} is waiting for approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
      { label: 'Paid to', value: f.party || '—' },
      { label: 'Requested', value: attentionDay(f.atIso, f.nowIso) || '—' },
    ],
  },
  register_withdrawal_above_limit: {
    group: 'cash_out',
    label: 'Above executive limit',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) => `${attentionNgn(f.amountNgn)} is above the ${attentionNgn(f.thresholdNgn)} executive limit — MD only`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn), tone: 'bad' },
      { label: 'Limit', value: attentionNgn(f.thresholdNgn) },
    ],
  },
  inter_branch_loan_pending: {
    group: 'cash_out',
    label: 'Inter-branch loan waiting',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Loan ${attentionNgn(f.amountNgn)} from ${f.lender || 'lender'} to ${f.borrower || 'borrower'} is waiting for MD approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Amount', value: attentionNgn(f.amountNgn) },
      { label: 'From', value: f.lender || '—' },
      { label: 'To', value: f.borrower || '—' },
    ],
  },

  /* ---- people */
  overtime_pending: {
    group: 'people',
    label: 'Overtime waiting',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Overtime ${f.amountNgn > 0 ? `${attentionNgn(f.amountNgn)} ` : ''}for ${attentionDay(f.dayIso, f.nowIso) || 'a day'}${f.workLabel ? ` (${f.workLabel})` : ''}${f.createdBy ? ` by ${f.createdBy}` : ''} is waiting for approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Payable', value: f.amountNgn > 0 ? attentionNgn(f.amountNgn) : '—' },
      { label: 'Day', value: attentionDay(f.dayIso, f.nowIso) || '—' },
      { label: 'Work', value: f.workLabel || '—' },
      ...(f.note ? [{ label: 'Reason', value: f.note }] : []),
    ],
  },
  staff_credit_pending: {
    group: 'people',
    label: 'Staff purchase on credit',
    severity: 'warning',
    focus: 'amount',
    actions: ['approve', 'reject'],
    message: (f) =>
      `Staff purchase credit ${attentionNgn(f.amountNgn)} for ${f.staff || 'staff'}${f.quotationRef ? ` on ${f.quotationRef}` : ''}${f.installmentNgn > 0 ? ` (${attentionNgn(f.installmentNgn)}/month from payroll)` : ''} needs MD approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Credit', value: attentionNgn(f.amountNgn) },
      { label: 'Monthly deduction', value: f.installmentNgn > 0 ? attentionNgn(f.installmentNgn) : '—' },
      { label: 'Staff', value: f.staff || '—' },
    ],
  },
  payroll_md_signoff: {
    group: 'people',
    label: 'Payroll waiting for MD sign-off',
    severity: 'warning',
    focus: 'totals',
    actions: ['sign_off'],
    message: (f) => `Payroll ${f.period || ''} is a draft waiting for MD sign-off before it can be locked${waited(f)}`,
    evidence: (f) => [{ label: 'Period', value: f.period || '—' }],
  },

  /* ---- stock */
  material_incident_pending: {
    group: 'stock',
    label: 'Material exception waiting',
    severity: 'warning',
    focus: 'incident',
    actions: ['approve', 'reject'],
    message: (f) =>
      `${f.incidentType || 'Material exception'}${f.meters > 0 ? ` of ${Math.round(f.meters * 10) / 10} m` : ''}${f.spec ? ` ${f.spec}` : ''} reported ${attentionDay(f.atIso, f.nowIso) || '—'} is waiting for approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Type', value: f.incidentType || '—' },
      { label: 'Metres', value: f.meters > 0 ? `${Math.round(f.meters * 10) / 10} m` : '—' },
      { label: 'Storekeeper note', value: f.remark || '—' },
    ],
  },

  /* ---- edits */
  edit_second_approval: {
    group: 'edits',
    label: 'Edit needs second approval',
    severity: 'warning',
    focus: 'change',
    actions: ['approve', 'reject'],
    message: (f) =>
      `${f.requestedBy || 'Someone'} changed ${f.entityLabel}${f.changeSummary ? ` (${f.changeSummary})` : ''} — it saves only after a second approval${waited(f)}`,
    evidence: (f) => [
      { label: 'Record', value: f.entityLabel },
      { label: 'Change', value: f.changeSummary || '—' },
      { label: 'Edited by', value: f.requestedBy || '—' },
    ],
  },

  /* ---- governance */
  branch_missing_manager: {
    group: 'controls',
    label: 'Branch has no manager',
    severity: 'critical',
    focus: 'branch',
    actions: ['assign'],
    message: (f) =>
      `${f.branchName || 'This branch'} has no Branch Manager — complaints, overtime and other branch approvals have no owner`,
    evidence: (f) => [{ label: 'Branch', value: f.branchName || '—', tone: 'bad' }],
  },

  /* ---- cashier desk */
  receipt_no_bank_line: {
    group: 'cash_in',
    label: 'Receipt with no bank line',
    severity: 'warning',
    focus: 'bank_line',
    actions: ['ask_cashier', 'open'],
    message: (f) =>
      `Receipt ${attentionNgn(f.amountNgn)}${f.customer ? ` from ${f.customer}` : ''} has no matching bank line${f.ageDays == null ? '' : f.ageDays === 0 ? ' (received today)' : ` after ${attentionAgeLabel(f.ageDays)}`}`,
    evidence: (f) => [
      { label: 'Receipt', value: attentionNgn(f.amountNgn) },
      { label: 'Receipt date', value: attentionDay(f.atIso, f.nowIso) || '—' },
      { label: 'Bank line', value: 'None found', tone: 'bad' },
      ...(f.paidTo ? [{ label: 'Said paid to', value: f.paidTo }] : []),
    ],
  },
  receipt_under_investigation: {
    group: 'cash_in',
    label: 'Receipt under investigation',
    severity: 'warning',
    focus: 'status',
    actions: ['open'],
    message: (f) =>
      `Receipt ${attentionNgn(f.amountNgn)}${f.customer ? ` from ${f.customer}` : ''} is under investigation${f.caseId ? ` (case ${f.caseId})` : ''} — it cannot be confirmed until the case is cleared${waited(f)}`,
    evidence: (f) => [
      { label: 'Receipt', value: attentionNgn(f.amountNgn) },
      { label: 'Status', value: f.status || 'Suspended', tone: 'bad' },
      { label: 'Case', value: f.caseId || '—' },
    ],
  },

  /* ---- reports: payment exception queue */
  quotation_paid_mismatch: {
    group: 'cash_in',
    label: 'Quote paid ≠ receipts',
    severity: 'warning',
    focus: 'paid',
    actions: ['open'],
    message: (f) =>
      `${f.quotationRef} shows ${attentionNgn(f.paidOnQuoteNgn)} paid but receipts + applied credit come to ${attentionNgn(f.expectedPaidNgn)} — ${attentionNgn(Math.abs(f.paidOnQuoteNgn - f.expectedPaidNgn))} ${f.paidOnQuoteNgn > f.expectedPaidNgn ? 'more' : 'less'} on the quote`,
    evidence: (f) => [
      { label: 'Paid on quote', value: attentionNgn(f.paidOnQuoteNgn), tone: 'bad' },
      { label: 'Receipts', value: attentionNgn(f.receiptsNgn) },
      { label: 'Credit applied', value: attentionNgn(f.creditAppliedNgn) },
    ],
  },
  receipt_treasury_mismatch: {
    group: 'cash_in',
    label: 'Receipt ≠ treasury',
    severity: 'warning',
    focus: 'treasury',
    actions: ['open'],
    message: (f) =>
      `${f.refId || 'Receipt'}${f.customer ? ` (${f.customer})` : ''}: ${f.issue || 'receipt and treasury line differ'} — ${attentionNgn(Math.abs(f.deltaNgn))} difference`,
    evidence: (f) => [
      { label: 'Difference', value: attentionNgn(f.deltaNgn), tone: 'bad' },
      { label: 'Quotation', value: f.quotationRef || '—' },
    ],
  },

  /* ---- office / generic */
  office_memo_open: {
    group: 'office',
    label: 'Memo open',
    severity: 'info',
    focus: 'memo',
    actions: ['open'],
    message: (f) => `Memo ${quote(f.subject || 'Untitled')} is open for the executive office${f.ageDays != null ? ` — last update ${attentionAgeLabel(f.ageDays)}${f.ageDays ? ' ago' : ''}` : ''}`,
    evidence: (f) => [{ label: 'Subject', value: f.subject || '—' }],
  },
  work_item_pending: {
    group: 'office',
    label: 'Work item waiting',
    severity: 'info',
    focus: 'item',
    actions: ['open'],
    message: (f) =>
      `${f.title || 'Work item'}${f.amountNgn > 0 ? ` ${attentionNgn(f.amountNgn)}` : ''} is ${String(f.status || 'pending').toLowerCase()}${waited(f)}`,
    evidence: (f) => [
      { label: 'Status', value: f.status || '—' },
      ...(f.amountNgn > 0 ? [{ label: 'Amount', value: attentionNgn(f.amountNgn) }] : []),
    ],
  },
};

/* ------------------------------------------------------------------ detectors: record → rule ids + facts */

const MD_DISCOUNT_RE = /md\s*discount/i;

function belowFloorLines(row) {
  let arr = row?.violations ?? row?.md_price_exception_snapshot_json ?? row?.mdPriceExceptionSnapshotJson;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((v) => {
      const floor = pickNum(v.floorPerMeter, v.floor_per_meter);
      const quoted = pickNum(v.quotedPerMeter, v.quoted_per_meter);
      const name = [pick(v.lineName, v.line_name, v.lineCategory), pick(v.gauge)].filter(Boolean).join(' ');
      return { name: name || `Line ${num(v.lineIndex ?? v.line_index) + 1}`, floorPerMeter: floor, quotedPerMeter: quoted };
    })
    .filter((l) => l.floorPerMeter != null && l.quotedPerMeter != null && l.floorPerMeter > l.quotedPerMeter)
    .sort((a, b) => b.floorPerMeter - b.quotedPerMeter - (a.floorPerMeter - a.quotedPerMeter));
}

/**
 * Which rules apply to an attention item, most serious first.
 * Item = a row of GET /api/management/attention (server/mdAttentionOps.js), an exec work-tray row, or a
 * cashier/report row passed with an explicit `ruleId`.
 * @param {object} item
 * @param {{ limits?: { refundExecutiveThresholdNgn?: number, expenseExecutiveThresholdNgn?: number }, nowIso?: string }} [ctx]
 * @returns {{ ruleId: string, facts: object }[]}
 */
export function attentionRulesForItem(item, ctx = {}) {
  const it = item || {};
  const row = it.row || it.reviewContext?.row || {};
  const kind = clean(it.kind).toLowerCase();
  const id = clean(it.id);
  const limits = ctx.limits || it.limits || {};
  const refundHi = num(limits.refundExecutiveThresholdNgn) || REFUND_MD_APPROVAL_THRESHOLD_NGN;
  const expenseHi = num(limits.expenseExecutiveThresholdNgn) || EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
  const base = { itemId: id, branchId: pick(it.branchId, row.branch_id, row.branchId), nowIso: ctx.nowIso };
  /** @type {{ ruleId: string, facts: object }[]} */
  const out = [];
  const add = (ruleId, facts) => out.push({ ruleId, facts: { ...base, ...facts } });

  if (it.ruleId && ATTENTION_RULES[it.ruleId]) {
    add(it.ruleId, { ...(it.facts || {}), atIso: it.facts?.atIso ?? it.atIso });
    return out;
  }

  const atIso = pick(it.atIso, it.reviewContext?.atIso);

  if (kind === 'clearance') {
    const totalNgn = num(row.total_ngn ?? row.totalNgn ?? it.amountNgn);
    const paidNgn = num(row.paid_ngn ?? row.paidNgn);
    const f = { quotationRef: pick(it.quotationRef, row.id, it.title), totalNgn, paidNgn, atIso: atIso || row.date_iso, thresholdNgn: expenseHi };
    if (totalNgn > 0 && paidNgn > totalNgn) add('quote_overpaid', f);
    add('quote_not_cleared', f);
    if (totalNgn > 0 && paidNgn < totalNgn * 0.7) add('quote_below_production_gate', f);
    if (totalNgn >= expenseHi) add('quote_high_value', f);
    return out;
  }
  if (kind === 'price_exception') {
    const lines = belowFloorLines(row);
    add('quote_below_floor', {
      quotationRef: pick(it.quotationRef, row.id, it.title),
      totalNgn: num(row.total_ngn ?? it.amountNgn),
      paidNgn: num(row.paid_ngn ?? row.paidNgn),
      atIso: atIso || row.date_iso,
      belowLines: lines,
      worstLine: lines[0] || null,
      belowLineCount: lines.length,
    });
    return out;
  }
  if (kind === 'flagged') {
    add('quote_flagged', {
      quotationRef: pick(it.quotationRef, row.id, it.title),
      totalNgn: num(row.total_ngn ?? it.amountNgn),
      flagReason: pick(row.manager_flag_reason, row.managerFlagReason),
      atIso: atIso || row.manager_flagged_at_iso,
    });
    return out;
  }
  if (kind === 'production') {
    add('production_held_unpaid', {
      quotationRef: pick(it.quotationRef, row.quotation_ref),
      cuttingListId: pick(it.cuttingListId, row.id),
      totalNgn: num(row.total_ngn ?? it.amountNgn),
      paidNgn: num(row.paid_ngn),
      atIso,
    });
    return out;
  }
  if (kind === 'conversions') {
    add('conversion_unsigned', {
      jobId: pick(it.jobId, row.job_id, it.title),
      quotationRef: pick(it.quotationRef, row.quotation_ref),
      actualMeters: num(row.actual_meters),
      actualKg: num(row.actual_weight_kg),
      alertState: pick(row.conversion_alert_state).toUpperCase(),
      varianceReason: pick(row.conversion_variance_reason_text, row.conversion_variance_reason_code),
      atIso: atIso || row.completed_at_iso,
    });
    return out;
  }
  if (kind === 'refunds') {
    const amountNgn = num(row.amount_ngn ?? row.amountNgn ?? it.amountNgn);
    const reasons = parseReasonCategories(row.reason_category ?? row.reasonCategory);
    const f = {
      refundId: pick(it.refundId, row.refund_id, it.title),
      customer: pick(row.customer_name, row.customer),
      quotationRef: pick(it.quotationRef, row.quotation_ref),
      amountNgn,
      reasons,
      atIso: atIso || row.requested_at_iso,
      thresholdNgn: refundHi,
    };
    add('refund_pending', f);
    if (amountNgn >= refundHi) add('refund_above_limit', f);
    if (reasons.some((r) => MD_DISCOUNT_RE.test(r))) add('refund_md_discount', f);
    return out;
  }
  if (kind === 'register_settlement') {
    const amountNgn = num(row.amountNgn ?? row.amount_ngn ?? it.amountNgn);
    const f = {
      settlementId: pick(it.settlementId, row.settlementId, it.title),
      party: pick(row.partyName, row.party_name),
      amountNgn,
      atIso: atIso || row.requestedAtIso,
      thresholdNgn: refundHi,
    };
    add('register_withdrawal_pending', f);
    if (amountNgn >= refundHi) add('register_withdrawal_above_limit', f);
    return out;
  }
  if (kind === 'payments') {
    const amountNgn = num(row.amount_requested_ngn ?? row.amountRequestedNgn ?? it.amountNgn);
    const f = {
      requestId: pick(it.requestId, row.request_id, it.title),
      amountNgn,
      description: pick(row.description),
      category: pick(row.expense_category, row.expenseCategory),
      payee: pick(row.payee_name, row.payeeName),
      attachmentPresent: Boolean(row.attachment_present ?? row.attachmentPresent),
      atIso: atIso || row.request_date,
      thresholdNgn: expenseHi,
    };
    add('payment_request_pending', f);
    if (amountNgn >= expenseHi) add('payment_request_above_limit', f);
    return out;
  }
  if (kind === 'overtime') {
    const link = pick(row.quotationRef, row.poId);
    const work = pick(row.workType);
    add('overtime_pending', {
      otRequestId: pick(it.otRequestId, row.id, it.title),
      amountNgn: num(row.totalPayableNgn ?? it.amountNgn),
      dayIso: pick(row.dayIso),
      workLabel: [work, link].filter(Boolean).join(', '),
      createdBy: pick(row.createdByName),
      note: pick(row.reason).slice(0, 120),
      atIso,
    });
    return out;
  }
  if (kind === 'material') {
    add('material_incident_pending', {
      incidentId: pick(row.id, it.title),
      incidentType: pick(row.incident_type).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      meters: num(row.total_meters),
      spec: [pick(row.gauge_label), pick(row.colour)].filter(Boolean).join(' '),
      remark: pick(row.storekeeper_remark),
      atIso: atIso || row.date_iso,
    });
    return out;
  }
  if (kind === 'edit_approvals') {
    const ek = pick(row.entityKind).replace(/_/g, ' ');
    add('edit_second_approval', {
      editApprovalId: pick(row.id),
      entityLabel: [ek || 'record', pick(row.entityId)].filter(Boolean).join(' '),
      changeSummary: pick(row.changeSummary),
      requestedBy: pick(row.requestedByDisplay, row.requestedByUserId),
      atIso: atIso || row.requestedAtISO,
    });
    return out;
  }
  if (kind === 'staff_purchase_credit') {
    add('staff_credit_pending', {
      accountId: pick(it.accountId, row.id),
      amountNgn: num(row.principalOriginalNgn ?? it.amountNgn),
      installmentNgn: num(row.installmentNgn),
      staff: pick(row.staffDisplayName, row.userId),
      quotationRef: pick(it.quotationRef, row.quotationRef),
      atIso: atIso || row.createdAtIso,
    });
    return out;
  }
  if (kind === 'governance') {
    const integrity = pick(it.integrityKind, row.integrityKind);
    if (integrity === 'missing_branch_manager') {
      add('branch_missing_manager', { branchName: pick(row.branchName, it.branchName, row.branchId) });
      return out;
    }
    if (row.kind === 'same_requester_approver' || row.kind === 'same_approver_payer') {
      add(row.kind, {
        refundId: pick(it.refundId, row.refundId, it.title),
        amountNgn: num(row.amountNgn ?? it.amountNgn),
        requestedBy: pick(row.requestedBy),
        approvedBy: pick(row.approvedBy),
        paidBy: pick(row.paidBy),
        quotationRef: pick(it.quotationRef, row.quotationRef),
      });
      return out;
    }
    if (row.jobId || it.jobId) {
      add('production_gate_breach', {
        jobId: pick(it.jobId, row.jobId),
        quotationRef: pick(it.quotationRef, row.quotationRef),
        totalNgn: num(row.totalNgn ?? it.amountNgn),
        paidNgn: num(row.paidNgn),
        paidPct: pickNum(row.paidPct),
        outstandingNgn: pickNum(row.outstandingNgn),
        atIso: atIso || row.completedAtIso,
      });
      return out;
    }
  }
  if (kind === 'payroll') {
    add('payroll_md_signoff', { period: pick(row.period_yyyymm, it.reviewContext?.subtitle), atIso: atIso || row.created_at_iso });
    return out;
  }
  if (kind === 'inter_branch_loan') {
    const sub = pick(it.reviewContext?.subtitle, it.branchName);
    const [lender, borrower] = sub.split('→').map(clean);
    add('inter_branch_loan_pending', {
      loanId: pick(row.loan_id, it.title),
      amountNgn: num(row.principal_ngn ?? it.amountNgn),
      lender,
      borrower,
      atIso: atIso || row.created_at_iso,
    });
    return out;
  }
  if (kind === 'office_memo') {
    add('office_memo_open', { subject: pick(it.reviewContext?.subject, it.title), atIso });
    return out;
  }
  add('work_item_pending', { title: pick(it.title, id), status: pick(it.status), amountNgn: num(it.amountNgn), atIso });
  return out;
}

/* ------------------------------------------------------------------ deep links */

/**
 * Where a click on this item goes. MD/CEO → the exec review (they cannot open /manager);
 * BM → the manager desk record; cashier rows → the cashier desk with the receipt open.
 * Every link carries `attention=<item id>` so the page opens that record with the banner.
 * @param {object} item
 * @param {'exec' | 'manager' | 'cashier'} surface
 */
export function attentionDeepLink(item, surface = 'exec') {
  const it = item || {};
  const id = clean(it.id);
  const kind = clean(it.kind).toLowerCase();
  const row = it.row || it.reviewContext?.row || {};
  const enc = encodeURIComponent;
  const tag = id ? `attention=${enc(id)}` : '';
  const withTag = (path) => (tag ? `${path}${path.includes('?') ? '&' : '?'}${tag}` : path);

  if (clean(it.integrityKind || row.integrityKind) === 'missing_branch_manager') return '/settings/team';

  if (surface === 'cashier') {
    const rid = pick(it.receiptId, row.id, it.title);
    return withTag(rid ? `/cashier?receipt=${enc(rid)}` : '/cashier');
  }
  if (surface === 'exec') return withTag('/exec?tab=decide');

  // manager desk
  if (kind === 'clearance' || kind === 'flagged' || kind === 'production' || kind === 'price_exception') {
    const q = pick(it.quotationRef, it.title);
    return withTag(
      q
        ? `/manager?inbox=orders&quoteRef=${enc(q)}${kind === 'price_exception' ? '&review=price_exception' : ''}`
        : '/manager?inbox=orders'
    );
  }
  if (kind === 'refunds') {
    const r = pick(it.refundId, it.title);
    return withTag(r ? `/manager?inbox=cash_out&refundId=${enc(r)}` : '/manager?inbox=cash_out');
  }
  if (kind === 'register_settlement') {
    const s = pick(it.settlementId, it.title);
    return withTag(s ? `/manager?inbox=withdrawals&settlementId=${enc(s)}` : '/manager?inbox=withdrawals');
  }
  if (kind === 'payments') {
    const r = pick(it.requestId, it.title);
    return withTag(r ? `/manager?inbox=cash_out&requestId=${enc(r)}` : '/manager?inbox=cash_out');
  }
  if (kind === 'conversions') {
    const j = pick(it.jobId, it.title);
    return withTag(j ? `/manager?inbox=qc&jobId=${enc(j)}` : '/manager?inbox=qc');
  }
  if (kind === 'material') {
    const m = pick(it.title, row.id);
    return withTag(m ? `/manager?inbox=material&materialIncidentId=${enc(m)}` : '/manager?inbox=material');
  }
  if (kind === 'edit_approvals') return withTag('/manager?inbox=edits');
  if (kind === 'governance') {
    if (it.refundId) return withTag(`/manager?inbox=cash_out&refundId=${enc(it.refundId)}`);
    if (it.jobId) return withTag(`/manager?inbox=qc&jobId=${enc(it.jobId)}`);
    if (it.quotationRef) return withTag(`/manager?inbox=orders&quoteRef=${enc(it.quotationRef)}`);
    return withTag('/manager?inbox=governance');
  }
  return withTag('/manager?inbox=attention');
}

/* ------------------------------------------------------------------ explain + summarize */

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * One item → everything the row, the banner and the badge need.
 * @param {object} item
 * @param {{ limits?: object, nowIso?: string, surface?: 'exec' | 'manager' | 'cashier' }} [ctx]
 */
export function explainAttentionItem(item, ctx = {}) {
  const nowIso = ctx.nowIso || new Date().toISOString();
  const matches = attentionRulesForItem(item, { ...ctx, nowIso });
  const flags = matches
    .map(({ ruleId, facts }, idx) => {
      const rule = ATTENTION_RULES[ruleId];
      const ageDays = attentionAgeDays(facts.atIso, nowIso);
      const f = { ...facts, nowIso, ageDays };
      return {
        ruleId,
        label: rule.label,
        severity: rule.severity,
        group: rule.group,
        focus: rule.focus,
        sentence: rule.message(f),
        evidence: rule.evidence(f),
        actions: rule.actions.map((a) => ({ id: a, ...ATTENTION_ACTIONS[a] })),
        _order: idx,
      };
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a._order - b._order)
    .map(({ _order, ...flag }) => flag);
  const primary = flags[0];
  const atIso = matches[0]?.facts?.atIso || clean(item?.atIso) || '';
  const ageDays = attentionAgeDays(atIso, nowIso);
  const amountNgn = item?.amountNgn != null ? Math.round(num(item.amountNgn)) : null;
  return {
    itemId: clean(item?.id),
    ruleId: primary?.ruleId || '',
    ruleIds: flags.map((f) => f.ruleId),
    group: primary?.group || 'office',
    groupLabel: ATTENTION_GROUPS[primary?.group || 'office'],
    severity: primary?.severity || 'info',
    sentence: primary?.sentence || '',
    flags,
    atIso,
    ageDays,
    ageLabel: attentionAgeLabel(ageDays),
    amountNgn,
    links: {
      exec: attentionDeepLink(item, 'exec'),
      manager: attentionDeepLink(item, 'manager'),
    },
  };
}

/**
 * Counts and ₦ totals per group — the MD list header and any badge read this, never their own count.
 * @param {object[]} items attention items (each may already carry `.attention` from the server)
 * @param {{ order?: 'newest' | 'oldest', limits?: object, nowIso?: string }} [opts]
 */
export function summarizeAttention(items, opts = {}) {
  const order = opts.order === 'oldest' ? 'oldest' : 'newest';
  const explained = (items || []).map((it) => ({ item: it, attention: it?.attention?.flags ? it.attention : explainAttentionItem(it, opts) }));
  const byGroup = new Map();
  for (const e of explained) {
    const g = e.attention.group;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(e);
  }
  const ts = (e) => {
    const t = Date.parse(e.attention.atIso || '');
    return Number.isFinite(t) ? t : null;
  };
  const sortRows = (rows) =>
    rows.slice().sort((a, b) => {
      const ta = ts(a);
      const tb = ts(b);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return order === 'newest' ? tb - ta : ta - tb;
    });
  const groups = Object.keys(ATTENTION_GROUPS)
    .filter((g) => byGroup.has(g))
    .map((g) => {
      const rows = sortRows(byGroup.get(g));
      return {
        group: g,
        label: ATTENTION_GROUPS[g],
        count: rows.length,
        totalNgn: rows.reduce((s, e) => s + (e.attention.amountNgn || 0), 0),
        rows,
      };
    });
  return {
    total: explained.length,
    totalNgn: groups.reduce((s, g) => s + g.totalNgn, 0),
    order,
    groups,
  };
}
