import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { nextInTransitLoadHumanId } from './humanId.js';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const value = JSON.parse(String(raw));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeDate(raw) {
  const s = String(raw || '').trim();
  return s || null;
}

function inTransitTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='in_transit_loads'`).get());
  } catch {
    return false;
  }
}

function poLoadLines(db, poId) {
  return db
    .prepare(
      `SELECT po_id, line_key, product_id, product_name, qty_ordered, qty_received
       FROM purchase_order_lines WHERE po_id = ? ORDER BY line_key`
    )
    .all(poId);
}

function listLoadRows(db, branchScope = 'ALL') {
  const useScope = branchScope !== 'ALL' && String(branchScope || '').trim();
  const args = useScope ? [branchScope] : [];
  const sql = useScope
    ? `SELECT * FROM in_transit_loads WHERE destination_branch_id = ? ORDER BY posted_at_iso DESC, id DESC`
    : `SELECT * FROM in_transit_loads ORDER BY posted_at_iso DESC, id DESC`;
  const lineStmt = db.prepare(
    `SELECT * FROM in_transit_load_lines WHERE load_id = ? ORDER BY line_no ASC`
  );
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    destinationBranchId: row.destination_branch_id,
    status: row.status,
    sourceKind: row.source_kind,
    sourceId: row.source_id || '',
    purchaseOrderId: row.purchase_order_id || '',
    materialRequestId: row.material_request_id || '',
    transportAgentId: row.transport_agent_id || '',
    transportAgentName: row.transport_agent_name || '',
    transportReference: row.transport_reference || '',
    waybillRef: row.waybill_ref || '',
    etaDateIso: row.eta_date_iso || '',
    loadedAtIso: row.loaded_at_iso || '',
    postedAtIso: row.posted_at_iso || '',
    receivedAtIso: row.received_at_iso || '',
    delayReason: row.delay_reason || '',
    exceptionNote: row.exception_note || '',
    haulageCostNgn: Number(row.haulage_cost_ngn) || 0,
    treasuryMovementId: row.treasury_movement_id || '',
    relatedWorkItemId: row.related_work_item_id || '',
    data: safeJsonParse(row.data_json, {}),
    lines: lineStmt.all(row.id).map((line) => ({
      lineNo: line.line_no,
      purchaseOrderLineKey: line.purchase_order_line_key || '',
      materialRequestLineNo: line.material_request_line_no ?? null,
      productId: line.product_id || '',
      itemName: line.item_name || '',
      unit: line.unit,
      qtyLoaded: Number(line.qty_loaded) || 0,
      qtyReceived: Number(line.qty_received) || 0,
      shortLandedQty: Number(line.short_landed_qty) || 0,
    })),
  }));
}

export function listInTransitLoads(db, branchScope = 'ALL') {
  if (!inTransitTablesReady(db)) return [];
  return listLoadRows(db, branchScope);
}

function upsertLoadLines(db, loadId, lines) {
  db.prepare(`DELETE FROM in_transit_load_lines WHERE load_id = ?`).run(loadId);
  const insert = db.prepare(
    `INSERT INTO in_transit_load_lines (
      load_id, line_no, purchase_order_line_key, material_request_line_no, product_id, item_name, unit,
      qty_loaded, qty_received, short_landed_qty
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const line of lines) {
    insert.run(
      loadId,
      line.lineNo,
      line.purchaseOrderLineKey || null,
      line.materialRequestLineNo ?? null,
      line.productId || null,
      line.itemName || null,
      line.unit || 'unit',
      line.qtyLoaded || 0,
      line.qtyReceived || 0,
      line.shortLandedQty || 0
    );
  }
}

function findLoadByPo(db, poId) {
  if (!inTransitTablesReady(db)) return null;
  return db
    .prepare(
      `SELECT * FROM in_transit_loads
       WHERE purchase_order_id = ?
       ORDER BY posted_at_iso DESC, loaded_at_iso DESC, id DESC
       LIMIT 1`
    )
    .get(poId);
}

export function syncInTransitLoadFromPoLink(db, poId, actor = null) {
  if (!inTransitTablesReady(db)) return { ok: true, load: null };
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poId);
  if (!po) return { ok: false, error: 'PO not found.' };
  const now = nowIso();
  const existing = findLoadByPo(db, poId);
  const id = existing?.id || nextInTransitLoadHumanId(db, po.branch_id || DEFAULT_BRANCH_ID);
  const referenceNo = existing?.reference_no || id;
  const lineRows = poLoadLines(db, poId);
  const lines = lineRows.map((line, idx) => ({
    lineNo: idx + 1,
    purchaseOrderLineKey: line.line_key,
    materialRequestLineNo: null,
    productId: line.product_id || '',
    itemName: line.product_name || line.product_id || '',
    unit: /^ACC-/i.test(String(line.product_id || '').trim())
      ? 'unit'
      : /^STONE-/i.test(String(line.product_id || '').trim())
        ? 'm'
        : 'kg',
    qtyLoaded: Math.max(0, Number(line.qty_ordered) || 0),
    qtyReceived: Math.max(0, Number(line.qty_received) || 0),
    shortLandedQty: 0,
  }));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO in_transit_loads (
        id, reference_no, branch_id, destination_branch_id, status, source_kind, source_id, purchase_order_id,
        material_request_id, transport_agent_id, transport_agent_name, transport_reference, waybill_ref,
        eta_date_iso, loaded_at_iso, posted_at_iso, received_at_iso, delay_reason, exception_note,
        haulage_cost_ngn, treasury_movement_id, related_work_item_id, data_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        branch_id = excluded.branch_id,
        destination_branch_id = excluded.destination_branch_id,
        status = excluded.status,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        purchase_order_id = excluded.purchase_order_id,
        material_request_id = excluded.material_request_id,
        transport_agent_id = excluded.transport_agent_id,
        transport_agent_name = excluded.transport_agent_name,
        transport_reference = excluded.transport_reference,
        waybill_ref = excluded.waybill_ref,
        eta_date_iso = excluded.eta_date_iso,
        loaded_at_iso = excluded.loaded_at_iso,
        delay_reason = excluded.delay_reason,
        exception_note = excluded.exception_note,
        data_json = excluded.data_json`
    ).run(
      id,
      referenceNo,
      String(po.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
      String(po.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
      po.status === 'In Transit' ? 'in_transit' : 'loading_confirmed',
      'purchase_order',
      poId,
      poId,
      null,
      String(po.transport_agent_id || '').trim() || null,
      String(po.transport_agent_name || '').trim() || null,
      String(po.transport_reference || '').trim() || null,
      String(po.transport_reference || '').trim() || null,
      normalizeDate(po.expected_delivery_iso),
      po.status === 'On loading' ? now : existing?.loaded_at_iso || now,
      existing?.posted_at_iso || null,
      existing?.received_at_iso || null,
      existing?.delay_reason || null,
      existing?.exception_note || null,
      Number(po.transport_amount_ngn) || 0,
      String(po.transport_treasury_movement_id || '').trim() || null,
      existing?.related_work_item_id || null,
      JSON.stringify({
        routePath: '/procurement',
        routeState: { focusTab: 'suppliers' },
      })
    );
    upsertLoadLines(db, id, lines);
  })();
  appendAuditLog(db, {
    actor,
    action: 'in_transit_load.sync_from_link',
    entityKind: 'in_transit_load',
    entityId: id,
    note: poId,
  });
  return { ok: true, load: listLoadRows(db, 'ALL').find((row) => row.id === id) || null };
}

export function syncInTransitLoadFromTransportPost(db, poId, actor = null) {
  if (!inTransitTablesReady(db)) return { ok: true, load: null };
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poId);
  if (!po) return { ok: false, error: 'PO not found.' };
  const existing = findLoadByPo(db, poId);
  if (!existing) return syncInTransitLoadFromPoLink(db, poId, actor);
  const now = nowIso();
  db.prepare(
    `UPDATE in_transit_loads
     SET status = 'in_transit',
         posted_at_iso = ?,
         transport_agent_id = ?,
         transport_agent_name = ?,
         transport_reference = ?,
         waybill_ref = ?,
         haulage_cost_ngn = ?,
         treasury_movement_id = ?
     WHERE id = ?`
  ).run(
    now,
    String(po.transport_agent_id || '').trim() || null,
    String(po.transport_agent_name || '').trim() || null,
    String(po.transport_reference || '').trim() || null,
    String(po.transport_reference || '').trim() || null,
    Number(po.transport_amount_ngn) || 0,
    String(po.transport_treasury_movement_id || '').trim() || null,
    existing.id
  );
  appendAuditLog(db, {
    actor,
    action: 'in_transit_load.post_transport',
    entityKind: 'in_transit_load',
    entityId: existing.id,
    note: poId,
  });
  return { ok: true, load: listLoadRows(db, 'ALL').find((row) => row.id === existing.id) || null };
}

export function syncInTransitLoadFromGrn(db, poId, receivedEntries = [], actor = null) {
  if (!inTransitTablesReady(db)) return { ok: true, load: null };
  const load = findLoadByPo(db, poId);
  if (!load) return { ok: true, load: null };
  const currentLines = db
    .prepare(`SELECT * FROM in_transit_load_lines WHERE load_id = ? ORDER BY line_no ASC`)
    .all(load.id);
  const byLineKey = new Map(currentLines.map((line) => [String(line.purchase_order_line_key || '').trim(), line]));
  const byProductId = new Map(currentLines.map((line) => [String(line.product_id || '').trim(), line]));
  for (const entry of receivedEntries) {
    const line =
      byLineKey.get(String(entry?.lineKey || '').trim()) || byProductId.get(String(entry?.productID || '').trim());
    if (!line) continue;
    const qtyReceived = Math.max(0, Number(entry?.qtyReceived) || 0);
    const nextReceived = (Number(line.qty_received) || 0) + qtyReceived;
    const qtyLoaded = Number(line.qty_loaded) || 0;
    const shortLandedQty = Math.max(0, qtyLoaded - nextReceived);
    db.prepare(
      `UPDATE in_transit_load_lines SET qty_received = ?, short_landed_qty = ? WHERE load_id = ? AND line_no = ?`
    ).run(nextReceived, shortLandedQty, load.id, line.line_no);
  }
  const updatedLines = db
    .prepare(`SELECT * FROM in_transit_load_lines WHERE load_id = ? ORDER BY line_no ASC`)
    .all(load.id);
  const anyOutstanding = updatedLines.some((line) => (Number(line.qty_received) || 0) < (Number(line.qty_loaded) || 0));
  const anyShort = updatedLines.some((line) => Number(line.short_landed_qty) > 0);
  const status = anyOutstanding ? (anyShort ? 'partial_receipt' : 'in_transit') : anyShort ? 'short_landed' : 'received';
  db.prepare(
    `UPDATE in_transit_loads
     SET status = ?, received_at_iso = CASE WHEN ? = 'received' THEN ? ELSE received_at_iso END
     WHERE id = ?`
  ).run(status, status, status === 'received' ? nowIso() : null, load.id);
  appendAuditLog(db, {
    actor,
    action: 'in_transit_load.receive',
    entityKind: 'in_transit_load',
    entityId: load.id,
    note: `${poId} → ${status}`,
  });
  return { ok: true, load: listLoadRows(db, 'ALL').find((row) => row.id === load.id) || null };
}
