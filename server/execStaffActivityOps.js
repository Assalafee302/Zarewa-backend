/**
 * Staff activity summary (not performance ranking) for executive dashboard.
 */
import { branchWhere } from './readModel.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
function displayNameForUser(db, userId) {
  const id = String(userId || '').trim();
  if (!id) return '—';
  try {
    const row = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(id);
    return row?.display_name || id;
  } catch {
    return id;
  }
}

/**
 * @param {Map<string, object>} byUser
 * @param {string} userId
 */
function ensureUser(db, byUser, userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  if (!byUser.has(id)) {
    byUser.set(id, {
      userId: id,
      displayName: displayNameForUser(db, id),
      receiptsPostedCount: 0,
      receiptValuePostedNgn: 0,
      paymentRequestsRaisedCount: 0,
      expensesRaisedCount: 0,
      approvalsActedCount: 0,
      workItemsOwnedCount: 0,
      officeMemosCreatedCount: 0,
      attendanceEventsCount: 0,
    });
  }
  return byUser.get(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ startISO: string; endISO: string }} period
 */
export function buildStaffActivitySummary(db, branchScope, period) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const startISO = String(period?.startISO || '').slice(0, 10);
  const endISO = String(period?.endISO || '').slice(0, 10);

  /** @type {Map<string, object>} */
  const byUser = new Map();

  try {
    const bLedger = branchWhere(db, 'ledger_entries', scope);
    const ledgerRows = db
      .prepare(
        `SELECT created_by_user_id, amount_ngn, type
         FROM ledger_entries
         WHERE created_by_user_id IS NOT NULL AND TRIM(created_by_user_id) != ''
           AND DATE(at_iso) >= ? AND DATE(at_iso) <= ?${bLedger.sql}`
      )
      .all(startISO, endISO, ...bLedger.args);
    for (const r of ledgerRows) {
      const u = ensureUser(db, byUser, r.created_by_user_id);
      if (!u) continue;
      const t = String(r.type || '').toUpperCase();
      if (t.includes('RECEIPT')) {
        u.receiptsPostedCount += 1;
        u.receiptValuePostedNgn += Math.round(Number(r.amount_ngn) || 0);
      }
    }
  } catch {
    /* optional */
  }

  try {
    const bExp = branchWhere(db, 'expenses', scope);
    const expRows = db
      .prepare(
        `SELECT created_by_user_id FROM expenses
         WHERE created_by_user_id IS NOT NULL AND TRIM(created_by_user_id) != ''
           AND DATE(date) >= ? AND DATE(date) <= ?${bExp.sql}`
      )
      .all(startISO, endISO, ...bExp.args);
    for (const r of expRows) {
      const u = ensureUser(db, byUser, r.created_by_user_id);
      if (u) u.expensesRaisedCount += 1;
    }
  } catch {
    /* optional */
  }

  try {
    const bExp = branchWhere(db, 'expenses', scope);
    const prRows = db
      .prepare(
        `SELECT requested_by_user_id FROM payment_requests pr
         LEFT JOIN expenses e ON e.expense_id = pr.expense_id
         WHERE requested_by_user_id IS NOT NULL AND TRIM(requested_by_user_id) != ''
           AND DATE(pr.request_date) >= ? AND DATE(pr.request_date) <= ?${bExp.sql.replace(/branch_id/g, 'e.branch_id')}`
      )
      .all(startISO, endISO, ...bExp.args);
    for (const r of prRows) {
      const uid = r.requested_by_user_id;
      const u = ensureUser(db, byUser, uid);
      if (u) u.paymentRequestsRaisedCount += 1;
    }
  } catch {
    /* optional */
  }

  try {
    const appr = db
      .prepare(
        `SELECT acted_by_user_id FROM approval_actions
         WHERE acted_by_user_id IS NOT NULL AND TRIM(acted_by_user_id) != ''
           AND DATE(acted_at_iso) >= ? AND DATE(acted_at_iso) <= ?`
      )
      .all(startISO, endISO);
    for (const r of appr) {
      const u = ensureUser(db, byUser, r.acted_by_user_id);
      if (u) u.approvalsActedCount += 1;
    }
  } catch {
    /* optional */
  }

  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'`).get()) {
      const bWi = branchWhere(db, 'work_items', scope);
      const wiRows = db
        .prepare(
          `SELECT responsible_user_id FROM work_items
           WHERE responsible_user_id IS NOT NULL AND TRIM(responsible_user_id) != ''
             AND DATE(COALESCE(updated_at_iso, created_at_iso)) >= ? AND DATE(COALESCE(updated_at_iso, created_at_iso)) <= ?${bWi.sql}`
        )
        .all(startISO, endISO, ...bWi.args);
      for (const r of wiRows) {
        const u = ensureUser(db, byUser, r.responsible_user_id);
        if (u) u.workItemsOwnedCount += 1;
      }
    }
  } catch {
    /* optional */
  }

  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_threads'`).get()) {
      const bOff = branchWhere(db, 'office_threads', scope);
      const otRows = db
        .prepare(
          `SELECT created_by_user_id FROM office_threads
           WHERE created_by_user_id IS NOT NULL AND TRIM(created_by_user_id) != ''
             AND DATE(created_at_iso) >= ? AND DATE(created_at_iso) <= ?${bOff.sql}`
        )
        .all(startISO, endISO, ...bOff.args);
      for (const r of otRows) {
        const u = ensureUser(db, byUser, r.created_by_user_id);
        if (u) u.officeMemosCreatedCount += 1;
      }
    }
  } catch {
    /* optional */
  }

  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_attendance_events'`).get()) {
      const attRows = db
        .prepare(
          `SELECT user_id FROM hr_attendance_events
           WHERE user_id IS NOT NULL AND TRIM(user_id) != ''
             AND event_date_iso >= ? AND event_date_iso <= ?`
        )
        .all(startISO, endISO);
      for (const r of attRows) {
        const u = ensureUser(db, byUser, r.user_id);
        if (u) u.attendanceEventsCount += 1;
      }
    }
  } catch {
    /* optional */
  }

  const rows = [...byUser.values()]
    .map((r) => ({
      ...r,
      receiptValuePostedNgn: Math.round(r.receiptValuePostedNgn),
      activityScore:
        r.receiptsPostedCount +
        r.paymentRequestsRaisedCount +
        r.expensesRaisedCount +
        r.approvalsActedCount +
        r.workItemsOwnedCount +
        r.officeMemosCreatedCount,
    }))
    .filter((r) => r.activityScore > 0)
    .sort((a, b) => b.activityScore - a.activityScore)
    .slice(0, 30);

  return {
    label: 'Staff activity summary',
    notPerformanceRanking: true,
    period: { startISO, endISO },
    rows,
    legacyNote:
      'Quotations and production jobs with text-only handled_by/operator fields are excluded from this summary.',
    notes: [
      'Activity counts only — not performance ranking.',
      'Based on user_id fields in ledger, expenses, payment requests, approvals, work items, and office.',
      'Do not use for bonus or pay decisions without HR policy.',
    ],
  };
}
