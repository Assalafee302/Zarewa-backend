/**
 * Detect and remove duplicate HR staff accounts from failed bulk imports.
 * @module server/hrStaffDuplicateCleanup
 */

import { updateAppUserStatus } from './auth.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { purgeUserHrOperationalData } from './hrUserOperationalCleanup.js';

const PROTECTED_ROLES = new Set(['admin', 'md']);

/**
 * Penalty when import retries appended digits after surname.employeeId (e.g. okoro.51 for emp 5).
 * @param {string} username
 * @param {string} [employeeNo]
 */
export function usernameSuffixPenalty(username, employeeNo = '') {
  const u = String(username || '').trim().toLowerCase();
  const emp = String(employeeNo || '').trim();
  if (!u || !emp) return 0;
  const m = u.match(/^(.+)\.(\d+)$/);
  if (!m) return 0;
  const numPart = m[2];
  if (numPart === emp) return 0;
  if (numPart.startsWith(emp) && numPart.length > emp.length) {
    return (numPart.length - emp.length) * 15;
  }
  return 0;
}

/**
 * Pick the best account to keep when several share the same employee number.
 * @param {object[]} candidates
 */
export function pickCanonicalStaffMember(candidates) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];

  const scored = candidates.map((c) => {
    let score = 0;
    if (String(c.status || '') === 'active') score += 100;
    const empNo = String(c.employeeNo || '').trim();
    const idealUsername = empNo ? `${String(c.username || '').split('.')[0] || ''}.${empNo}`.toLowerCase() : '';
    const un = String(c.username || '').trim().toLowerCase();
    if (idealUsername && un === idealUsername) score += 60;
    score -= usernameSuffixPenalty(un, empNo);
    if (String(c.employeeNo || '').trim()) score += 20;
    if (String(c.jobTitle || '').trim()) score += 10;
    if (String(c.dateJoinedIso || '').trim()) score += 8;
    if (Number(c.baseSalaryNgn) > 0) score += 5;
    if (String(c.profileUpdatedAtIso || '').trim()) score += 2;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

function listStaffJoinRows(db) {
  if (!hrTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.status, u.email,
              u.role_key AS roleKey, u.created_at_iso AS createdAtIso,
              p.employee_no AS employeeNo, p.job_title AS jobTitle, p.branch_id AS branchId,
              p.base_salary_ngn AS baseSalaryNgn, p.date_joined_iso AS dateJoinedIso,
              p.updated_at_iso AS profileUpdatedAtIso
       FROM app_users u
       LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE u.role_key NOT IN ('admin', 'md')`
    )
    .all();
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function scanHrStaffDuplicates(db) {
  if (!hrTablesReady(db)) {
    return { ok: false, error: 'HR module not initialised.' };
  }

  const rows = listStaffJoinRows(db);
  const profileUserIds = new Set(
    db
      .prepare(`SELECT user_id AS userId FROM hr_staff_profiles`)
      .all()
      .map((r) => String(r.userId))
  );
  const withProfile = rows.filter((r) => profileUserIds.has(String(r.userId)));

  const orphans = rows
    .filter((r) => !profileUserIds.has(String(r.userId)))
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      status: r.status,
      reason: 'orphan_login',
    }));

  const byEmployeeNo = new Map();
  for (const r of withProfile) {
    const empNo = String(r.employeeNo || '').trim();
    if (!empNo) continue;
    if (!byEmployeeNo.has(empNo)) byEmployeeNo.set(empNo, []);
    byEmployeeNo.get(empNo).push(r);
  }

  const employeeNoDuplicates = [];
  for (const [employeeNo, members] of byEmployeeNo.entries()) {
    if (members.length < 2) continue;
    const keep = pickCanonicalStaffMember(members);
    const remove = members.filter((m) => m.userId !== keep?.userId);
    employeeNoDuplicates.push({
      employeeNo,
      keep: keep
        ? {
            userId: keep.userId,
            username: keep.username,
            displayName: keep.displayName,
            status: keep.status,
          }
        : null,
      remove: remove.map((m) => ({
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
        status: m.status,
        reason: 'duplicate_employee_no',
      })),
    });
  }

  const byDisplayName = new Map();
  for (const r of withProfile) {
    const dn = String(r.displayName || '').trim().toLowerCase();
    if (!dn) continue;
    if (!byDisplayName.has(dn)) byDisplayName.set(dn, []);
    byDisplayName.get(dn).push(r);
  }

  const displayNameDuplicates = [];
  const employeeNoDupIds = new Set(
    employeeNoDuplicates.flatMap((g) => g.remove.map((m) => m.userId))
  );
  for (const [displayName, members] of byDisplayName.entries()) {
    if (members.length < 2) continue;
    const uniqueEmpNos = new Set(members.map((m) => String(m.employeeNo || '').trim()).filter(Boolean));
    if (uniqueEmpNos.size === members.length) continue;
    const keep = pickCanonicalStaffMember(members);
    const remove = members
      .filter((m) => m.userId !== keep?.userId && !employeeNoDupIds.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
        employeeNo: m.employeeNo,
        status: m.status,
        reason: 'duplicate_display_name',
      }));
    if (!remove.length) continue;
    displayNameDuplicates.push({
      displayName,
      keep: keep
        ? {
            userId: keep.userId,
            username: keep.username,
            displayName: keep.displayName,
            employeeNo: keep.employeeNo,
          }
        : null,
      remove,
    });
  }

  const toRemove = new Map();
  for (const o of orphans) toRemove.set(o.userId, o);
  for (const g of employeeNoDuplicates) {
    for (const m of g.remove) toRemove.set(m.userId, m);
  }
  for (const g of displayNameDuplicates) {
    for (const m of g.remove) toRemove.set(m.userId, m);
  }

  return {
    ok: true,
    summary: {
      orphanLogins: orphans.length,
      duplicateEmployeeNos: employeeNoDuplicates.length,
      duplicateDisplayNames: displayNameDuplicates.length,
      proposedRemovals: toRemove.size,
      activeStaffWithProfile: withProfile.filter((r) => String(r.employeeNo || '').trim()).length,
    },
    orphans,
    employeeNoDuplicates,
    displayNameDuplicates,
    proposedRemovals: [...toRemove.values()],
  };
}

/** @param {import('better-sqlite3').Database} db */
function tableHasColumn(db, table, column) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  } catch {
    return false;
  }
}

/** @param {import('better-sqlite3').Database} db */
function repointUserColumn(db, table, column, fromId, toId) {
  if (!hrTableExists(db, table) || !tableHasColumn(db, table, column)) return;
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(toId, fromId);
}

/** Tables where user_id (or subject_user_id) identifies the staff member. */
const STAFF_SUBJECT_USER_COLUMNS = [
  ['hr_requests', 'user_id'],
  ['hr_notifications', 'user_id'],
  ['hr_staff_documents', 'user_id'],
  ['hr_discipline_cases', 'user_id'],
  ['hr_staff_branch_history', 'user_id'],
  ['hr_employee_number_history', 'user_id'],
  ['hr_employment_letters', 'user_id'],
  ['hr_performance_reviews', 'user_id'],
  ['hr_training_records', 'user_id'],
  ['hr_beneficiaries', 'user_id'],
  ['hr_incident_memos', 'user_id'],
  ['hr_transfer_recommendations', 'user_id'],
  ['hr_staff_skills', 'user_id'],
  ['hr_engagement_responses', 'user_id'],
  ['hr_grievances', 'user_id'],
  ['hr_exit_interviews', 'user_id'],
  ['hr_exit_clearance', 'user_id'],
  ['hr_leave_accrual_ledger', 'user_id'],
  ['hr_attendance_events', 'user_id'],
  ['hr_appraisal_forms', 'subject_user_id'],
  ['hr_feedback_notes', 'subject_user_id'],
  ['office_memo_drafts', 'user_id'],
  ['hr_payroll_line_loans', 'user_id'],
];

/** Columns where the duplicate user may be referenced (manager, assignee). */
const STAFF_REFERENCE_USER_COLUMNS = [
  ['hr_staff_profiles', 'line_manager_user_id'],
  ['hr_grievances', 'assigned_to_user_id'],
];

/**
 * When both users have a row with the same non-user primary key, drop the loser's row.
 * @param {import('better-sqlite3').Database} db
 */
function mergeCompositeUserRows(db, table, userCol, siblingCols, fromId, toId) {
  if (!hrTableExists(db, table) || !tableHasColumn(db, table, userCol)) return;
  const loserRows = db.prepare(`SELECT * FROM ${table} WHERE ${userCol} = ?`).all(fromId);
  for (const row of loserRows) {
    const where = siblingCols.map((c) => `${c} = ?`).join(' AND ');
    const args = siblingCols.map((c) => row[c]);
    const winnerHas = db
      .prepare(`SELECT 1 FROM ${table} WHERE ${userCol} = ? AND ${where}`)
      .get(toId, ...args);
    if (winnerHas) {
      const delWhere = [userCol, ...siblingCols].map((c) => `${c} = ?`).join(' AND ');
      db.prepare(`DELETE FROM ${table} WHERE ${delWhere}`).run(fromId, ...args);
    } else {
      db.prepare(`UPDATE ${table} SET ${userCol} = ? WHERE ${userCol} = ? AND ${where}`).run(toId, fromId, ...args);
    }
  }
}

/** @param {import('better-sqlite3').Database} db */
function mergePayrollAndLeaveRows(db, fromId, toId) {
  mergeCompositeUserRows(db, 'hr_payroll_lines', 'user_id', ['run_id'], fromId, toId);
  mergeCompositeUserRows(db, 'hr_leave_balances', 'user_id', ['leave_type', 'period_yyyymm'], fromId, toId);
  mergeCompositeUserRows(db, 'office_thread_reads', 'user_id', ['thread_id'], fromId, toId);
  if (hrTableExists(db, 'hr_policy_acknowledgements')) {
    const rows = db.prepare(`SELECT id, policy_key, policy_version FROM hr_policy_acknowledgements WHERE user_id = ?`).all(fromId);
    for (const row of rows) {
      const winnerHas = db
        .prepare(
          `SELECT 1 FROM hr_policy_acknowledgements WHERE user_id = ? AND policy_key = ? AND policy_version = ?`
        )
        .get(toId, row.policy_key, row.policy_version);
      if (winnerHas) {
        db.prepare(`DELETE FROM hr_policy_acknowledgements WHERE id = ?`).run(row.id);
      } else {
        db.prepare(`UPDATE hr_policy_acknowledgements SET user_id = ? WHERE id = ?`).run(toId, row.id);
      }
    }
  }
}

/**
 * Fill empty winner profile fields from the duplicate account.
 * @param {import('better-sqlite3').Database} db
 */
function mergeStaffProfileFields(db, winnerId, loserId) {
  if (!hrTableExists(db, 'hr_staff_profiles')) return;
  const winner = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(winnerId);
  const loser = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(loserId);
  if (!winner || !loser) return;

  const skip = new Set(['user_id', 'employee_no']);
  const patch = {};
  for (const [key, val] of Object.entries(loser)) {
    if (skip.has(key)) continue;
    const wVal = winner[key];
    const lVal = val;
    const wEmpty =
      wVal == null ||
      (typeof wVal === 'string' && !String(wVal).trim()) ||
      (typeof wVal === 'number' && wVal === 0 && key.endsWith('_ngn'));
    const lPresent =
      lVal != null &&
      ((typeof lVal === 'string' && String(lVal).trim()) ||
        (typeof lVal === 'number' && lVal !== 0) ||
        typeof lVal !== 'string');
    if (wEmpty && lPresent) patch[key] = lVal;
  }

  if (winner.profile_extra_json || loser.profile_extra_json) {
    try {
      const wExtra = winner.profile_extra_json ? JSON.parse(String(winner.profile_extra_json)) : {};
      const lExtra = loser.profile_extra_json ? JSON.parse(String(loser.profile_extra_json)) : {};
      const merged = { ...lExtra, ...wExtra };
      for (const k of Object.keys(lExtra)) {
        if (merged[k] == null || merged[k] === '') merged[k] = lExtra[k];
        if (typeof merged[k] === 'object' && merged[k] && typeof lExtra[k] === 'object' && lExtra[k]) {
          merged[k] = { ...lExtra[k], ...merged[k] };
        }
      }
      if (JSON.stringify(merged) !== String(winner.profile_extra_json || '')) {
        patch.profile_extra_json = JSON.stringify(merged);
      }
    } catch {
      /* keep winner json */
    }
  }

  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE hr_staff_profiles SET ${sets} WHERE user_id = @user_id`).run({
    user_id: winnerId,
    ...patch,
  });
}

/** @param {import('better-sqlite3').Database} db */
function mergeAppUserFields(db, winnerId, loserId) {
  const winner = db
    .prepare(`SELECT email, avatar_url, display_name FROM app_users WHERE id = ?`)
    .get(winnerId);
  const loser = db
    .prepare(`SELECT email, avatar_url, display_name FROM app_users WHERE id = ?`)
    .get(loserId);
  if (!winner || !loser) return;
  const email = String(winner.email || '').trim() || String(loser.email || '').trim() || null;
  const avatar = String(winner.avatar_url || '').trim() || String(loser.avatar_url || '').trim() || null;
  const displayName =
    String(winner.display_name || '').trim() || String(loser.display_name || '').trim() || null;
  db.prepare(`UPDATE app_users SET email = ?, avatar_url = ?, display_name = ? WHERE id = ?`).run(
    email,
    avatar,
    displayName,
    winnerId
  );
}

/**
 * Merge duplicate login into the canonical staff account (same employee number).
 * Repoints HR records, merges profile gaps, then removes the duplicate login.
 * @param {import('better-sqlite3').Database} db
 * @param {string} fromUserId duplicate login to absorb
 * @param {string} toUserId canonical login to keep
 * @param {string} [actorUserId]
 */
export function mergeHrStaffUserInto(db, fromUserId, toUserId, actorUserId) {
  const fromId = String(fromUserId || '').trim();
  const toId = String(toUserId || '').trim();
  if (!fromId || !toId) return { ok: false, error: 'Both user ids are required.' };
  if (fromId === toId) return { ok: false, error: 'Cannot merge a user into itself.' };
  if (actorUserId && fromId === actorUserId) return { ok: false, error: 'Cannot merge your own account.' };

  const fromRow = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE id = ?`).get(fromId);
  const toRow = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE id = ?`).get(toId);
  if (!fromRow || !toRow) return { ok: false, error: 'User not found.' };
  if (PROTECTED_ROLES.has(fromRow.roleKey) || PROTECTED_ROLES.has(toRow.roleKey)) {
    return { ok: false, error: 'Protected system account.' };
  }

  try {
    db.transaction(() => {
      mergeAppUserFields(db, toId, fromId);
      mergeStaffProfileFields(db, toId, fromId);
      for (const [table, column] of STAFF_SUBJECT_USER_COLUMNS) {
        repointUserColumn(db, table, column, fromId, toId);
      }
      for (const [table, column] of STAFF_REFERENCE_USER_COLUMNS) {
        repointUserColumn(db, table, column, fromId, toId);
      }
      mergePayrollAndLeaveRows(db, fromId, toId);
      db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(fromId);
      if (hrTableExists(db, 'hr_staff_profiles')) {
        db.prepare(`DELETE FROM hr_staff_profiles WHERE user_id = ?`).run(fromId);
      }
      db.prepare(`DELETE FROM app_users WHERE id = ?`).run(fromId);
    })();
    return {
      ok: true,
      fromUserId: fromId,
      fromUsername: fromRow.username,
      toUserId: toId,
      toUsername: toRow.username,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'Merge failed'), fromUserId: fromId, toUserId: toId };
  }
}

/**
 * Merge every duplicate staff login that shares the same employee number.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [actorUserId]
 */
export function mergeAllDuplicateHrStaffByEmployeeNo(db, actorUserId) {
  const scan = scanHrStaffDuplicates(db);
  if (!scan.ok) return scan;

  const merges = [];
  const failed = [];
  for (const group of scan.employeeNoDuplicates) {
    const keepId = group.keep?.userId;
    if (!keepId) continue;
    for (const m of group.remove) {
      const r = mergeHrStaffUserInto(db, m.userId, keepId, actorUserId);
      if (r.ok) {
        merges.push({
          employeeNo: group.employeeNo,
          fromUserId: r.fromUserId,
          fromUsername: r.fromUsername,
          toUserId: r.toUserId,
          toUsername: r.toUsername,
        });
      } else {
        failed.push({ employeeNo: group.employeeNo, ...m, error: r.error });
      }
    }
  }

  const after = scanHrStaffDuplicates(db);
  return {
    ok: true,
    merged: merges.length,
    merges,
    failed,
    after: after.ok ? after.summary : null,
  };
}

/**
 * Remove HR staff user and login. Deletes profile first, then app user.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} [actorUserId]
 */
export function purgeHrStaffUser(db, userId, actorUserId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'User id required.' };
  if (actorUserId && uid === actorUserId) return { ok: false, error: 'Cannot remove your own account.' };

  const row = db.prepare(`SELECT id, username, role_key AS roleKey, status FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  if (PROTECTED_ROLES.has(row.roleKey)) return { ok: false, error: 'Protected system account.' };

  try {
    db.transaction(() => {
      purgeUserHrOperationalData(db, uid);
      db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM app_users WHERE id = ?`).run(uid);
    })();
    return { ok: true, userId: uid, username: row.username };
  } catch (e) {
    const suspend = updateAppUserStatus(db, uid, 'suspended', { actorUserId });
    return {
      ok: false,
      error: String(e?.message || e || 'Delete failed'),
      suspendedFallback: suspend.ok,
      userId: uid,
      username: row.username,
    };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ dryRun?: boolean; removeOrphans?: boolean; removeDuplicates?: boolean; userIds?: string[] }} [opts]
 */
export function cleanupHrStaffDuplicates(db, actor, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const scan = scanHrStaffDuplicates(db);
  if (!scan.ok) return scan;

  let targets = scan.proposedRemovals.map((r) => ({ ...r }));
  if (Array.isArray(opts.userIds) && opts.userIds.length) {
    const allow = new Set(opts.userIds.map((id) => String(id).trim()).filter(Boolean));
    targets = targets.filter((t) => allow.has(t.userId));
  }
  if (opts.removeOrphans === false) {
    targets = targets.filter((t) => t.reason !== 'orphan_login');
  }
  if (opts.removeDuplicates === false) {
    targets = targets.filter((t) => t.reason === 'orphan_login');
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      ...scan,
      targets,
      summary: {
        ...scan.summary,
        willRemove: targets.length,
      },
    };
  }

  const keepByDuplicate = new Map();
  for (const g of scan.employeeNoDuplicates) {
    if (!g.keep?.userId) continue;
    for (const m of g.remove) keepByDuplicate.set(m.userId, g.keep.userId);
  }
  for (const g of scan.displayNameDuplicates) {
    if (!g.keep?.userId) continue;
    for (const m of g.remove) {
      if (!keepByDuplicate.has(m.userId)) keepByDuplicate.set(m.userId, g.keep.userId);
    }
  }

  const removed = [];
  const merged = [];
  const failed = [];
  for (const t of targets) {
    const keepId = keepByDuplicate.get(t.userId);
    const r = keepId
      ? mergeHrStaffUserInto(db, t.userId, keepId, actor?.id)
      : purgeHrStaffUser(db, t.userId, actor?.id);
    if (r.ok) {
      if (keepId) {
        merged.push({
          userId: t.userId,
          username: r.fromUsername,
          mergedIntoUserId: keepId,
          mergedIntoUsername: r.toUsername,
          reason: t.reason,
        });
      } else {
        removed.push({ userId: t.userId, username: r.username, reason: t.reason });
      }
    } else {
      failed.push({
        userId: t.userId,
        username: t.username,
        reason: t.reason,
        error: r.error,
        suspendedFallback: r.suspendedFallback || false,
      });
    }
  }

  try {
    appendHrAuditEvent(db, {
      actorUserId: actor?.id,
      action: 'hr.bulk_staff.duplicate_cleanup',
      entityKind: 'hr_staff_import',
      entityId: 'duplicate_cleanup',
      details: {
        removed: removed.length,
        merged: merged.length,
        failed: failed.length,
        targets: targets.length,
      },
    });
  } catch {
    /* optional */
  }

  const after = scanHrStaffDuplicates(db);
  return {
    ok: true,
    dryRun: false,
    removed,
    merged,
    failed,
    after: after.ok ? after.summary : null,
  };
}
