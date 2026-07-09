import {
  aggregatePaidShortfallsFromRefunds,
  maxProducedMetresAfterPaidUnproducedRefund,
} from '../shared/lib/refundPaidProductionCaps.js';
import { quotedCoilSheetPoolMetresFromLines, quotedRoofingSheetMetresFromLines } from '../shared/lib/refundQuotationMetres.js';
import { isStoneMeterQuotationLinesJson } from './stoneInventory.js';
import {
  normAccessoryNameKey,
  parseQuotationAccessoryLines,
  sumPriorAccessorySuppliedForLine,
} from './accessoryFulfillment.js';
import {
  parseQuotationStoneFlatsheetLines,
  sumPriorStoneFlatsheetConsumedM2ForLine,
} from './stoneFlatsheetFulfillment.js';

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function loadPaidRefundProductionCaps(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) {
    return {
      unproducedMetres: 0,
      accessoryShortfallByKey: new Map(),
      stoneShortfallM2ByKey: new Map(),
    };
  }
  const rows = db
    .prepare(
      `SELECT calculation_lines_json, paid_amount_ngn, status
       FROM customer_refunds
       WHERE quotation_ref = ?
         AND COALESCE(paid_amount_ngn, 0) > 0
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
    )
    .all(ref);
  return aggregatePaidShortfallsFromRefunds(rows);
}

export function jobEffectiveOutputMetres(db, jobId) {
  const jid = String(jobId || '').trim();
  if (!jid) return 0;
  const row = db.prepare(`SELECT actual_meters FROM production_jobs WHERE job_id = ?`).get(jid);
  const adj = db
    .prepare(
      `SELECT COALESCE(SUM(delta_finished_goods_m), 0) AS s
       FROM production_completion_adjustments WHERE job_id = ?`
    )
    .get(jid);
  return safeNumber(row?.actual_meters) + safeNumber(adj?.s);
}

export function quotationEffectiveOutputMetres(db, quotationRef, { replaceJobId, replaceMetres } = {}) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return 0;
  const jobs = db
    .prepare(
      `SELECT job_id FROM production_jobs
       WHERE quotation_ref = ? AND LOWER(TRIM(COALESCE(status, ''))) = 'completed'`
    )
    .all(ref);
  let sum = 0;
  const replaceId = String(replaceJobId || '').trim();
  for (const j of jobs) {
    const jid = String(j.job_id || '').trim();
    if (replaceId && jid === replaceId && replaceMetres != null) {
      sum += safeNumber(replaceMetres);
    } else {
      sum += jobEffectiveOutputMetres(db, jid);
    }
  }
  if (replaceId && replaceMetres != null && !jobs.some((j) => String(j.job_id) === replaceId)) {
    sum += safeNumber(replaceMetres);
  }
  return sum;
}

/**
 * Block increasing roofing/stone FG metres after a paid unproduced-meterage refund.
 */
export function validateProducedMetresEditAgainstPaidRefunds(db, quotationRef, jobId, proposedJobOutputMetres) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true };
  const caps = loadPaidRefundProductionCaps(db, ref);
  if (caps.unproducedMetres <= 0) return { ok: true };

  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  let stoneMeterQuote = false;
  try {
    stoneMeterQuote = quote?.lines_json
      ? isStoneMeterQuotationLinesJson(db, JSON.parse(String(quote.lines_json)))
      : false;
  } catch {
    stoneMeterQuote = false;
  }
  const quotedMetres = stoneMeterQuote
    ? quotedRoofingSheetMetresFromLines(quote?.lines_json ?? '')
    : quotedCoilSheetPoolMetresFromLines(quote?.lines_json ?? '');
  const maxMetres = maxProducedMetresAfterPaidUnproducedRefund(quotedMetres, caps.unproducedMetres);
  if (maxMetres == null) return { ok: true };

  const proposedQuoteTotal = quotationEffectiveOutputMetres(db, ref, {
    replaceJobId: jobId,
    replaceMetres: proposedJobOutputMetres,
  });
  if (proposedQuoteTotal > maxMetres + 0.001) {
    return {
      ok: false,
      code: 'PAID_UNPRODUCED_REFUND_PRODUCTION_CAP',
      error: `This quotation has a paid unproduced-meterage refund (${caps.unproducedMetres.toFixed(
        2
      )} m). Production output cannot exceed ${maxMetres.toFixed(
        2
      )} m in total (currently attempting ${proposedQuoteTotal.toFixed(2)} m). Reverse or adjust the refund before increasing metres produced.`,
      maxProducedMetres: maxMetres,
      proposedProducedMetres: proposedQuoteTotal,
      refundedUnproducedMetres: caps.unproducedMetres,
    };
  }
  return { ok: true, maxProducedMetres: maxMetres };
}

export function validateAccessoryCorrectionAgainstPaidRefunds(db, quotationRef, jobId, plannedLines) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true };
  const caps = loadPaidRefundProductionCaps(db, ref);
  if (!caps.accessoryShortfallByKey.size) return { ok: true };

  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  const accessoryLines = parseQuotationAccessoryLines(quote?.lines_json);
  for (const line of accessoryLines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const paidShortfall =
      caps.accessoryShortfallByKey.get(normAccessoryNameKey(line.name)) ||
      caps.accessoryShortfallByKey.get(stableKey) ||
      0;
    if (paidShortfall <= 0) continue;

    const maxSupplied = Math.max(0, line.orderedQty - paidShortfall);
    const fromOtherJobs = sumPriorAccessorySuppliedForLine(db, ref, stableKey, {
      lineKey,
      name: line.name,
      excludeJobId: jobId,
    });
    const hit = (plannedLines || []).find(
      (p) =>
        String(p.quoteLineId || p.quote_line_id || '').trim() === stableKey ||
        normAccessoryNameKey(p.name) === normAccessoryNameKey(line.name)
    );
    const thisJobQty = safeNumber(hit?.suppliedQty ?? hit?.supplied_qty);
    const total = fromOtherJobs + thisJobQty;
    if (total > maxSupplied + 0.001) {
      return {
        ok: false,
        code: 'PAID_ACCESSORY_REFUND_PRODUCTION_CAP',
        error: `Paid accessory shortfall refund on "${line.name}" (${paidShortfall} unit(s)). Total supplied cannot exceed ${maxSupplied} (attempting ${total}). Adjust the refund before increasing supplied quantity.`,
        accessoryName: line.name,
        maxSuppliedQty: maxSupplied,
        proposedSuppliedQty: total,
      };
    }
  }
  return { ok: true };
}

export function validateStoneFlatsheetCorrectionAgainstPaidRefunds(db, quotationRef, jobId, plannedLines) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return { ok: true };
  const caps = loadPaidRefundProductionCaps(db, ref);
  if (!caps.stoneShortfallM2ByKey.size) return { ok: true };

  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  const stoneLines = parseQuotationStoneFlatsheetLines(quote?.lines_json);
  for (const line of stoneLines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}:${line.lengthM}`;
    const capKey = `${normAccessoryNameKey(line.name)}|${line.lengthM}`;
    const paidShortfallM2 = caps.stoneShortfallM2ByKey.get(capKey) || 0;
    if (paidShortfallM2 <= 0) continue;

    const maxConsumedM2 = Math.max(0, line.orderedM2 - paidShortfallM2);
    const fromOtherJobs = sumPriorStoneFlatsheetConsumedM2ForLine(db, ref, stableKey, {
      lineKey,
      excludeJobId: jobId,
    });
    const hit = (plannedLines || []).find(
      (p) =>
        String(p.quoteLineId || p.quote_line_id || '').trim() === stableKey ||
        (normAccessoryNameKey(p.name) === normAccessoryNameKey(line.name) &&
          safeNumber(p.lengthM ?? p.length_m) === safeNumber(line.lengthM))
    );
    const thisJobM2 =
      safeNumber(hit?.suppliedM2 ?? hit?.supplied_m2) + safeNumber(hit?.deductionM2 ?? hit?.deduction_m2);
    const total = fromOtherJobs + thisJobM2;
    if (total > maxConsumedM2 + 0.001) {
      return {
        ok: false,
        code: 'PAID_STONE_FLATSHEET_REFUND_PRODUCTION_CAP',
        error: `Paid stone flatsheet shortfall refund on "${line.name}" (${paidShortfallM2.toFixed(
          2
        )} m²). Total supplied + deduction cannot exceed ${maxConsumedM2.toFixed(
          2
        )} m² (attempting ${total.toFixed(2)} m²). Adjust the refund before increasing stone flatsheet usage.`,
        stoneLineName: line.name,
        maxConsumedM2,
        proposedConsumedM2: total,
      };
    }
  }
  return { ok: true };
}

export function validateProductionEditAgainstPaidRefunds(db, jobRow, checks = {}) {
  const quotationRef = String(jobRow?.quotation_ref ?? '').trim();
  const jobId = String(jobRow?.job_id ?? jobRow?.jobID ?? '').trim();
  if (!quotationRef || !jobId) return { ok: true };

  if (checks.proposedJobOutputMetres != null) {
    const m = validateProducedMetresEditAgainstPaidRefunds(
      db,
      quotationRef,
      jobId,
      checks.proposedJobOutputMetres
    );
    if (!m.ok) return m;
  }
  if (checks.plannedAccessoryLines) {
    const a = validateAccessoryCorrectionAgainstPaidRefunds(
      db,
      quotationRef,
      jobId,
      checks.plannedAccessoryLines
    );
    if (!a.ok) return a;
  }
  if (checks.plannedStoneFlatsheetLines) {
    const s = validateStoneFlatsheetCorrectionAgainstPaidRefunds(
      db,
      quotationRef,
      jobId,
      checks.plannedStoneFlatsheetLines
    );
    if (!s.ok) return s;
  }
  return { ok: true };
}
