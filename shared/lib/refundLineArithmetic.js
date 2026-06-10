/**
 * Verify refund breakdown lines where the label encodes a formula (e.g. unproduced metres × ₦/m).
 */

import { REFUND_AMOUNT_LINE_TOLERANCE_NGN } from '../refundConstants.js';

export function roundRefundLineMoney(value) {
  return Math.round(Number(value) || 0);
}

function parseNgnToken(raw) {
  return roundRefundLineMoney(String(raw || '').replace(/,/g, ''));
}

/** @returns {{ metres: number, pricePerMeterNgn: number } | null} */
export function parseUnproducedMetresLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(/Unproduced metres\s*\(([\d.]+)\s*m\s*@\s*₦([\d,]+)\)/i);
  if (!m) return null;
  const metres = Number(m[1]);
  const pricePerMeterNgn = parseNgnToken(m[2]);
  if (!Number.isFinite(metres) || metres <= 0 || pricePerMeterNgn <= 0) return null;
  return { metres, pricePerMeterNgn };
}

/**
 * When the label encodes a formula, return the implied line amount (NGN).
 * @param {string} label
 * @param {string} [category]
 * @returns {number | null}
 */
export function expectedAmountFromRefundLineLabel(label, category) {
  const cat = String(category || '').trim();
  const text = String(label || '').trim();
  if (cat === 'Unproduced meterage' || /unproduced metres/i.test(text)) {
    const parsed = parseUnproducedMetresLabel(text);
    if (parsed) {
      return roundRefundLineMoney(parsed.metres * parsed.pricePerMeterNgn);
    }
  }
  return null;
}

/**
 * @param {Array<{ label?: string, amountNgn?: number, amount_ngn?: number, category?: string, include?: boolean }>} lines
 * @param {number} [toleranceNgn]
 */
export function auditRefundCalculationLineArithmetic(lines, toleranceNgn = REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
  const tol = Math.max(0, roundRefundLineMoney(toleranceNgn));
  /** @type {Array<{ lineIndex: number, category?: string, label: string, amountNgn: number, expectedAmountNgn: number, code: string, formulaText?: string }>} */
  const issues = [];
  for (let i = 0; i < (lines || []).length; i += 1) {
    const line = lines[i];
    if (line?.include === false) continue;
    const amt = roundRefundLineMoney(line?.amountNgn ?? line?.amount_ngn);
    if (amt <= 0) continue;
    const expected = expectedAmountFromRefundLineLabel(line?.label, line?.category);
    if (expected == null) continue;
    if (Math.abs(amt - expected) > tol) {
      const parsed = parseUnproducedMetresLabel(line?.label);
      issues.push({
        lineIndex: i,
        category: line?.category,
        label: String(line?.label || '').trim(),
        amountNgn: amt,
        expectedAmountNgn: expected,
        code: 'line_label_amount_mismatch',
        formulaText:
          parsed != null
            ? `${parsed.metres}m × ₦${parsed.pricePerMeterNgn.toLocaleString('en-NG')}`
            : undefined,
      });
    }
  }
  return issues;
}

/**
 * @param {Array<{ label?: string, amountNgn?: number, amount_ngn?: number, category?: string, include?: boolean }>} lines
 * @param {number} [toleranceNgn]
 */
export function validateRefundCalculationLineArithmetic(lines, toleranceNgn = REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
  const issues = auditRefundCalculationLineArithmetic(lines, toleranceNgn);
  if (!issues.length) return { ok: true, issues: [] };
  const first = issues[0];
  const formula = first.formulaText ? ` (${first.formulaText})` : '';
  return {
    ok: false,
    code: 'REFUND_LINE_ARITHMETIC_MISMATCH',
    error: `Line breakdown does not match its description: "${first.label}" implies ₦${first.expectedAmountNgn.toLocaleString(
      'en-NG'
    )}${formula} but the line amount is ₦${first.amountNgn.toLocaleString('en-NG')}. Correct the amount or description.`,
    issues,
  };
}
