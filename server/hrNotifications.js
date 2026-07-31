/**
 * In-app HR notifications for employees and HR staff.
 * @module server/hrNotifications
 */

import crypto from 'node:crypto';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function hrNotificationsTableReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_notifications'`).get());
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   userId: string;
 *   kind: string;
 *   title: string;
 *   body?: string;
 *   routePath?: string;
 *   entityKind?: string;
 *   entityId?: string;
 * }} input
 */
export function createHrNotification(db, input) {
  if (!hrNotificationsTableReady(db)) return { ok: false, error: 'HR notifications not initialised.' };
  const userId = String(input.userId || '').trim();
  const title = String(input.title || '').trim();
  if (!userId || title.length < 2) return { ok: false, error: 'userId and title are required.' };
  const userRow = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(userId);
  if (!userRow) return { ok: false, error: 'User not found.', skipped: true };
  const id = newId('HRN');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_notifications (
      id, user_id, kind, title, body, route_path, entity_kind, entity_id, created_at_iso, read_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    String(input.kind || 'general').trim(),
    title,
    String(input.body || '').trim() || null,
    String(input.routePath || '').trim() || null,
    String(input.entityKind || '').trim() || null,
    String(input.entityId || '').trim() || null,
    now,
    null
  );
  return { ok: true, id };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ limit?: number; unreadOnly?: boolean }} [opts]
 */
export function listHrNotifications(db, userId, opts = {}) {
  if (!hrNotificationsTableReady(db)) return [];
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const cap = Math.min(100, Math.max(1, Math.round(Number(opts.limit) || 40)));
  const unreadOnly = Boolean(opts.unreadOnly);
  const rows = db
    .prepare(
      `SELECT id, kind, title, body, route_path AS routePath, entity_kind AS entityKind, entity_id AS entityId,
              created_at_iso AS createdAtIso, read_at_iso AS readAtIso
       FROM hr_notifications
       WHERE user_id = ? ${unreadOnly ? 'AND read_at_iso IS NULL' : ''}
       ORDER BY created_at_iso DESC LIMIT ?`
    )
    .all(uid, cap);
  return rows.map((r) => ({ ...r, read: Boolean(r.readAtIso) }));
}

export function countUnreadHrNotifications(db, userId) {
  if (!hrNotificationsTableReady(db)) return 0;
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  return db
    .prepare(`SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND read_at_iso IS NULL`)
    .get(uid).c;
}

export function markHrNotificationRead(db, userId, notificationId) {
  if (!hrNotificationsTableReady(db)) return { ok: false, error: 'HR notifications not initialised.' };
  const uid = String(userId || '').trim();
  const id = String(notificationId || '').trim();
  const row = db.prepare(`SELECT id FROM hr_notifications WHERE id = ? AND user_id = ?`).get(id, uid);
  if (!row) return { ok: false, error: 'Notification not found.' };
  db.prepare(`UPDATE hr_notifications SET read_at_iso = ? WHERE id = ?`).run(nowIso(), id);
  return { ok: true };
}

export function markAllHrNotificationsRead(db, userId) {
  if (!hrNotificationsTableReady(db)) return { ok: false, error: 'HR notifications not initialised.' };
  const uid = String(userId || '').trim();
  db.prepare(`UPDATE hr_notifications SET read_at_iso = ? WHERE user_id = ? AND read_at_iso IS NULL`).run(nowIso(), uid);
  return { ok: true };
}

const REQUEST_KIND_LABEL = { leave: 'Leave', loan: 'Loan' };

/**
 * Notify employee when a request is finally rejected or approved.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; kind: string; status: string }} row
 * @param {'approved' | 'rejected'} outcome
 */
export function notifyHrRequestOutcome(db, row, outcome) {
  if (!row?.user_id) return;
  const kind = String(row.kind || 'request');
  const label = REQUEST_KIND_LABEL[kind] || kind;
  const approved = outcome === 'approved';
  createHrNotification(db, {
    userId: row.user_id,
    kind: approved ? `${kind}_approved` : `${kind}_rejected`,
    title: approved ? `${label} request approved` : `${label} request declined`,
    body: approved
      ? `Your ${label.toLowerCase()} request (${row.id}) was approved.`
      : `Your ${label.toLowerCase()} request (${row.id}) was declined.`,
    routePath: kind === 'loan' ? '/my-profile/loans' : '/my-profile/leave',
    entityKind: 'hr_request',
    entityId: row.id,
  });
}

function hrRequestRoutePath(requestId, scope) {
  const id = encodeURIComponent(String(requestId || '').trim());
  const sc = scope ? `&scope=${encodeURIComponent(scope)}` : '';
  return `/hr/requests?requestId=${id}${sc}`;
}

function hrRequestEmployeeRoutePath(kind) {
  return kind === 'loan' ? '/my-profile/loans' : '/my-profile/leave';
}

function requestKindLabel(kind) {
  return REQUEST_KIND_LABEL[String(kind || '').toLowerCase()] || String(kind || 'HR request').replace(/_/g, ' ');
}

function listHrReviewersForBranch(db, branchId, excludeUserId) {
  const exclude = String(excludeUserId || '').trim();
  try {
    let rows = [];
    if (branchId) {
      rows = db
        .prepare(
          `SELECT DISTINCT u.id
           FROM app_users u
           LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE u.status = 'active'
             AND u.role_key IN ('hr_admin','gmhr','admin','md')
             AND (u.role_key IN ('admin','md') OR p.branch_id = ? OR p.branch_id IS NULL)
           LIMIT 25`
        )
        .all(branchId);
    }
    if (!rows.length) {
      rows = db
        .prepare(`SELECT id FROM app_users WHERE status = 'active' AND role_key IN ('hr_admin','gmhr','admin','md') LIMIT 20`)
        .all();
    }
    return rows.filter((u) => u?.id && u.id !== exclude);
  } catch {
    return [];
  }
}

function listBranchEndorsersForRequest(db, row, excludeUserId) {
  const exclude = String(excludeUserId || '').trim();
  const branchId = String(row.branch_id || '').trim();
  const employeeId = String(row.user_id || '').trim();
  const out = new Set();
  try {
    const lineMgr = db
      .prepare(`SELECT line_manager_user_id FROM hr_staff_profiles WHERE user_id = ?`)
      .get(employeeId)?.line_manager_user_id;
    if (lineMgr && lineMgr !== exclude) out.add(lineMgr);
    if (branchId) {
      const managers = db
        .prepare(
          `SELECT DISTINCT u.id
           FROM app_users u
           JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE u.status = 'active'
             AND p.branch_id = ?
             AND u.role_key IN ('branch_manager','sales_manager')
           LIMIT 10`
        )
        .all(branchId);
      for (const m of managers) {
        if (m?.id && m.id !== exclude) out.add(m.id);
      }
    }
  } catch {
    /* optional */
  }
  return [...out].map((id) => ({ id }));
}

function listGmHrApprovers(db, excludeUserId) {
  const exclude = String(excludeUserId || '').trim();
  try {
    return db
      .prepare(`SELECT id FROM app_users WHERE status = 'active' AND role_key IN ('gmhr','admin','md') LIMIT 15`)
      .all()
      .filter((u) => u?.id && u.id !== exclude);
  } catch {
    return [];
  }
}

function notifyUsers(db, users, payload) {
  for (const u of users) {
    if (!u?.id) continue;
    createHrNotification(db, { ...payload, userId: u.id });
  }
}

/**
 * Notify HR reviewers when an employee submits a leave or loan request.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; kind: string; branch_id?: string; title?: string }} row
 * @param {string} submitterUserId
 */
export function notifyHrRequestSubmitted(db, row, submitterUserId) {
  if (!row?.id) return;
  const kind = String(row.kind || '').toLowerCase();
  if (kind !== 'leave' && kind !== 'loan') return;
  const label = requestKindLabel(kind);
  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(String(row.user_id || '').trim());
  const staffName = staff?.display_name || 'Staff member';
  const title = `${label} request awaiting HR review`;
  const body = `${staffName} submitted ${label.toLowerCase()} request ${row.id}${row.title ? `: ${String(row.title).slice(0, 80)}` : ''}.`;
  notifyUsers(db, listHrReviewersForBranch(db, row.branch_id, submitterUserId), {
    kind: 'hr_request_hr_review',
    title,
    body,
    routePath: hrRequestRoutePath(row.id, 'hr_queue'),
    entityKind: 'hr_request',
    entityId: row.id,
  });
  if (row.user_id) {
    createHrNotification(db, {
      userId: row.user_id,
      kind: 'hr_request_submitted',
      title: `${label} request submitted`,
      body: `Your ${label.toLowerCase()} request (${row.id}) is with HR for review.`,
      routePath: hrRequestEmployeeRoutePath(kind),
      entityKind: 'hr_request',
      entityId: row.id,
    });
  }
}

/**
 * Notify the next queue when a request advances (HR → branch, branch → GM).
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; kind: string; branch_id?: string; status: string }} row
 * @param {'branch_manager_review' | 'gm_hr_review'} nextStatus
 * @param {string} [actorUserId]
 */
export function notifyHrRequestQueueHandoff(db, row, nextStatus, actorUserId) {
  if (!row?.id) return;
  const kind = String(row.kind || '').toLowerCase();
  if (kind !== 'leave' && kind !== 'loan') return;
  const label = requestKindLabel(kind);
  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(String(row.user_id || '').trim());
  const staffName = staff?.display_name || 'Staff member';

  if (nextStatus === 'branch_manager_review') {
    notifyUsers(db, listBranchEndorsersForRequest(db, row, actorUserId), {
      kind: 'hr_request_branch_endorse',
      title: `${label} awaiting branch endorsement`,
      body: `${staffName} · ${row.id} cleared HR review — endorsement required.`,
      routePath: hrRequestRoutePath(row.id, 'endorse_queue'),
      entityKind: 'hr_request',
      entityId: row.id,
    });
    if (row.user_id) {
      createHrNotification(db, {
        userId: row.user_id,
        kind: 'hr_request_progress',
        title: `${label} at branch endorsement`,
        body: `Your ${label.toLowerCase()} request (${row.id}) is with your branch manager.`,
        routePath: hrRequestEmployeeRoutePath(kind),
        entityKind: 'hr_request',
        entityId: row.id,
      });
    }
    return;
  }

  if (nextStatus === 'gm_hr_review') {
    notifyUsers(db, listGmHrApprovers(db, actorUserId), {
      kind: 'hr_request_gm_review',
      title: `${label} awaiting GM HR approval`,
      body: `${staffName} · ${row.id} endorsed by branch — final approval required.`,
      routePath: hrRequestRoutePath(row.id, 'gm_queue'),
      entityKind: 'hr_request',
      entityId: row.id,
    });
    if (row.user_id) {
      createHrNotification(db, {
        userId: row.user_id,
        kind: 'hr_request_progress',
        title: `${label} at GM HR`,
        body: `Your ${label.toLowerCase()} request (${row.id}) is awaiting final GM HR approval.`,
        routePath: hrRequestEmployeeRoutePath(kind),
        entityKind: 'hr_request',
        entityId: row.id,
      });
    }
  }
}

function hrIdCardRoutePath(requestId) {
  return `/hr/employees?tab=id-cards&requestId=${encodeURIComponent(String(requestId || '').trim())}`;
}

/**
 * Notify HR when an ID card request is submitted and confirm to the employee.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string }} row
 * @param {string} [actorUserId]
 */
export function notifyIdCardRequestSubmitted(db, row, actorUserId) {
  if (!row?.id || !row?.user_id) return;
  const uid = String(row.user_id).trim();
  const actorId = String(actorUserId || '').trim();
  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(uid);
  const staffName = staff?.display_name || 'Staff member';
  const branchId = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(uid)?.branch_id;
  notifyUsers(db, listHrReviewersForBranch(db, branchId, actorId), {
    kind: 'id_card_hr_review',
    title: 'ID card request awaiting processing',
    body: `${staffName} submitted ID card request ${row.id}.`,
    routePath: hrIdCardRoutePath(row.id),
    entityKind: 'hr_id_card',
    entityId: row.id,
  });
  createHrNotification(db, {
    userId: uid,
    kind: 'id_card_submitted',
    title: 'ID card request submitted',
    body:
      actorId && actorId !== uid
        ? `HR opened ID card request ${row.id} on your behalf. You will be notified when it is ready.`
        : `Your ID card request (${row.id}) is with HR for processing.`,
    routePath: '/my-profile/id-card',
    entityKind: 'hr_id_card',
    entityId: row.id,
  });
}

/**
 * Notify employee when an ID card is ready for collection.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string }} row
 */
export function notifyIdCardReady(db, row) {
  if (!row?.id || !row?.user_id) return;
  createHrNotification(db, {
    userId: row.user_id,
    kind: 'id_card_ready',
    title: 'ID card ready for collection',
    body: `Your staff ID card (${row.id}) is ready. Please collect it from HR.`,
    routePath: '/my-profile/id-card',
    entityKind: 'hr_id_card',
    entityId: row.id,
  });
}

function hrTransferRoutePath(transferId, scope) {
  const id = encodeURIComponent(String(transferId || '').trim());
  const sc = scope ? `&scope=${encodeURIComponent(scope)}` : '';
  return `/hr/discipline-exit?tab=exit&view=transfers&transferId=${id}${sc}`;
}

function transferScopeForStatus(status) {
  const s = String(status || '').trim();
  if (s === 'branch_review') return 'branch_queue';
  if (s === 'hr_review') return 'hr_queue';
  if (s === 'gm_approval') return 'gm_queue';
  if (s === 'approved') return 'complete_queue';
  return 'all';
}

/**
 * Notify reviewers when a transfer enters the workflow.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; transfer_type?: string; from_branch_id?: string; to_branch_id?: string; status: string }} row
 * @param {string} [actorUserId]
 */
export function notifyHrTransferSubmitted(db, row, actorUserId) {
  if (!row?.id) return;
  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(String(row.user_id || '').trim());
  const staffName = staff?.display_name || 'Staff member';
  const route = hrTransferRoutePath(row.id, transferScopeForStatus(row.status));
  const body = `${staffName} · transfer ${row.id} (${String(row.transfer_type || 'transfer').replace(/_/g, ' ')})`;

  if (row.status === 'branch_review') {
    notifyUsers(
      db,
      listBranchEndorsersForRequest(
        db,
        { user_id: row.user_id, branch_id: row.from_branch_id || row.to_branch_id },
        actorUserId
      ),
      {
        kind: 'hr_transfer_branch_review',
        title: 'Transfer awaiting branch review',
        body,
        routePath: route,
        entityKind: 'hr_transfer_request',
        entityId: row.id,
      }
    );
  } else if (row.status === 'hr_review') {
    notifyUsers(db, listHrReviewersForBranch(db, row.from_branch_id || row.to_branch_id, actorUserId), {
      kind: 'hr_transfer_hr_review',
      title: 'Transfer awaiting HR review',
      body,
      routePath: route,
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  }

  if (row.user_id && row.user_id !== actorUserId) {
    createHrNotification(db, {
      userId: row.user_id,
      kind: 'hr_transfer_submitted',
      title: 'Transfer request submitted',
      body: `Your transfer request (${row.id}) is in progress.`,
      routePath: '/my-profile/employment',
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; transfer_type?: string; from_branch_id?: string; status: string }} row
 * @param {'hr_review' | 'gm_approval' | 'approved'} nextStatus
 * @param {string} [actorUserId]
 */
export function notifyHrTransferQueueHandoff(db, row, nextStatus, actorUserId) {
  if (!row?.id) return;
  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(String(row.user_id || '').trim());
  const staffName = staff?.display_name || 'Staff member';
  const body = `${staffName} · ${row.id}`;
  const route = hrTransferRoutePath(row.id, transferScopeForStatus(nextStatus));

  if (nextStatus === 'hr_review') {
    notifyUsers(db, listHrReviewersForBranch(db, row.from_branch_id, actorUserId), {
      kind: 'hr_transfer_hr_review',
      title: 'Transfer awaiting HR review',
      body: `${body} — branch review complete.`,
      routePath: route,
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  } else if (nextStatus === 'gm_approval') {
    notifyUsers(db, listGmHrApprovers(db, actorUserId), {
      kind: 'hr_transfer_gm_review',
      title: 'Transfer awaiting GM approval',
      body: `${body} — HR cleared, GM sign-off required.`,
      routePath: route,
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  } else if (nextStatus === 'approved') {
    notifyUsers(db, listHrReviewersForBranch(db, row.from_branch_id, actorUserId), {
      kind: 'hr_transfer_approved',
      title: 'Transfer approved — complete when effective',
      body: `${body} is approved. Complete the transfer on the effective date.`,
      routePath: hrTransferRoutePath(row.id, 'complete_queue'),
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  }

  if (row.user_id) {
    const labels = {
      hr_review: 'with HR for review',
      gm_approval: 'awaiting GM approval',
      approved: 'approved — effective date pending',
    };
    createHrNotification(db, {
      userId: row.user_id,
      kind: 'hr_transfer_progress',
      title: 'Transfer update',
      body: `Your transfer (${row.id}) is ${labels[nextStatus] || 'in progress'}.`,
      routePath: '/my-profile/employment',
      entityKind: 'hr_transfer_request',
      entityId: row.id,
    });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; status: string }} row
 * @param {'approved' | 'rejected' | 'completed'} outcome
 */
export function notifyHrTransferOutcome(db, row, outcome) {
  if (!row?.user_id) return;
  const approved = outcome === 'approved' || outcome === 'completed';
  const titles = {
    approved: 'Transfer approved',
    rejected: 'Transfer declined',
    completed: 'Transfer completed',
  };
  createHrNotification(db, {
    userId: row.user_id,
    kind: approved ? 'hr_transfer_approved' : 'hr_transfer_rejected',
    title: titles[outcome] || 'Transfer update',
    body:
      outcome === 'completed'
        ? `Your transfer (${row.id}) is complete — your profile has been updated.`
        : outcome === 'rejected'
          ? `Your transfer request (${row.id}) was declined.`
          : `Your transfer request (${row.id}) was approved.`,
    routePath: '/my-profile/employment',
    entityKind: 'hr_transfer_request',
    entityId: row.id,
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; period_yyyymm?: string; periodYyyymm?: string }} run
 * @param {'locked' | 'paid'} status
 * @param {string[]} userIds
 */
export function notifyPayrollRunStatus(db, run, status, userIds = []) {
  if (!run?.id || !userIds.length) return;
  const period = String(run.period_yyyymm || run.periodYyyymm || '');
  const periodLabel = period.length === 6 ? `${period.slice(0, 4)}-${period.slice(4, 6)}` : period;
  const title = status === 'paid' ? `Payroll ${periodLabel} marked paid` : `Payroll ${periodLabel} locked`;
  const body =
    status === 'paid'
      ? 'Your payslip for this period should reflect payment in treasury records.'
      : 'Your payslip for this period is available in My Profile → Payslips.';
  for (const userId of userIds) {
    if (!userId) continue;
    createHrNotification(db, {
      userId,
      kind: status === 'paid' ? 'payroll_paid' : 'payroll_locked',
      title,
      body,
      routePath: '/my-profile/payslips',
      entityKind: 'hr_payroll_run',
      entityId: run.id,
    });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} subjectUserId
 * @param {{ id: string; label: string; dueByIso?: string | null }} cycle
 */
export function notifyAppraisalFormOpened(db, subjectUserId, cycle) {
  const uid = String(subjectUserId || '').trim();
  if (!uid || !cycle?.id) return;
  createHrNotification(db, {
    userId: uid,
    kind: 'appraisal_due',
    title: `Appraisal: ${cycle.label || cycle.id}`,
    body: cycle.dueByIso ? `Complete your appraisal by ${cycle.dueByIso}.` : 'An appraisal form is open for you.',
    routePath: '/hr/performance',
    entityKind: 'hr_appraisal_cycle',
    entityId: cycle.id,
  });
}

/**
 * Notify HR reviewers when a team lead records an incident memo.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id: string;
 *   branchId?: string;
 *   branch_id?: string;
 *   userId?: string;
 *   staffDisplayName?: string;
 *   summary?: string;
 *   incidentDateIso?: string;
 * }} memo
 * @param {string} reporterUserId
 */
export function notifyIncidentMemoReported(db, memo, reporterUserId) {
  if (!memo?.id) return;
  const branchId = String(memo.branchId || memo.branch_id || '').trim();
  const staffName = String(memo.staffDisplayName || memo.userId || 'staff member').trim();
  const reporter = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(String(reporterUserId || '').trim());
  const reporterName = reporter?.display_name || 'A team lead';
  const routePath = `/hr/discipline-exit?tab=accountability&memoId=${encodeURIComponent(memo.id)}`;
  const title = 'Incident memo awaiting escalation';
  const body = `${reporterName} reported ${staffName} (${String(memo.incidentDateIso || '').slice(0, 10) || 'date n/a'}): ${String(memo.summary || '').slice(0, 140)}`;
  const reporterId = String(reporterUserId || '').trim();

  try {
    let hrUsers = [];
    if (branchId) {
      hrUsers = db
        .prepare(
          `SELECT DISTINCT u.id
           FROM app_users u
           LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE u.status = 'active'
             AND u.role_key IN ('hr_admin','gmhr','admin','md')
             AND (u.role_key IN ('admin','md') OR p.branch_id = ? OR p.branch_id IS NULL)
           LIMIT 25`
        )
        .all(branchId);
    }
    if (!hrUsers.length) {
      hrUsers = db
        .prepare(`SELECT id FROM app_users WHERE status = 'active' AND role_key IN ('hr_admin','gmhr','admin','md') LIMIT 20`)
        .all();
    }
    for (const u of hrUsers) {
      if (!u?.id || u.id === reporterId) continue;
      createHrNotification(db, {
        userId: u.id,
        kind: 'incident_memo',
        title,
        body,
        routePath,
        entityKind: 'hr_incident_memo',
        entityId: memo.id,
      });
    }
  } catch {
    /* optional */
  }
}

/**
 * Notify the subject employee when HR resolves their discipline appeal.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; case_number?: string }} caseRow
 * @param {'upheld' | 'rejected' | string} outcome
 * @param {string} [finalOutcomeText]
 */
export function notifyDisciplineAppealResolved(db, caseRow, outcome, finalOutcomeText) {
  const uid = String(caseRow?.user_id || '').trim();
  if (!uid) return;
  const resolved = String(outcome || '').trim().toLowerCase();
  const upheld = resolved === 'upheld';
  const caseRef = caseRow.case_number || caseRow.id;
  const detail =
    String(finalOutcomeText || '').trim() ||
    (upheld
      ? 'Management upheld your appeal. Open My profile → Discipline for the recorded outcome.'
      : 'Management rejected your appeal. The original decision stands.');
  createHrNotification(db, {
    userId: uid,
    kind: upheld ? 'discipline_appeal_upheld' : 'discipline_appeal_rejected',
    title: upheld ? `Appeal upheld — ${caseRef}` : `Appeal rejected — ${caseRef}`,
    body: detail,
    routePath: '/my-profile/discipline',
    entityKind: 'hr_discipline_case',
    entityId: caseRow.id,
  });
}

function safeJsonParse(raw) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Resolve scholarship beneficiary app user from executive benefits linkage.
 * @param {import('better-sqlite3').Database} db
 * @param {{ beneficiaryId?: string; payeeName?: string }} input
 */
export function resolveScholarshipUserId(db, input = {}) {
  const beneficiaryId = String(input.beneficiaryId || '').trim();
  const payeeName = String(input.payeeName || '').trim();
  if (beneficiaryId) {
    const rows = db
      .prepare(`SELECT user_id, profile_extra_json FROM hr_staff_profiles WHERE payroll_group = 'scholarship'`)
      .all();
    for (const row of rows) {
      const extra = safeJsonParse(row.profile_extra_json);
      if (String(extra?.schoolProfile?.beneficiaryId || '').trim() === beneficiaryId) {
        return row.user_id;
      }
    }
  }
  if (payeeName) {
    const hit = db
      .prepare(
        `SELECT u.id AS userId
         FROM app_users u
         JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE p.payroll_group = 'scholarship' AND u.display_name = ?
         LIMIT 1`
      )
      .get(payeeName);
    return hit?.userId || null;
  }
  return null;
}

/**
 * Resolve household staff app user from executive domestic profile linkage.
 * @param {import('better-sqlite3').Database} db
 * @param {{ domesticProfileId?: string; payeeName?: string }} input
 */
export function resolveDomesticStaffUserId(db, input = {}) {
  const profileId = String(input.domesticProfileId || '').trim();
  if (profileId && hrTableExists(db, 'hr_domestic_staff_profiles')) {
    const row = db.prepare(`SELECT user_id FROM hr_domestic_staff_profiles WHERE id = ?`).get(profileId);
    if (row?.user_id) return row.user_id;
  }
  const payeeName = String(input.payeeName || '').trim();
  if (payeeName) {
    const hit = db
      .prepare(
        `SELECT u.id AS userId
         FROM app_users u
         JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE p.payroll_group = 'chairman_staffs' AND u.display_name = ?
         LIMIT 1`
      )
      .get(payeeName);
    return hit?.userId || null;
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; payment_type?: string; payee_name?: string; amount_ngn?: number; term?: string; academic_session?: string; source_kind?: string; source_id?: string }} payment
 */
export function notifyScholarshipPaymentPaid(db, payment) {
  if (!payment?.id) return;
  const amount = Math.round(Number(payment.amount_ngn) || 0);
  const type = String(payment.payment_type || '').toLowerCase();

  if (payment.source_kind === 'domestic_staff') {
    const userId = resolveDomesticStaffUserId(db, {
      domesticProfileId: payment.source_id,
      payeeName: payment.payee_name,
    });
    if (!userId) return;
    createHrNotification(db, {
      userId,
      kind: 'domestic_salary_paid',
      title: 'Monthly salary paid',
      body: `Your salary of ₦${amount.toLocaleString('en-NG')} has been paid.`,
      routePath: '/my-profile/payments',
      entityKind: 'hr_executive_payment',
      entityId: payment.id,
    });
    return;
  }

  let beneficiaryId = null;
  if (payment.source_kind === 'school_fee' && payment.source_id) {
    const fee = db.prepare(`SELECT beneficiary_id FROM hr_chairman_school_fees WHERE id = ?`).get(payment.source_id);
    beneficiaryId = fee?.beneficiary_id || null;
  } else if (payment.source_kind === 'stipend' && payment.source_id) {
    const stip = db.prepare(`SELECT beneficiary_id FROM hr_executive_stipends WHERE id = ?`).get(payment.source_id);
    beneficiaryId = stip?.beneficiary_id || null;
  }
  const userId = resolveScholarshipUserId(db, { beneficiaryId, payeeName: payment.payee_name });
  if (!userId) return;
  const isStipend = type === 'stipend';
  createHrNotification(db, {
    userId,
    kind: isStipend ? 'scholarship_stipend_paid' : 'scholarship_fee_paid',
    title: isStipend ? 'Monthly allowance paid' : 'School fees paid',
    body: isStipend
      ? `Your monthly allowance of ₦${amount.toLocaleString('en-NG')} has been paid.`
      : `School fees${payment.term ? ` (${payment.term})` : ''} of ₦${amount.toLocaleString('en-NG')} have been paid.`,
    routePath: '/my-profile/payments',
    entityKind: 'hr_executive_payment',
    entityId: payment.id,
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; payment_type?: string; payee_name?: string; amount_ngn?: number; term?: string; source_kind?: string; source_id?: string }} payment
 */
export function notifyScholarshipPaymentApproved(db, payment) {
  if (!payment?.id) return;
  let beneficiaryId = null;
  if (payment.source_kind === 'school_fee' && payment.source_id) {
    const fee = db.prepare(`SELECT beneficiary_id FROM hr_chairman_school_fees WHERE id = ?`).get(payment.source_id);
    beneficiaryId = fee?.beneficiary_id || null;
  }
  const userId = resolveScholarshipUserId(db, { beneficiaryId, payeeName: payment.payee_name });
  if (!userId) return;
  const type = String(payment.payment_type || '').toLowerCase();
  if (type === 'stipend') return;
  const amount = Math.round(Number(payment.amount_ngn) || 0);
  createHrNotification(db, {
    userId,
    kind: 'scholarship_fee_approved',
    title: 'School fees approved',
    body: `Your school fee payment${payment.term ? ` for ${payment.term}` : ''} (₦${amount.toLocaleString('en-NG')}) has been approved and will be processed soon.`,
    routePath: '/my-profile/payments',
    entityKind: 'hr_executive_payment',
    entityId: payment.id,
  });
}

const SCHOLARSHIP_REQUEST_LABEL = {
  scholarship_profile_update: 'School details update',
  scholarship_fee_request: 'School fee request',
};

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string; user_id: string; kind: string; status: string }} row
 * @param {'approved' | 'rejected'} outcome
 */
export function notifyScholarshipRequestOutcome(db, row, outcome) {
  if (!row?.user_id) return;
  const label = SCHOLARSHIP_REQUEST_LABEL[row.kind] || 'Benefits request';
  const approved = outcome === 'approved';
  let body = approved
    ? `Your request was approved by the office.`
    : `Your request was declined. Contact the office if you need help.`;
  if (approved && row.kind === 'scholarship_fee_request') {
    body += ' Your school fee has been submitted for payment in Executive benefits.';
  }
  createHrNotification(db, {
    userId: row.user_id,
    kind: approved ? 'scholarship_request_approved' : 'scholarship_request_rejected',
    title: approved ? `${label} approved` : `${label} declined`,
    body,
    routePath: '/my-profile/requests',
    entityKind: 'hr_request',
    entityId: row.id,
  });
}

/**
 * Create in-app reminders for upcoming fee due dates and term end (at most once per week per reminder).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {object[]} reminders
 */
export function syncScholarshipDueReminders(db, userId, reminders = []) {
  if (!hrNotificationsTableReady(db) || !reminders.length) return;
  const uid = String(userId || '').trim();
  if (!uid) return;
  for (const rem of reminders) {
    if (!rem?.id || !rem?.kind) continue;
    const kind = `scholarship_reminder_${rem.kind}`;
    const entityId = String(rem.id).slice(0, 80);
    const recent = db
      .prepare(
        `SELECT id FROM hr_notifications
         WHERE user_id = ? AND kind = ? AND entity_id = ?
           AND datetime(created_at_iso) > datetime('now', '-7 days')
         LIMIT 1`
      )
      .get(uid, kind, entityId);
    if (recent) continue;
    createHrNotification(db, {
      userId: uid,
      kind,
      title: rem.title || 'Benefits reminder',
      body: rem.body || '',
      routePath: rem.actionPath || '/my-profile/school',
      entityKind: 'scholarship_reminder',
      entityId,
    });
  }
}
