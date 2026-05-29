/**
 * Staff onboarding / offboarding lifecycle stored in profile_extra_json.lifecycle.
 * @module server/hrStaffLifecycle
 */

import {
  HR_SEPARATION_STATUSES,
  normalizeHrLifecycleState,
} from '../shared/lib/hrStaffLifecycle.js';

function hrTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_profiles'`).get());
  } catch {
    return false;
  }
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function readProfileExtra(db, userId) {
  const row = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!row) return null;
  return safeJsonParse(row.profile_extra_json, {});
}

function writeProfileExtra(db, userId, extra) {
  db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ?, updated_at_iso = ? WHERE user_id = ?`).run(
    JSON.stringify(extra),
    nowIso(),
    userId
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} staff
 */
export function enrichStaffWithLifecycle(staff) {
  if (!staff) return staff;
  const extra = staff.profileExtra && typeof staff.profileExtra === 'object' ? staff.profileExtra : {};
  const lifecycle = normalizeHrLifecycleState(extra.lifecycle);
  return { ...staff, lifecycle };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function getHrStaffLifecycle(db, userId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  const extra = readProfileExtra(db, uid);
  if (extra == null) return { ok: false, error: 'Staff profile not found.' };
  return { ok: true, lifecycle: normalizeHrLifecycleState(extra.lifecycle) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} userId
 * @param {'onboarding' | 'offboarding'} workflow
 * @param {string} taskKey
 * @param {boolean} done
 */
export function patchHrLifecycleTask(db, actor, userId, workflow, taskKey, done) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  const wf = workflow === 'offboarding' ? 'offboarding' : 'onboarding';
  const key = String(taskKey || '').trim();
  if (!key) return { ok: false, error: 'taskKey is required.' };
  const extra = readProfileExtra(db, uid);
  if (extra == null) return { ok: false, error: 'Staff profile not found.' };
  if (!extra.lifecycle || typeof extra.lifecycle !== 'object') extra.lifecycle = {};
  if (!extra.lifecycle[wf] || typeof extra.lifecycle[wf] !== 'object') extra.lifecycle[wf] = {};
  if (done) {
    extra.lifecycle[wf][key] = {
      done: true,
      at: nowIso(),
      by: actor?.id || null,
    };
  } else {
    delete extra.lifecycle[wf][key];
  }
  writeProfileExtra(db, uid, extra);
  return { ok: true, lifecycle: normalizeHrLifecycleState(extra.lifecycle) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {string} userId
 * @param {{ status?: string; lastWorkingDayIso?: string; reason?: string; notes?: string }} body
 */
export function patchHrStaffSeparation(db, actor, userId, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  const extra = readProfileExtra(db, uid);
  if (extra == null) return { ok: false, error: 'Staff profile not found.' };
  if (!extra.lifecycle || typeof extra.lifecycle !== 'object') extra.lifecycle = {};
  const prev = extra.lifecycle.separation && typeof extra.lifecycle.separation === 'object' ? extra.lifecycle.separation : {};
  const status = body.status !== undefined ? String(body.status || '').trim() : prev.status || 'active';
  if (!HR_SEPARATION_STATUSES.includes(status)) {
    return { ok: false, error: 'Invalid separation status.' };
  }
  extra.lifecycle.separation = {
    status,
    lastWorkingDayIso:
      body.lastWorkingDayIso !== undefined
        ? String(body.lastWorkingDayIso || '').slice(0, 10) || null
        : prev.lastWorkingDayIso || null,
    reason: body.reason !== undefined ? String(body.reason || '').trim() || null : prev.reason || null,
    notes: body.notes !== undefined ? String(body.notes || '').trim() || null : prev.notes || null,
    updatedAtIso: nowIso(),
    updatedByUserId: actor?.id || null,
  };
  writeProfileExtra(db, uid, extra);
  if (status === 'separated') {
    db.prepare(`UPDATE hr_staff_profiles SET self_service_eligible = 0, updated_at_iso = ? WHERE user_id = ?`).run(
      nowIso(),
      uid
    );
  }
  return { ok: true, lifecycle: normalizeHrLifecycleState(extra.lifecycle) };
}
