/**
 * Display names for receipt confirmer logins.
 * Prefer HR legal name when app_users.display_name is still the role title (e.g. "Cashier").
 */
import { roleLabel } from '../auth.js';
import { composeLegalDisplayName } from '../../shared/lib/hrLegalDisplayName.js';

function parseProfilePersonal(profileExtraJson) {
  try {
    const extra = JSON.parse(String(profileExtraJson || '{}'));
    return extra?.personal && typeof extra.personal === 'object' ? extra.personal : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ display_name?: string, role_key?: string, profile_extra_json?: string }} row
 */
export function personNameForLoginRow(row) {
  const loginName = String(row?.display_name || '').trim();
  const legal = composeLegalDisplayName(parseProfilePersonal(row?.profile_extra_json));
  const title = String(roleLabel(row?.role_key) || '').trim();
  const loginLooksLikeRole =
    Boolean(loginName && title) && loginName.toLowerCase() === title.toLowerCase();
  if (legal && (loginLooksLikeRole || !loginName)) return legal;
  return loginName || legal || '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} userIds
 * @returns {Map<string, string>}
 */
export function displayNamesByUserIds(db, userIds) {
  const ids = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT u.id, u.display_name, u.role_key, p.profile_extra_json
         FROM app_users u
         LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.id IN (${ph})`
      )
      .all(...ids);
  } catch {
    try {
      rows = db.prepare(`SELECT id, display_name, role_key FROM app_users WHERE id IN (${ph})`).all(...ids);
    } catch {
      return map;
    }
  }
  for (const row of rows) {
    map.set(String(row.id), personNameForLoginRow(row));
  }
  return map;
}
