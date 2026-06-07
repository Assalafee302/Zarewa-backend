/**
 * Phase 10 — audit report for users with custom permission overrides (`permissions_json`).
 */
import { ROLE_DEFINITIONS, permissionsForRole } from './auth.js';

const RISK_PERMISSIONS = {
  hr: [
    'hr.directory.view',
    'hr.staff.manage',
    'hr.requests.review',
    'hr.requests.hr_review',
    'hr.payroll.prepare',
    'hr.payroll.manage',
    'hr.payroll.view_sensitive',
    'hr.settings.manage',
    'hr.executive.view',
  ],
  payroll_sensitive: ['hr.payroll.view_sensitive', 'hr.payroll.prepare', 'hr.payroll.manage', 'hr.payroll.md_approve'],
  finance: ['finance.view', 'finance.post', 'finance.approve', 'finance.pay', 'treasury.manage', 'accounting.desk.view'],
  executive: ['hr.executive.view', 'hr.special_beneficiary.manage', 'exec.dashboard.view'],
  procurement: ['procurement.manage', 'purchase_orders.manage', 'suppliers.manage'],
};

const RISK_LEVEL_ORDER = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/**
 * @param {string[]} extraPerms
 */
function classifyExtraPermissions(extraPerms) {
  const modules = new Set();
  let risk = 'none';
  const bump = (level) => {
    if ((RISK_LEVEL_ORDER[level] || 0) > (RISK_LEVEL_ORDER[risk] || 0)) risk = level;
  };
  for (const p of extraPerms) {
    if (p === '*') {
      modules.add('all');
      bump('critical');
      continue;
    }
    if (RISK_PERMISSIONS.payroll_sensitive.includes(p)) {
      modules.add('payroll_sensitive');
      bump('critical');
    }
    if (RISK_PERMISSIONS.hr.includes(p)) {
      modules.add('hr');
      bump('high');
    }
    if (RISK_PERMISSIONS.finance.includes(p)) {
      modules.add('finance');
      bump('high');
    }
    if (RISK_PERMISSIONS.executive.includes(p)) {
      modules.add('executive');
      bump('high');
    }
    if (RISK_PERMISSIONS.procurement.includes(p)) {
      modules.add('procurement');
      bump('medium');
    }
    if (p.startsWith('hr.')) modules.add('hr');
    if (p.startsWith('finance.') || p.startsWith('accounting.') || p.startsWith('treasury.')) {
      modules.add('finance');
    }
  }
  if (modules.size && risk === 'none') bump('low');
  return { riskLevel: risk, modulesAffected: [...modules].sort() };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function buildCustomPermissionOverrideAudit(db) {
  const rows = db
    .prepare(
      `SELECT id, username, display_name AS displayName, role_key AS roleKey, permissions_json AS permissionsJson, status
       FROM app_users
       WHERE permissions_json IS NOT NULL AND TRIM(permissions_json) != '' AND permissions_json != '[]'
       ORDER BY role_key, username`
    )
    .all();

  const users = [];
  for (const row of rows) {
    let custom = [];
    try {
      custom = JSON.parse(row.permissionsJson);
    } catch {
      custom = [];
    }
    if (!Array.isArray(custom) || custom.length === 0) continue;
    const roleDefaults = new Set(permissionsForRole(row.roleKey));
    const extra = custom.filter((p) => p === '*' || !roleDefaults.has(p));
    if (extra.length === 0) continue;
    const { riskLevel, modulesAffected } = classifyExtraPermissions(extra);
    users.push({
      userId: row.id,
      username: row.username,
      displayName: row.displayName,
      roleKey: row.roleKey,
      roleLabel: ROLE_DEFINITIONS[row.roleKey]?.label || row.roleKey,
      status: row.status,
      extraPermissions: extra,
      riskLevel,
      modulesAffected,
    });
  }
  return {
    generatedAtIso: new Date().toISOString(),
    count: users.length,
    users,
  };
}
