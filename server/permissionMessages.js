/** Human guidance for permission codes shown in API errors. */

const PERMISSION_GUIDANCE = {
  'audit.view': 'Audit log access',
  'finance.view': 'Finance desk access',
  'finance.post': 'Finance posting permission',
  'sales.view': 'Sales desk access',
  'sales.edit': 'Sales edit permission',
  'procurement.view': 'Procurement desk access',
  'operations.view': 'Operations desk access',
  'hr.view': 'HR desk access',
  'hr.manage': 'HR management permission',
  'settings.manage': 'Settings administration',
  'reports.view': 'Reports access',
  'cashier.post': 'Cashier posting permission',
  'treasury.manage': 'Treasury management',
};

/**
 * @param {string|string[]|null|undefined} permissions
 * @returns {string}
 */
export function permissionGuidanceMessage(permissions) {
  const list = Array.isArray(permissions)
    ? permissions
    : String(permissions || '')
        .split(/[,\s]+/)
        .filter(Boolean);
  if (!list.length) {
    return 'You do not have permission for this action. Contact your branch manager or administrator.';
  }
  const labels = list.slice(0, 3).map((p) => PERMISSION_GUIDANCE[p] || p.replace(/\./g, ' '));
  return `This action requires ${labels.join(' or ')}. Contact your branch manager if you need access.`;
}

/**
 * @param {string} code
 * @returns {string|null}
 */
export function labelForPermission(code) {
  return PERMISSION_GUIDANCE[String(code || '').trim()] || null;
}
