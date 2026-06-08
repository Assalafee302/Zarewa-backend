/**
 * Detect and remove duplicate HR staff accounts from failed bulk imports.
 * @module server/hrStaffDuplicateCleanup
 */

import { updateAppUserStatus } from './auth.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';

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

function runOptionalDelete(db, sql, userId) {
  try {
    db.prepare(sql).run(userId);
  } catch {
    /* table may be missing or row absent */
  }
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
      db.prepare(`UPDATE hr_staff_profiles SET line_manager_user_id = NULL WHERE line_manager_user_id = ?`).run(uid);
      if (hrTableExists(db, 'hr_notifications')) {
        runOptionalDelete(db, `DELETE FROM hr_notifications WHERE user_id = ?`, uid);
      }
      if (hrTableExists(db, 'hr_policy_acknowledgements')) {
        runOptionalDelete(db, `DELETE FROM hr_policy_acknowledgements WHERE user_id = ?`, uid);
      }
      if (hrTableExists(db, 'hr_staff_documents')) {
        runOptionalDelete(db, `DELETE FROM hr_staff_documents WHERE user_id = ?`, uid);
      }
      if (hrTableExists(db, 'hr_requests')) {
        runOptionalDelete(db, `DELETE FROM hr_requests WHERE user_id = ?`, uid);
      }
      if (hrTableExists(db, 'hr_staff_profiles')) {
        db.prepare(`DELETE FROM hr_staff_profiles WHERE user_id = ?`).run(uid);
      }
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

  const removed = [];
  const failed = [];
  for (const t of targets) {
    const r = purgeHrStaffUser(db, t.userId, actor?.id);
    if (r.ok) {
      removed.push({ userId: t.userId, username: r.username, reason: t.reason });
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
    failed,
    after: after.ok ? after.summary : null,
  };
}
