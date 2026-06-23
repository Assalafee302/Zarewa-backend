/**
 * Accessory lines on quotations: plan supplied qty at production completion, persist usage, drive stock/refunds.
 */
import { getProductRowForWorkspace } from './productBranchInventory.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

/**
 * @param {unknown} linesJson
 * @returns {{ quoteLineId: string; name: string; orderedQty: number; unitPriceNgn: number }[]}
 */
export function parseQuotationAccessoryLines(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const arr = payload?.accessories;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((row) => {
      const orderedQty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
      let unitPriceNgn = Math.round(
        Number(String(row?.unitPrice ?? row?.unit_price_ngn ?? row?.unit_price ?? '').replace(/,/g, '')) || 0
      );
      if (unitPriceNgn <= 0 && orderedQty > 0) {
        const lump = Math.round(
          Number(String(row?.value ?? row?.lineTotal ?? row?.line_total_ngn ?? '').replace(/,/g, '')) || 0
        );
        if (lump > 0) unitPriceNgn = Math.round(lump / orderedQty);
      }
      if (unitPriceNgn <= 0) {
        unitPriceNgn = Math.round(
          Number(String(row?.value ?? row?.lineTotal ?? row?.line_total_ngn ?? '').replace(/,/g, '')) || 0
        );
      }
      return {
        quoteLineId: String(row?.id ?? '').trim(),
        name: String(row?.name ?? '').trim(),
        orderedQty,
        unitPriceNgn,
      };
    })
    .filter((r) => r.name && r.orderedQty > 0);
}

/** Normalize accessory label for case/whitespace-tolerant payload matching. */
export function normAccessoryNameKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * SQL equality params for `LOWER(TRIM(u.name))` so minor label drift still rolls up
 * (e.g. "Drive screw nail" on quote vs "Drive screw nails" on usage rows).
 */
export function accessoryNameMatchParamVariants(name) {
  const base = normAccessoryNameKey(name);
  if (!base) return [];
  const v = new Set([base]);
  if (base.length > 2 && base.endsWith('s') && !base.endsWith('ss')) {
    v.add(base.slice(0, -1));
  } else if (base.length > 0 && !base.endsWith('s')) {
    v.add(base + 's');
  }
  return [...v];
}

/**
 * Indexes `accessoriesSupplied` from completion / correction payloads.
 * When both `quoteLineId` and `name` are present, **both** are registered so a stale
 * client line id cannot prevent resolving the quantity by accessory name.
 */
export function buildAccessorySuppliedLookup(accessoriesSupplied) {
  const byLineId = new Map();
  const byNameKey = new Map();
  for (const e of Array.isArray(accessoriesSupplied) ? accessoriesSupplied : []) {
    const qid = String(e?.quoteLineId ?? e?.quote_line_id ?? '').trim();
    const nm = String(e?.name ?? '').trim();
    const sq = Number(e?.suppliedQty ?? e?.supplied_qty);
    if (!Number.isFinite(sq)) continue;
    if (qid) byLineId.set(qid, sq);
    if (nm) {
      for (const vk of accessoryNameMatchParamVariants(nm)) {
        byNameKey.set(vk, sq);
      }
    }
  }
  return { byLineId, byNameKey };
}

/**
 * @param {{ quoteLineId: string; name: string }} line
 * @param {{ byLineId: Map<string, number>; byNameKey: Map<string, number> }} maps
 * @param {number} remainingDefault
 */
export function resolveSuppliedQtyFromPayloadMaps(line, maps, remainingDefault) {
  const lineKey = line.quoteLineId || '';
  const stableKey = lineKey || `name:${line.name}`;
  const { byLineId, byNameKey } = maps;
  if (lineKey && byLineId.has(lineKey)) return Number(byLineId.get(lineKey));
  if (byLineId.has(stableKey)) return Number(byLineId.get(stableKey));
  for (const variant of accessoryNameMatchParamVariants(line.name)) {
    if (variant && byNameKey.has(variant)) return Number(byNameKey.get(variant));
  }
  return remainingDefault;
}

/**
 * Sum supplied accessory qty across completed jobs for a quotation line.
 * Matches `quote_line_id` (stable key or legacy id) **or** the persisted usage `name`
 * when ids on the quotation were regenerated but the label stayed the same.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} stableKey `quoteLineId` or `name:${name}` from the quotation JSON
 * @param {{ lineKey?: string; name?: string; excludeJobId?: string }} [opts]
 */
export function sumPriorAccessorySuppliedForLine(db, quotationRef, stableKey, opts = {}) {
  const ref = String(quotationRef || '').trim();
  const sk = String(stableKey || '').trim();
  if (!ref || !sk) return 0;
  const lineKey = String(opts.lineKey ?? '').trim();
  const name = String(opts.name ?? '').trim();
  const excludeJobId = String(opts.excludeJobId ?? '').trim();

  const parts = ['u.quote_line_id = ?'];
  const params = [ref, sk];
  if (lineKey && lineKey !== sk) {
    parts.push('u.quote_line_id = ?');
    params.push(lineKey);
  }
  if (name) {
    const variants = accessoryNameMatchParamVariants(name);
    if (variants.length) {
      parts.push(`(${variants.map(() => 'LOWER(TRIM(u.name)) = ?').join(' OR ')})`);
      params.push(...variants);
    }
  }

  let sql = `SELECT COALESCE(SUM(u.supplied_qty), 0) AS s
     FROM production_job_accessory_usage u
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
 * @param {string} quoteLineId
 * @param {string} lineName
 * @returns {string | null}
 */
export function resolveAccessoryInventoryProductId(db, quoteLineId, lineName) {
  const id = String(quoteLineId || '').trim();
  const name = String(lineName || '').trim();
  if (id) {
    const byId = db.prepare(`SELECT inventory_product_id FROM setup_quote_items WHERE item_id = ?`).get(id);
    const pid = byId?.inventory_product_id != null ? String(byId.inventory_product_id).trim() : '';
    if (pid) return pid;
  }
  if (name) {
    const byName = db
      .prepare(
        `SELECT inventory_product_id FROM setup_quote_items
         WHERE item_type = 'accessory' AND active = 1 AND name = ?
         ORDER BY sort_order ASC, item_id ASC LIMIT 1`
      )
      .get(name);
    const pid = byName?.inventory_product_id != null ? String(byName.inventory_product_id).trim() : '';
    if (pid) return pid;
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} jobRow production_jobs row
 * @param {{ accessoriesSupplied?: unknown[] }} payload
 * @returns {{ ok: true, plannedLines: object[], accessoryStockWarnings: string[] } | { ok: false, error: string }}
 */
export function planAccessoryCompletion(db, jobRow, payload = {}) {
  const quotationRef = String(jobRow?.quotation_ref ?? '').trim();
  if (!quotationRef) {
    return { ok: true, plannedLines: [], accessoryStockWarnings: [] };
  }
  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(quotationRef);
  if (!quote) {
    return { ok: false, error: 'Quotation not found for accessory validation.' };
  }
  const accessoryLines = parseQuotationAccessoryLines(quote.lines_json);
  if (!accessoryLines.length) {
    return { ok: true, plannedLines: [], accessoryStockWarnings: [] };
  }

  const accessoriesSupplied = Array.isArray(payload.accessoriesSupplied) ? payload.accessoriesSupplied : [];
  const maps = buildAccessorySuppliedLookup(accessoriesSupplied);

  const plannedLines = [];
  const accessoryStockWarnings = [];
  const EPS = 1e-6;
  const branchId = String(jobRow?.branch_id ?? DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  for (const line of accessoryLines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const prior = sumPriorAccessorySuppliedForLine(db, quotationRef, stableKey, {
      lineKey,
      name: line.name,
    });
    const remaining = Math.max(0, line.orderedQty - prior);
    const supplied = resolveSuppliedQtyFromPayloadMaps(line, maps, remaining);
    if (!Number.isFinite(supplied) || supplied < 0 - EPS) {
      return { ok: false, error: `Invalid supplied quantity for accessory "${line.name}".` };
    }
    if (supplied > remaining + EPS) {
      return {
        ok: false,
        error: `Accessory "${line.name}": supplied ${supplied} exceeds remaining ${remaining.toFixed(2)} (ordered ${line.orderedQty}, already issued ${prior.toFixed(2)}).`,
      };
    }
    const inventoryProductId = resolveAccessoryInventoryProductId(db, lineKey, line.name);
    if (inventoryProductId) {
      const p = getProductRowForWorkspace(db, inventoryProductId, branchId);
      if (!p) {
        return {
          ok: false,
          error: `Accessory "${line.name}" maps to unknown stock product ${inventoryProductId}.`,
        };
      }
      const stock = Number(p.stock_level) || 0;
      if (stock + EPS < supplied) {
        accessoryStockWarnings.push(
          `"${line.name}" (${p.name || inventoryProductId}): issuing ${supplied} units but only ${stock} on hand — accessory balance will go negative.`
        );
      }
    }
    plannedLines.push({
      quoteLineId: stableKey,
      name: line.name,
      orderedQty: line.orderedQty,
      suppliedQty: supplied,
      unitPriceNgn: line.unitPriceNgn,
      inventoryProductId,
    });
  }

  return { ok: true, plannedLines, accessoryStockWarnings };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobID
 * @param {string} quotationRef
 * @param {string} completedAtISO
 * @param {object[]} plannedLines from planAccessoryCompletion
 * @param {(db: import('better-sqlite3').Database, productID: string, delta: number) => void} adjustProductStockTx
 * @param {(db: import('better-sqlite3').Database, payload: object) => void} appendStockMovementTx
 */
export function applyAccessoryCompletionTx(
  db,
  jobID,
  quotationRef,
  completedAtISO,
  plannedLines,
  adjustProductStockTx,
  appendStockMovementTx
) {
  db.prepare(`DELETE FROM production_job_accessory_usage WHERE job_id = ?`).run(jobID);
  const ins = db.prepare(
    `INSERT INTO production_job_accessory_usage (
      id, job_id, quotation_ref, quote_line_id, name, ordered_qty, supplied_qty, inventory_product_id, posted_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const at = String(completedAtISO || '').slice(0, 10);
  plannedLines.forEach((line, idx) => {
    const usageId = `PAU-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 9)}`;
    ins.run(
      usageId,
      jobID,
      quotationRef || null,
      line.quoteLineId,
      line.name,
      line.orderedQty,
      line.suppliedQty,
      line.inventoryProductId || null,
      completedAtISO
    );
    if (line.inventoryProductId && line.suppliedQty > 0) {
      adjustProductStockTx(db, line.inventoryProductId, -line.suppliedQty);
      appendStockMovementTx(db, {
        atISO: completedAtISO,
        type: 'ACCESSORY_ISSUE',
        ref: jobID,
        productID: line.inventoryProductId,
        qty: -line.suppliedQty,
        detail: `${line.name} · ${jobID} · ${quotationRef || ''}`,
        dateISO: at,
      });
    }
  });
}

/**
 * Per quotation: ordered vs supplied (completed jobs) for refund preview / intelligence.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function accessoryFulfillmentSummaryForQuotation(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return [];
  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  if (!quote) return [];
  const lines = parseQuotationAccessoryLines(quote.lines_json);
  if (!lines.length) return [];
  const out = [];
  for (const line of lines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const supplied = sumPriorAccessorySuppliedForLine(db, ref, stableKey, {
      lineKey,
      name: line.name,
    });
    const shortfall = Math.max(0, line.orderedQty - supplied);
    out.push({
      quoteLineId: stableKey,
      name: line.name,
      ordered: line.orderedQty,
      supplied,
      shortfall,
      unitPriceNgn: line.unitPriceNgn,
    });
  }
  return out;
}
