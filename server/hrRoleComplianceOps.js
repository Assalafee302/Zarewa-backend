/**
 * Persist computed role-requirement compliance on hr_staff_profiles.
 * Qualification vs designation min rank; years in role vs max tenure.
 */
import { computeRoleCompliance } from '../shared/lib/hrRoleCompliance.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';

function complianceColumnsReady(db) {
  try {
    return hasColumn(db, 'hr_staff_profiles', 'compliance_status');
  } catch {
    return false;
  }
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * When designation changes, stamp role start. If still empty, copy hire date (migration proxy).
 */
export function syncRoleStartedAtIso(db, { userId, prevDesignationId, nextDesignationId, dateJoinedIso, explicitStartIso }) {
  if (!hasColumn(db, 'hr_staff_profiles', 'role_started_at_iso')) return;
  const next = String(nextDesignationId || '').trim();
  const prev = String(prevDesignationId || '').trim();
  const explicit = String(explicitStartIso || '').trim().slice(0, 10);
  const joined = String(dateJoinedIso || '').trim().slice(0, 10);
  let start = explicit;
  if (next && next !== prev) {
    start = explicit || (prev ? todayIsoDate() : joined || todayIsoDate());
  } else if (!start) {
    const current = db
      .prepare(`SELECT role_started_at_iso FROM hr_staff_profiles WHERE user_id = ?`)
      .get(userId)?.role_started_at_iso;
    if (String(current || '').trim()) return;
    start = joined || (next ? todayIsoDate() : '');
  }
  if (!start) return;
  db.prepare(`UPDATE hr_staff_profiles SET role_started_at_iso = ? WHERE user_id = ?`).run(start, userId);
}

export function persistQualificationRank(db, userId, qualificationRank) {
  if (!hasColumn(db, 'hr_staff_profiles', 'qualification_rank')) return;
  if (qualificationRank === undefined) return;
  const n =
    qualificationRank === null || qualificationRank === ''
      ? null
      : Number.isFinite(Number(qualificationRank))
        ? Number(qualificationRank)
        : null;
  db.prepare(`UPDATE hr_staff_profiles SET qualification_rank = ? WHERE user_id = ?`).run(n, userId);
}

export function persistStaffRoleCompliance(db, userId) {
  if (!complianceColumnsReady(db)) return { ok: false, skipped: true };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId required' };
  const profile = db
    .prepare(
      `SELECT designation_id, qualification_rank, role_started_at_iso FROM hr_staff_profiles WHERE user_id = ?`
    )
    .get(uid);
  if (!profile) return { ok: false, error: 'profile not found' };

  let designation = null;
  if (profile.designation_id) {
    try {
      designation = db
        .prepare(
          `SELECT title, min_qualification_rank, max_tenure_years FROM hr_designations WHERE id = ?`
        )
        .get(profile.designation_id);
    } catch {
      designation = null;
    }
  }

  const computed = computeRoleCompliance({
    designationTitle: designation?.title,
    minQualificationRank: designation?.min_qualification_rank,
    qualificationRank: profile.qualification_rank,
    maxTenureYears: designation?.max_tenure_years,
    roleStartedAtIso: profile.role_started_at_iso,
  });

  db.prepare(
    `UPDATE hr_staff_profiles SET compliance_status = ?, compliance_reason = ? WHERE user_id = ?`
  ).run(computed.status, computed.reason, uid);
  return { ok: true, ...computed };
}

export function recomputeRoleComplianceForDesignation(db, designationId) {
  if (!complianceColumnsReady(db)) return { ok: false, skipped: true };
  const id = String(designationId || '').trim();
  if (!id) return { ok: true, updated: 0 };
  const rows = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE designation_id = ?`).all(id);
  let updated = 0;
  for (const row of rows) {
    persistStaffRoleCompliance(db, row.user_id);
    updated += 1;
  }
  return { ok: true, updated };
}

export function recomputeAllStaffRoleCompliance(db) {
  if (!complianceColumnsReady(db)) return { ok: false, skipped: true };
  const rows = db.prepare(`SELECT user_id FROM hr_staff_profiles`).all();
  let updated = 0;
  for (const row of rows) {
    persistStaffRoleCompliance(db, row.user_id);
    updated += 1;
  }
  return { ok: true, updated };
}
