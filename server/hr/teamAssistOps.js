/**
 * Team HR assist: branch managers (and other hr.team.assist holders) may fill
 * personal profile fields, upload documents, and create/submit HR requests for
 * staff in their Team HR scope — without hr.staff.manage or salary access.
 * @module server/hr/teamAssistOps
 */

import { hrUserHas, userCanAssistTeamHr } from '../hrPermissions.js';
import {
  createHrRequest,
  deleteHrRequestDraft,
  submitHrRequest,
  submitMyHrStaffProfile,
  updateMyHrStaffProfile,
} from '../hrOps.js';
import { assertStaffUserIdInHrScope } from '../hrStaffScope.js';

export { userCanAssistTeamHr };

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} subjectUserId
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function assertActorMayAssistStaff(db, actor, subjectUserId, scope) {
  const uid = String(subjectUserId || '').trim();
  const actorId = String(actor?.id || '').trim();
  if (!uid) {
    return { ok: false, error: 'Staff user id is required.', code: 'FORBIDDEN', status: 400 };
  }
  if (uid === actorId) return { ok: true, self: true };
  if (hrUserHas(actor, '*') || hrUserHas(actor, 'hr.staff.manage')) return { ok: true, org: true };
  if (!hrUserHas(actor, 'hr.team.assist')) {
    return {
      ok: false,
      error: 'You can only act on your own HR file.',
      code: 'FORBIDDEN',
      status: 403,
    };
  }
  const gate = assertStaffUserIdInHrScope(db, scope, uid);
  if (!gate.ok) return gate;
  return { ok: true, team: true };
}

/**
 * Same personal fields as employee self-service; salary/bank/role are ignored.
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} subjectUserId
 * @param {object} body
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function updateTeamStaffProfile(db, actor, subjectUserId, body, scope) {
  const gate = assertActorMayAssistStaff(db, actor, subjectUserId, scope);
  if (!gate.ok) return gate;
  const r = updateMyHrStaffProfile(db, subjectUserId, body || {}, {
    actorUserId: String(actor?.id || '').trim(),
    action: gate.self ? 'hr.profile.self_service_update' : 'hr.profile.manager_assist_update',
  });
  return r;
}

/**
 * Submit (lock) a team member's completed profile.
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} subjectUserId
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function submitTeamStaffProfile(db, actor, subjectUserId, scope) {
  const gate = assertActorMayAssistStaff(db, actor, subjectUserId, scope);
  if (!gate.ok) return gate;
  const r = submitMyHrStaffProfile(db, subjectUserId, {
    actorUserId: String(actor?.id || '').trim(),
  });
  return r;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} forUserId
 * @param {object} body
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function createHrRequestForStaff(db, actor, forUserId, body, scope) {
  const gate = assertActorMayAssistStaff(db, actor, forUserId, scope);
  if (!gate.ok) return gate;
  return createHrRequest(db, forUserId, body || {}, actor);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {object} actor
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function submitHrRequestForStaff(db, requestId, actor, scope) {
  const row = db.prepare(`SELECT user_id AS userId FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  const actorId = String(actor?.id || '').trim();
  const isOwner = String(row.userId) === actorId;
  const adminOnBehalf =
    hrUserHas(actor, '*') || hrUserHas(actor, 'hr.staff.manage') || hrUserHas(actor, 'hr.requests.review');
  if (!isOwner && !adminOnBehalf) {
    const gate = assertActorMayAssistStaff(db, actor, row.userId, scope);
    if (!gate.ok) return gate;
  }
  return submitHrRequest(db, requestId, actor);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {object} actor
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 */
export function deleteHrRequestDraftForStaff(db, requestId, actor, scope) {
  const row = db.prepare(`SELECT user_id AS userId, status FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  const gate = assertActorMayAssistStaff(db, actor, row.userId, scope);
  if (!gate.ok) return gate;
  return deleteHrRequestDraft(db, requestId, row.userId);
}

/**
 * @param {object} user
 */
export function teamHrAssistCapabilities(user) {
  const canAssist = userCanAssistTeamHr(user);
  return {
    canAssistTeam: canAssist,
    canUpdateTeamProfiles: canAssist,
    canSubmitTeamProfiles: canAssist,
    canCreateTeamRequests: canAssist,
    canSubmitTeamRequests: canAssist,
    canUploadTeamDocuments: canAssist,
    canMarkAttendance: hrUserHas(user, 'hr.attendance.mark') || hrUserHas(user, 'hr.daily_roll.mark'),
    canEndorseRequests: hrUserHas(user, 'hr.branch.endorse_staff') || hrUserHas(user, 'hr.leave.endorse'),
  };
}
