/**
 * Accessory lines on quotations: plan supplied qty at production completion, persist usage, drive stock/refunds.
 */

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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} quoteLineId
 */
export function sumPriorAccessorySuppliedForLine(db, quotationRef, quoteLineId) {
  const ref = String(quotationRef || '').trim();
  const lid = String(quoteLineId || '').trim();
  if (!ref || !lid) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(u.supplied_qty), 0) AS s
       FROM production_job_accessory_usage u
       INNER JOIN production_jobs j ON j.job_id = u.job_id
       WHERE u.quotation_ref = ? AND u.quote_line_id = ? AND j.status = 'Completed'`
    )
    .get(ref, lid);
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
 * @returns {{ ok: true, plannedLines: object[] } | { ok: false, error: string }}
 */
export function planAccessoryCompletion(db, jobRow, payload = {}) {
  const quotationRef = String(jobRow?.quotation_ref ?? '').trim();
  if (!quotationRef) {
    return { ok: true, plannedLines: [] };
  }
  const quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(quotationRef);
  if (!quote) {
    return { ok: false, error: 'Quotation not found for accessory validation.' };
  }
  const accessoryLines = parseQuotationAccessoryLines(quote.lines_json);
  if (!accessoryLines.length) {
    return { ok: true, plannedLines: [] };
  }

  const accessoriesSupplied = Array.isArray(payload.accessoriesSupplied) ? payload.accessoriesSupplied : [];
  const byLineId = new Map();
  const byName = new Map();
  for (const e of accessoriesSupplied) {
    const qid = String(e?.quoteLineId ?? e?.quote_line_id ?? '').trim();
    const nm = String(e?.name ?? '').trim();
    const sq = Number(e?.suppliedQty ?? e?.supplied_qty);
    if (qid) byLineId.set(qid, sq);
    else if (nm) byName.set(nm, sq);
  }

  const plannedLines = [];
  const EPS = 1e-6;

  for (const line of accessoryLines) {
    const lineKey = line.quoteLineId || '';
    const stableKey = lineKey || `name:${line.name}`;
    const prior = sumPriorAccessorySuppliedForLine(db, quotationRef, stableKey);
    const remaining = Math.max(0, line.orderedQty - prior);
    let supplied;
    if (lineKey && byLineId.has(lineKey)) {
      supplied = Number(byLineId.get(lineKey));
    } else if (byLineId.has(stableKey)) {
      supplied = Number(byLineId.get(stableKey));
    } else if (byName.has(line.name)) {
      supplied = Number(byName.get(line.name));
    } else {
      supplied = remaining;
    }
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
      const p = db.prepare(`SELECT stock_level, name FROM products WHERE product_id = ?`).get(inventoryProductId);
      if (!p) {
        return {
          ok: false,
          error: `Accessory "${line.name}" maps to unknown stock product ${inventoryProductId}.`,
        };
      }
      const stock = Number(p.stock_level) || 0;
      if (stock + EPS < supplied) {
        return {
          ok: false,
          error: `Insufficient stock for "${line.name}" (${p.name || inventoryProductId}): need ${supplied}, have ${stock}.`,
        };
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

  return { ok: true, plannedLines };
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
    const supplied = sumPriorAccessorySuppliedForLine(db, ref, stableKey);
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
