/**
 * In-app HR notifications for employees and HR staff.
 * @module server/hrNotifications
 */

import crypto from 'node:crypto';

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
