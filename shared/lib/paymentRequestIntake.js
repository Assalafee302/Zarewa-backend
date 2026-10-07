/**
 * Payment-request intake rules. Blocks the September mistakes:
 * refunds filed as expenses, IOUs without a staff name, bending with no quote,
 * and a second save of the same amount, date, and description.
 */

import { isStaffLoanExpenseCategory } from '../expenseCategories.js';

export const REFUND_EXPENSE_BLOCK_MESSAGE = 'Refunds must be raised in the Refund screen.';

const REFUND_WORD = /\brefunds?\b/i;
const IOU_WORD = /\b(iou|10u)\b/i;
const OUTSIDE_WORK = /\b(bending|outside\s+corrugat\w*|outside\s+work)\b/i;
const FORKLIFT = /\bfork\s*-?\s*lifts?\b|\bforklift\b/i;

function normDesc(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same idea in both texts (equal, contained, or most of the words shared). */
export function descriptionsSimilar(a, b) {
  const x = normDesc(a);
  const y = normDesc(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xt = new Set(x.split(' ').filter((w) => w.length > 2));
  const yt = y.split(' ').filter((w) => w.length > 2);
  if (!xt.size || !yt.length) return false;
  const shared = yt.filter((w) => xt.has(w)).length;
  return shared / Math.max(xt.size, yt.length) >= 0.6;
}

export function paymentRequestNarrative(input = {}) {
  const lines = Array.isArray(input.lineItems) ? input.lineItems : [];
  return [input.description, ...lines.map((row) => row?.item)]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');
}

export function isForkliftRepairText(text) {
  return FORKLIFT.test(String(text || ''));
}

/**
 * @param {object} input
 * @param {Array<{ id?: string, date?: string, amountNgn?: number, description?: string }>} [peers]
 */
export function reviewPaymentRequestIntake(input = {}, peers = []) {
  const errors = [];
  const text = paymentRequestNarrative(input);
  const category = String(input.expenseCategory || '').trim();
  if (REFUND_WORD.test(text) || REFUND_WORD.test(category)) {
    errors.push(REFUND_EXPENSE_BLOCK_MESSAGE);
  }

  const staffLoan = isStaffLoanExpenseCategory(category) || IOU_WORD.test(text);
  if (staffLoan) {
    if (!String(input.staffName || '').trim() && !String(input.staffUserId || '').trim()) {
      errors.push('IOU / staff loan requires the staff name.');
    }
    if (!/^\d{4}-\d{2}$/.test(String(input.repaymentMonth || '').trim())) {
      errors.push('IOU / staff loan requires the repayment month (YYYY-MM).');
    }
  }

  const outside =
    category === 'Outside corrugation' || OUTSIDE_WORK.test(text) || OUTSIDE_WORK.test(category);
  const quotationRef = String(input.quotationRef || '').trim();
  if (outside && !quotationRef) {
    errors.push('Bending and outside work require a quote number.');
  }

  if (category === 'Carriage inward' && !String(input.requestReference || '').trim()) {
    errors.push('Carriage inward requires the PO or coil numbers it relates to.');
  }

  const amount = Math.round(Number(input.amountNgn) || 0);
  const date = String(input.requestDate || '').slice(0, 10);
  const selfId = String(input.id || '').trim();
  const dup = (peers || []).find((peer) => {
    const id = String(peer?.id || '').trim();
    if (selfId && id === selfId) return false;
    if (String(peer?.date || '').slice(0, 10) !== date) return false;
    if (Math.round(Number(peer?.amountNgn) || 0) !== amount || amount <= 0) return false;
    return descriptionsSimilar(peer?.description, text);
  });
  if (dup && String(input.duplicateReason || '').trim().length < 10) {
    errors.push(
      `Same amount and date as ${dup.id || 'another request'} with a similar description. Confirm with a reason before saving.`
    );
  }

  const recordAsAsset = input.recordAsAsset === true || input.asset === true;
  if (recordAsAsset && !String(input.assetName || input.description || '').trim()) {
    errors.push('An asset needs a name.');
  }

  return {
    ok: errors.length === 0,
    errors,
    error: errors[0] || '',
    recordAsAsset,
    staffLoan,
    outsideWork: outside,
    quotationRef,
    forklift: isForkliftRepairText(text),
    duplicateOf: dup ? String(dup.id || '') : '',
  };
}

/** Alert when one asset's repairs in a month pass the threshold. */
export function equipmentRepairMonthAlert(lines = [], opts = {}) {
  const assetName = String(opts.assetName || 'Forklift').trim() || 'Forklift';
  const month = String(opts.month || '').slice(0, 7);
  const thresholdNgn = Math.round(Number(opts.thresholdNgn) || 250000);
  const totalNgn = (lines || []).reduce((sum, line) => {
    if (String(line?.month || '').slice(0, 7) !== month) return sum;
    if (String(line?.assetName || '') !== assetName) return sum;
    return sum + Math.round(Number(line?.amountNgn) || 0);
  }, 0);
  return {
    alert: totalNgn > thresholdNgn,
    assetName,
    month,
    totalNgn,
    thresholdNgn,
  };
}
