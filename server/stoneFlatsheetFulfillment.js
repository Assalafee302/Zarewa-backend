/**
 * Stone flatsheet (m²) lines on quotations: plan usage at production completion, persist rows, drive stock.
 */

import {
  normQuoteItemKey,
  productLineKey,
  resolveStoneFlatsheetLengthM,
} from '../shared/lib/stoneCoatedQuotationPolicy.js';
import { quotationLineUnitPriceNumber } from '../shared/lib/quotationLineNumericForRefund.js';
import { ensureStoneFlatsheetProduct } from './stoneInventory.js';

/**
 * @param {unknown} linesJson
 * @returns {{ quoteLineId: string; name: string; orderedM2: number; lengthM: 1.4 | 1.5 | 2; colourLabel: string }[]}
 */
export function parseQuotationStoneFlatsheetLines(linesJson) {
  let j = linesJson;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j || '{}');
    } catch {
      j = {};
    }
  }
  if (!j || typeof j !== 'object') j = {};
  const headerColour = String(j.materialColor || '').trim();
  const products = Array.isArray(j.products) ? j.products : [];
  const out = [];
  for (const row of products) {
    const name = String(row?.name ?? '').trim();
    if (productLineKey(name) !== 'stone flatsheet') continue;
    const orderedM2 = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
    const lengthM = resolveStoneFlatsheetLengthM(row);
    const quoteLineId = String(row?.id ?? '').trim();
    if (orderedM2 <= 0) continue;
    if (lengthM == null) continue;
    out.push({
      quoteLineId,
      name: name || 'Stone flatsheet',
      orderedM2,
      lengthM,
      colourLabel: headerColour,
    });
  }
  return out;
}

/**
 * @param {unknown} linesJson
 * @returns {boolean}
 */
export function quotationHasStoneFlatsheetWithQtyButMissingLength(linesJson) {
  let j = linesJson;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j || '{}');
    } catch {
      j = {};
    }
  }
  if (!j || typeof j !== 'object') return false;
  const products = Array.isArray(j.products) ? j.products : [];
  for (const row of products) {
    const name = String(row?.name ?? '').trim();
    if (productLineKey(name) !== 'stone flatsheet') continue;
    const orderedM2 = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
    if (orderedM2 <= 0) continue;
    const lengthM = resolveStoneFlatsheetLengthM(row);
    if (lengthM == null) return true;
  }
  return false;
}

/**
 * @param {unknown} rows
 * @returns {{ byLineId: Map<string, { suppliedM2: number; deductionM2: number }>; byNameKey: Map<string, { suppliedM2: number; deductionM2: number }> }}
 */
export function buildStoneFlatsheetSuppliedLookup(rows) {
  const byLineId = new Map();
  const byNameKey = new Map();
  for (const e of Array.isArray(rows) ? rows : []) {
    const qid = String(e?.quoteLineId ?? e?.quote_line_id ?? '').trim();
    const nm = String(e?.name ?? '').trim();
    const sm = Number(e?.suppliedM2 ?? e?.supplied_m2);
    const dm = Number(e?.deductionM2 ?? e?.deduction_m2 ?? 0);
    if (!Number.isFinite(sm) && !Number.isFinite(dm)) continue;
    const suppliedM2 = Number.isFinite(sm) ? sm : 0;
    const deductionM2 = Number.isFinite(dm) ? dm : 0;
    const rec = { suppliedM2, deductionM2 };
    if (qid) byLineId.set(qid, rec);
    if (nm) byNameKey.set(normQuoteItemKey(nm), rec);
  }
  return { byLineId, byNameKey };
}

/**
 * @param {{ quoteLineId: string; name: string }} line
 * @param {{ byLineId: Map<string, { suppliedM2: number; deductionM2: number }>; byNameKey: Map<string, { suppliedM2: number; deductionM2: number }> }} maps
 * @param {number} remainingDefault supplied m² default when payload omits the line
 */
export function resolveStoneFlatsheetUsageFromPayloadMaps(line, maps, remainingDefault) {
  const lineKey = line.quoteLineId || '';
  const { byLineId, byNameKey } = maps;
  if (lineKey && byLineId.has(lineKey)) return byLineId.get(lineKey);
  const nk = normQuoteItemKey(line.name);
  if (nk && byNameKey.has(nk)) return byNameKey.get(nk);
  return { suppliedM2: remainingDefault, deductionM2: 0 };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} stableKey
 * @param {{ lineKey?: string; excludeJobId?: string }} [opts]
 */
export function sumPriorStoneFlatsheetConsumedM2ForLine(db, quotationRef, stableKey, opts = {}) {
  const ref = String(quotationRef || '').trim();
  const sk = String(stableKey || '').trim();
  if (!ref || !sk) return 0;
  const lineKey = String(opts.lineKey ?? '').trim();
  const excludeJobId = String(opts.excludeJobId ?? '').trim();

  const parts = ['u.quote_line_id = ?'];
  const params = [ref, sk];
  if (lineKey && lineKey !== sk) {
    parts.push('u.quote_line_id = ?');
    params.push(lineKey);
  }

  let sql = `SELECT COALESCE(SUM(u.supplied_m2 + u.deduction_m2), 0) AS s
     FROM production_job_stone_flatsheet_usage u
     INNER JOIN production_jobs j ON j.job_id = u.job_id
     WHERE u.quotation_ref = ? AND j.status = 'Completed' AND (${parts.join(' OR ')})`;
  if (excludeJobId) {
    sql += ' AND u.job_id != ?';
    params.push(excludeJobId);
  }
  const row = db.prepare(sql).get(...params);
  return Number(row?.s) || 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} jobRow production_jobs row
 * @param {{ stoneFlatsheetSupplied?: unknown[] }} payload
 * @param {{ excludeJobId?: string }} [opts]
 * @returns {{ ok: true, plannedLines: object[], stoneFlatsheetStockWarnings: string[] } | { ok: false, error: string }}
 */
export function planStoneFlatsheetFulfillment(db, jobRow, payload = {}, opts = {}) {
  const excludeJobId = String(opts.excludeJobId ?? '').trim();
  const quotationRef = String(jobRow?.quotation_ref ?? '').trim();
  if (!quotationRef) {
    return { ok: true, plannedLines: [], stoneFlatsheetStockWarnings: [] };
  }
  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(quotationRef);
  if (!quote) return { ok: false, error: 'Quotation not found for stone flatsheet validation.' };

  if (quotationHasStoneFlatsheetWithQtyButMissingLength(quote.lines_json)) {
    return {
      ok: false,
      error:
        'Stone flatsheet lines on this quotation are missing length (1.4 m, 1.5 m, or 2 m). Update the quotation before completing production.',
    };
  }

  const lines = parseQuotationStoneFlatsheetLines(quote.lines_json);
  if (!lines.length) {
    return { ok: true, plannedLines: [], stoneFlatsheetStockWarnings: [] };
  }

  const maps = buildStoneFlatsheetSuppliedLookup(payload.stoneFlatsheetSupplied);
  const plannedLines = [];
  const stoneFlatsheetStockWarnings = [];
  const EPS = 1e-6;
  const branchId = String(jobRow?.branch_id ?? '').trim() || '';

  for (const line of lines) {
    if (!line.colourLabel) {
      return {
        ok: false,
        error: 'Quotation header colour is required when stone flatsheet lines are on the quote.',
      };
    }
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const prior = sumPriorStoneFlatsheetConsumedM2ForLine(db, quotationRef, stableKey, {
      excludeJobId,
      lineKey,
    });
    const remaining = Math.max(0, line.orderedM2 - prior);
    const fromMaps = resolveStoneFlatsheetUsageFromPayloadMaps(line, maps, remaining);
    let suppliedM2 = Number(fromMaps.suppliedM2);
    let deductionM2 = Number(fromMaps.deductionM2);
    if (!Number.isFinite(suppliedM2)) suppliedM2 = remaining;
    if (!Number.isFinite(deductionM2)) deductionM2 = 0;
    if (suppliedM2 < 0 - EPS || deductionM2 < 0 - EPS) {
      return { ok: false, error: `Invalid supplied or deduction m² for stone flatsheet "${line.name}".` };
    }
    const totalUse = suppliedM2 + deductionM2;
    if (totalUse > remaining + EPS) {
      return {
        ok: false,
        error: `Stone flatsheet "${line.name}" (${line.lengthM} m): ${totalUse.toFixed(
          2
        )} m² exceeds remaining ${remaining.toFixed(2)} m² (ordered ${line.orderedM2.toFixed(
          2
        )}, already consumed ${prior.toFixed(2)}).`,
      };
    }

    let inventoryProductId;
    try {
      inventoryProductId = ensureStoneFlatsheetProduct(db, {
        colourLabel: line.colourLabel,
        lengthM: line.lengthM,
        branchId,
      });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    const p = db.prepare(`SELECT stock_level, name FROM products WHERE product_id = ?`).get(inventoryProductId);
    if (!p) {
      return {
        ok: false,
        error: `Stone flatsheet "${line.name}" maps to unknown stock product ${inventoryProductId}.`,
      };
    }
    const stock = Number(p.stock_level) || 0;
    if (stock + EPS < totalUse) {
      stoneFlatsheetStockWarnings.push(
        `"${line.name}" (${line.lengthM} m, ${p.name || inventoryProductId}): ${totalUse.toFixed(
          2
        )} m² from stock but only ${stock.toFixed(2)} m² on hand — balance may go negative.`
      );
    }

    plannedLines.push({
      quoteLineId: stableKey,
      name: line.name,
      lengthM: line.lengthM,
      orderedM2: line.orderedM2,
      suppliedM2,
      deductionM2,
      inventoryProductId,
    });
  }

  return { ok: true, plannedLines, stoneFlatsheetStockWarnings };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobID
 * @param {string} quotationRef
 * @param {string} completedAtISO
 * @param {object[]} plannedLines from planStoneFlatsheetFulfillment
 * @param {(db: import('better-sqlite3').Database, productID: string, delta: number) => void} adjustProductStockTx
 * @param {(db: import('better-sqlite3').Database, payload: object) => void} appendStockMovementTx
 */
export function applyStoneFlatsheetCompletionTx(
  db,
  jobID,
  quotationRef,
  completedAtISO,
  plannedLines,
  adjustProductStockTx,
  appendStockMovementTx
) {
  db.prepare(`DELETE FROM production_job_stone_flatsheet_usage WHERE job_id = ?`).run(jobID);
  const ins = db.prepare(
    `INSERT INTO production_job_stone_flatsheet_usage (
      id, job_id, quotation_ref, quote_line_id, name, length_m, ordered_m2, supplied_m2, deduction_m2, inventory_product_id, posted_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const at = String(completedAtISO || '').slice(0, 10);
  plannedLines.forEach((line, idx) => {
    const usageId = `PSF-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 9)}`;
    ins.run(
      usageId,
      jobID,
      quotationRef || null,
      line.quoteLineId,
      line.name,
      line.lengthM,
      line.orderedM2,
      line.suppliedM2,
      line.deductionM2,
      line.inventoryProductId || null,
      completedAtISO
    );
    const totalOut = (Number(line.suppliedM2) || 0) + (Number(line.deductionM2) || 0);
    if (line.inventoryProductId && totalOut > 0) {
      adjustProductStockTx(db, line.inventoryProductId, -totalOut);
      appendStockMovementTx(db, {
        atISO: completedAtISO,
        type: 'STONE_FLATSHEET_ISSUE',
        ref: jobID,
        productID: line.inventoryProductId,
        qty: -totalOut,
        detail: `${line.name} ${line.lengthM} m · supplied ${line.suppliedM2} m² · deduction ${line.deductionM2} m² · ${jobID} · ${quotationRef || ''}`,
        dateISO: at,
      });
    }
  });
}

/**
 * Refund preview lines: quoted stone flatsheet m² minus supplied and deduction on completed/cancelled jobs.
 * Requires at least one persisted usage row for this quotation (avoids treating “not yet produced” as full shortfall).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {unknown} linesJson quotation `lines_json`
 * @returns {{ quoteLineId: string; name: string; lengthM: number; shortfallM2: number; unitPriceNgn: number; amountNgn: number }[]}
 */
export function stoneFlatsheetShortfallRefundSuggestions(db, quotationRef, linesJson) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return [];

  let quoteProducts = [];
  try {
    let j = linesJson;
    if (typeof j === 'string') j = JSON.parse(j || '{}');
    quoteProducts = Array.isArray(j?.products) ? j.products : [];
  } catch {
    quoteProducts = [];
  }

  const fromQuote = parseQuotationStoneFlatsheetLines(linesJson);
  if (!fromQuote.length) return [];

  try {
    if (
      !db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_job_stone_flatsheet_usage'`)
        .get()
    ) {
      return [];
    }
  } catch {
    return [];
  }

  const hasAnyUsage = db
    .prepare(
      `SELECT 1 AS x FROM production_job_stone_flatsheet_usage u
       INNER JOIN production_jobs j ON j.job_id = u.job_id
       WHERE j.quotation_ref = ?
         AND LOWER(TRIM(COALESCE(j.status, ''))) IN ('completed', 'cancelled')
       LIMIT 1`
    )
    .get(ref);
  if (!hasAnyUsage) return [];

  let aggRows;
  try {
    aggRows = db
      .prepare(
        `SELECT u.quote_line_id AS quote_line_id,
                u.name AS name,
                u.length_m AS length_m,
                MAX(u.ordered_m2) AS ordered_m2,
                SUM(u.supplied_m2) AS supplied_m2,
                SUM(u.deduction_m2) AS deduction_m2
         FROM production_job_stone_flatsheet_usage u
         INNER JOIN production_jobs j ON j.job_id = u.job_id
         INNER JOIN quotations q ON q.id = j.quotation_ref
         WHERE j.quotation_ref = ?
           AND LOWER(TRIM(COALESCE(j.status, ''))) IN ('completed', 'cancelled')
         GROUP BY u.quote_line_id, u.name, u.length_m`
      )
      .all(ref);
  } catch {
    return [];
  }

  const roundMoney = (v) => Math.round(Number(v) || 0);

  function matchAgg(line) {
    const lid = String(line.quoteLineId || '').trim();
    if (lid) {
      const byId = aggRows.find((r) => String(r.quote_line_id || '').trim() === lid);
      if (byId) return byId;
    }
    const nk = normQuoteItemKey(line.name);
    const len = line.lengthM;
    return aggRows.find((r) => {
      if (normQuoteItemKey(r.name) !== nk) return false;
      return Math.abs(Number(r.length_m) - len) < 1e-3;
    });
  }

  const out = [];
  for (const line of fromQuote) {
    const merged = matchAgg(line);
    const supplied = Number(merged?.supplied_m2) || 0;
    const deduction = Number(merged?.deduction_m2) || 0;
    const ordered = line.orderedM2;
    const shortM2 = Math.max(0, ordered - supplied - deduction);
    if (shortM2 <= 0) continue;
    const lid = String(line.quoteLineId || '').trim();
    const raw =
      (lid && quoteProducts.find((p) => String(p?.id ?? '').trim() === lid)) ||
      quoteProducts.find((p) => {
        if (productLineKey(p?.name) !== 'stone flatsheet') return false;
        return resolveStoneFlatsheetLengthM(p) === line.lengthM;
      });
    const unitR = Math.round(quotationLineUnitPriceNumber(raw));
    const amountNgn = roundMoney(shortM2 * unitR);
    if (amountNgn <= 0) continue;
    out.push({
      quoteLineId: lid,
      name: line.name,
      lengthM: line.lengthM,
      shortfallM2: shortM2,
      unitPriceNgn: unitR,
      amountNgn,
    });
  }
  return out;
}
