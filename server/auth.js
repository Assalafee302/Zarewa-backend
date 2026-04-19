import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { normalizeWorkspaceDepartment } from './departmentRoleTemplates.js';

function appUsersHasEmailColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
    return cols.some((c) => c.name === 'email');
  } catch {
    return false;
  }
}

export const SESSION_COOKIE = 'zarewa_session';
export const CSRF_COOKIE = 'zarewa_csrf';
const SESSION_TTL_HOURS = 12;
const RESET_TOKEN_TTL_MINUTES = 60;
/** Max stored profile image (data URL or https URL). */
export const MAX_AVATAR_URL_LEN = 180_000;
const RESET_TOKEN_BYTES = 32;

export function validatePasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 12) {
    return { ok: false, error: 'Password must be at least 12 characters.' };
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

export const ROLE_DEFINITIONS = {
  admin: {
    label: 'Administrator',
    permissions: ['*'],
  },
  hr_manager: {
    label: 'HR manager',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'hr.directory.view',
      'hr.staff.manage',
      'hr.requests.hr_review',
      'hr.requests.final_approve',
      'hr.requests.gm_approve',
      'hr.branch.endorse_staff',
      'hr.payroll.manage',
      'hr.attendance.upload',
      'hr.loan_maintain',
      'hr.letters.generate',
      'hr.compliance',
    ],
  },
  hr_officer: {
    label: 'HR officer',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'hr.directory.view',
      'hr.requests.hr_review',
      'hr.attendance.upload',
      'hr.letters.generate',
    ],
  },
  md: {
    label: 'Managing Director',
    // MD can view everything and use all-branches rollups, but should not have settings/admin write access by default.
    permissions: [
      'hq.view_all_branches',
      'dashboard.view',
      'office.use',
      'reports.view',
      'sales.view',
      'procurement.view',
      'operations.view',
      'finance.view',
      'audit.view',
      'hr.directory.view',
      'hr.daily_roll.mark',
      // Manager dashboard (/manager): quotation clearance / flags / production override, payment approvals, conversion sign-off; refunds: same gate as branch manager (refunds.approve) plus finance.approve on API
      'quotations.manage',
      'finance.approve',
      'refunds.approve',
      'production.release',
      'hr.payroll.md_approve',
      'pricing.manage',
      'md.price_exception.approve',
      'inter_branch_loan.md_approve',
    ],
  },
  ceo: {
    label: 'Chief Executive Officer',
    // Read-only executive: org aggregates only (see GET /api/exec/summary); no line-level modules.
    permissions: ['hq.view_all_branches', 'exec.dashboard.view', 'dashboard.view', 'office.use'],
  },
  finance_manager: {
    label: 'Finance manager',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'sales.view',
      'procurement.view',
      'operations.view',
      'finance.view',
      'finance.post',
      'finance.approve',
      'finance.pay',
      'finance.reverse',
      'finance.cross_branch_post',
      'treasury.manage',
      'audit.view',
      'period.manage',
      'settings.view',
    ],
  },
  cashier: {
    label: 'Cashier',
    permissions: [
      'dashboard.view',
      'office.use',
      'sales.view',
      'customers.manage',
      'quotations.manage',
      'receipts.post',
      'refunds.request',
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
      'refunds.approve',
      'operations.view',
      'operations.manage',
      'production.manage',
      'production.release',
      'deliveries.manage',
      'inventory.receive',
      'inventory.adjust',
      'finance.approve',
      'hr.directory.view',
      'hr.daily_roll.mark',
      'hr.branch.endorse_staff',
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
      'refunds.request',
      'hr.directory.view',
    ],
  },
  procurement_officer: {
    label: 'Procurement officer',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'procurement.view',
      'procurement.manage',
      'suppliers.manage',
      'purchase_orders.manage',
    ],
  },
  operations_officer: {
    label: 'Operations officer',
    permissions: [
      'dashboard.view',
      'office.use',
      'reports.view',
      'operations.view',
      'operations.manage',
      'inventory.receive',
      'inventory.adjust',
      'production.manage',
      'production.release',
      'deliveries.manage',
    ],
  },
  viewer: {
    label: 'Read only',
    permissions: ['dashboard.view', 'reports.view'],
  },
};

const DEFAULT_USERS = [
  {
    id: 'USR-ADMIN',
    username: 'admin',
    displayName: 'Zarewa Admin',
    roleKey: 'admin',
    department: 'it',
    password: 'Admin@123',
  },
  {
    id: 'USR-HRM',
    username: 'hr.manager',
    displayName: 'HR Manager',
    roleKey: 'hr_manager',
    department: 'hr',
    password: 'HrManager@12345!',
  },
  {
    id: 'USR-HRO',
    username: 'hr.officer',
    displayName: 'HR Officer',
    roleKey: 'hr_officer',
    department: 'hr',
    password: 'HrOfficer@12345!',
  },
  {
    id: 'USR-MD',
    username: 'md',
    displayName: 'Managing Director',
    roleKey: 'md',
    department: 'leadership',
    password: 'Md@1234567890!',
  },
  {
    id: 'USR-CEO',
    username: 'ceo',
    displayName: 'Chief Executive Officer',
    roleKey: 'ceo',
    department: 'leadership',
    password: 'Ceo@1234567890!',
  },
  {
    id: 'USR-FIN',
    username: 'finance.manager',
    displayName: 'Finance Manager',
    roleKey: 'finance_manager',
    department: 'finance',
    password: 'Finance@123',
  },
  {
    id: 'USR-SM',
    username: 'sales.manager',
    displayName: 'Sales Manager',
    roleKey: 'sales_manager',
    department: 'sales',
    password: 'Sales@123',
  },
  {
    id: 'USR-SS',
    username: 'sales.staff',
    displayName: 'Sales Officer',
    roleKey: 'sales_staff',
    department: 'customer',
    password: 'Sales@123',
  },
  {
    id: 'USR-PROC',
    username: 'procurement',
    displayName: 'Procurement Officer',
    roleKey: 'procurement_officer',
    department: 'purchase',
    password: 'Procure@123',
  },
  {
    id: 'USR-OPS',
    username: 'operations',
    displayName: 'Operations Officer',
    roleKey: 'operations_officer',
    department: 'inventory',
    password: 'Ops@123',
  },
  {
    id: 'USR-VIEW',
    username: 'viewer',
    displayName: 'Read-only viewer',
    roleKey: 'viewer',
    department: 'reports',
    password: 'Viewer@123456!',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function addHoursToIso(iso, hours) {
  const dt = new Date(iso);
  dt.setHours(dt.getHours() + hours);
  return dt.toISOString();
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

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function roleLabel(roleKey) {
  return ROLE_DEFINITIONS[roleKey]?.label || roleKey || 'User';
}

export function permissionsForRole(roleKey) {
  return [...(ROLE_DEFINITIONS[roleKey]?.permissions || [])];
}

export function userHasPermission(user, permission) {
  if (!user || !permission) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : permissionsForRole(user.roleKey);
  return perms.includes('*') || perms.includes(permission);
}

export function canUseAllBranchesRollup(user) {
  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  return roleKey === 'admin' || roleKey === 'md' || roleKey === 'ceo';
}

/** Only these roles may PATCH without a prior second-party approval token. */
const EDIT_MUTATION_EXEMPT_ROLE_KEYS = new Set(['admin', 'ceo']);

/** Who may approve another user's edit request (two-person control). */
const EDIT_APPROVER_ROLE_KEYS = new Set([
  'admin',
  'ceo',
  'md',
  'sales_manager',
  'finance_manager',
  'hr_manager',
  'procurement_officer',
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
  const rk = String(user.roleKey || '').trim().toLowerCase();
  if (EDIT_APPROVER_ROLE_KEYS.has(rk)) return true;
  return userHasPermission(user, 'quotations.manage');
}

export function publicUserFromRow(row) {
  if (!row) return null;
  const roleKey = row.role_key ?? row.roleKey;
  const emailRaw = row.email ?? null;
  const avatarRaw = row.avatar_url ?? row.avatarUrl ?? null;
  const department = normalizeWorkspaceDepartment(row.department ?? row.workspace_department);
  let permissions = permissionsForRole(roleKey);
  const pJson = row.permissions_json ?? row.permissionsJson;
  if (pJson && String(pJson).trim()) {
    try {
      const parsed = JSON.parse(pJson);
      if (Array.isArray(parsed)) permissions = parsed;
    } catch {
      /* fallback to role default */
    }
  }
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
  // Prevent re-introducing known credentials in production by default.
  // Enable explicitly for initial staging/testing if needed.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ZAREWA_ALLOW_SEEDED_USERS !== 'true' &&
    process.env.ZAREWA_ALLOW_SEEDED_USERS !== '1'
  ) {
    return;
  }
  const count = db.prepare(`SELECT COUNT(*) AS c FROM app_users`).get().c;
  if (count > 0) return;
  const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
  const hasDept = cols.some((c) => c.name === 'department');
  const ins = hasDept
    ? db.prepare(
        `INSERT INTO app_users (
      id, username, display_name, password_hash, role_key, department, status, last_login_at_iso, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
      )
    : db.prepare(
        `INSERT INTO app_users (
      id, username, display_name, password_hash, role_key, status, last_login_at_iso, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?)`
      );
  const createdAtISO = nowIso();
  db.transaction(() => {
    for (const user of DEFAULT_USERS) {
      const dept = normalizeWorkspaceDepartment(user.department);
      if (hasDept) {
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
  const department = normalizeWorkspaceDepartment(row?.department ?? row?.workspaceDepartment);
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
  const hasDeptCol = db.prepare(`PRAGMA table_info(app_users)`).all().some((c) => c.name === 'department');
  try {
    if (hasDeptCol) {
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
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')) {
      return { ok: false, error: 'Username already exists.' };
    }
    throw e;
  }
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
         u.created_at_iso
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
 * HQ roles may pick any active branch. Other users may only select their HR-assigned branch when set,
 * otherwise the organisation default branch (used when staff have no profile row yet).
 */
export function userMaySelectSessionWorkspaceBranch(db, user, branchId) {
  const id = String(branchId || '').trim();
  if (!id || !user) return false;
  const br = db.prepare(`SELECT id, active FROM branches WHERE id = ?`).get(id);
  if (!br || Number(br.active) !== 1) return false;
  if (canUseAllBranchesRollup(user)) return true;
  let assigned = '';
  try {
    const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(user.id);
    assigned = String(prof?.branch_id || '').trim();
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

    // Pin normal users to their assigned branch (from HR staff profile) when available.
    // PATCH /api/session/workspace still persists a chosen branch when allowed by userMaySelectSessionWorkspaceBranch.
    if (!canUseAllBranchesRollup(user)) {
      try {
        const prof = db
          .prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`)
          .get(user.id);
        const assigned = String(prof?.branch_id || '').trim();
        if (assigned) {
          const br = db.prepare(`SELECT id, active FROM branches WHERE id = ?`).get(assigned);
          if (br?.id && Number(br.active) === 1) {
            currentBranchId = assigned;
          }
        }
      } catch {
        /* If HR tables are absent on older DBs, fall back to session/default branch. */
      }
    }

    req.workspaceBranchId = currentBranchId;
    req.workspaceViewAll = viewAllBranches;
    req.session = {
      ...buildSessionPayload(user),
      currentBranchId,
      viewAllBranches,
      branches: listBranches(db),
    };
    refreshSessionTouch(db, token, addHoursToIso(now, SESSION_TTL_HOURS));
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

function sessionCookieFlags() {
  const sameSite = sessionCookieSameSite();
  if (sameSite === 'None') {
    return '; SameSite=None; Secure';
  }
  if (process.env.COOKIE_SECURE === '0' || process.env.COOKIE_SECURE === 'false') {
    return `; SameSite=${sameSite}`;
  }
  const secure =
    process.env.COOKIE_SECURE === '1' ||
    process.env.COOKIE_SECURE === 'true' ||
    process.env.NODE_ENV === 'production';
  return secure ? `; SameSite=${sameSite}; Secure` : `; SameSite=${sameSite}`;
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
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_HOURS * 60 * 60}${extra}`
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
    `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_HOURS * 60 * 60}${extra}`
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
  const expiresAtISO = addHoursToIso(createdAtISO, SESSION_TTL_HOURS);
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
    },
  };
}

export function loginWithPassword(db, username, password) {
  const key = String(username || '').trim().toLowerCase();
  const row = db
    .prepare(`SELECT * FROM app_users WHERE lower(trim(username)) = ?`)
    .get(key);
  if (!row || row.status !== 'active') {
    return { ok: false, error: 'Invalid username or password.' };
  }
  if (!verifyPassword(password, row.password_hash)) {
    return { ok: false, error: 'Invalid username or password.' };
  }
  return openSessionForUser(db, row);
}

/**
 * Verify a Firebase ID token and open the same cookie session as password login.
 * Links Firebase users to `app_users` by **verified email** (`app_users.email`).
 */
export async function loginWithFirebaseIdToken(db, idToken) {
  const trimmed = String(idToken || '').trim();
  if (!trimmed) {
    return { ok: false, code: 'ID_TOKEN_REQUIRED', error: 'Sign-in token is required.' };
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) {
    return {
      ok: false,
      code: 'FIREBASE_NOT_CONFIGURED',
      error: 'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS on the API server.',
    };
  }

  const { verifyFirebaseIdToken, getFirebaseAdminApp } = await import('./firebaseAdmin.js');
  if (!getFirebaseAdminApp()) {
    return {
      ok: false,
      code: 'FIREBASE_NOT_CONFIGURED',
      error:
        'Firebase Admin could not be initialized. Check FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS (service account JSON path).',
    };
  }

  const decoded = await verifyFirebaseIdToken(trimmed);
  if (!decoded) {
    return { ok: false, error: 'Invalid or expired sign-in. Please try again.' };
  }

  const emailNorm = normalizeEmail(decoded.email);
  if (!emailNorm) {
    return {
      ok: false,
      error: 'Your Firebase account has no usable email. Use username/password or link an email in Firebase.',
    };
  }
  if (decoded.email_verified !== true) {
    return {
      ok: false,
      error: 'Verify your email in Firebase before signing in to Zarewa.',
    };
  }

  if (!appUsersHasEmailColumn(db)) {
    return {
      ok: false,
      error: 'This database has no email column on app_users. Run migrations, then set user emails in Settings.',
    };
  }

  const row = db.prepare(`SELECT * FROM app_users WHERE lower(trim(email)) = ?`).get(emailNorm);
  if (!row) {
    return {
      ok: false,
      error:
        'No Zarewa user matches this email. Ask an administrator to set your account email to the same address as your Google (Firebase) account.',
    };
  }
  if (row.status !== 'active') {
    return { ok: false, error: 'This account is not active.' };
  }

  return openSessionForUser(db, row);
}

export function logoutSession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM user_sessions WHERE session_token = ?`).run(token);
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
  db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(createPasswordHash(nextPassword), userId);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ displayName?: string; email?: string | null; avatarUrl?: string | null }} patch
 */
export function updateUserProfile(db, userId, patch) {
  const row = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(userId);
  if (!row) return { ok: false, error: 'User not found.' };

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

  db.prepare(`UPDATE app_users SET display_name = ?, email = ?, avatar_url = ? WHERE id = ?`).run(
    displayName,
    email,
    avatarUrl,
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
  if (!userHasPermission(actorUser, 'settings.view') && !userHasPermission(actorUser, '*')) {
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
  const department = normalizeWorkspaceDepartment(rawDepartment);
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

/**
 * Creates a reset token. Always returns the same public shape (no user enumeration).
 * @returns {{ ok: true, devResetToken?: string }}
 */
export function requestPasswordReset(db, identifier) {
  const row = findUserByIdentifier(db, identifier);
  const createdAtISO = nowIso();
  const expiresAtISO = addMinutesToIso(createdAtISO, RESET_TOKEN_TTL_MINUTES);

  if (row) {
    db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at_iso IS NULL`).run(row.id);
    const plain = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
    const tokenHash = hashResetToken(plain);
    const id = `PRT-${crypto.randomBytes(12).toString('hex')}`;
    db.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at_iso, expires_at_iso, used_at_iso)
       VALUES (?,?,?,?,?,NULL)`
    ).run(id, row.id, tokenHash, createdAtISO, expiresAtISO);

    const expose =
      process.env.NODE_ENV !== 'production' &&
      (process.env.ZAREWA_DEV_RESET_TOKEN === '1' || process.env.ZAREWA_DEV_RESET_TOKEN === 'true');
    if (expose) {
      return { ok: true, devResetToken: plain };
    }
  }

  return { ok: true };
}

function addMinutesToIso(iso, minutes) {
  const dt = new Date(iso);
  dt.setMinutes(dt.getMinutes() + minutes);
  return dt.toISOString();
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

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) return strength;

  db.transaction(() => {
    db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(
      createPasswordHash(String(newPassword)),
      matchRow.user_id
    );
    db.prepare(`UPDATE password_reset_tokens SET used_at_iso = ? WHERE id = ?`).run(nowIso(), matchRow.prt_id);
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(matchRow.user_id);
  })();

  return { ok: true };
}

export function requireAuth(req, res, next) {
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
  const rows = db.prepare(`SELECT * FROM app_users ORDER BY username ASC`).all();
  return rows.map((r) => publicUserFromRow(r));
}

const PRIVILEGED_ROLE_KEYS = new Set(['admin', 'ceo']);

function countOtherPrivilegedActiveAdmins(db, excludeUserId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM app_users WHERE id != ? AND role_key IN ('admin','ceo') AND status = 'active'`
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
      return { ok: false, error: 'Cannot remove the last privileged administrator (admin or CEO role).' };
    }
  }
  db.prepare(`UPDATE app_users SET role_key = ?, permissions_json = NULL WHERE id = ?`).run(
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
export function updateAppUserPermissions(db, targetUserId, permissions) {
  if (!Array.isArray(permissions)) {
    return { ok: false, error: 'Permissions must be an array.' };
  }
  const permRe = /^(\*|[a-z][a-z0-9_.-]*)$/;
  for (const p of permissions) {
    const s = String(p ?? '').trim();
    if (!s) return { ok: false, error: 'Empty permission entry.' };
    if (!permRe.test(s)) {
      return { ok: false, error: `Invalid permission format: ${s}` };
    }
  }
  const json = JSON.stringify(permissions);
  db.prepare(`UPDATE app_users SET permissions_json = ? WHERE id = ?`).run(json, targetUserId);
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
