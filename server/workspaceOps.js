/**
 * Workspace command center — counts, monitoring, bulk actions, timelines.
 */
import { userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { categoryForWorkItem } from '../shared/lib/workspaceCategoryRegistry.js';
import { isConfidentialLevel } from '../shared/lib/workspaceConfidentialAccess.js';
import { sanitizeTimelineEvent } from '../shared/lib/workspaceSanitize.js';
import { getOfficeThread, listOfficeThreads } from './officeOps.js';
import { listOfficeMemoDrafts } from './officeDraftOps.js';
import { getOfficeThreadFiling } from './officeFilingOps.js';
import {
  getUnifiedWorkItem,
  listUnifiedWorkItems,
  userCanSeePersistedWorkItem,
  workRegistryTablesReady,
} from './workItems.js';
import { workItemNeedsActionForUser } from '../shared/lib/workspaceInboxBuckets.js';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function workspaceOpsTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_read_state'`).get()
    );
  } catch {
    return false;
  }
}

function loadWorkItemRow(db, workItemId) {
  if (!workRegistryTablesReady(db)) return null;
  return db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(String(workItemId || '').trim());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} user
 */
export function getWorkspaceCounts(db, scope, user) {
  const items = listUnifiedWorkItems(db, scope, user, { limit: 400 });
  const uid = String(user?.id || '').trim();
  const actionRequired = items.filter((item) => workItemNeedsActionForUser(item, uid));
  const overdue = actionRequired.filter(
    (item) => item.slaState === 'overdue' || (item.dueAtIso && item.dueAtIso < nowIso())
  );
  const unfiled = items.filter((item) => item.filingIncomplete);
  const maintenanceOpen = items.filter((item) => {
    const payload = item.data?.smartMemo || item.data || {};
    const type = payload.memoType || item.data?.smartMemoType || '';
    return type === 'maintenance_repairs' && workItemNeedsActionForUser(item, uid);
  });
  const fuelRequestsOpen = items.filter((item) => {
    const payload = item.data?.smartMemo || item.data || {};
    const type = payload.memoType || item.data?.smartMemoType || '';
    return type === 'fuel_diesel' && workItemNeedsActionForUser(item, uid);
  });
  const confidentialAssigned = items.filter(
    (item) =>
      isConfidentialLevel(item.confidentiality) &&
      String(item.responsibleUserId || '').trim() === uid &&
      workItemNeedsActionForUser(item, uid)
  );

  let draftCount = 0;
  try {
    const branchId = String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
    draftCount = listOfficeMemoDrafts(db, uid, branchId).length;
  } catch {
    draftCount = 0;
  }

  return {
    ok: true,
    counts: {
      actionRequired: actionRequired.length,
      overdue: overdue.length,
      pendingApprovals: actionRequired.filter((i) => i.requiresApproval).length,
      pendingResponses: actionRequired.filter((i) => i.requiresResponse).length,
      unfiled: unfiled.length,
      unreadMemos: actionRequired.filter((i) => categoryForWorkItem(i) === 'memos').length,
      financePending: actionRequired.filter((i) => categoryForWorkItem(i) === 'finance').length,
      productionAttention: actionRequired.filter((i) => categoryForWorkItem(i) === 'production').length,
      procurementPending: actionRequired.filter((i) =>
        ['procurement', 'inventory'].includes(categoryForWorkItem(i))
      ).length,
      maintenanceOpen: maintenanceOpen.length,
      fuelRequestsOpen: fuelRequestsOpen.length,
      confidentialAssignedToMe: confidentialAssigned.length,
      drafts: draftCount,
      totalVisible: items.length,
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} user
 */
export function getWorkspaceMonitoring(db, scope, user) {
  if (!userHasPermission(user, 'reports.view') && !userHasPermission(user, 'office.use')) {
    const rk = String(user?.roleKey || '').trim().toLowerCase();
    if (!['admin', 'md', 'ceo', 'sales_manager'].includes(rk) && !userHasPermission(user, '*')) {
      return { ok: false, error: 'Forbidden.' };
    }
  }
  const items = listUnifiedWorkItems(db, scope, user, { limit: 400 });
  const byBranch = {};
  for (const item of items) {
    const bid = String(item.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
    if (!byBranch[bid]) {
      byBranch[bid] = { branchId: bid, total: 0, actionRequired: 0, overdue: 0, unfiled: 0, memos: 0 };
    }
    byBranch[bid].total += 1;
    if (item.filingIncomplete) byBranch[bid].unfiled += 1;
    if (categoryForWorkItem(item) === 'memos') byBranch[bid].memos += 1;
    if (workItemNeedsActionForUser(item, user?.id)) byBranch[bid].actionRequired += 1;
    if (item.slaState === 'overdue') byBranch[bid].overdue += 1;
  }

  let memoVolume = [];
  if (userHasPermission(user, 'office.use')) {
    const threads = listOfficeThreads(db, scope, user, {});
    const memoByBranch = {};
    for (const t of threads.slice(0, 200)) {
      const bid = String(t.branchId || DEFAULT_BRANCH_ID).trim();
      memoByBranch[bid] = (memoByBranch[bid] || 0) + 1;
    }
    memoVolume = Object.entries(memoByBranch).map(([branchId, count]) => ({ branchId, count }));
  }

  return {
    ok: true,
    branchWorkload: Object.values(byBranch).sort((a, b) => b.actionRequired - a.actionRequired),
    memoVolumeByBranch: memoVolume,
    totals: {
      branches: Object.keys(byBranch).length,
      actionRequired: items.filter((i) => workItemNeedsActionForUser(i, user?.id)).length,
      overdue: items.filter((i) => i.slaState === 'overdue').length,
      unfiled: items.filter((i) => i.filingIncomplete).length,
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} user
 * @param {string} workItemId
 */
export function getWorkItemTimeline(db, scope, user, workItemId) {
  const wid = String(workItemId || '').trim();
  const hit = getUnifiedWorkItem(db, scope, user, wid);
  if (!hit.ok) return hit;
  const item = hit.item;
  /** @type {{ id: string, kind: string, label: string, atIso: string, actor?: string, note?: string }[]} */
  const events = [];

  events.push({
    id: `created-${wid}`,
    kind: 'created',
    label: 'Work item created',
    atIso: item.createdAtIso || '',
    note: item.referenceNo,
  });

  if (workRegistryTablesReady(db)) {
    const decisions = db
      .prepare(
        `SELECT * FROM work_item_decisions WHERE work_item_id = ? ORDER BY acted_at_iso ASC`
      )
      .all(wid);
    for (const d of decisions) {
      events.push({
        id: d.id,
        kind: 'decision',
        label: `${d.decision_key}: ${d.outcome_status}`,
        atIso: d.acted_at_iso,
        actor: d.actor_display_name || d.actor_user_id || '',
        note: d.note || '',
      });
    }

    const audits = db
      .prepare(
        `SELECT * FROM audit_log WHERE entity_id = ? OR (entity_kind = 'work_item' AND entity_id = ?)
         ORDER BY occurred_at_iso ASC LIMIT 50`
      )
      .all(wid, wid);
    for (const a of audits) {
      events.push({
        id: a.id,
        kind: 'audit',
        label: a.action,
        atIso: a.occurred_at_iso,
        actor: a.actor_name || a.actor_user_id || '',
        note: a.note || '',
      });
    }
  }

  if (item.linkedThreadId) {
    const threadEvents = buildThreadTimelineEvents(db, scope, user, item.linkedThreadId);
    if (threadEvents.ok) events.push(...threadEvents.events);
  }

  events.sort((a, b) => String(a.atIso).localeCompare(String(b.atIso)));
  return { ok: true, workItemId: wid, events };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} user
 * @param {string} threadId
 */
export function getOfficeThreadTimeline(db, scope, user, threadId) {
  return buildThreadTimelineEvents(db, scope, user, threadId);
}

function buildThreadTimelineEvents(db, scope, user, threadId) {
  const tid = String(threadId || '').trim();
  const detail = getOfficeThread(db, scope, user, tid);
  if (!detail.ok) return detail;
  const t = detail.thread;
  /** @type {{ id: string, kind: string, label: string, atIso: string, actor?: string, note?: string }[]} */
  const events = [
    {
      id: `thread-created-${tid}`,
      kind: 'memo_created',
      label: 'Memo created',
      atIso: t.createdAtIso || '',
      note: t.subject,
    },
  ];

  for (const m of detail.messages || []) {
    events.push(
      sanitizeTimelineEvent({
        id: m.id,
        kind: m.kind === 'system' ? 'system_update' : 'reply_added',
        label: m.kind === 'system' ? 'System update' : 'Reply added',
        atIso: m.createdAtIso || '',
        actor: m.authorDisplayName || m.authorUserId || '',
        note: String(m.body || '').slice(0, 120),
      })
    );
  }

  if (Array.isArray(t.attachments) && t.attachments.length) {
    for (const att of t.attachments) {
      events.push({
        id: `att-${att.name || att.id || Math.random()}`,
        kind: 'attachment_uploaded',
        label: 'Supporting document attached',
        atIso: t.updatedAtIso || t.createdAtIso || '',
        note: String(att.name || 'Attachment').slice(0, 80),
      });
    }
  }

  if (t.status && t.status !== 'open') {
    events.push({
      id: `status-${tid}`,
      kind: 'status_changed',
      label: `Status: ${String(t.status).replace(/_/g, ' ')}`,
      atIso: t.updatedAtIso || t.createdAtIso || '',
    });
  }

  const payload = t.payload || {};
  if (payload.convertedAtIso) {
    events.push({
      id: `converted-${tid}`,
      kind: 'converted',
      label: payload.materialRequestId ? 'Converted to procurement' : 'Converted to expense',
      atIso: payload.convertedAtIso,
      note: payload.materialRequestId || payload.paymentRequestId || '',
    });
  }

  const filing = getOfficeThreadFiling(db, scope, user, tid);
  if (filing?.ok && filing.filing?.updatedAtIso) {
    events.push({
      id: `filed-${tid}`,
      kind: 'filed',
      label: 'Filed to cabinet',
      atIso: filing.filing.updatedAtIso,
      note: filing.filing.categoryLabel || '',
    });
  }

  events.sort((a, b) => String(a.atIso).localeCompare(String(b.atIso)));
  return { ok: true, threadId: tid, events };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} user
 * @param {string} workItemId
 */
export function getWorkItemRelatedRecords(db, scope, user, workItemId) {
  const wid = String(workItemId || '').trim();
  const hit = getUnifiedWorkItem(db, scope, user, wid);
  if (!hit.ok) return hit;
  const item = hit.item;
  /** @type {{ kind: string, id: string, label: string, path?: string }[]} */
  const related = [];

  if (item.linkedThreadId) {
    related.push({ kind: 'office_thread', id: item.linkedThreadId, label: 'Internal memo thread', path: '/' });
  }

  if (workRegistryTablesReady(db)) {
    const links = db
      .prepare(`SELECT entity_kind, entity_id, note FROM work_item_links WHERE work_item_id = ?`)
      .all(wid);
    for (const link of links) {
      related.push({
        kind: link.entity_kind,
        id: link.entity_id,
        label: link.note || `${link.entity_kind} ${link.entity_id}`,
      });
    }
  }

  const payload = item.data || {};
  if (payload.paymentRequestId) {
    related.push({ kind: 'payment_request', id: payload.paymentRequestId, label: 'Expense request', path: '/accounts' });
  }
  if (payload.materialRequestId) {
    related.push({ kind: 'material_request', id: payload.materialRequestId, label: 'Material request', path: '/operations' });
  }

  return { ok: true, workItemId: wid, related };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} actor
 * @param {string[]} workItemIds
 */
export function bulkMarkWorkItemsRead(db, scope, actor, workItemIds = []) {
  if (!workspaceOpsTablesReady(db)) return { ok: false, error: 'Workspace read state is not available.' };
  const uid = String(actor?.id || '').trim();
  if (!uid) return { ok: false, error: 'Sign in required.' };
  const ids = [...new Set(workItemIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const now = nowIso();
  const results = [];
  const insert = db.prepare(
    `INSERT INTO workspace_read_state (user_id, work_item_id, last_read_at_iso)
     VALUES (?,?,?)
     ON CONFLICT(user_id, work_item_id) DO UPDATE SET last_read_at_iso = excluded.last_read_at_iso`
  );

  for (const id of ids) {
    const row = loadWorkItemRow(db, id);
    if (!row || !userCanSeePersistedWorkItem(db, scope, actor, row)) {
      results.push({ id, ok: false, error: 'Forbidden or not found.' });
      continue;
    }
    insert.run(uid, id, now);
    results.push({ id, ok: true });
  }

  appendAuditLog(db, {
    actor,
    action: 'workspace.bulk.read',
    entityKind: 'workspace',
    entityId: uid,
    note: `${results.filter((r) => r.ok).length} items marked read`,
    details: { ids: results.filter((r) => r.ok).map((r) => r.id) },
  });

  return {
    ok: true,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean, branchId: string }} scope
 * @param {object} actor
 * @param {string[]} workItemIds
 */
export function bulkArchiveWorkItems(db, scope, actor, workItemIds = []) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  if (!userHasPermission(actor, 'office.use') && !userHasPermission(actor, '*')) {
    return { ok: false, error: 'Permission denied.' };
  }
  const ids = [...new Set(workItemIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const now = nowIso();
  const results = [];

  for (const id of ids) {
    const row = loadWorkItemRow(db, id);
    if (!row || !userCanSeePersistedWorkItem(db, scope, actor, row)) {
      results.push({ id, ok: false, error: 'Forbidden or not found.' });
      continue;
    }
    if (isConfidentialLevel(row.confidentiality) && String(row.sender_user_id) !== String(actor?.id)) {
      results.push({ id, ok: false, error: 'Cannot archive confidential item.' });
      continue;
    }
    db.prepare(
      `UPDATE work_items SET status = 'archived', archived_at_iso = ?, updated_at_iso = ? WHERE id = ?`
    ).run(now, now, id);
    results.push({ id, ok: true });
  }

  if (workspaceOpsTablesReady(db)) {
    db.prepare(
      `INSERT INTO workspace_bulk_action_log (id, actor_user_id, action, item_ids_json, result_json, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(
      `WBA-${Date.now().toString(36)}`,
      String(actor?.id || ''),
      'archive',
      JSON.stringify(ids),
      JSON.stringify(results),
      now
    );
  }

  appendAuditLog(db, {
    actor,
    action: 'workspace.bulk.archive',
    entityKind: 'workspace',
    entityId: String(actor?.id || ''),
    note: `${results.filter((r) => r.ok).length} items archived`,
  });

  return {
    ok: true,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}
