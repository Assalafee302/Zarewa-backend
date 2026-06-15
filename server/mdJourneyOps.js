/**
 * Entity journey enrichment — audit timeline, edit approvals, PO lifecycle drill-down.
 */
import { listPurchaseOrders } from './readModel.js';

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function pushEvent(events, row) {
  events.push(row);
}

function resolveUserDisplayName(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !tableExists(db, 'app_users')) return '';
  const row = db.prepare(`SELECT display_name FROM app_users WHERE id = ? LIMIT 1`).get(uid);
  return String(row?.display_name || '').trim();
}

function latestTimelineActor(timeline, action) {
  const hit = (timeline || []).find((e) => String(e.action || '') === action);
  return hit ? { by: hit.actor || '', atIso: hit.atIso || '' } : { by: '', atIso: '' };
}

function buildQuotationStageActors(db, auditPayload, activityTimeline) {
  const q = auditPayload.quotation || {};
  const sum = auditPayload.summary || {};
  const clearAudit = latestTimelineActor(activityTimeline, 'quotation.clear');
  const flagAudit = latestTimelineActor(activityTimeline, 'quotation.flag');
  const prodAudit = latestTimelineActor(activityTimeline, 'quotation.approve_production');
  const mdApproveAudit = latestTimelineActor(activityTimeline, 'quotation.md_price_exception_approve');
  const mdConfirmAudit = latestTimelineActor(activityTimeline, 'quotation.md_price_exception_confirm');
  const mdBy =
    resolveUserDisplayName(db, q.mdPriceExceptionApprovedByUserId) ||
    resolveUserDisplayName(db, q.priceExceptionMdConfirmedByUserId) ||
    mdApproveAudit.by ||
    mdConfirmAudit.by;

  return {
    quotation: { by: q.handledBy || '', atIso: q.dateISO || '', label: 'Quoted / prepared' },
    managerClear: {
      by: clearAudit.by,
      atIso: sum.managerClearedAtIso || clearAudit.atIso,
      label: 'Manager clearance',
    },
    managerFlag: {
      by: flagAudit.by,
      atIso: sum.managerFlaggedAtIso || flagAudit.atIso,
      label: 'Manager flag',
    },
    managerProduction: {
      by: prodAudit.by,
      atIso: sum.managerProductionApprovedAtIso || prodAudit.atIso,
      label: 'Production override',
    },
    bmPriceException: {
      by: resolveUserDisplayName(db, q.bmPriceExceptionApprovedByUserId) || '',
      atIso: q.bmPriceExceptionApprovedAtISO || '',
      label: 'Below-floor (legacy BM)',
    },
    mdPriceException: {
      by: mdBy,
      atIso: q.mdPriceExceptionApprovedAtISO || q.priceExceptionMdConfirmedAtISO || mdApproveAudit.atIso || mdConfirmAudit.atIso,
      label: 'Below-floor (MD)',
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listActivityTimelineForEntity(db, { entityKind, entityId, quotationRef }) {
  const ek = String(entityKind || '').trim();
  const eid = String(entityId || '').trim();
  const qref = String(quotationRef || '').trim();
  const events = [];

  if (tableExists(db, 'audit_log')) {
    const auditRows = db
      .prepare(
        `SELECT occurred_at_iso, actor_name, action, entity_kind, entity_id, status, note
         FROM audit_log
         WHERE (entity_kind = ? AND entity_id = ?)
            OR (? != '' AND entity_kind = 'quotation' AND entity_id = ?)
            OR (? != '' AND note LIKE ?)
         ORDER BY occurred_at_iso DESC
         LIMIT 120`
      )
      .all(ek, eid, qref, qref, qref, qref ? `%${qref}%` : '___no_match___');
    for (const r of auditRows) {
      pushEvent(events, {
        atIso: r.occurred_at_iso,
        kind: 'audit',
        action: r.action,
        actor: r.actor_name || '',
        status: r.status,
        note: r.note || '',
        entityKind: r.entity_kind,
        entityId: r.entity_id,
      });
    }
  }

  if (tableExists(db, 'approval_actions')) {
    const appr = db
      .prepare(
        `SELECT acted_at_iso, acted_by_name, action, status, note, entity_kind, entity_id
         FROM approval_actions
         WHERE (entity_kind = ? AND entity_id = ?)
            OR (? != '' AND entity_kind = 'quotation' AND entity_id = ?)
         ORDER BY acted_at_iso DESC
         LIMIT 80`
      )
      .all(ek, eid, qref, qref);
    for (const r of appr) {
      pushEvent(events, {
        atIso: r.acted_at_iso,
        kind: 'approval',
        action: r.action,
        actor: r.acted_by_name || '',
        status: r.status,
        note: r.note || '',
        entityKind: r.entity_kind,
        entityId: r.entity_id,
      });
    }
  }

  if (tableExists(db, 'edit_approval_tokens')) {
    const edits = db
      .prepare(
        `SELECT requested_at_iso, requested_by_display, approved_at_iso, approved_by_display, status, entity_kind, entity_id, id
         FROM edit_approval_tokens
         WHERE (entity_kind = ? AND entity_id = ?)
            OR (? != '' AND entity_kind = 'quotation' AND entity_id = ?)
         ORDER BY requested_at_iso DESC
         LIMIT 40`
      )
      .all(ek, eid, qref, qref);
    for (const r of edits) {
      pushEvent(events, {
        atIso: r.approved_at_iso || r.requested_at_iso,
        kind: 'edit_approval',
        action: `edit_approval.${r.status}`,
        actor: r.approved_by_display || r.requested_by_display || '',
        status: r.status,
        note: `Token ${r.id}`,
        entityKind: r.entity_kind,
        entityId: r.entity_id,
      });
    }
  }

  if (qref) {
    const ledger = db
      .prepare(
        `SELECT at_iso, type, amount_ngn, created_by_name, payment_method, note, purpose
         FROM ledger_entries WHERE quotation_ref = ? ORDER BY at_iso ASC`
      )
      .all(qref);
    for (const r of ledger) {
      pushEvent(events, {
        atIso: r.at_iso,
        kind: 'ledger',
        action: r.type,
        actor: r.created_by_name || '',
        status: 'posted',
        note: [r.purpose, r.note, r.payment_method].filter(Boolean).join(' · '),
        amountNgn: Number(r.amount_ngn) || 0,
        entityKind: 'quotation',
        entityId: qref,
      });
    }
  }

  events.sort((a, b) => String(b.atIso || '').localeCompare(String(a.atIso || '')));
  const seen = new Set();
  const deduped = [];
  for (const e of events) {
    const key = `${e.kind}|${e.atIso}|${e.action}|${e.actor}|${e.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped.slice(0, 150);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function enrichQuotationAuditPayload(db, auditPayload) {
  if (!auditPayload?.ok || !auditPayload.quotation) return auditPayload;
  const qid = String(auditPayload.quotation?.id || auditPayload.quotation?.quotationID || '').trim();
  if (!qid) return auditPayload;

  const activityTimeline = listActivityTimelineForEntity(db, {
    entityKind: 'quotation',
    entityId: qid,
    quotationRef: qid,
  });

  let editApprovals = [];
  if (tableExists(db, 'edit_approval_tokens')) {
    editApprovals = db
      .prepare(
        `SELECT id, entity_kind, entity_id, status, requested_at_iso, requested_by_display,
          approved_at_iso, approved_by_display, used_at_iso
         FROM edit_approval_tokens
         WHERE entity_kind = 'quotation' AND entity_id = ?
         ORDER BY requested_at_iso DESC`
      )
      .all(qid)
      .map((r) => ({
        id: r.id,
        entityKind: r.entity_kind,
        entityId: r.entity_id,
        status: r.status,
        requestedAtISO: r.requested_at_iso,
        requestedByDisplay: r.requested_by_display,
        approvedAtISO: r.approved_at_iso,
        approvedByDisplay: r.approved_by_display,
        usedAtISO: r.used_at_iso,
      }));
  }

  const stageActors = buildQuotationStageActors(db, auditPayload, activityTimeline);

  return {
    ...auditPayload,
    activityTimeline,
    editApprovals,
    stageActors,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listManagerPoAudit(db, poId) {
  const pid = String(poId || '').trim();
  if (!pid) {
    return { ok: false, error: 'poId required', purchaseOrder: null, lines: [], treasuryMovements: [], activityTimeline: [] };
  }

  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(pid);
  if (!row) {
    return { ok: false, error: 'Purchase order not found', purchaseOrder: null, lines: [], treasuryMovements: [], activityTimeline: [] };
  }

  const rawLines = db
    .prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY line_key`)
    .all(pid);

  const treasuryMovements = db
    .prepare(
      `SELECT tm.id, tm.occurred_at_iso, tm.direction, tm.amount_ngn, tm.note, tm.source_kind, tm.source_id,
        ta.name AS account_name
       FROM treasury_movements tm
       LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE (tm.source_kind = 'PURCHASE_ORDER' AND tm.source_id = ?)
          OR (tm.source_kind = 'PO_TRANSPORT' AND tm.source_id = ?)
       ORDER BY tm.occurred_at_iso ASC`
    )
    .all(pid, pid);

  const pos = listPurchaseOrders(db, 'ALL');
  const mapped = pos.find((p) => String(p.poID) === pid) || null;

  const activityTimeline = listActivityTimelineForEntity(db, {
    entityKind: 'purchase_order',
    entityId: pid,
    quotationRef: '',
  });

  return {
    ok: true,
    purchaseOrder: mapped || {
      poID: row.po_id,
      supplierID: row.supplier_id,
      supplierName: row.supplier_name,
      orderDateISO: row.order_date_iso,
      status: row.status,
      branchId: row.branch_id || '',
      supplierPaidNgn: Number(row.supplier_paid_ngn) || 0,
      transportPaidNgn: Number(row.transport_paid_ngn) || 0,
    },
    lines: rawLines.map((ln) => ({
      lineKey: ln.line_key,
      productName: ln.product_name,
      qty: Number(ln.qty) || 0,
      unit: ln.unit,
      unitCostNgn: Number(ln.unit_cost_ngn) || 0,
      lineTotalNgn: Number(ln.line_total_ngn) || 0,
    })),
    treasuryMovements: treasuryMovements.map((tm) => ({
      id: tm.id,
      atIso: tm.occurred_at_iso,
      direction: tm.direction,
      amountNgn: Number(tm.amount_ngn) || 0,
      note: tm.note || '',
      accountName: tm.account_name || '',
      sourceKind: tm.source_kind,
      sourceId: tm.source_id,
    })),
    activityTimeline,
  };
}
