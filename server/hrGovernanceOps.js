/**
 * Phase 6 — skills matrix, grievances, exit interviews, promotion readiness.
 * @module server/hrGovernanceOps
 */

import crypto from 'node:crypto';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function hrGovernanceTablesReady(db) {
  return hrTableExists(db, 'hr_staff_skills');
}

export function listStaffSkills(db, userId) {
  if (!hrGovernanceTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT id, user_id AS userId, skill_name AS skillName, proficiency_level AS proficiencyLevel,
              verified, verified_at_iso AS verifiedAtIso, notes, updated_at_iso AS updatedAtIso
       FROM hr_staff_skills WHERE user_id = ? ORDER BY skill_name ASC`
    )
    .all(String(userId || '').trim());
}

export function upsertStaffSkill(db, userId, body, actor) {
  if (!hrGovernanceTablesReady(db)) return { ok: false, error: 'Skills module not initialised.' };
  const uid = String(userId || '').trim();
  const skillName = String(body?.skillName || '').trim();
  if (skillName.length < 2) return { ok: false, error: 'Skill name is required.' };
  const now = nowIso();
  const id = String(body?.id || '').trim() || newId('HRSK');
  const existing = db.prepare(`SELECT id FROM hr_staff_skills WHERE id = ?`).get(id);
  const row = {
    id,
    user_id: uid,
    skill_name: skillName,
    proficiency_level: Math.min(5, Math.max(1, Math.round(Number(body?.proficiencyLevel) || 3))),
    verified: body?.verified ? 1 : 0,
    verified_at_iso: body?.verified ? now : null,
    notes: String(body?.notes || '').trim() || null,
    updated_at_iso: now,
    updated_by_user_id: actor?.id || null,
  };
  if (existing) {
    db.prepare(
      `UPDATE hr_staff_skills SET skill_name=@skill_name, proficiency_level=@proficiency_level,
       verified=@verified, verified_at_iso=@verified_at_iso, notes=@notes, updated_at_iso=@updated_at_iso,
       updated_by_user_id=@updated_by_user_id WHERE id=@id`
    ).run(row);
  } else {
    db.prepare(
      `INSERT INTO hr_staff_skills (id, user_id, skill_name, proficiency_level, verified, verified_at_iso, notes, created_at_iso, updated_at_iso, updated_by_user_id)
       VALUES (@id,@user_id,@skill_name,@proficiency_level,@verified,@verified_at_iso,@notes,@created_at_iso,@updated_at_iso,@updated_by_user_id)`
    ).run({ ...row, created_at_iso: now });
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.skills.updated',
    entityKind: 'staff',
    entityId: uid,
    details: { skillName, proficiencyLevel: row.proficiency_level },
  });
  return { ok: true, id };
}

export function getPromotionReadiness(db, userId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  const profile = db
    .prepare(
      `SELECT p.*, u.display_name AS displayName FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id WHERE p.user_id = ?`
    )
    .get(uid);
  if (!profile) return { ok: false, error: 'Staff not found.' };
  const joined = Date.parse(String(profile.date_joined_iso || '').slice(0, 10));
  const years = Number.isFinite(joined) ? (Date.now() - joined) / (365.25 * 24 * 60 * 60 * 1000) : 0;
  const skills = hrGovernanceTablesReady(db) ? listStaffSkills(db, uid) : [];
  const avgSkill = skills.length
    ? skills.reduce((s, k) => s + (Number(k.proficiencyLevel) || 0), 0) / skills.length
    : 0;
  let appraisalScore = null;
  try {
    const form = db
      .prepare(
        `SELECT scores_json FROM hr_appraisal_forms WHERE user_id = ? ORDER BY updated_at_iso DESC LIMIT 1`
      )
      .get(uid);
    if (form?.scores_json) {
      const scores = safeJsonParse(form.scores_json, {});
      appraisalScore = Number(scores.overall ?? scores.total) || null;
    }
  } catch {
    /* appraisal table optional */
  }
  const trainingCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM hr_training_records WHERE user_id = ?`)
    .get(uid)?.cnt || 0;
  const checks = [
    { id: 'tenure', label: 'Minimum tenure (3 years)', pass: years >= 3, value: `${Math.floor(years * 10) / 10} yrs` },
    { id: 'appraisal', label: 'Appraisal score ≥ 3.5', pass: appraisalScore == null ? false : appraisalScore >= 3.5, value: appraisalScore ?? '—' },
    { id: 'skills', label: 'Skills documented', pass: skills.length >= 2, value: `${skills.length} skills` },
    { id: 'training', label: 'Training records', pass: trainingCount >= 1, value: `${trainingCount} records` },
  ];
  const passed = checks.filter((c) => c.pass).length;
  const pct = Math.round((passed / checks.length) * 100);
  return {
    ok: true,
    userId: uid,
    displayName: profile.displayName,
    readinessPct: pct,
    ready: pct >= 75,
    checks,
    skills,
    avgSkillLevel: Math.round(avgSkill * 10) / 10,
    appraisalScore,
    yearsOfService: Math.floor(years * 10) / 10,
  };
}

export function listGrievances(db, scope) {
  if (!hrTableExists(db, 'hr_grievances')) return [];
  let sql = `SELECT g.*, u.display_name AS submitterDisplayName FROM hr_grievances g
             LEFT JOIN app_users u ON u.id = g.user_id WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (g.branch_id = ? OR g.user_id = ?)`;
    args.push(scope?.branchId || 'HQ', scope?.actorUserId || '');
  }
  sql += ` ORDER BY g.created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map(mapGrievance);
}

function mapGrievance(row) {
  return {
    id: row.id,
    userId: row.user_id,
    branchId: row.branch_id,
    category: row.category,
    summary: row.summary,
    details: row.details,
    status: row.status,
    anonymous: Boolean(row.anonymous_flag),
    submitterDisplayName: row.anonymous_flag ? 'Anonymous' : row.submitterDisplayName || row.user_id,
    assignedToUserId: row.assigned_to_user_id,
    resolutionNote: row.resolution_note,
    createdAtIso: row.created_at_iso,
    resolvedAtIso: row.resolved_at_iso,
  };
}

const GRIEVANCE_STATUSES = new Set(['new', 'investigating', 'resolved', 'closed']);
const GRIEVANCE_TRANSITIONS = {
  new: new Set(['investigating', 'closed']),
  investigating: new Set(['resolved', 'closed']),
  resolved: new Set(['closed']),
  closed: new Set(),
};

export function createGrievance(db, actor, body) {
  if (!hrTableExists(db, 'hr_grievances')) return { ok: false, error: 'Grievance module not initialised.' };
  const summary = String(body?.summary || '').trim();
  if (summary.length < 10) return { ok: false, error: 'Summary must be at least 10 characters.' };
  const anonymous = Boolean(body?.anonymous);
  const id = newId('HRGRV');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_grievances (id, user_id, branch_id, category, summary, details, status, anonymous_flag, created_at_iso, updated_at_iso)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    anonymous ? null : actor?.id || null,
    String(body?.branchId || actor?.branchId || 'HQ').trim(),
    String(body?.category || 'general').trim(),
    summary,
    String(body?.details || '').trim() || null,
    'new',
    anonymous ? 1 : 0,
    now,
    now
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.grievance.created',
    entityKind: 'grievance',
    entityId: id,
    details: { category: body?.category, anonymous },
  });
  return { ok: true, id };
}

export function patchGrievance(db, grievanceId, body, actor) {
  if (!hrTableExists(db, 'hr_grievances')) return { ok: false, error: 'Grievance module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_grievances WHERE id = ?`).get(grievanceId);
  if (!row) return { ok: false, error: 'Grievance not found.' };
  const current = String(row.status || 'new').trim();
  const status = String(body?.status || current).trim();
  if (!GRIEVANCE_STATUSES.has(status)) {
    return { ok: false, error: `Invalid grievance status: ${status}.` };
  }
  if (status !== current) {
    const allowed = GRIEVANCE_TRANSITIONS[current];
    if (!allowed?.has(status)) {
      return { ok: false, error: `Cannot transition grievance from "${current}" to "${status}".` };
    }
  }
  const now = nowIso();
  db.prepare(
    `UPDATE hr_grievances SET status = ?, assigned_to_user_id = COALESCE(?, assigned_to_user_id),
     resolution_note = COALESCE(?, resolution_note), resolved_at_iso = ?, updated_at_iso = ? WHERE id = ?`
  ).run(
    status,
    body?.assignedToUserId ?? null,
    body?.resolutionNote ?? null,
    status === 'resolved' || status === 'closed' ? now : row.resolved_at_iso,
    now,
    grievanceId
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.grievance.updated',
    entityKind: 'grievance',
    entityId: grievanceId,
    details: { status },
  });
  return { ok: true, grievance: mapGrievance(db.prepare(`SELECT g.*, u.display_name AS submitterDisplayName FROM hr_grievances g LEFT JOIN app_users u ON u.id = g.user_id WHERE g.id = ?`).get(grievanceId)) };
}

export function upsertExitInterview(db, clearanceId, body, actor) {
  if (!hrTableExists(db, 'hr_exit_interviews')) return { ok: false, error: 'Exit interview module not initialised.' };
  const cid = String(clearanceId || '').trim();
  if (!cid) return { ok: false, error: 'Clearance ID is required.' };
  const responses = body?.responses && typeof body.responses === 'object' ? body.responses : {};
  const now = nowIso();
  const existing = db.prepare(`SELECT id FROM hr_exit_interviews WHERE clearance_id = ?`).get(cid);
  if (existing) {
    db.prepare(
      `UPDATE hr_exit_interviews SET responses_json = ?, conducted_at_iso = ?, conducted_by_user_id = ?, updated_at_iso = ? WHERE clearance_id = ?`
    ).run(JSON.stringify(responses), now, actor?.id || null, now, cid);
  } else {
    db.prepare(
      `INSERT INTO hr_exit_interviews (id, clearance_id, user_id, responses_json, conducted_at_iso, conducted_by_user_id, created_at_iso, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(newId('HREXI'), cid, String(body?.userId || '').trim() || null, JSON.stringify(responses), now, actor?.id || null, now, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.exit.interview_recorded',
    entityKind: 'hr_exit_clearance',
    entityId: cid,
  });
  return { ok: true };
}

export function getExitInterview(db, clearanceId) {
  if (!hrTableExists(db, 'hr_exit_interviews')) return null;
  const row = db.prepare(`SELECT * FROM hr_exit_interviews WHERE clearance_id = ?`).get(String(clearanceId || '').trim());
  if (!row) return null;
  return {
    id: row.id,
    clearanceId: row.clearance_id,
    userId: row.user_id,
    responses: safeJsonParse(row.responses_json, {}),
    conductedAtIso: row.conducted_at_iso,
    conductedByUserId: row.conducted_by_user_id,
  };
}
