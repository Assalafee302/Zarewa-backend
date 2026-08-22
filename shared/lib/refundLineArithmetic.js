/**
 * Verify refund breakdown lines where the label encodes a formula (e.g. unproduced metres × ₦/m).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/refundLineArithmetic.js
 */

import { REFUND_AMOUNT_LINE_TOLERANCE_NGN } from '../refundConstants.js';

export function roundRefundLineMoney(value) {
  return Math.round(Number(value) || 0);
}

/** Sum included line amounts (comma thousands allowed). */
export function sumRefundCalculationLines(lines) {
  return (lines || []).reduce((s, l) => {
    if (l?.include === false) return s;
    const n = Number(String(l?.amountNgn ?? l?.amount_ngn ?? '').replace(/,/g, ''));
    return s + (Number.isNaN(n) ? 0 : n);
  }, 0);
}

function parseNgnToken(raw) {
  return roundRefundLineMoney(String(raw || '').replace(/,/g, ''));
}

/** Parse ₦ token that may include decimals (e.g. 5,805.64). */
function parseNgnTokenDecimal(raw) {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @returns {{ metres: number, pricePerMeterNgn: number } | null} */
export function parseUnproducedMetresLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(/Unproduced (?:trim )?metres\s*\(([\d.]+)\s*m\s*@\s*₦([\d,]+(?:\.\d+)?)\)/i);
  if (m) {
    const metres = Number(m[1]);
    const pricePerMeterNgn = parseNgnTokenDecimal(m[2]);
    if (Number.isFinite(metres) && metres > 0 && pricePerMeterNgn > 0) {
      return { metres, pricePerMeterNgn };
    }
  }
  /* Blended-rate label — no strict metres × ₦/m check */
  if (/Unproduced (?:trim )?metres\s*\([\d.]+m\s*—/i.test(text)) return null;
  return null;
}

export function formatUnproducedMetresLabel(metres, pricePerMeterNgn) {
  const built = buildUnproducedMetresRefundLine(metres, pricePerMeterNgn);
  return built.label;
}

/**
 * Build unproduced line label + amount so UI arithmetic checks pass (integer ₦/m in label
 * can disagree with blended quote ₦/m after rounding).
 */
export function buildUnproducedMetresRefundLine(metres, pricePerMeterNgn, { trim = false } = {}) {
  const m = Number(metres);
  const ppmRaw = Number(pricePerMeterNgn);
  const prefix = trim ? 'Unproduced trim metres' : 'Unproduced metres';
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(ppmRaw) || ppmRaw <= 0) {
    return { label: prefix, amountNgn: 0 };
  }
  const amountNgn = roundRefundLineMoney(m * ppmRaw);
  const metresText = Number.isInteger(m) ? String(m) : m.toFixed(2);
  const finishedSuffix = trim ? ' finished' : '';

  const intPpm = roundRefundLineMoney(ppmRaw);
  if (Math.abs(roundRefundLineMoney(m * intPpm) - amountNgn) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
    return {
      label: `${prefix} (${metresText}m${finishedSuffix} @ ₦${intPpm.toLocaleString('en-NG')})`,
      amountNgn,
    };
  }

  const decPpm = Math.round((amountNgn / m) * 100) / 100;
  if (Math.abs(roundRefundLineMoney(m * decPpm) - amountNgn) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
    const ppmText = decPpm.toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return {
      label: `${prefix} (${metresText}m${finishedSuffix} @ ₦${ppmText})`,
      amountNgn,
    };
  }

  return {
    label: `${prefix} (${metresText}m${finishedSuffix} — ₦${amountNgn.toLocaleString('en-NG')} at blended rate)`,
    amountNgn,
  };
}

/**
 * When an approver sets a lower approved amount but lines still sum to the original request,
 * scale included line amounts proportionally and rebuild formula labels where applicable.
 */
export function scaleRefundCalculationLinesToApprovedAmount(lines, targetNgn) {
  const target = roundRefundLineMoney(targetNgn);
  if (!Array.isArray(lines) || target <= 0) return lines;
  const includedIndices = [];
  let sum = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.include === false) continue;
    const n = Number(String(lines[i]?.amountNgn ?? lines[i]?.amount_ngn ?? '').replace(/,/g, ''));
    if (!Number.isNaN(n) && n > 0) {
      includedIndices.push(i);
      sum += roundRefundLineMoney(n);
    }
  }
  if (includedIndices.length === 0 || sum <= 0) return lines;
  if (Math.abs(sum - target) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN) return lines;

  const scale = target / sum;
  const next = lines.map((l) => ({ ...l }));
  let allocated = 0;
  for (let j = 0; j < includedIndices.length; j += 1) {
    const i = includedIndices[j];
    const raw = Number(String(lines[i]?.amountNgn ?? lines[i]?.amount_ngn ?? '').replace(/,/g, ''));
    const isLast = j === includedIndices.length - 1;
    const amt = isLast ? target - allocated : roundRefundLineMoney(raw * scale);
    const parsed = parseUnproducedMetresLabel(lines[i]?.label);
    const label =
      parsed != null
        ? formatUnproducedMetresLabel(amt / parsed.pricePerMeterNgn, parsed.pricePerMeterNgn)
        : lines[i]?.label;
    next[i] = { ...next[i], amountNgn: amt, ...(label ? { label } : {}) };
    allocated += amt;
  }
  return next;
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
    /* Under implied (floor/blended ₦/m rounding) — allow; over-claim is blocked. */
    if (amt > expected + tol) {
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
