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
 * MD discount is the same shape as commission: applicant enters ₦ per metre,
 * total = that rate × produced metres (not quoted). Unproduced shortfall is a
 * separate line, so concession ₦/m must not re-apply to metres never produced.
 * Example: 100 m produced × ₦100/m = ₦10,000.
 */
export function mdDiscountRefundNgn(ngnPerMeter, metres) {
  const ppm = Number(ngnPerMeter);
  const m = Number(metres);
  if (!Number.isFinite(ppm) || ppm <= 0 || !Number.isFinite(m) || m <= 0.001) return 0;
  return roundRefundLineMoney(ppm * m);
}

/** @returns {{ metres: number, pricePerMeterNgn: number } | null} */
export function parseMdDiscountMetresLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(
    /MD discount\s*\(([\d.]+)\s*m\s*@\s*₦\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*m)?\)/i
  );
  if (!m) return null;
  const metres = Number(m[1]);
  const pricePerMeterNgn = parseNgnTokenDecimal(m[2]);
  if (!Number.isFinite(metres) || metres <= 0 || !(pricePerMeterNgn > 0)) return null;
  return { metres, pricePerMeterNgn };
}

function mdDiscountMetresText(metres) {
  const m = Number(metres);
  if (!Number.isFinite(m) || m <= 0) return '0';
  return Number.isInteger(m) ? String(m) : m.toFixed(2);
}

/**
 * @param {number} metres produced metres (same basis as agent commission)
 * @param {number|string} ngnPerMeter applicant ₦/m (e.g. 100)
 */
export function buildMdDiscountRefundLine(metres, ngnPerMeter) {
  const m = Number(metres);
  const ppmRaw = Number(String(ngnPerMeter ?? '').replace(/,/g, ''));
  const metresText = mdDiscountMetresText(m);
  if (!Number.isFinite(m) || m <= 0.001) {
    return {
      label: 'MD discount',
      amountNgn: 0,
      category: 'MD discount',
      mdDiscountMetres: 0,
      mdDiscountNgnPerM: Number.isFinite(ppmRaw) && ppmRaw > 0 ? ppmRaw : 0,
    };
  }
  if (!Number.isFinite(ppmRaw) || ppmRaw <= 0) {
    return {
      label: `MD discount (${metresText}m @ ₦/m)`,
      amountNgn: 0,
      category: 'MD discount',
      mdDiscountMetres: m,
      mdDiscountNgnPerM: 0,
    };
  }
  const amountNgn = mdDiscountRefundNgn(ppmRaw, m);
  const intPpm = roundRefundLineMoney(ppmRaw);
  const ppmForLabel =
    Math.abs(mdDiscountRefundNgn(intPpm, m) - amountNgn) <= REFUND_AMOUNT_LINE_TOLERANCE_NGN
      ? intPpm
      : Math.round(ppmRaw * 100) / 100;
  return {
    label: `MD discount (${metresText}m @ ₦${ppmForLabel.toLocaleString('en-NG')}/m)`,
    amountNgn,
    category: 'MD discount',
    mdDiscountMetres: m,
    mdDiscountNgnPerM: ppmForLabel,
  };
}

/**
 * MD discount lines must be ₦/m × produced metres (not a free lump sum).
 * Unproduced shortfall is claimed separately — do not multiply by quoted metres.
 * @param {Array<{ category?: string, label?: string, amountNgn?: number, mdDiscountNgnPerM?: number, mdDiscountMetres?: number, include?: boolean }>} lines
 * @param {number} producedMetres
 * @param {number} [toleranceNgn]
 */
export function validateMdDiscountPerMetreLines(lines, producedMetres, toleranceNgn = REFUND_AMOUNT_LINE_TOLERANCE_NGN) {
  const mdMetres = Number(producedMetres);
  const included = (Array.isArray(lines) ? lines : []).filter((l) => {
    if (l?.include === false) return false;
    return String(l?.category || '').trim() === 'MD discount';
  });
  if (!included.length) return { ok: true };
  if (!Number.isFinite(mdMetres) || mdMetres <= 0.001) {
    return {
      ok: false,
      error: 'MD discount is ₦ per metre × produced metres. This quotation has no produced roofing metres yet.',
    };
  }
  const tol = Math.max(0, roundRefundLineMoney(toleranceNgn));
  for (const line of included) {
    const parsed = parseMdDiscountMetresLabel(line?.label);
    const ppm = Number(line?.mdDiscountNgnPerM) || parsed?.pricePerMeterNgn || 0;
    if (!(ppm > 0)) {
      return {
        ok: false,
        error: 'MD discount requires ₦ per metre (e.g. 100). Total is that rate × produced metres, same as commission.',
      };
    }
    const expected = mdDiscountRefundNgn(ppm, mdMetres);
    if (expected <= 0) {
      return {
        ok: false,
        error: 'MD discount ₦ per metre × produced metres must be a positive amount.',
      };
    }
    const amt = roundRefundLineMoney(line?.amountNgn);
    if (Math.abs(amt - expected) > tol) {
      return {
        ok: false,
        error: `MD discount must be ₦${roundRefundLineMoney(ppm).toLocaleString(
          'en-NG'
        )}/m × ${mdDiscountMetresText(mdMetres)} m produced = ₦${expected.toLocaleString('en-NG')}.`,
      };
    }
  }
  return { ok: true };
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
    const mdParsed = parseMdDiscountMetresLabel(lines[i]?.label);
    let label = lines[i]?.label;
    if (parsed != null) {
      label = formatUnproducedMetresLabel(amt / parsed.pricePerMeterNgn, parsed.pricePerMeterNgn);
    } else if (mdParsed != null && mdParsed.metres > 0) {
      const nextPpm = amt / mdParsed.metres;
      label = buildMdDiscountRefundLine(mdParsed.metres, nextPpm).label;
    }
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
  if (cat === 'MD discount' || /^MD discount\s*\(/i.test(text)) {
    const parsed = parseMdDiscountMetresLabel(text);
    if (parsed) {
      return mdDiscountRefundNgn(parsed.pricePerMeterNgn, parsed.metres);
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
      const mdParsed = parseMdDiscountMetresLabel(line?.label);
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
            : mdParsed != null
              ? `${mdParsed.metres}m × ₦${mdParsed.pricePerMeterNgn.toLocaleString('en-NG')}/m`
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
