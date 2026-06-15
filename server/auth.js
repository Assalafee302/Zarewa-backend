import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { normalizeWorkspaceDepartment } from './departmentRoleTemplates.js';
import { HR_PERMISSION_KEYS } from './hrPermissionKeys.js';
import { HR_ROLE_PERMISSION_BUNDLES } from './hrRoleBundles.js';

function appUsersHasEmailColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
    return cols.some((c) => c.name === 'email');
  } catch {
    return false;
  }
}

function appUsersHasColumn(db, name) {
  try {
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
    return cols.some((c) => c.name === name);
  } catch {
    return false;
  }
}

/** Phase 12: plaintext password storage removed — no-op for backward compatibility. */
export function storeRegisteredPassword(_db, _userId, _plainPassword) {
  /* intentionally empty */
}

function readMustChangePassword(row) {
  if (!row) return false;
  return Number(row.must_change_password) === 1;
}

function readTrainingCompleted(row) {
  if (!row) return true;
  if (!Object.prototype.hasOwnProperty.call(row, 'training_completed_at_iso')) return true;
  return Boolean(String(row.training_completed_at_iso ?? '').trim());
}

/** Users still in onboarding may use a reset code (must change password or training not done). */
export function userRequiresInitialPasswordSetup(row) {
  if (!row || String(row.status || 'active') !== 'active') return false;
  if (readMustChangePassword(row)) return true;
  if (!readTrainingCompleted(row)) return true;
  return false;
}

/** Admin/HR may issue one-time reset codes for onboarding users. */
export function canIssuePasswordResetCodes(user) {
  return canRevealUserPasswords(user);
}

export const SESSION_COOKIE = 'zarewa_session';
export const CSRF_COOKIE = 'zarewa_csrf';
export const SESSION_WARNING_SECONDS = 60;
export const FAILED_LOGIN_LOCK_THRESHOLD = 5;
export const ACCOUNT_LOCK_MINUTES = 30;
const RESET_TOKEN_TTL_MINUTES = 60;

/** Inactivity timeout (sliding window). Override with SESSION_TIMEOUT_MINUTES (5–480). Default 2 hours. */
export function sessionTimeoutMinutes() {
  const raw = Number(process.env.SESSION_TIMEOUT_MINUTES ?? 120);
  if (Number.isFinite(raw) && raw >= 5 && raw <= 480) return Math.floor(raw);
  return 120;
}

function normalizeApiPath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '').split('?')[0].trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Whether this request should slide the server inactivity expiry forward.
 * GET bootstrap polls and passive reads do not extend; user activity and mutations do.
 */
export function requestShouldExtendSession(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return true;

  const path = normalizeApiPath(req);
  if (path === '/api/session/activity') return true;

  const touchHeader = String(req.headers?.['x-zarewa-session-touch'] || '').trim().toLowerCase();
  if (touchHeader === '1') return true;
  if (touchHeader === '0') return false;

  if (path === '/api/bootstrap') {
    const poll = String(req.query?.poll ?? req.query?.workspacePoll ?? '').trim();
    if (poll === '1') return false;
  }

  return false;
}

/** @type {((payload: { user: object; token: string }) => void) | null} */
let sessionTimeoutAuditHook = null;

export function setSessionTimeoutAuditHook(fn) {
  sessionTimeoutAuditHook = typeof fn === 'function' ? fn : null;
}
/** Max stored profile image (data URL or https URL). */
export const MAX_AVATAR_URL_LEN = 180_000;
const RESET_TOKEN_BYTES = 32;

export function validatePasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (!/[a-z]/.test(p)) {
    return { ok: false, error: 'Password must include a lowercase letter.' };
  }
  if (!/[A-Z]/.test(p)) {
    return { ok: false, error: 'Password must include an uppercase letter.' };
  }
  if (!/[0-9]/.test(p)) {
    return { ok: false, error: 'Password must include a number.' };
  }
  if (!/[^A-Za-z0-9]/.test(p)) {
    return { ok: false, error: 'Password must include a special character (for example ! @ # $).' };
  }
  return { ok: true };
}

function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Phase B desk separation — visibility foundation; mutation rules unchanged until Phase B3. */
export const FINANCE_DESK_PERMISSION_KEYS = [
  'cashier.desk.view',
  'cashier.receipts.confirm',
  'accounting.desk.view',
  'accounting.reconciliation.view',
  'accounting.gl.view',
];

/** Full Operations module: stock, production register (incl. stone-coated), deliveries, incidents. */
export const OPERATIONS_FLOOR_ROLE_PERMISSIONS = [
  'dashboard.view',
  'office.use',
  'operations.view',
  'operations.manage',
  'production.manage',
  'production.release',
  'inventory.receive',
  'inventory.adjust',
  'deliveries.manage',
  'material_incidents.create',
];

/** Store floor + production register (coil and stone-coated). One role: operations officer / store keeper. */
/** Normalize legacy role aliases (`storekeeper`, `store_keeper` → `operations_officer`). */
export function normalizeRoleKey(roleKey) {
  const rk = String(roleKey || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (rk === 'storekeeper' || rk === 'store_keeper') return 'operations_officer';
  return rk;
}

export const ROLE_DEFINITIONS = {
  admin: {
    label: 'Administrator',
    permissions: ['*', 'settings.view', 'settings.manage'],
  },
  md: {
    label: 'Managing Director',
    // Executive + org-wide rollups (merged former CEO scope). Procurement is centralized here, not a separate job role.
    permissions: [
      'hq.view_all_branches',
      'exec.dashboard.view',
      'dashboard.view',
      'office.use',
      'reports.view',
      'sales.view',
      'procurement.view',
      'procurement.manage',
      'suppliers.manage',
      'purchase_orders.manage',
      'operations.view',
      'finance.view',
      'finance.pay',
      'audit.view',
      'quotations.manage',
      'finance.approve',
      'refunds.approve',
      'production.release',
      'pricing.manage',
      'pricing.policy.manage',
      'md.price_exception.approve',
      'inter_branch_loan.md_approve',
      'inventory.receive',
      'inventory.adjust',
      'material_incidents.approve',
      ...HR_ROLE_PERMISSION_BUNDLES.mdExecutive,
      'hr.payroll.md_approve',
      'treasury.reserve_policy.manage',
      'accounting.desk.view',
      'accounting.reconciliation.view',
      'accounting.gl.view',
    ],
  },
  /** Role key `finance_manager` retained for backward compatibility; label matches company structure. */
  finance_manager: {
    label: 'Accountant / Head of Accounts',
    permissions: [
      'dashboard.view',
      'office.use',
      'procurement.view',
      'finance.view',
      'finance.post',
      'finance.approve',
      'finance.pay',
      'finance.reverse',
      'finance.cross_branch_post',
      'treasury.manage',
      'audit.view',
      'period.manage',
      'treasury.reserve_policy.manage',
      /** Management reports (`/api/reports/*`, `/reports`) — same gate as `userMayViewManagementReports`. */
      'reports.view',
      'accounting.desk.view',
      'accounting.reconciliation.view',
      'accounting.gl.view',
      ...HR_ROLE_PERMISSION_BUNDLES.financeHr,
    ],
  },
  cashier: {
    label: 'Cashier',
    permissions: [
      'dashboard.view',
      'office.use',
      'receipts.post',
      'refunds.request',
      'expenses.create',
      'finance.view',
      'finance.post',
      'finance.approve',
      'finance.pay',
      'finance.reverse',
      'treasury.manage',
      'audit.view',
      'reports.view',
      /** Phase B: desk routes — legacy finance perms retained for compatibility until B3. */
      'cashier.desk.view',
      'cashier.receipts.confirm',
    ],
  },
  sales_manager: {
    label: 'Branch manager',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'sales.view',
      'sales.manage',
      'customers.manage',
      'quotations.manage',
      'receipts.post',
      /** Direct expense rows + treasury debit (same POST as finance.post); excludes GL/bank-rec workflows. */
      'expenses.create',
      'refunds.approve',
      'operations.view',
      'operations.manage',
      'production.manage',
      'production.release',
      'deliveries.manage',
      'inventory.receive',
      'inventory.adjust',
      'material_incidents.approve',
      ...HR_ROLE_PERMISSION_BUNDLES.branchManager,
    ],
  },
  sales_staff: {
    label: 'Sales officer',
    permissions: [
      'dashboard.view',
      'office.use',
      'sales.view',
      'customers.manage',
      'quotations.manage',
      'receipts.post',
      'expenses.create',
      'refunds.request',
      ...HR_ROLE_PERMISSION_BUNDLES.selfService,
    ],
  },
  hr_admin: {
    label: 'HR / Admin',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      ...HR_ROLE_PERMISSION_BUNDLES.hrAdmin,
    ],
  },
  gmhr: {
    label: 'GM HR',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'hq.view_all_branches',
      ...HR_ROLE_PERMISSION_BUNDLES.gmhr,
    ],
  },
  operations_officer: {
    label: 'Operations officer / Store keeper',
    permissions: [...OPERATIONS_FLOOR_ROLE_PERMISSIONS],
  },
  ceo: {
    label: 'Chief Executive Officer',
    permissions: ['exec.dashboard.view', 'dashboard.view', 'office.use', 'reports.view'],
  },
  viewer: {
    label: 'Read-only viewer',
    permissions: ['dashboard.view'],
  },
};

const DEFAULT_USERS = [
  {
    id: 'USR-ADMIN',
    username: 'admin',
    displayName: 'Zarewa Admin',
    roleKey: 'admin',
    department: 'admin',
    password: 'Admin@123',
  },
  {
    id: 'USR-MD',
    username: 'md',
    displayName: 'Managing Director',
    roleKey: 'md',
    department: 'md',
    password: 'Md@1234567890!',
  },
  {
    id: 'USR-FIN',
    username: 'finance.manager',
    displayName: 'Finance Manager',
    roleKey: 'finance_manager',
    department: 'finance_manager',
    password: 'Finance@123',
  },
  {
    id: 'USR-CASH',
    username: 'cashier',
    displayName: 'Cashier',
    roleKey: 'cashier',
    department: 'cashier',
    password: 'Cashier@12345!',
  },
  {
    id: 'USR-SM',
    username: 'sales.manager',
    displayName: 'Sales Manager',
    roleKey: 'sales_manager',
    department: 'sales_manager',
    password: 'Sales@123',
  },
  {
    id: 'USR-SS',
    username: 'sales.staff',
    displayName: 'Sales Officer',
    roleKey: 'sales_staff',
    department: 'sales_staff',
    password: 'Sales@123',
  },
  {
    id: 'USR-OPS',
    username: 'operations',
    displayName: 'Operations Officer',
    roleKey: 'operations_officer',
    department: 'operations_officer',
    password: 'Ops@123',
  },
  {
    id: 'USR-CEO',
    username: 'ceo',
    displayName: 'Chief Executive Officer',
    roleKey: 'ceo',
    department: 'ceo',
    password: 'Ceo@1234567890!',
  },
  {
    id: 'USR-VIEW',
    username: 'viewer',
    displayName: 'Read-only Viewer',
    roleKey: 'viewer',
    department: 'viewer',
    password: 'Viewer@123456!',
  },
];

/** Username → default seed password (used when DB field is empty but hash still matches). */
export const DEFAULT_USER_PASSWORD_BY_USERNAME = Object.fromEntries(
  DEFAULT_USERS.map((u) => [String(u.username || '').trim().toLowerCase(), u.password])
);

export function canRevealUserPasswords(user) {
  const role = String(user?.roleKey || '').toLowerCase();
  return role === 'admin' || role === 'md' || role === 'hr_admin';
}

/**
 * Password shown to settings admins: stored value, else still-valid default seed password.
 * @param {import('better-sqlite3').Database} db
 * @param {{ username?: string, password_hash?: string, registered_password?: string }} row
 */
/** Phase 12: passwords are never displayed in admin UIs. */
export function resolveRegisteredPasswordDisplay(_db, _row) {
  return '';
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutesToIso(iso, minutes) {
  const dt = new Date(iso);
  dt.setMinutes(dt.getMinutes() + minutes);
  return dt.toISOString();
}

function sessionCookieMaxAgeSeconds() {
  return sessionTimeoutMinutes() * 60;
}

function sessionSecurityMeta(expiresAtISO) {
  return {
    sessionExpiresAtIso: expiresAtISO,
    sessionTimeoutMinutes: sessionTimeoutMinutes(),
    sessionWarningSeconds: SESSION_WARNING_SECONDS,
  };
}

function allowSeedDefaultUsers() {
  return (
    process.env.ZAREWA_ALLOW_SEEDED_USERS === 'true' ||
    process.env.ZAREWA_ALLOW_SEEDED_USERS === '1' ||
    process.env.NODE_ENV === 'test'
  );
}

function clearAccountLock(db, userId) {
  if (!appUsersHasColumn(db, 'failed_login_count')) return;
  db.prepare(
    `UPDATE app_users SET failed_login_count = 0, locked_until_iso = NULL WHERE id = ?`
  ).run(userId);
}

function clearFailedLoginAttempts(db, userId) {
  if (!appUsersHasColumn(db, 'failed_login_count')) return;
  db.prepare(`UPDATE app_users SET failed_login_count = 0 WHERE id = ?`).run(userId);
}

/**
 * @returns {{ locked: boolean; lockedUntilIso?: string; userId?: string; attemptCount?: number }}
 */
function recordFailedLoginAttempt(db, row) {
  if (!appUsersHasColumn(db, 'failed_login_count')) {
    return { locked: false, userId: row?.id };
  }
  const count = Number(row.failed_login_count || 0) + 1;
  if (count >= FAILED_LOGIN_LOCK_THRESHOLD) {
    const lockedUntil = addMinutesToIso(nowIso(), ACCOUNT_LOCK_MINUTES);
    db.prepare(
      `UPDATE app_users SET failed_login_count = ?, locked_until_iso = ? WHERE id = ?`
    ).run(count, lockedUntil, row.id);
    return { locked: true, lockedUntilIso: lockedUntil, userId: row.id, attemptCount: count };
  }
  db.prepare(`UPDATE app_users SET failed_login_count = ? WHERE id = ?`).run(count, row.id);
  return { locked: false, userId: row.id, attemptCount: count };
}

function buildLoginFailureAudits(row, username, fail) {
  const actor = {
    id: row?.id ?? null,
    displayName: row?.displayName || row?.display_name || username,
    username,
  };
  const audits = [
    {
      actor,
      action: 'session.login_failed',
      entityKind: 'user',
      entityId: row?.id ?? username,
      note: fail.locked
        ? `Failed sign-in (${fail.attemptCount}/${FAILED_LOGIN_LOCK_THRESHOLD}); account locked`
        : fail.attemptCount
          ? `Failed sign-in (${fail.attemptCount}/${FAILED_LOGIN_LOCK_THRESHOLD})`
          : 'Failed sign-in (unknown or inactive account)',
      details: { attemptCount: fail.attemptCount, locked: fail.locked },
    },
  ];
  if (fail.locked) {
    audits.push({
      actor,
      action: 'session.account_locked',
      entityKind: 'user',
      entityId: row?.id ?? username,
      note: `Account locked for ${ACCOUNT_LOCK_MINUTES} minutes after ${FAILED_LOGIN_LOCK_THRESHOLD} failed attempts`,
      details: { lockedUntilIso: fail.lockedUntilIso },
    });
  }
  return audits;
}

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Re-verify password for sensitive HR screens (compensation, payslips, etc.).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} password
 */
export function verifyUserPassword(db, userId, password) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'Not signed in.' };
  const row = db.prepare(`SELECT password_hash, status FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  if (String(row.status || '') !== 'active') return { ok: false, error: 'Account is not active.' };
  if (!verifyPassword(String(password || ''), row.password_hash)) {
    return { ok: false, error: 'Incorrect password.' };
  }
  return { ok: true };
}

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function roleLabel(roleKey) {
  const rk = normalizeRoleKey(roleKey);
  return ROLE_DEFINITIONS[rk]?.label || roleKey || 'User';
}

export function permissionsForRole(roleKey) {
  const rk = normalizeRoleKey(roleKey);
  return [...(ROLE_DEFINITIONS[rk]?.permissions || [])];
}

/** Store / production floor permissions — always granted for ops role and store departments. */
export const STORE_FLOOR_PERMISSION_KEYS = [
  'operations.view',
  'operations.manage',
  'production.manage',
  'production.release',
  'inventory.receive',
  'inventory.adjust',
  'deliveries.manage',
];

const STORE_FLOOR_DEPARTMENT_LABELS = new Set([
  'inventory',
  'production',
  'storekeeper',
  'store_keeper',
  'operations_officer',
]);

/**
 * Union role template permissions with optional custom list (custom adds; does not remove role defaults).
 * @param {string} roleKey
 * @param {unknown} customParsed
 */
export function mergeRoleAndCustomPermissions(roleKey, customParsed) {
  const base = permissionsForRole(roleKey);
  if (!Array.isArray(customParsed) || customParsed.length === 0) return [...base];
  if (customParsed.includes('*')) {
    if (normalizeRoleKey(roleKey) === 'admin') return ['*'];
    // Ignore wildcard in custom JSON — prevents privilege escalation via permissions_json.
  }
  const set = new Set(base);
  for (const p of customParsed) {
    const s = String(p ?? '').trim();
    if (s && s !== '*') set.add(s);
  }
  return [...set];
}

/**
 * @param {string[]} permissions — mutated in place
 * @param {{ roleKey?: string; department?: string }} ctx
 */
export function ensureStoreFloorPermissions(permissions, ctx = {}) {
  if (!Array.isArray(permissions) || permissions.includes('*')) return;
  const rk = String(ctx.roleKey || '').trim().toLowerCase();
  const rawDept = String(ctx.department || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const deptRole = normalizeWorkspaceDepartment(rawDept || rk);
  const normalizedRk = normalizeRoleKey(rk);
  const needsFloor =
    normalizedRk === 'operations_officer' ||
    STORE_FLOOR_DEPARTMENT_LABELS.has(rawDept) ||
    deptRole === 'operations_officer';
  if (!needsFloor) return;
  for (const p of STORE_FLOOR_PERMISSION_KEYS) {
    if (!permissions.includes(p)) permissions.push(p);
  }
}

/** Sales desk permissions — quotations, receipts, expense requests, refunds. */
export const SALES_DESK_PERMISSION_KEYS = [
  'dashboard.view',
  'office.use',
  'sales.view',
  'customers.manage',
  'quotations.manage',
  'receipts.post',
  'expenses.create',
  'refunds.request',
];

const SALES_DESK_DEPARTMENT_LABELS = new Set(['sales', 'customer', 'general', 'sales_staff']);

/**
 * @param {string[]} permissions — mutated in place
 * @param {{ roleKey?: string; department?: string }} ctx
 */
export function ensureSalesDeskPermissions(permissions, ctx = {}) {
  if (!Array.isArray(permissions) || permissions.includes('*')) return;
  const rk = String(ctx.roleKey || '').trim().toLowerCase();
  const rawDept = String(ctx.department || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const deptRole = normalizeWorkspaceDepartment(rawDept || rk);
  const needsSales =
    rk === 'sales_staff' ||
    SALES_DESK_DEPARTMENT_LABELS.has(rawDept) ||
    deptRole === 'sales_staff';
  if (!needsSales) return;
  for (const p of SALES_DESK_PERMISSION_KEYS) {
    if (!permissions.includes(p)) permissions.push(p);
  }
}

export function userHasPermission(user, permission) {
  if (!user || !permission) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : permissionsForRole(user.roleKey);
  return perms.includes('*') || perms.includes(permission);
}

/** Roles allowed to open management reports (`/reports`, `/api/reports/*`). */
export const MANAGEMENT_REPORTS_VIEWER_ROLE_KEYS = new Set([
  'admin',
  'md',
  'ceo',
  'sales_manager',
  'finance_manager',
]);

/**
 * Branch manager, MD, CEO, finance manager, or administrator. Custom `permissions_json` cannot bypass role for these reports.
 */
export function userMayViewManagementReports(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || '').trim().toLowerCase();
  if (!MANAGEMENT_REPORTS_VIEWER_ROLE_KEYS.has(rk)) return false;
  return userHasPermission(user, 'reports.view');
}

export function canUseAllBranchesRollup(user) {
  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  return roleKey === 'admin' || roleKey === 'md' || roleKey === 'ceo';
}

/** Only these roles may PATCH without a prior second-party approval token. */
const EDIT_MUTATION_EXEMPT_ROLE_KEYS = new Set(['admin', 'md']);

/** Who may approve another user's edit request (two-person control). */
const EDIT_APPROVER_ROLE_KEYS = new Set([
  'admin',
  'md',
  'sales_manager',
  'finance_manager',
  'operations_officer',
]);

/** @param {object|null|undefined} user */
export function editMutationRequiresSecondApproval(user) {
  if (!user) return true;
  const rk = String(user.roleKey || '').trim().toLowerCase();
  return !EDIT_MUTATION_EXEMPT_ROLE_KEYS.has(rk);
}

/** @param {object|null|undefined} user */
export function userCanApproveEditMutations(user) {
  if (!user) return false;
  const rk = normalizeRoleKey(user.roleKey);
  if (EDIT_APPROVER_ROLE_KEYS.has(rk)) return true;
  return userHasPermission(user, 'quotations.manage');
}

/** Administrator, managing director, or branch manager (`sales_manager`; `branch_manager` reserved). */
const COIL_LOT_MASTER_EDIT_ROLE_KEYS = new Set([
  'admin',
  'md',
  'sales_manager',
  'branch_manager',
  'operations_officer',
]);

/** @param {object|null|undefined} user */
export function userMayEditCoilLotMasterData(user) {
  if (!user) return false;
  const rk = normalizeRoleKey(user.roleKey);
  return COIL_LOT_MASTER_EDIT_ROLE_KEYS.has(rk);
}

export function publicUserFromRow(row) {
  if (!row) return null;
  const roleKey = normalizeRoleKey(row.role_key ?? row.roleKey);
  const emailRaw = row.email ?? null;
  const avatarRaw = row.avatar_url ?? row.avatarUrl ?? null;
  const storedDepartment = String(row.department ?? row.role_key ?? roleKey ?? '')
    .trim()
    .toLowerCase();
  const department = normalizeWorkspaceDepartment(storedDepartment || roleKey);
  let permissions = permissionsForRole(roleKey);
  const pJson = row.permissions_json ?? row.permissionsJson;
  if (pJson && String(pJson).trim()) {
    try {
      const parsed = JSON.parse(pJson);
      permissions = mergeRoleAndCustomPermissions(roleKey, parsed);
    } catch {
      /* fallback to role default */
    }
  }
  ensureStoreFloorPermissions(permissions, { roleKey, department: storedDepartment });
  ensureSalesDeskPermissions(permissions, { roleKey, department: storedDepartment });
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.displayName ?? row.username,
    email: emailRaw && String(emailRaw).trim() ? String(emailRaw).trim().toLowerCase() : null,
    avatarUrl: avatarRaw && String(avatarRaw).trim() ? String(avatarRaw).trim() : null,
    roleKey,
    roleLabel: roleLabel(roleKey),
    department,
    status: row.status ?? 'active',
    lastLoginAtISO: row.last_login_at_iso ?? row.lastLoginAtISO ?? '',
    createdAtISO: row.created_at_iso ?? row.createdAtISO ?? '',
    mustChangePassword: readMustChangePassword(row),
    trainingCompleted: readTrainingCompleted(row),
    usernameChangeCount: Number(row.username_change_count) || 0,
    canChangeUsernameFreely: (Number(row.username_change_count) || 0) < 1,
    permissions,
  };
}

export function buildSessionPayload(user) {
  if (!user) {
    return { authenticated: false, user: null, permissions: [] };
  }
  const normalized = publicUserFromRow(user);
  return {
    authenticated: true,
    user: normalized,
    permissions: [...normalized.permissions],
  };
}

export function actorName(actor) {
  return actor?.displayName || actor?.username || actor?.name || 'System';
}

export function actorId(actor) {
  return actor?.id || null;
}

export function seedAuthUsers(db) {
  // Phase 12: default demo accounts are disabled unless ZAREWA_ALLOW_SEEDED_USERS=1 (or NODE_ENV=test).
  if (!allowSeedDefaultUsers()) {
    return;
  }
  const seedMissingFlag =
    process.env.ZAREWA_SEED_MISSING_DEFAULT_USERS === 'true' ||
    process.env.ZAREWA_SEED_MISSING_DEFAULT_USERS === '1';
  const adminRow = db
    .prepare(`SELECT id FROM app_users WHERE lower(trim(username)) = 'admin'`)
    .get();
  if (
    process.env.NODE_ENV === 'production' &&
    adminRow &&
    !seedMissingFlag
  ) {
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
  const hasDept = cols.some((c) => c.name === 'department');
  const hasMustChange = cols.some((c) => c.name === 'must_change_password');
  const findByUsername = db.prepare(`SELECT id FROM app_users WHERE lower(trim(username)) = ?`);
  const ins = hasDept
    ? hasMustChange
      ? db.prepare(
          `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso, must_change_password
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
      : db.prepare(
          `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?)`
        )
    : hasMustChange
      ? db.prepare(
          `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, status, last_login_at_iso, created_at_iso, must_change_password
      ) VALUES (?,?,?,?,?,?,?,?,?)`
        )
      : db.prepare(
          `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, status, last_login_at_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?)`
        );
  const forcePasswordChange = process.env.NODE_ENV !== 'test';
  const createdAtISO = nowIso();
  db.transaction(() => {
    for (const user of DEFAULT_USERS) {
      const existing = findByUsername.get(String(user.username || '').trim().toLowerCase());
      if (existing?.id) continue;
      const dept = normalizeWorkspaceDepartment(user.department);
      const mustChange = forcePasswordChange ? 1 : 0;
      if (hasDept) {
        if (hasMustChange) {
          ins.run(
            user.id,
            user.username,
            user.displayName,
            createPasswordHash(user.password),
            user.roleKey,
            dept,
            'active',
            '',
            createdAtISO,
            mustChange
          );
        } else {
          ins.run(
            user.id,
            user.username,
            user.displayName,
            createPasswordHash(user.password),
            user.roleKey,
            dept,
            'active',
            '',
            createdAtISO
          );
        }
      } else if (hasMustChange) {
        ins.run(
          user.id,
          user.username,
          user.displayName,
          createPasswordHash(user.password),
          user.roleKey,
          'active',
          '',
          createdAtISO,
          mustChange
        );
      } else {
        ins.run(
          user.id,
          user.username,
          user.displayName,
          createPasswordHash(user.password),
          user.roleKey,
          'active',
          '',
          createdAtISO
        );
      }
    }
  })();
}

const DEFAULT_ADMIN_ROW = DEFAULT_USERS.find((u) => u.username === 'admin');

/**
 * Insert or update the built-in admin user so username `admin` can sign in with the default dev password.
 * For local/staging recovery; same production guard as {@link seedAuthUsers}.
 * @param {import('better-sqlite3').Database} db
 */
export function ensureDefaultAdminUser(db) {
  if (!allowSeedDefaultUsers()) {
    return;
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ZAREWA_ALLOW_SEEDED_USERS !== 'true' &&
    process.env.ZAREWA_ALLOW_SEEDED_USERS !== '1'
  ) {
    return;
  }
  if (!DEFAULT_ADMIN_ROW) return;
  const admin = DEFAULT_ADMIN_ROW;
  const hash = createPasswordHash(admin.password);
  const createdAtISO = nowIso();
  const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
  const hasDept = cols.some((c) => c.name === 'department');
  const dept = normalizeWorkspaceDepartment(admin.department);
  const existing = db
    .prepare(`SELECT id FROM app_users WHERE lower(trim(username)) = ?`)
    .get(admin.username.toLowerCase());
  if (existing?.id) {
    if (hasDept) {
      db.prepare(
        `UPDATE app_users SET display_name = ?, password_hash = ?, role_key = ?, department = ?, status = 'active' WHERE id = ?`
      ).run(admin.displayName, hash, admin.roleKey, dept, existing.id);
    } else {
      db.prepare(
        `UPDATE app_users SET display_name = ?, password_hash = ?, role_key = ?, status = 'active' WHERE id = ?`
      ).run(admin.displayName, hash, admin.roleKey, existing.id);
    }
    return;
  }
  if (hasDept) {
    db.prepare(
      `INSERT INTO app_users (
      id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      admin.id,
      admin.username,
      admin.displayName,
      hash,
      admin.roleKey,
      dept,
      'active',
      '',
      createdAtISO
    );
  } else {
    db.prepare(
      `INSERT INTO app_users (
      id, username, display_name, password_hash, role_key, status, last_login_at_iso, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?)`
    ).run(admin.id, admin.username, admin.displayName, hash, admin.roleKey, 'active', '', createdAtISO);
  }
}

/**
 * Create a new login user (HR onboarding, staff import). Does not open a session.
 * @param {import('better-sqlite3').Database} db
 * @param {{ username: string, displayName: string, password: string, roleKey: string }} row
 * @returns {{ ok: true, userId: string } | { ok: false, error: string }}
 */
export function createAppUserRecord(db, row) {
  const username = String(row?.username ?? '')
    .trim()
    .toLowerCase();
  const displayName = String(row?.displayName ?? '').trim();
  const roleKey = String(row?.roleKey ?? '').trim();
  const department = normalizeWorkspaceDepartment(roleKey);
  if (!username) return { ok: false, error: 'Username is required.' };
  if (!displayName) return { ok: false, error: 'Display name is required.' };
  if (!roleKey) return { ok: false, error: 'Role is required.' };
  if (!ROLE_DEFINITIONS[roleKey]) return { ok: false, error: 'Invalid role selection.' };
  const strength = validatePasswordStrength(row?.password);
  if (!strength.ok) return strength;
  if (db.prepare(`SELECT 1 FROM app_users WHERE lower(trim(username)) = ?`).get(username)) {
    return { ok: false, error: 'Username already exists.' };
  }
  const userId = `USR-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const createdAtISO = nowIso();
  const hasDeptCol = appUsersHasColumn(db, 'department');
  const hasOnboarding = appUsersHasColumn(db, 'must_change_password');
  try {
    if (hasDeptCol && hasOnboarding) {
      db.prepare(
        `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso,
        must_change_password, training_completed_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        userId,
        username,
        displayName,
        createPasswordHash(String(row.password)),
        roleKey,
        department,
        'active',
        '',
        createdAtISO,
        1,
        ''
      );
    } else if (hasDeptCol) {
      db.prepare(
        `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        userId,
        username,
        displayName,
        createPasswordHash(String(row.password)),
        roleKey,
        department,
        'active',
        '',
        createdAtISO
      );
    } else {
      db.prepare(
        `INSERT INTO app_users (
        id, username, display_name, password_hash, role_key, status, last_login_at_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        userId,
        username,
        displayName,
        createPasswordHash(String(row.password)),
        roleKey,
        'active',
        '',
        createdAtISO
      );
    }
  } catch (e) {
    if (
      e &&
      (e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        e.code === 'ER_DUP_ENTRY' ||
        e.errno === 1062)
    ) {
      return { ok: false, error: 'Username already exists.' };
    }
    throw e;
  }
  storeRegisteredPassword(db, userId, row.password);
  return { ok: true, userId };
}

function findSessionRow(db, token) {
  return db
    .prepare(
      `       SELECT
         s.session_token,
         s.user_id,
         s.created_at_iso,
         s.last_seen_at_iso,
         s.expires_at_iso,
         s.current_branch_id,
         s.view_all_branches,
         u.id,
         u.username,
         u.display_name,
         u.email,
         u.avatar_url,
         u.role_key,
         u.department,
         u.status,
         u.last_login_at_iso,
         u.created_at_iso,
         u.workspace_branch_id,
         u.must_change_password,
         u.training_completed_at_iso
       FROM user_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.session_token = ?`
    )
    .get(token);
}

function refreshSessionTouch(db, token, expiresAtISO) {
  db.prepare(`UPDATE user_sessions SET last_seen_at_iso = ?, expires_at_iso = ? WHERE session_token = ?`).run(
    nowIso(),
    expiresAtISO,
    token
  );
}

function defaultBranchIdForDb(db) {
  try {
    const r = db
      .prepare(`SELECT id FROM branches WHERE active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1`)
      .get();
    return r?.id || DEFAULT_BRANCH_ID;
  } catch {
    return DEFAULT_BRANCH_ID;
  }
}

/**
 * HQ roles may pick any active branch. Other users stay on their assigned workspace branch when set,
 * otherwise the organisation default branch.
 */
export function userMaySelectSessionWorkspaceBranch(db, user, branchId) {
  const id = String(branchId || '').trim();
  if (!id || !user) return false;
  const br = db.prepare(`SELECT id, active FROM branches WHERE id = ?`).get(id);
  if (!br || Number(br.active) !== 1) return false;
  if (canUseAllBranchesRollup(user)) return true;
  let assigned = '';
  try {
    const ur = db.prepare(`SELECT workspace_branch_id FROM app_users WHERE id = ?`).get(user.id);
    assigned = String(ur?.workspace_branch_id || '').trim();
  } catch {
    /* older DBs */
  }
  if (assigned) return id === assigned;
  return id === defaultBranchIdForDb(db);
}

export function attachAuthContext(db) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    const csrfToken = cookies[CSRF_COOKIE];
    req.sessionToken = token || null;
    req.user = null;
    req.session = buildSessionPayload(null);
    req.workspaceBranchId = DEFAULT_BRANCH_ID;
    req.workspaceViewAll = false;
    req.csrfToken = csrfToken || null;

    if (!token) return next();

    const row = findSessionRow(db, token);
    if (!row || row.status !== 'active') {
      req.sessionToken = null;
      return next();
    }
    const now = nowIso();
    if (row.expires_at_iso && row.expires_at_iso < now) {
      if (sessionTimeoutAuditHook) {
        try {
          sessionTimeoutAuditHook({ user: publicUserFromRow(row), token });
        } catch {
          /* ignore audit hook errors */
        }
      }
      db.prepare(`DELETE FROM user_sessions WHERE session_token = ?`).run(token);
      req.sessionToken = null;
      return next();
    }

    const user = publicUserFromRow(row);
    req.user = user;
    const baseBranch = defaultBranchIdForDb(db);
    let currentBranchId = String(row.current_branch_id || '').trim() || baseBranch;
    const rawViewAll = Number(row.view_all_branches) === 1;
    const viewAllBranches = rawViewAll && canUseAllBranchesRollup(user);

    // Pin normal users to their assigned workspace branch on the user record when set.
    // PATCH /api/session/workspace still persists a chosen branch when allowed by userMaySelectSessionWorkspaceBranch.
    if (!canUseAllBranchesRollup(user)) {
      const assigned = String(row.workspace_branch_id || '').trim();
      if (assigned) {
        const br = db.prepare(`SELECT id, active FROM branches WHERE id = ?`).get(assigned);
        if (br?.id && Number(br.active) === 1) {
          currentBranchId = assigned;
        }
      }
    }

    req.workspaceBranchId = currentBranchId;
    req.workspaceViewAll = viewAllBranches;
    const shouldExtend = requestShouldExtendSession(req);
    const expiresAtISO = shouldExtend
      ? addMinutesToIso(now, sessionTimeoutMinutes())
      : String(row.expires_at_iso || '').trim() || addMinutesToIso(now, sessionTimeoutMinutes());
    req.session = {
      ...buildSessionPayload(user),
      currentBranchId,
      viewAllBranches,
      branches: listBranches(db),
      ...sessionSecurityMeta(expiresAtISO),
    };
    if (shouldExtend) {
      refreshSessionTouch(db, token, expiresAtISO);
      // Re-issue cookies so browser Max-Age slides with the DB inactivity window (not fixed at login).
      setSessionCookie(res, token);
      setCsrfCookie(res, csrfToken || createCsrfToken());
    }
    return next();
  };
}

/**
 * strict (default): good for same-origin or same-site (e.g. app.* + api.* under one registrable domain).
 * lax: slightly looser cross-subdomain behavior; still not for unrelated UI/API domains.
 * none: required when the SPA origin and API origin are different sites; always paired with Secure.
 */
function sessionCookieSameSite() {
  const raw = String(process.env.ZAREWA_COOKIE_SAMESITE || 'strict').trim().toLowerCase();
  if (raw === 'none') return 'None';
  if (raw === 'lax') return 'Lax';
  if (raw === 'strict' || raw === '') return 'Strict';
  console.warn(
    `[zarewa] Invalid ZAREWA_COOKIE_SAMESITE=${JSON.stringify(process.env.ZAREWA_COOKIE_SAMESITE)}; using Strict`
  );
  return 'Strict';
}

function sessionCookieDomainAttr() {
  const raw = String(process.env.ZAREWA_COOKIE_DOMAIN || '').trim();
  if (!raw) return '';
  // Normalize common ".example.com/" input from copy/paste.
  const normalized = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!normalized) return '';
  if (normalized.includes(';') || /\s/.test(normalized)) {
    console.warn(
      `[zarewa] Invalid ZAREWA_COOKIE_DOMAIN=${JSON.stringify(process.env.ZAREWA_COOKIE_DOMAIN)}; ignoring`
    );
    return '';
  }
  return `; Domain=${normalized}`;
}

function sessionCookieFlags() {
  const sameSite = sessionCookieSameSite();
  const domainAttr = sessionCookieDomainAttr();
  if (sameSite === 'None') {
    return `${domainAttr}; SameSite=None; Secure`;
  }
  if (process.env.COOKIE_SECURE === '0' || process.env.COOKIE_SECURE === 'false') {
    return `${domainAttr}; SameSite=${sameSite}`;
  }
  const secure =
    process.env.COOKIE_SECURE === '1' ||
    process.env.COOKIE_SECURE === 'true' ||
    process.env.NODE_ENV === 'production';
  return secure
    ? `${domainAttr}; SameSite=${sameSite}; Secure`
    : `${domainAttr}; SameSite=${sameSite}`;
}

function pushSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, value]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), value]);
  }
}

export function setSessionCookie(res, token) {
  const extra = sessionCookieFlags();
  pushSetCookie(
    res,
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${sessionCookieMaxAgeSeconds()}${extra}`
  );
}

export function clearSessionCookie(res) {
  const extra = sessionCookieFlags();
  pushSetCookie(res, `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0${extra}`);
}

export function setCsrfCookie(res, token = createCsrfToken()) {
  const extra = sessionCookieFlags();
  // Non-HttpOnly on purpose: the SPA must read it and send it back in `X-CSRF-Token`.
  pushSetCookie(
    res,
    `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${sessionCookieMaxAgeSeconds()}${extra}`
  );
}

export function clearCsrfCookie(res) {
  const extra = sessionCookieFlags();
  pushSetCookie(res, `${CSRF_COOKIE}=; Path=/; Max-Age=0${extra}`);
}

/** Opens a cookie-backed session for an active `app_users` row (password already verified if applicable). */
function openSessionForUser(db, row) {
  const sessionToken = createSessionToken();
  const createdAtISO = nowIso();
  const expiresAtISO = addMinutesToIso(createdAtISO, sessionTimeoutMinutes());
  const branchId = defaultBranchIdForDb(db);
  db.transaction(() => {
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(row.id);
    const sessCols = db.prepare(`PRAGMA table_info(user_sessions)`).all();
    const hasBranch = sessCols.some((c) => c.name === 'current_branch_id');
    if (hasBranch) {
      db.prepare(
        `INSERT INTO user_sessions (session_token, user_id, created_at_iso, last_seen_at_iso, expires_at_iso, current_branch_id, view_all_branches)
         VALUES (?,?,?,?,?,?,?)`
      ).run(sessionToken, row.id, createdAtISO, createdAtISO, expiresAtISO, branchId, 0);
    } else {
      db.prepare(
        `INSERT INTO user_sessions (session_token, user_id, created_at_iso, last_seen_at_iso, expires_at_iso)
         VALUES (?,?,?,?,?)`
      ).run(sessionToken, row.id, createdAtISO, createdAtISO, expiresAtISO);
    }
    db.prepare(`UPDATE app_users SET last_login_at_iso = ? WHERE id = ?`).run(createdAtISO, row.id);
  })();

  return {
    ok: true,
    sessionToken,
    session: {
      ...buildSessionPayload({ ...row, last_login_at_iso: createdAtISO }),
      currentBranchId: branchId,
      viewAllBranches: false,
      branches: listBranches(db),
      ...sessionSecurityMeta(expiresAtISO),
    },
  };
}

export function loginWithPassword(db, username, password) {
  const key = String(username || '').trim().toLowerCase();
  const row = db
    .prepare(`SELECT * FROM app_users WHERE lower(trim(username)) = ?`)
    .get(key);
  if (!row || row.status !== 'active') {
    return {
      ok: false,
      error: 'Invalid username or password.',
      code: 'INVALID_CREDENTIALS',
      audits: buildLoginFailureAudits(row, key, { locked: false, attemptCount: null }),
    };
  }

  const lockedUntil = String(row.locked_until_iso ?? '').trim();
  if (lockedUntil && lockedUntil > nowIso()) {
    return {
      ok: false,
      error: `Account locked after too many failed sign-in attempts. Try again after ${new Date(lockedUntil).toLocaleString()}.`,
      code: 'ACCOUNT_LOCKED',
      lockedUntilIso: lockedUntil,
    };
  }
  if (lockedUntil && lockedUntil <= nowIso()) {
    clearAccountLock(db, row.id);
  }

  if (!verifyPassword(password, row.password_hash)) {
    const fresh = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(row.id);
    const fail = recordFailedLoginAttempt(db, fresh || row);
    return {
      ok: false,
      error: fail.locked
        ? `Account locked after ${FAILED_LOGIN_LOCK_THRESHOLD} failed attempts. Try again in ${ACCOUNT_LOCK_MINUTES} minutes.`
        : 'Invalid username or password.',
      code: fail.locked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
      lockedUntilIso: fail.lockedUntilIso,
      audits: buildLoginFailureAudits(fresh || row, key, fail),
    };
  }

  clearAccountLock(db, row.id);
  return openSessionForUser(db, row);
}

export function logoutSession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM user_sessions WHERE session_token = ?`).run(token);
}

/**
 * Admin/MD/HR Admin: set another user’s password and store it for Team & access display.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function adminSetUserPassword(db, actorUser, targetUserId, newPassword) {
  if (!canRevealUserPasswords(actorUser)) {
    return { ok: false, error: 'Only Admin, MD, or HR Admin can set user passwords.' };
  }
  const uid = String(targetUserId || '').trim();
  if (!uid) return { ok: false, error: 'User id is required.' };
  const row = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  const nextPassword = String(newPassword || '');
  const strength = validatePasswordStrength(nextPassword);
  if (!strength.ok) return strength;
  const hash = createPasswordHash(nextPassword);
  if (appUsersHasColumn(db, 'must_change_password')) {
    db.prepare(`UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?`).run(hash, uid);
  } else {
    db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hash, uid);
  }
  storeRegisteredPassword(db, uid, nextPassword);
  db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(uid);
  return { ok: true };
}

export function changePassword(db, userId, currentPassword, newPassword) {
  const row = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId);
  if (!row) return { ok: false, error: 'User not found.' };
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const nextPassword = String(newPassword || '');
  const strength = validatePasswordStrength(nextPassword);
  if (!strength.ok) return strength;
  if (appUsersHasColumn(db, 'must_change_password')) {
    db.prepare(`UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(
      createPasswordHash(nextPassword),
      userId
    );
  } else {
    db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(createPasswordHash(nextPassword), userId);
  }
  const next = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId);
  return { ok: true, user: publicUserFromRow(next) };
}

/**
 * Mark role-based onboarding training as completed for the signed-in user.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function completeUserTraining(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'User id is required.' };
  if (!appUsersHasColumn(db, 'training_completed_at_iso')) {
    return { ok: false, error: 'Training tracking is not available. Restart the server after migration.' };
  }
  const row = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  db.prepare(`UPDATE app_users SET training_completed_at_iso = ? WHERE id = ?`).run(nowIso(), uid);
  const next = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(uid);
  return { ok: true, user: publicUserFromRow(next) };
}

/**
 * Blocks mutating API calls until the user changes a temporary password (GET still allowed).
 */
export function requireActivePassword(req, res, next) {
  if (!req.user?.mustChangePassword) return next();
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const allowed = [
    '/api/session/activity',
    '/api/session/change-password',
    '/api/session/logout',
    '/api/session/complete-training',
  ];
  if (allowed.some((p) => path === p || path.endsWith(p))) return next();
  return res.status(403).json({
    ok: false,
    code: 'PASSWORD_CHANGE_REQUIRED',
    error: 'Change your temporary password before using this action.',
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ displayName?: string; email?: string | null; avatarUrl?: string | null; username?: string | null }} patch
 */
export function updateUserProfile(db, userId, patch) {
  const row = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId);
  if (!row) return { ok: false, error: 'User not found.' };

  let username = row.username;
  if (patch.username !== undefined && patch.username !== null) {
    const nextUsername = String(patch.username).trim().toLowerCase();
    if (nextUsername !== String(row.username || '').trim().toLowerCase()) {
      const changeCount = Number(row.username_change_count) || 0;
      if (changeCount >= 1) {
        return {
          ok: false,
          error: 'Username was already changed once. Submit a profile change request for HR approval.',
          code: 'USERNAME_HR_REQUIRED',
        };
      }
      if (!/^[a-z0-9._-]{3,40}$/.test(nextUsername)) {
        return {
          ok: false,
          error: 'Username must be 3–40 characters (letters, numbers, dot, dash, underscore).',
        };
      }
      const taken = db
        .prepare(`SELECT id FROM app_users WHERE lower(trim(username)) = ? AND id != ?`)
        .get(nextUsername, userId);
      if (taken) return { ok: false, error: 'That username is already taken.' };
      username = nextUsername;
    }
  }

  let displayName = row.display_name;
  if (patch.displayName != null) {
    const d = String(patch.displayName).trim();
    if (d.length < 1 || d.length > 120) {
      return { ok: false, error: 'Display name must be 1–120 characters.' };
    }
    displayName = d;
  }

  let email = row.email ?? null;
  if (patch.email !== undefined) {
    if (patch.email === null || String(patch.email).trim() === '') {
      email = null;
    } else {
      const norm = normalizeEmail(patch.email);
      if (norm === null) return { ok: false, error: 'Invalid email address.' };
      const taken = db
        .prepare(`SELECT id FROM app_users WHERE lower(trim(email)) = ? AND id != ?`)
        .get(norm, userId);
      if (taken) return { ok: false, error: 'That email is already in use.' };
      email = norm;
    }
  }

  let avatarUrl = row.avatar_url ?? null;
  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl === null || String(patch.avatarUrl).trim() === '') {
      avatarUrl = null;
    } else {
      const a = String(patch.avatarUrl).trim();
      if (a.length > MAX_AVATAR_URL_LEN) {
        return { ok: false, error: 'Profile image is too large. Use a smaller image.' };
      }
      if (a.startsWith('data:image/')) {
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(a)) {
          return { ok: false, error: 'Profile image must be PNG, JPEG, or WebP (base64).' };
        }
      } else if (a.startsWith('https://')) {
        if (a.length > 2048) return { ok: false, error: 'Image URL is too long.' };
      } else {
        return { ok: false, error: 'Profile image must be a secure (https) URL or a pasted image.' };
      }
      avatarUrl = a;
    }
  }

  db.prepare(
    `UPDATE app_users SET display_name = ?, email = ?, avatar_url = ?, username = ?, username_change_count = ? WHERE id = ?`
  ).run(
    displayName,
    email,
    avatarUrl,
    username,
    username !== row.username ? 1 : Number(row.username_change_count) || 0,
    userId
  );
  const next = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId);
  return { ok: true, user: publicUserFromRow(next) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actorUser
 * @param {string} targetUserId
 * @param {string} rawDepartment
 */
export function patchAppUserWorkspaceDepartment(db, actorUser, targetUserId, rawDepartment) {
  if (!userHasPermission(actorUser, 'settings.manage') && !userHasPermission(actorUser, '*')) {
    return { ok: false, error: 'You do not have permission to assign workspace departments.' };
  }
  const tid = String(targetUserId || '').trim();
  if (!tid) return { ok: false, error: 'User id is required.' };
  const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
  if (!cols.some((c) => c.name === 'department')) {
    return { ok: false, error: 'Workspace department is not available on this database version.' };
  }
  const row = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'User not found.' };
  const roleKey = row.role_key ?? row.roleKey;
  const department = normalizeWorkspaceDepartment(roleKey);
  db.prepare(`UPDATE app_users SET department = ? WHERE id = ?`).run(department, tid);
  const next = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(tid);
  return { ok: true, user: publicUserFromRow(next) };
}

function findUserByIdentifier(db, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  const lower = id.toLowerCase();
  return db
    .prepare(
      `SELECT * FROM app_users
       WHERE status = 'active'
         AND (lower(username) = ? OR (email IS NOT NULL AND trim(email) != '' AND lower(email) = ?))`
    )
    .get(lower, lower);
}

function issuePasswordResetTokenForUserId(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const row = db.prepare(`SELECT * FROM app_users WHERE id = ? AND status = 'active'`).get(uid);
  if (!row) return null;
  const createdAtISO = nowIso();
  const expiresAtISO = addMinutesToIso(createdAtISO, RESET_TOKEN_TTL_MINUTES);
  db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at_iso IS NULL`).run(row.id);
  const plain = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashResetToken(plain);
  const id = `PRT-${crypto.randomBytes(12).toString('hex')}`;
  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at_iso, expires_at_iso, used_at_iso)
     VALUES (?,?,?,?,?,NULL)`
  ).run(id, row.id, tokenHash, createdAtISO, expiresAtISO);
  if (appUsersHasColumn(db, 'must_change_password')) {
    db.prepare(`UPDATE app_users SET must_change_password = 1 WHERE id = ?`).run(row.id);
  }
  return {
    token: plain,
    expiresAtISO,
    userId: String(row.id || ''),
    username: String(row.username || ''),
    email: String(row.email || ''),
  };
}

/**
 * Creates a reset token. Always returns the same public shape (no user enumeration).
 * @returns {{ ok: true, devResetToken?: string }}
 */
export function requestPasswordReset(db, identifier) {
  const row = findUserByIdentifier(db, identifier);

  if (row && userRequiresInitialPasswordSetup(row)) {
    const issued = issuePasswordResetTokenForUserId(db, row.id);
    const plain = issued?.token || '';

    const expose =
      process.env.NODE_ENV !== 'production' &&
      (process.env.ZAREWA_DEV_RESET_TOKEN === '1' || process.env.ZAREWA_DEV_RESET_TOKEN === 'true');
    if (expose) {
      return { ok: true, devResetToken: plain };
    }
  }

  return { ok: true };
}

/**
 * Admin helper: issue a one-time reset code directly from Team & Access.
 * @returns {{ ok: true, resetToken: string, expiresAtISO: string, identifier: string } | { ok: false, error: string }}
 */
export function issuePasswordResetForAdmin(db, userId) {
  const uid = String(userId || '').trim();
  const row = uid ? db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(uid) : null;
  if (!row || row.status !== 'active') {
    return { ok: false, error: 'Active user not found.' };
  }
  if (!userRequiresInitialPasswordSetup(row)) {
    return {
      ok: false,
      error:
        'Reset codes are only for users still in onboarding (must change password or training not completed). Use Set password in Team & access instead.',
    };
  }
  const issued = issuePasswordResetTokenForUserId(db, row.id);
  if (!issued?.token) {
    return { ok: false, error: 'Active user not found.' };
  }
  const preferredIdentifier = issued.email || issued.username;
  return {
    ok: true,
    resetToken: issued.token,
    expiresAtISO: issued.expiresAtISO,
    identifier: preferredIdentifier,
  };
}

/**
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function completePasswordReset(db, identifier, token, newPassword) {
  const idTrim = String(identifier || '').trim();
  const tokenHash = hashResetToken(String(token || '').trim());
  const matchRow = db
    .prepare(
      `SELECT t.id AS prt_id, u.id AS user_id, u.username, u.email, u.status
       FROM password_reset_tokens t
       JOIN app_users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.used_at_iso IS NULL AND t.expires_at_iso > ?`
    )
    .get(tokenHash, nowIso());
  if (!matchRow || matchRow.status !== 'active') {
    return { ok: false, error: 'Invalid or expired reset link. Request a new reset.' };
  }

  const lower = idTrim.toLowerCase();
  const identOk =
    idTrim &&
    (String(matchRow.username || '').toLowerCase() === lower ||
      (matchRow.email && String(matchRow.email).trim().toLowerCase() === lower));
  if (!identOk) {
    return { ok: false, error: 'Invalid or expired reset link. Request a new reset.' };
  }

  const userRow = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(matchRow.user_id);
  if (!userRequiresInitialPasswordSetup(userRow)) {
    return {
      ok: false,
      error: 'Password reset codes are only for new users. Contact your administrator.',
    };
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) return strength;

  db.transaction(() => {
    if (appUsersHasColumn(db, 'must_change_password')) {
      db.prepare(`UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(
        createPasswordHash(String(newPassword)),
        matchRow.user_id
      );
    } else {
      db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(
        createPasswordHash(String(newPassword)),
        matchRow.user_id
      );
    }
    db.prepare(`UPDATE password_reset_tokens SET used_at_iso = ? WHERE id = ?`).run(nowIso(), matchRow.prt_id);
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(matchRow.user_id);
  })();
  storeRegisteredPassword(db, matchRow.user_id, newPassword);

  return { ok: true };
}

export function requireAuth(req, res, next) {
  /* CORS library may forward OPTIONS when origin is disallowed; never answer preflight with JSON 401. */
  if (String(req.method || '').toUpperCase() === 'OPTIONS') {
    return next();
  }
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
  }

  if (process.env.NODE_ENV === 'test' && process.env.ZAREWA_TEST_ENFORCE_CSRF !== '1') {
    return next();
  }

  // CSRF protection for cookie-authenticated state-changing requests.
  // Double-submit pattern:
  // - server sets a random `zarewa_csrf` cookie on login
  // - frontend must echo it back as `X-CSRF-Token`
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const cookieToken = req.csrfToken || null;
    const headerToken = String(req.headers['x-csrf-token'] || req.headers['X-CSRF-Token'] || '')
      .trim();
    if (!cookieToken || !headerToken || headerToken !== cookieToken) {
      return res.status(403).json({ ok: false, error: 'Invalid CSRF token.', code: 'CSRF_INVALID' });
    }
  }
  return next();
}

export function requirePermission(required) {
  const perms = Array.isArray(required) ? required : [required];
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Sign in required.', code: 'AUTH_REQUIRED' });
    }
    if (perms.some((perm) => userHasPermission(req.user, perm))) {
      return next();
    }
    return res.status(403).json({
      ok: false,
      error: 'You do not have permission for this action.',
      code: 'FORBIDDEN',
    });
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listAllAppUsers(db) {
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT u.*,
          COALESCE(NULLIF(trim(u.workspace_branch_id), ''), p.branch_id) AS hr_branch_id
         FROM app_users u
         LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
         ORDER BY u.username ASC`
      )
      .all();
  } catch {
    rows = db.prepare(`SELECT * FROM app_users ORDER BY username ASC`).all();
  }
  return rows.map((r) => {
    const u = publicUserFromRow(r);
    const bid = String(r.hr_branch_id ?? r.HR_BRANCH_ID ?? '').trim();
    const registeredPassword = resolveRegisteredPasswordDisplay(db, r);
    return { ...u, branchId: bid || null, registeredPassword };
  });
}

const PRIVILEGED_ROLE_KEYS = new Set(['admin', 'md']);

function countOtherPrivilegedActiveAdmins(db, excludeUserId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM app_users WHERE id != ? AND role_key IN ('admin','md') AND status = 'active'`
    )
    .get(excludeUserId);
  return row?.c ?? 0;
}

/** Sorted union of all permission strings declared on roles (for admin UIs). */
export function allKnownPermissionKeys() {
  const s = new Set();
  for (const def of Object.values(ROLE_DEFINITIONS)) {
    for (const p of def.permissions) s.add(p);
  }
  for (const p of HR_PERMISSION_KEYS) s.add(p);
  for (const p of FINANCE_DESK_PERMISSION_KEYS) s.add(p);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} targetUserId
 * @param {string} roleKey
 */
export function updateAppUserRole(db, targetUserId, roleKey) {
  if (!ROLE_DEFINITIONS[roleKey]) {
    return { ok: false, error: 'Invalid role selection.' };
  }
  const current = db.prepare(`SELECT role_key FROM app_users WHERE id = ?`).get(targetUserId);
  if (!current) {
    return { ok: false, error: 'User not found.' };
  }
  const wasPri = PRIVILEGED_ROLE_KEYS.has(current.role_key);
  const willPri = PRIVILEGED_ROLE_KEYS.has(roleKey);
  if (wasPri && !willPri) {
    if (countOtherPrivilegedActiveAdmins(db, targetUserId) < 1) {
      return { ok: false, error: 'Cannot remove the last privileged administrator (admin or managing director role).' };
    }
  }
  db.prepare(`UPDATE app_users SET role_key = ?, permissions_json = NULL, department = ? WHERE id = ?`).run(
    roleKey,
    roleKey,
    targetUserId
  );
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} targetUserId
 * @param {string[]} permissions
 */
/**
 * @param {object | null | undefined} actorUser
 * @param {string[]} permissions
 */
export function validatePermissionGrant(actorUser, permissions) {
  if (!actorUser) {
    return { ok: false, error: 'Not authenticated.' };
  }
  if (!userHasPermission(actorUser, 'settings.manage') && !userHasPermission(actorUser, '*')) {
    return { ok: false, error: 'You do not have permission to change user permissions.' };
  }
  if (!Array.isArray(permissions)) {
    return { ok: false, error: 'Permissions must be an array.' };
  }
  const permRe = /^[a-z][a-z0-9_.-]*$/;
  for (const p of permissions) {
    const s = String(p ?? '').trim();
    if (!s) return { ok: false, error: 'Empty permission entry.' };
    if (s === '*') {
      return { ok: false, error: 'Wildcard * permission cannot be granted via custom overrides.' };
    }
    if (!permRe.test(s)) {
      return { ok: false, error: `Invalid permission format: ${s}` };
    }
    if (!userHasPermission(actorUser, s)) {
      return { ok: false, error: `You cannot grant permission you do not hold: ${s}` };
    }
  }
  return { ok: true };
}

export function updateAppUserPermissions(db, targetUserId, permissions, actorUser = null) {
  const grant = validatePermissionGrant(actorUser, permissions);
  if (!grant.ok) return grant;
  const tid = String(targetUserId || '').trim();
  const actorId = String(actorUser?.id || '').trim();
  if (tid && actorId && tid === actorId) {
    const row = db.prepare(`SELECT role_key, permissions_json FROM app_users WHERE id = ?`).get(tid);
    if (!row) return { ok: false, error: 'User not found.' };
    let currentCustom = [];
    const pJson = row.permissions_json;
    if (pJson && String(pJson).trim()) {
      try {
        const parsed = JSON.parse(pJson);
        if (Array.isArray(parsed)) currentCustom = parsed.map((p) => String(p).trim()).filter(Boolean);
      } catch {
        currentCustom = [];
      }
    }
    const next = permissions.map((p) => String(p).trim()).filter(Boolean);
    const added = next.filter((p) => !currentCustom.includes(p));
    if (added.length > 0) {
      return { ok: false, error: 'You cannot elevate your own permissions.' };
    }
  }
  const json = JSON.stringify(permissions);
  db.prepare(`UPDATE app_users SET permissions_json = ? WHERE id = ?`).run(json, tid);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} targetUserId
 * @param {'active' | 'suspended'} status
 * @param {{ actorUserId?: string }} [opts]
 */
export function updateAppUserStatus(db, targetUserId, status, opts = {}) {
  if (status !== 'active' && status !== 'suspended') {
    return { ok: false, error: 'Invalid status.' };
  }
  const actorUserId = opts.actorUserId;
  if (status === 'suspended' && actorUserId && targetUserId === actorUserId) {
    return { ok: false, error: 'You cannot suspend your own account.' };
  }
  if (status === 'suspended') {
    const u = db.prepare(`SELECT role_key FROM app_users WHERE id = ?`).get(targetUserId);
    if (u && PRIVILEGED_ROLE_KEYS.has(u.role_key)) {
      if (countOtherPrivilegedActiveAdmins(db, targetUserId) < 1) {
        return { ok: false, error: 'Cannot suspend the last active privileged administrator.' };
      }
    }
  }
  db.prepare(`UPDATE app_users SET status = ? WHERE id = ?`).run(status, targetUserId);
  if (status === 'suspended') {
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(targetUserId);
  }
  return { ok: true };
}

/**
 * Permanently remove an app user (sessions first). Requires matching confirmUsername (login name).
 * @param {import('better-sqlite3').Database} db
 * @param {string} targetUserId
 * @param {{ actorUserId?: string; confirmUsername?: string }} [opts]
 */
export function deleteAppUser(db, targetUserId, opts = {}) {
  const tid = String(targetUserId || '').trim();
  const actorUserId = String(opts.actorUserId || '').trim();
  const confirmUsername = String(opts.confirmUsername || '').trim().toLowerCase();
  if (!tid) return { ok: false, error: 'User id required.' };
  if (actorUserId && tid === actorUserId) {
    return { ok: false, error: 'You cannot delete your own account.' };
  }
  const row = db.prepare(`SELECT id, username, role_key, status FROM app_users WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'User not found.' };
  const un = String(row.username || '').trim().toLowerCase();
  if (!confirmUsername || confirmUsername !== un) {
    return {
      ok: false,
      error: 'Confirm by sending confirmUsername matching this user’s login name.',
    };
  }
  const st = String(row.status || '').trim().toLowerCase();
  if (PRIVILEGED_ROLE_KEYS.has(row.role_key) && st === 'active') {
    if (countOtherPrivilegedActiveAdmins(db, tid) < 1) {
      return { ok: false, error: 'Cannot delete the last active privileged administrator.' };
    }
  }
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(tid);
      db.prepare(`DELETE FROM app_users WHERE id = ?`).run(tid);
    })();
  } catch (e) {
    const msg = String(e?.message || e || '');
    const isFk =
      msg.includes('FOREIGN KEY') || msg.toLowerCase().includes('constraint') || msg.includes('SQLITE_CONSTRAINT');
    return {
      ok: false,
      error: isFk
        ? 'This user cannot be deleted while related records still reference them. Remove or reassign those links first, or suspend the account instead.'
        : msg || 'Delete failed.',
    };
  }
  return { ok: true };
}
