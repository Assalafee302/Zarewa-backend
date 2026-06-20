/**
 * Persisted work items, MD notifications, and pending counts for staff purchase credit.
 * @module server/staffPurchaseCreditWorkItems
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createHrNotification } from './hrNotifications.js';
import {
  OBLIGATION_KIND,
  OBLIGATION_STATUS,
  staffObligationTablesReady,
} from './staffObligationOps.js';
import {
  appendWorkItemDecision,
  findPersistedWorkItemBySource,
  upsertWorkItemBySource,
  workRegistryTablesReady,
} from './workItems.js';

export const STAFF_PURCHASE_CREDIT_WORK_SOURCE = 'staff_purchase_credit';

function nowIso() {
  return new Date().toISOString();
}

function listMdNotifyUsers(db) {
  try {
    return db
      .prepare(`SELECT id FROM app_users WHERE status = 'active' AND role_key IN ('md', 'admin') LIMIT 25`)
      .all();
  } catch {
    return [];
  }
}

/**
 * In-app notification to MD when Sales or staff submits purchase credit.
 * @param {import('better-sqlite3').Database} db
 * @param {object} account mapped obligation account
 * @param {object | null} actor
 * @param {string} [staffDisplayName]
 */
export function notifyMdStaffPurchaseCreditSubmitted(db, account, actor, staffDisplayName = '') {
  const id = String(account?.id || '').trim();
  if (!id) return;
  const amt = Math.round(Number(account.principalOriginalNgn) || 0);
  const quote = String(account.quotationRef || '').trim();
  const staff = String(staffDisplayName || account.staffDisplayName || 'Staff').trim();
  const submitter = String(actor?.displayName || actor?.username || 'Sales').trim();
  const body = [
    staff,
    amt ? `₦${amt.toLocaleString('en-NG')}` : '',
    quote ? `Quote ${quote}` : '',
    `Submitted by ${submitter}`,
  ]
    .filter(Boolean)
    .join(' · ');
  for (const u of listMdNotifyUsers(db)) {
    createHrNotification(db, {
      userId: u.id,
      kind: 'staff_purchase_credit_pending',
      title: 'Staff purchase credit — MD approval required',
      body,
      routePath: '/manager?inbox=attention&attentionFilter=staff_credit',
      entityKind: 'hr_staff_obligation_account',
      entityId: id,
    });
  }
}

function workItemPayloadFromAccount(row, actor = null) {
  const accountId = String(row.id || '').trim();
  const branchId = String(row.branch_id || row.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const staffName = String(row.staff_display_name || row.staffDisplayName || row.user_id || 'Staff').trim();
  const quote = String(row.quotation_ref || row.quotationRef || '').trim();
  const amountNgn = Math.round(Number(row.principal_original_ngn || row.principalOriginalNgn) || 0);
  const installmentNgn = Math.round(Number(row.installment_ngn || row.installmentNgn) || 0);
  const uid = String(actor?.id || row.created_by_user_id || '').trim();
  const disp = String(actor?.displayName || actor?.username || '').trim();
  return {
    sourceKind: STAFF_PURCHASE_CREDIT_WORK_SOURCE,
    sourceId: accountId,
    branchId,
    officeKey: 'executive',
    responsibleOfficeKey: 'executive',
    documentClass: 'approval',
    documentType: 'staff_purchase_credit',
    senderUserId: uid || null,
    senderDisplayName: disp || null,
    senderRoleKey: String(actor?.roleKey || '').trim() || null,
    senderOfficeKey: 'sales',
    senderBranchId: branchId,
    title: `Staff purchase credit · ${staffName}`,
    summary: [
      quote ? `Quote ${quote}` : '',
      amountNgn ? `₦${amountNgn.toLocaleString('en-NG')}` : '',
      installmentNgn ? `₦${installmentNgn.toLocaleString('en-NG')}/mo` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    requiresApproval: true,
    requiresResponse: false,
    priority: 'high',
    data: {
      routePath: '/manager?inbox=attention&attentionFilter=staff_credit',
      routeState: { attentionFilter: 'staff_credit' },
      accountId,
      quotationRef: quote,
      amountNgn,
      installmentNgn,
      termMonths: row.term_months || row.termMonths,
      staffUserId: row.user_id || row.userId,
      staffDisplayName: staffName,
    },
    links: quote ? [{ entityKind: 'quotation', entityId: quote }] : [],
  };
}

/**
 * Create/update persisted work item for a purchase credit obligation row.
 * @param {import('better-sqlite3').Database} db
 * @param {object} accountRow raw or mapped DB row
 * @param {object | null} [actor]
 */
export function syncStaffPurchaseCreditWorkItem(db, accountRow, actor = null) {
  if (!workRegistryTablesReady(db) || !accountRow) return { ok: true, noop: true };
  const status = String(accountRow.status || '').trim();
  const base = workItemPayloadFromAccount(accountRow, actor);
  const now = nowIso();

  if (status === OBLIGATION_STATUS.PENDING_APPROVAL) {
    return upsertWorkItemBySource(db, {
      actor,
      ...base,
      status: 'pending_review',
      updatedAtIso: now,
      closedAtIso: null,
      requiresApproval: true,
    });
  }

  const closedStatuses = new Set([
    OBLIGATION_STATUS.ACTIVE,
    OBLIGATION_STATUS.REJECTED,
    OBLIGATION_STATUS.PAID_OFF,
    OBLIGATION_STATUS.CANCELLED,
  ]);
  if (!closedStatuses.has(status)) return { ok: true, noop: true };

  const outcome =
    status === OBLIGATION_STATUS.ACTIVE
      ? 'approved'
      : status === OBLIGATION_STATUS.REJECTED
        ? 'rejected'
        : 'closed';
  const upsert = upsertWorkItemBySource(db, {
    actor,
    ...base,
    status: outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'closed',
    updatedAtIso: now,
    closedAtIso: now,
    requiresApproval: false,
    keyDecisionSummary: `Staff purchase credit ${outcome}`,
  });
  const existing = findPersistedWorkItemBySource(db, STAFF_PURCHASE_CREDIT_WORK_SOURCE, base.sourceId);
  if (existing?.id && actor?.id) {
    try {
      appendWorkItemDecision(db, {
        workItemId: existing.id,
        decisionKey: 'md_approval',
        outcomeStatus: outcome,
        note: String(accountRow.note || '').trim() || null,
        actor,
      });
    } catch {
      /* optional audit row */
    }
  }
  return upsert;
}

export function countPendingStaffPurchaseCreditRequests(db, branchScope = 'ALL') {
  if (!staffObligationTablesReady(db)) return 0;
  let sql = `SELECT COUNT(*) AS c FROM hr_staff_obligation_accounts WHERE kind = ? AND status = ?`;
  const args = [OBLIGATION_KIND.PURCHASE, OBLIGATION_STATUS.PENDING_APPROVAL];
  if (branchScope && branchScope !== 'ALL') {
    sql += ` AND branch_id = ?`;
    args.push(String(branchScope).trim());
  }
  return Number(db.prepare(sql).get(...args)?.c) || 0;
}

/**
 * Pending counts grouped by branch — for MD cross-branch banner.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [currentBranchId]
 */
export function summarizePendingStaffPurchaseCreditByBranch(db, currentBranchId = '') {
  if (!staffObligationTablesReady(db)) {
    return { total: 0, byBranch: {}, otherBranchCount: 0, currentBranchCount: 0 };
  }
  const rows = db
    .prepare(
      `SELECT o.id, o.branch_id, o.quotation_ref, o.principal_original_ngn, u.display_name AS staff_display_name
       FROM hr_staff_obligation_accounts o
       JOIN app_users u ON u.id = o.user_id
       WHERE o.kind = ? AND o.status = ?
       ORDER BY o.updated_at_iso DESC LIMIT 200`
    )
    .all(OBLIGATION_KIND.PURCHASE, OBLIGATION_STATUS.PENDING_APPROVAL);
  const byBranch = {};
  for (const r of rows) {
    const b = String(r.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
    byBranch[b] = (byBranch[b] || 0) + 1;
  }
  const cur = String(currentBranchId || '').trim();
  const currentBranchCount = cur ? rows.filter((r) => String(r.branch_id || '') === cur).length : 0;
  const otherBranchCount = cur ? rows.length - currentBranchCount : 0;
  return { total: rows.length, byBranch, otherBranchCount, currentBranchCount, items: rows };
}

/**
 * Audit timeline for quotation panel / MD review.
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 */
export function getStaffPurchaseCreditAuditTimeline(db, accountId) {
  const id = String(accountId || '').trim();
  if (!id) return [];
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_audit_events'`).get()) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT e.occurred_at_iso AS atIso, e.action, e.actor_user_id AS actorUserId,
                u.display_name AS actorDisplayName, e.details_json AS detailsJson
         FROM hr_audit_events e
         LEFT JOIN app_users u ON u.id = e.actor_user_id
         WHERE e.entity_kind = 'hr_staff_obligation_account' AND e.entity_id = ?
         ORDER BY e.occurred_at_iso ASC`
      )
      .all(id);
    return rows.map((r) => {
      let details = {};
      try {
        details = r.detailsJson ? JSON.parse(String(r.detailsJson)) : {};
      } catch {
        details = {};
      }
      return {
        atIso: r.atIso,
        action: r.action,
        actorUserId: r.actorUserId,
        actorDisplayName: r.actorDisplayName || r.actorUserId || '',
        details,
      };
    });
  } catch {
    return [];
  }
}
