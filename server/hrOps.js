import crypto from 'node:crypto';
import { canUseAllBranchesRollup, createAppUserRecord, roleLabel, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  annualLeaveEntitlementDaysForUser,
  countWorkingDaysInclusive,
  getHrPolicyPayload,
  isApprovedLeaveOnDay,
  validateStaffLoanApplication,
} from './hrBusinessRules.js';
import { provisionStaffLoanForFinanceQueue } from './writeOps.js';

const REQUEST_KINDS = new Set([
  'leave',
  'loan',
  'attendance_exception',
  'retirement',
  'appeal',
  'profile_change',
  'bonus',
  'training',
  'promotion',
  'welfare',
  'other',
]);

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(10).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function yyyymmFromIso(iso) {
  return String(iso || '').slice(0, 7).replace('-', '');
}

function diffDays(fromIso, toIso) {
  const a = Date.parse(String(fromIso || '').slice(0, 10));
  const b = Date.parse(String(toIso || '').slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function normalizeToken(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

const SPECIAL_ORG_NODES = new Set(['mining_div', 'scholarship', 'chairman_staffs']);

function normalizeOrgNode(rawDepartment) {
  const token = normalizeToken(rawDepartment);
  if (!token) return null;
  if (token.includes('mining')) return 'mining_div';
  if (token.includes('scholar')) return 'scholarship';
  if (token.includes('chairman')) return 'chairman_staffs';
  return null;
}

function normalizeEmploymentType(rawEmploymentType) {
  const t = normalizeToken(rawEmploymentType);
  if (!t) return 'unknown';
  if (t.includes('permanent') || t.includes('full')) return 'permanent';
  if (t.includes('contract') || t.includes('temp')) return 'contract';
  if (t.includes('intern') || t.includes('siwes')) return 'intern';
  if (t.includes('casual') || t.includes('daily')) return 'casual';
  return 'other';
}

function roleFamilyFromJob(rawJob, rawDept) {
  const t = `${normalizeToken(rawJob)} ${normalizeToken(rawDept)}`.trim();
  if (!t) return 'general';
  if (t.includes('finance') || t.includes('account') || t.includes('treasury')) return 'finance';
  if (t.includes('hr') || t.includes('human resource') || t.includes('talent')) return 'hr';
  if (t.includes('sales') || t.includes('marketing') || t.includes('customer')) return 'commercial';
  if (t.includes('procurement') || t.includes('purchase') || t.includes('supply')) return 'procurement';
  if (t.includes('production') || t.includes('machine') || t.includes('operator') || t.includes('operations')) return 'operations';
  if (t.includes('it') || t.includes('tech') || t.includes('software') || t.includes('data')) return 'technology';
  if (t.includes('security')) return 'security';
  if (t.includes('driver') || t.includes('transport') || t.includes('logistics')) return 'logistics';
  if (t.includes('admin') || t.includes('secretary') || t.includes('office')) return 'administration';
  return 'general';
}

function deriveGradeBand(rawPromotionGrade, salaryNgn) {
  const g = String(rawPromotionGrade || '').trim();
  if (g) return g.toUpperCase();
  const amount = Math.round(Number(salaryNgn) || 0);
  if (amount >= 900000) return 'G7';
  if (amount >= 700000) return 'G6';
  if (amount >= 500000) return 'G5';
  if (amount >= 350000) return 'G4';
  if (amount >= 220000) return 'G3';
  if (amount >= 130000) return 'G2';
  if (amount > 0) return 'G1';
  return 'UNSET';
}

function deriveSeniority(rawJobTitle, salaryNgn) {
  const t = normalizeToken(rawJobTitle);
  if (t.includes('head') || t.includes('chief') || t.includes('director') || t.includes('manager')) return 'leadership';
  if (t.includes('senior') || t.includes('supervisor')) return 'senior';
  if (t.includes('intern') || t.includes('trainee')) return 'entry';
  const amount = Math.round(Number(salaryNgn) || 0);
  if (amount >= 500000) return 'senior';
  if (amount > 0) return 'mid';
  return 'unknown';
}

function branchAliasCanonical(rawBranchId) {
  const t = normalizeToken(rawBranchId);
  if (!t) return null;
  if (t.includes('kad')) return 'BR-KD';
  if (t.includes('abuja') || t.includes('fct')) return 'BR-ABJ';
  if (t.includes('jos')) return 'BR-JOS';
  if (t.includes('kano')) return 'BR-KAN';
  if (t.includes('yol')) return 'BR-YL';
  if (t.includes('jalingo')) return 'DEPRECATED-JALINGO';
  if (/^br-[a-z0-9]+$/i.test(String(rawBranchId || '').trim())) return String(rawBranchId || '').trim().toUpperCase();
  return null;
}

function buildStaffDerived(row, complianceByUserId = new Map()) {
  const normalizedBranchId = branchAliasCanonical(row.branchId);
  const orgNode = normalizeOrgNode(row.department);
  const employmentTypeNorm = normalizeEmploymentType(row.employmentType);
  const roleFamily = roleFamilyFromJob(row.jobTitle, row.department);
  const gradeBand = deriveGradeBand(row.promotionGrade, row.baseSalaryNgn);
  const seniority = deriveSeniority(row.jobTitle, row.baseSalaryNgn);
  const qualityFlags = {
    needsBranchMapping: !normalizedBranchId || normalizedBranchId === 'DEPRECATED-JALINGO',
    needsUnitMapping: !orgNode && !String(row.department || '').trim(),
    invalidCategory: employmentTypeNorm === 'unknown' || employmentTypeNorm === 'other',
  };
  const criticalMissing = [];
  if (!String(row.employeeNo || '').trim()) criticalMissing.push('employeeNo');
  if (!String(row.dateJoinedIso || '').trim()) criticalMissing.push('dateJoinedIso');
  if (!String(row.jobTitle || '').trim()) criticalMissing.push('jobTitle');
  if (!String(row.department || '').trim()) criticalMissing.push('department');
  if (!String(row.branchId || '').trim()) criticalMissing.push('branchId');
  const compliance = complianceByUserId.get(row.userId) || null;
  const complianceBadges = {
    handbookAcknowledged: Boolean(compliance?.handbookAcknowledged),
    profileComplete: criticalMissing.length === 0,
    overdueReview: Boolean(compliance?.overdueReview),
  };
  return {
    normalized: {
      branchId: normalizedBranchId,
      orgNode: orgNode || 'branch_ops',
      taxonomy: {
        employmentType: employmentTypeNorm,
        roleFamily,
        gradeBand,
        seniority,
        status: row.status === 'active' ? 'active' : 'inactive',
      },
    },
    sourceValues: {
      branchId: row.branchId || null,
      department: row.department || null,
      employmentType: row.employmentType || null,
      promotionGrade: row.promotionGrade || null,
    },
    qualityFlags,
    complianceBadges,
    dataQualityScore: 100 - (Object.values(qualityFlags).filter(Boolean).length * 20 + criticalMissing.length * 8),
    criticalMissing,
  };
}

export function appendHrAuditEvent(db, event = {}) {
  if (!hrTablesReady(db)) return;
  const id = newId('HRAUD');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_audit_events (
      id, occurred_at_iso, actor_user_id, actor_display_name, action, entity_kind, entity_id, branch_id, reason, details_json, correlation_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    now,
    event.actorUserId || null,
    event.actorDisplayName || null,
    String(event.action || 'hr.event'),
    String(event.entityKind || 'hr'),
    event.entityId || null,
    event.branchId || null,
    event.reason || null,
    event.details != null ? JSON.stringify(event.details) : null,
    event.correlationId || null
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function hrTablesReady(db) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_profiles'`).get()
  );
}

/**
 * @param {{ user: object; workspaceBranchId?: string; workspaceViewAll?: boolean }} req
 */
export function hrListScope(req) {
  const viewAll = Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user);
  const branchId = String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
  return { viewAll, branchId };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string; includeUnassigned?: boolean }} scope
 * @param {{ includeInactive?: boolean }} [opts]
 */
export function listHrStaff(db, scope, opts = {}) {
  if (!hrTablesReady(db)) return [];
  const { viewAll, branchId, includeUnassigned } = scope;
  const includeInactive = Boolean(opts.includeInactive);

  let sql = `
    SELECT u.id AS userId, u.username, u.display_name AS displayName, u.email, u.role_key AS roleKey, u.status,
           p.branch_id AS branchId, p.employee_no AS employeeNo, p.job_title AS jobTitle, p.department,
           p.employment_type AS employmentType, p.date_joined_iso AS dateJoinedIso,
           p.probation_end_iso AS probationEndIso,
           p.base_salary_ngn AS baseSalaryNgn, p.housing_allowance_ngn AS housingAllowanceNgn,
           p.transport_allowance_ngn AS transportAllowanceNgn, p.minimum_qualification AS minimumQualification,
           p.academic_qualification AS academicQualification,
           p.promotion_grade AS promotionGrade, p.welfare_notes AS welfareNotes, p.training_summary AS trainingSummary,
           p.tax_id AS taxId, p.pension_rsa_pin AS pensionRsaPin, p.bank_name AS bankName,
           p.bank_account_name AS bankAccountName, p.bank_account_no_masked AS bankAccountNoMasked,
           p.bonus_accrual_note AS bonusAccrualNote,
           p.paye_tax_percent AS payeTaxPercent,
           p.pension_percent_override AS pensionPercentOverride,
           p.self_service_eligible AS selfServiceEligible,
           p.next_of_kin_json AS nextOfKinJson,
           p.profile_extra_json AS profileExtraJson,
           p.line_manager_user_id AS lineManagerUserId,
           p.leave_entitlement_band AS leaveEntitlementBand
    FROM app_users u
    LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
    WHERE 1=1
  `;
  const args = [];
  if (!includeInactive) {
    sql += ` AND u.status = 'active'`;
  }
  if (!viewAll) {
    if (includeUnassigned) {
      sql += ` AND (p.branch_id = ? OR p.branch_id IS NULL)`;
      args.push(branchId);
    } else {
      sql += ` AND p.branch_id = ?`;
      args.push(branchId);
    }
  }
  sql += ` ORDER BY u.display_name ASC`;

  const rows = db.prepare(sql).all(...args);
  const ackRows = db
    .prepare(
      `SELECT user_id, MAX(accepted_at_iso) AS accepted_at_iso
       FROM hr_policy_acknowledgements
       WHERE policy_key = 'employee_handbook'
       GROUP BY user_id`
    )
    .all();
  const ackByUserId = new Map(ackRows.map((r) => [String(r.user_id), String(r.accepted_at_iso || '')]));
  const overdueRows = listHrRequests(db, scope, {}).filter((r) => r.slaState === 'overdue');
  const overdueByUser = new Set(overdueRows.map((r) => String(r.userId)));
  const complianceByUserId = new Map(
    rows.map((r) => [
      String(r.userId),
      {
        handbookAcknowledged: Boolean(ackByUserId.get(String(r.userId))),
        overdueReview: overdueByUser.has(String(r.userId)),
      },
    ])
  );
  return rows.map((row) => ({
    ...row,
    selfServiceEligible: Boolean(Number(row.selfServiceEligible)),
    nextOfKin: safeJsonParse(row.nextOfKinJson, null),
    nextOfKinJson: undefined,
    profileExtra: safeJsonParse(row.profileExtraJson, {}),
    profileExtraJson: undefined,
    ...buildStaffDerived(row, complianceByUserId),
  }));
}

export function listHrCompensationInsights(db, scope, opts = {}) {
  const canViewSensitiveHr = Boolean(opts?.canViewSensitiveHr);
  const staff = listHrStaff(db, scope, { includeInactive: false }).filter((s) => Number(s.baseSalaryNgn) > 0);
  const salaries = staff.map((s) => Number(s.baseSalaryNgn) || 0).sort((a, b) => a - b);
  const percentile = (p) => {
    if (!salaries.length) return 0;
    const idx = Math.max(0, Math.min(salaries.length - 1, Math.floor((p / 100) * (salaries.length - 1))));
    return salaries[idx];
  };
  const median = percentile(50);
  const p90 = percentile(90);
  const p10 = percentile(10);
  const byBranchGrade = new Map();
  for (const s of staff) {
    const key = `${s.normalized?.branchId || 'UNMAPPED'}::${s.normalized?.taxonomy?.gradeBand || 'UNSET'}`;
    if (!byBranchGrade.has(key)) byBranchGrade.set(key, []);
    byBranchGrade.get(key).push(Number(s.baseSalaryNgn) || 0);
  }
  const branchGradeVariance = Array.from(byBranchGrade.entries()).map(([k, vals]) => {
    const [branchId, gradeBand] = k.split('::');
    const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    return { branchId, gradeBand, count: vals.length, averageBaseSalaryNgn: Math.round(avg) };
  });
  const outliers = staff
    .filter((s) => Number(s.baseSalaryNgn) > p90 || Number(s.baseSalaryNgn) < p10)
    .slice(0, 80)
    .map((s) => ({
      userId: s.userId,
      displayName: s.displayName,
      baseSalaryNgn: canViewSensitiveHr ? s.baseSalaryNgn : null,
      salaryBucket: canViewSensitiveHr ? null : s.normalized?.taxonomy?.gradeBand || 'UNSET',
      gradeBand: s.normalized?.taxonomy?.gradeBand || 'UNSET',
      branchId: s.normalized?.branchId || s.branchId || 'UNMAPPED',
      qualityFlags: s.qualityFlags,
    }));
  return {
    summary: {
      headcount: staff.length,
      medianBaseSalaryNgn: Math.round(median),
      p10BaseSalaryNgn: Math.round(p10),
      p90BaseSalaryNgn: Math.round(p90),
      spreadNgn: Math.max(0, Math.round(p90 - p10)),
      qualityIssues: staff.filter((s) => Object.values(s.qualityFlags || {}).some(Boolean)).length,
    },
    branchGradeVariance,
    outliers,
  };
}

export function listHrDataCleanupQueue(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: true });
  return staff
    .filter(
      (s) =>
        s.criticalMissing?.length ||
        Object.values(s.qualityFlags || {}).some(Boolean) ||
        Number(s.dataQualityScore || 0) < 80
    )
    .map((s) => ({
      userId: s.userId,
      displayName: s.displayName,
      branchId: s.branchId,
      normalizedBranchId: s.normalized?.branchId || null,
      orgNode: s.normalized?.orgNode || null,
      qualityFlags: s.qualityFlags,
      criticalMissing: s.criticalMissing,
      dataQualityScore: s.dataQualityScore,
      payrollImpact: Math.round(Number(s.baseSalaryNgn) || 0),
      suggestedActions: [
        s.qualityFlags?.needsBranchMapping ? 'map_branch_alias' : null,
        s.qualityFlags?.needsUnitMapping ? 'map_org_node' : null,
        s.qualityFlags?.invalidCategory ? 'normalize_employment_type' : null,
      ].filter(Boolean),
    }))
    .sort((a, b) => (b.payrollImpact || 0) - (a.payrollImpact || 0));
}

export function applyHrDataCleanupAction(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body.userId || '').trim();
  const action = String(body.action || '').trim();
  if (!userId || !action) return { ok: false, error: 'userId and action are required.' };
  const row = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!row) return { ok: false, error: 'Staff profile not found.' };
  const extra = safeJsonParse(row.profile_extra_json, {});
  const now = nowIso();
  if (action === 'map_branch_alias') {
    const target = String(body.targetValue || '').trim();
    if (!target) return { ok: false, error: 'targetValue required for map_branch_alias.' };
    db.prepare(`UPDATE hr_staff_profiles SET branch_id = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`).run(
      target,
      now,
      actor?.id || null,
      userId
    );
  } else if (action === 'map_org_node') {
    const target = String(body.targetValue || '').trim();
    if (!target) return { ok: false, error: 'targetValue required for map_org_node.' };
    if (!SPECIAL_ORG_NODES.has(target) && target !== 'branch_ops') {
      return { ok: false, error: 'Invalid org node target.' };
    }
    extra.manualOrgNode = target;
    db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`).run(
      JSON.stringify(extra),
      now,
      actor?.id || null,
      userId
    );
  } else if (action === 'normalize_employment_type') {
    const target = String(body.targetValue || '').trim();
    if (!target) return { ok: false, error: 'targetValue required for normalize_employment_type.' };
    db.prepare(
      `UPDATE hr_staff_profiles SET employment_type = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`
    ).run(target, now, actor?.id || null, userId);
  } else {
    return { ok: false, error: 'Unsupported cleanup action.' };
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.cleanup.resolve',
    entityKind: 'hr_staff_profile',
    entityId: userId,
    details: { action, targetValue: body.targetValue || null },
  });
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function getHrStaffOne(db, userId) {
  if (!hrTablesReady(db)) return null;
  const list = listHrStaff(
    db,
    { viewAll: true, branchId: DEFAULT_BRANCH_ID, includeUnassigned: true },
    { includeInactive: true }
  );
  return list.find((s) => s.userId === userId) ?? null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string; includeUnassigned?: boolean }} scope
 * @param {{ includeInactive?: boolean }} listOpts
 */
export function listRecentDisciplinaryEvents(db, scope, listOpts = {}) {
  if (!hrTablesReady(db)) return [];
  const staff = listHrStaff(db, scope, listOpts);
  const out = [];
  for (const s of staff) {
    const ev = s.profileExtra?.disciplinaryEvents;
    if (!Array.isArray(ev)) continue;
    for (const e of ev) {
      out.push({
        ...e,
        staffUserId: s.userId,
        staffDisplayName: s.displayName,
        staffEmployeeNo: s.employeeNo,
      });
    }
  }
  out.sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')));
  return out.slice(0, 150);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ kind?: string; dateIso?: string; summary?: string }} body
 * @param {string} actorUserId
 */
export function appendHrDisciplinaryEvent(db, userId, body, actorUserId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!row) return { ok: false, error: 'No HR employee file for this user.' };
  const extra = safeJsonParse(row.profile_extra_json, {});
  const events = Array.isArray(extra.disciplinaryEvents) ? extra.disciplinaryEvents : [];
  const kind = String(body?.kind || 'warning').trim();
  const summary = String(body?.summary || '').trim();
  if (summary.length < 3) return { ok: false, error: 'Summary must be at least 3 characters.' };
  const dateIso = String(body?.dateIso || '').trim().slice(0, 10) || nowIso().slice(0, 10);
  events.unshift({
    id: newId('HRD'),
    kind,
    dateIso,
    summary,
    recordedByUserId: actorUserId,
    createdAtIso: nowIso(),
  });
  extra.disciplinaryEvents = events;
  const now = nowIso();
  db.prepare(
    `UPDATE hr_staff_profiles SET profile_extra_json = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`
  ).run(JSON.stringify(extra), now, actorUserId, userId);
  return { ok: true, events };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {object} body
 */
export function upsertHrStaffProfile(db, actorUserId, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const u = db.prepare(`SELECT id FROM app_users WHERE id = ? AND status = 'active'`).get(userId);
  if (!u) return { ok: false, error: 'User not found or inactive.' };

  const branchId = String(body?.branchId || '').trim() || DEFAULT_BRANCH_ID;
  const now = nowIso();
  const existing = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const prevRow = existing ? db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId) : null;
  const prevExtraRow =
    existing &&
    body?.profileExtra === undefined &&
    db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(userId);

  const lineManagerUserId =
    body?.lineManagerUserId !== undefined
      ? String(body.lineManagerUserId || '').trim() || null
      : prevRow?.line_manager_user_id ?? null;
  const leaveEntitlementBand =
    body?.leaveEntitlementBand !== undefined
      ? String(body.leaveEntitlementBand || '').trim().toLowerCase() || null
      : prevRow?.leave_entitlement_band ?? null;

  let selfServiceEligible = 0;
  if (body?.selfServiceEligible !== undefined && body?.selfServiceEligible !== null) {
    selfServiceEligible =
      body.selfServiceEligible === true ||
      body.selfServiceEligible === 1 ||
      body.selfServiceEligible === '1'
        ? 1
        : 0;
  } else if (existing) {
    const prev = db.prepare(`SELECT self_service_eligible FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
    selfServiceEligible = Number(prev?.self_service_eligible) ? 1 : 0;
  }

  const nullableNonNegNumber = (v) => {
    if (v === undefined || v === null) return null;
    if (v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  };

  const row = {
    user_id: userId,
    branch_id: branchId,
    employee_no: String(body?.employeeNo ?? '').trim() || null,
    job_title: String(body?.jobTitle ?? '').trim() || null,
    department: String(body?.department ?? '').trim() || null,
    employment_type: String(body?.employmentType ?? '').trim() || null,
    date_joined_iso: String(body?.dateJoinedIso ?? '').trim() || null,
    probation_end_iso: String(body?.probationEndIso ?? '').trim() || null,
    bank_account_name: String(body?.bankAccountName ?? '').trim() || null,
    bank_name: String(body?.bankName ?? '').trim() || null,
    bank_account_no_masked: String(body?.bankAccountNoMasked ?? '').trim() || null,
    tax_id: String(body?.taxId ?? '').trim() || null,
    pension_rsa_pin: String(body?.pensionRsaPin ?? '').trim() || null,
    next_of_kin_json: body?.nextOfKin != null ? JSON.stringify(body.nextOfKin) : null,
    base_salary_ngn: Math.max(0, Math.round(Number(body?.baseSalaryNgn) || 0)),
    housing_allowance_ngn: Math.max(0, Math.round(Number(body?.housingAllowanceNgn) || 0)),
    transport_allowance_ngn: Math.max(0, Math.round(Number(body?.transportAllowanceNgn) || 0)),
    bonus_accrual_note: String(body?.bonusAccrualNote ?? '').trim() || null,
    minimum_qualification: String(body?.minimumQualification ?? '').trim() || null,
    academic_qualification: String(body?.academicQualification ?? '').trim() || null,
    promotion_grade: String(body?.promotionGrade ?? '').trim() || null,
    welfare_notes: String(body?.welfareNotes ?? '').trim() || null,
    training_summary: String(body?.trainingSummary ?? '').trim() || null,
    paye_tax_percent: nullableNonNegNumber(body?.payeTaxPercent),
    pension_percent_override: nullableNonNegNumber(body?.pensionPercentOverride),
    profile_extra_json:
      body?.profileExtra != null
        ? JSON.stringify(body.profileExtra)
        : prevExtraRow
          ? prevExtraRow.profile_extra_json
          : null,
    updated_at_iso: now,
    updated_by_user_id: actorUserId,
    self_service_eligible: selfServiceEligible,
    line_manager_user_id: lineManagerUserId,
    leave_entitlement_band: leaveEntitlementBand,
  };

  if (existing) {
    const prevBranchId = prevRow?.branch_id ? String(prevRow.branch_id) : null;
    db.prepare(
      `UPDATE hr_staff_profiles SET
        branch_id=@branch_id, employee_no=@employee_no, job_title=@job_title, department=@department,
        employment_type=@employment_type, date_joined_iso=@date_joined_iso, probation_end_iso=@probation_end_iso,
        bank_account_name=@bank_account_name, bank_name=@bank_name, bank_account_no_masked=@bank_account_no_masked,
        tax_id=@tax_id, pension_rsa_pin=@pension_rsa_pin, next_of_kin_json=@next_of_kin_json,
        base_salary_ngn=@base_salary_ngn, housing_allowance_ngn=@housing_allowance_ngn,
        transport_allowance_ngn=@transport_allowance_ngn, bonus_accrual_note=@bonus_accrual_note,
        minimum_qualification=@minimum_qualification, academic_qualification=@academic_qualification,
        promotion_grade=@promotion_grade,
        welfare_notes=@welfare_notes, training_summary=@training_summary,
        paye_tax_percent=@paye_tax_percent, pension_percent_override=@pension_percent_override,
        profile_extra_json=@profile_extra_json,
        self_service_eligible=@self_service_eligible,
        line_manager_user_id=@line_manager_user_id, leave_entitlement_band=@leave_entitlement_band,
        updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
      WHERE user_id=@user_id`
    ).run(row);
    if (prevBranchId && branchId && prevBranchId !== branchId) {
      try {
        const hid = newId('HRBH');
        db.prepare(
          `INSERT INTO hr_staff_branch_history (
            id, user_id, from_branch_id, to_branch_id, effective_from_iso, reason, actor_user_id, created_at_iso
          ) VALUES (?,?,?,?,?,?,?,?)`
        ).run(
          hid,
          userId,
          prevBranchId,
          branchId,
          now.slice(0, 10),
          String(body?.branchChangeReason ?? '').trim() || null,
          actorUserId,
          now
        );
        appendHrAuditEvent(db, {
          actorUserId: actorUserId,
          action: 'hr.staff.branch_change',
          entityKind: 'hr_staff_profile',
          entityId: userId,
          branchId,
          details: { fromBranchId: prevBranchId, toBranchId: branchId },
        });
      } catch {
        /* hr_staff_branch_history may be missing on very old DBs */
      }
    }
  } else {
    db.prepare(
      `INSERT INTO hr_staff_profiles (
        user_id, branch_id, employee_no, job_title, department, employment_type, date_joined_iso, probation_end_iso,
        bank_account_name, bank_name, bank_account_no_masked, tax_id, pension_rsa_pin, next_of_kin_json,
        base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, bonus_accrual_note,
        minimum_qualification, academic_qualification, promotion_grade, welfare_notes, training_summary,
        paye_tax_percent, pension_percent_override, profile_extra_json, self_service_eligible,
        line_manager_user_id, leave_entitlement_band,
        updated_at_iso, updated_by_user_id
      ) VALUES (
        @user_id, @branch_id, @employee_no, @job_title, @department, @employment_type, @date_joined_iso, @probation_end_iso,
        @bank_account_name, @bank_name, @bank_account_no_masked, @tax_id, @pension_rsa_pin, @next_of_kin_json,
        @base_salary_ngn, @housing_allowance_ngn, @transport_allowance_ngn, @bonus_accrual_note,
        @minimum_qualification, @academic_qualification, @promotion_grade, @welfare_notes, @training_summary,
        @paye_tax_percent, @pension_percent_override, @profile_extra_json, @self_service_eligible,
        @line_manager_user_id, @leave_entitlement_band,
        @updated_at_iso, @updated_by_user_id
      )`
    ).run(row);
  }
  return { ok: true, profile: getHrStaffOne(db, userId) };
}

/**
 * Bonus / welfare narrative on file (partial update — does not touch other profile columns).
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {string} userId
 * @param {string | null | undefined} note
 */
export function patchHrStaffBonusAccrualNote(db, actorUserId, userId, note) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId is required.' };
  const exists = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(uid);
  if (!exists) return { ok: false, error: 'No HR employee file for this user.' };
  const now = nowIso();
  const v = note == null ? null : String(note).trim() || null;
  db.prepare(
    `UPDATE hr_staff_profiles SET bonus_accrual_note = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`
  ).run(v, now, actorUserId, uid);
  return { ok: true, profile: getHrStaffOne(db, uid) };
}

/**
 * Reference tax/pension (from payroll runs) + approved staff loans for welfare planning.
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 */
export function salaryWelfareSnapshot(db, scope) {
  if (!hrTablesReady(db)) {
    return {
      ok: true,
      referenceRun: null,
      taxPercent: 7.5,
      pensionPercent: 8,
      approvedLoans: [],
    };
  }

  const draftRun = db
    .prepare(
      `SELECT id, period_yyyymm, tax_percent, pension_percent, status, notes, created_at_iso
       FROM hr_payroll_runs WHERE status = 'draft' ORDER BY created_at_iso DESC LIMIT 1`
    )
    .get();
  const latestRun =
    draftRun ||
    db
      .prepare(
        `SELECT id, period_yyyymm, tax_percent, pension_percent, status, notes, created_at_iso
         FROM hr_payroll_runs ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get();

  const taxPercent =
    latestRun != null && Number(latestRun.tax_percent) >= 0 ? Number(latestRun.tax_percent) : 7.5;
  const pensionPercent =
    latestRun != null && Number(latestRun.pension_percent) >= 0 ? Number(latestRun.pension_percent) : 8;

  const referenceRun = latestRun
    ? {
        id: latestRun.id,
        periodYyyymm: latestRun.period_yyyymm,
        status: latestRun.status,
        taxPercent: Number(latestRun.tax_percent),
        pensionPercent: Number(latestRun.pension_percent),
        notes: latestRun.notes,
        createdAtIso: latestRun.created_at_iso,
        isDraft: latestRun.status === 'draft',
      }
    : null;

  let sql = `
    SELECT r.id, r.user_id, r.title, r.payload_json, r.branch_id,
           COALESCE(r.manager_reviewed_at_iso, r.hr_reviewed_at_iso, r.created_at_iso) AS decided_at_iso,
           u.display_name AS staffDisplayName, u.username AS staffUsername,
           p.employee_no AS employeeNo
    FROM hr_requests r
    JOIN app_users u ON u.id = r.user_id
    LEFT JOIN hr_staff_profiles p ON p.user_id = r.user_id
    WHERE r.kind = 'loan' AND r.status = 'approved'`;
  const args = [];
  if (!scope.viewAll) {
    sql += ` AND r.branch_id = ?`;
    args.push(scope.branchId);
  }
  sql += ` ORDER BY decided_at_iso DESC LIMIT 200`;

  const rows = db.prepare(sql).all(...args);
  const approvedLoans = rows.map((row) => {
    const payload = safeJsonParse(row.payload_json, {});
    const disbursed = Boolean(payload.loanDisbursedAtIso);
    const monthsTotal = Math.round(Number(payload.repaymentMonths) || 0);
    const monthsDone = Math.round(Number(payload.loanMonthsDeducted) || 0);
    const principalOut = Number.isFinite(Number(payload.principalOutstandingNgn))
      ? Math.max(0, Math.round(Number(payload.principalOutstandingNgn)))
      : null;
    const deductionsActive = Boolean(
      payload.deductionsActive &&
        disbursed &&
        (monthsTotal <= 0 || monthsDone < monthsTotal) &&
        (principalOut === null || principalOut > 0)
    );
    const repaymentMonthsRemaining =
      monthsTotal > 0 ? Math.max(0, monthsTotal - monthsDone) : null;
    return {
      requestId: row.id,
      userId: row.user_id,
      title: row.title,
      staffDisplayName: row.staffDisplayName,
      staffUsername: row.staffUsername,
      employeeNo: row.employeeNo,
      branchId: row.branch_id,
      amountNgn: Math.round(Number(payload.amountNgn) || 0),
      repaymentMonths: monthsTotal,
      deductionPerMonthNgn: Math.round(Number(payload.deductionPerMonthNgn) || 0),
      loanMonthsDeducted: monthsDone,
      repaymentMonthsRemaining,
      principalOutstandingNgn: principalOut,
      decidedAtIso: row.decided_at_iso,
      loanDisbursedAtIso: payload.loanDisbursedAtIso || null,
      loanRepaidByScheduleAtIso: payload.loanRepaidByScheduleAtIso || null,
      loanRepaidByPrincipalAtIso: payload.loanRepaidByPrincipalAtIso || null,
      loanClosedEarlyAtIso: payload.loanClosedEarlyAtIso || null,
      deductionsActive,
      pendingDisbursement: !disbursed,
      financePaymentRequestId: payload.financePaymentRequestId || null,
      disbursementQueueStatus: payload.disbursementQueueStatus || null,
      financeRejectionNote: payload.financeRejectionNote || null,
    };
  });

  return { ok: true, referenceRun, taxPercent, pensionPercent, approvedLoans };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string; canManage: boolean }} scope
 * @param {{ status?: string; userId?: string }} filter
 */
const HR_REQUEST_SEARCH_MAX = 200;

export function listHrRequests(db, scope, filter = {}) {
  if (!hrTablesReady(db)) return [];
  let sql = `
    SELECT r.*, u.display_name AS staffDisplayName, u.username AS staffUsername
    FROM hr_requests r
    JOIN app_users u ON u.id = r.user_id
    WHERE 1=1
  `;
  const args = [];
  if (!scope.viewAll) {
    sql += ` AND r.branch_id = ?`;
    args.push(scope.branchId);
  }
  if (filter.status) {
    sql += ` AND r.status = ?`;
    args.push(filter.status);
  }
  if (filter.userId) {
    sql += ` AND r.user_id = ?`;
    args.push(filter.userId);
  }
  if (filter.kind) {
    sql += ` AND r.kind = ?`;
    args.push(String(filter.kind).trim());
  }
  const rawSearch = String(filter.search || '').trim();
  if (rawSearch) {
    const clipped = rawSearch.slice(0, HR_REQUEST_SEARCH_MAX);
    const esc = clipped.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${esc}%`;
    sql += ` AND (
      r.title LIKE ? ESCAPE '\\' OR IFNULL(r.body, '') LIKE ? ESCAPE '\\'
      OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
    )`;
    args.push(term, term, term, term);
  }
  sql += ` ORDER BY r.created_at_iso DESC`;
  const todayIso = nowIso().slice(0, 10);
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      branchId: row.branch_id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      body: row.body,
      payload: safeJsonParse(row.payload_json, {}),
      submittedAtIso: row.submitted_at_iso,
      hrReviewerUserId: row.hr_reviewer_user_id,
      hrReviewerNote: row.hr_reviewer_note,
      hrReviewedAtIso: row.hr_reviewed_at_iso,
      managerReviewerUserId: row.manager_reviewer_user_id,
      managerNote: row.manager_note,
      managerReviewedAtIso: row.manager_reviewed_at_iso,
      gmHrReviewerUserId: row.gm_hr_reviewer_user_id ?? null,
      gmHrReviewerNote: row.gm_hr_reviewer_note ?? null,
      gmHrReviewedAtIso: row.gm_hr_reviewed_at_iso ?? null,
      createdAtIso: row.created_at_iso,
      staffDisplayName: row.staffDisplayName,
      staffUsername: row.staffUsername,
      nextStepLabel:
        row.status === 'hr_review'
          ? 'HR_officer_review'
          : row.status === 'branch_manager_review'
            ? 'Branch_manager_endorse'
            : row.status === 'gm_hr_review'
              ? 'GM_HR_final'
              : null,
      slaState:
        row.status === 'hr_review' ||
        row.status === 'branch_manager_review' ||
        row.status === 'gm_hr_review'
          ? diffDays(row.submitted_at_iso || row.created_at_iso, todayIso) > 2
            ? 'overdue'
            : 'on_track'
          : 'n/a',
      daysOpen:
        row.status === 'hr_review' ||
        row.status === 'branch_manager_review' ||
        row.status === 'gm_hr_review'
          ? Math.max(0, diffDays(row.submitted_at_iso || row.created_at_iso, todayIso))
          : 0,
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {object} body
 */
export function createHrRequest(db, userId, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const kind = String(body?.kind || '').trim();
  if (!REQUEST_KINDS.has(kind)) return { ok: false, error: 'Invalid request kind.' };
  const title = String(body?.title || '').trim();
  if (title.length < 2) return { ok: false, error: 'Title is required.' };
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const branchId = prof?.branch_id || DEFAULT_BRANCH_ID;
  const id = newId('HRR');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_requests (
      id, user_id, branch_id, kind, status, title, body, payload_json, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    branchId,
    kind,
    'draft',
    title,
    String(body?.body ?? '').trim() || null,
    body?.payload != null ? JSON.stringify(body.payload) : null,
    now
  );
  if (kind === 'leave') {
    const p = body?.payload || {};
    db.prepare(
      `INSERT OR REPLACE INTO hr_request_leave (
        request_id, leave_type, start_date_iso, end_date_iso, days_requested, handover_to, contact_during_leave
      ) VALUES (?,?,?,?,?,?,?)`
    ).run(
      id,
      String(p.leaveType || '').trim() || null,
      String(p.startDateIso || p.startDate || '').trim() || null,
      String(p.endDateIso || p.endDate || '').trim() || null,
      Number(p.daysRequested) || null,
      String(p.handoverTo || '').trim() || null,
      String(p.contactDuringLeave || '').trim() || null
    );
  } else if (kind === 'loan') {
    const p = body?.payload || {};
    const amountNgn = Math.round(Number(p.amountNgn) || 0);
    const repaymentMonths = Math.round(Number(p.repaymentMonths) || 0);
    const deductionPerMonthNgn = Math.round(Number(p.deductionPerMonthNgn) || 0);
    if (amountNgn <= 0) return { ok: false, error: 'Loan amount must be greater than 0.' };
    const policy = getHrPolicyPayload(db);
    if (repaymentMonths < 1 || repaymentMonths > policy.loanMaxRepaymentMonths) {
      return {
        ok: false,
        error: `repaymentMonths must be between 1 and ${policy.loanMaxRepaymentMonths}.`,
      };
    }
    if (deductionPerMonthNgn <= 0) return { ok: false, error: 'deductionPerMonthNgn must be greater than 0.' };
    const minDeduction = Math.ceil(amountNgn / repaymentMonths);
    if (deductionPerMonthNgn < minDeduction) {
      return { ok: false, error: `deductionPerMonthNgn too low for repaymentMonths (min ${minDeduction}).` };
    }
    const loanVal = validateStaffLoanApplication(db, userId, { amountNgn, repaymentMonths });
    if (!loanVal.ok) {
      return { ok: false, error: loanVal.error || 'Loan does not meet policy.' };
    }
    db.prepare(
      `INSERT OR REPLACE INTO hr_request_loan (
        request_id, amount_ngn, repayment_months, deduction_per_month_ngn, purpose
      ) VALUES (?,?,?,?,?)`
    ).run(
      id,
      amountNgn,
      repaymentMonths,
      deductionPerMonthNgn,
      String(p.purpose || '').trim() || null
    );
  }
  appendHrAuditEvent(db, {
    actorUserId: userId,
    action: 'hr.request.create',
    entityKind: 'hr_request',
    entityId: id,
    branchId,
    details: { kind },
  });
  const reqRow = listHrRequests(db, { viewAll: true, branchId: DEFAULT_BRANCH_ID }, {}).find((r) => r.id === id);
  return { ok: true, request: reqRow };
}

export function submitHrRequest(db, requestId, userId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row || row.user_id !== userId) return { ok: false, error: 'Request not found.' };
  if (row.status !== 'draft') return { ok: false, error: 'Only draft requests can be submitted.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_requests SET status = 'hr_review', submitted_at_iso = ? WHERE id = ?`
  ).run(now, requestId);
  appendHrAuditEvent(db, {
    actorUserId: userId,
    action: 'hr.request.submit',
    entityKind: 'hr_request',
    entityId: requestId,
    branchId: row.branch_id,
  });
  return { ok: true };
}

export function hrReviewRequest(db, requestId, actor, approve, note) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (row.status !== 'hr_review') {
    return { ok: false, error: 'Request is not awaiting HR review.' };
  }
  const HR_DECISION_REASON_CODES = new Set([
    'documentation',
    'policy',
    'attendance',
    'performance',
    'finance',
    'other',
  ]);
  const rc = String(arguments[5] ?? '') // reasonCode (back-compat: optional)
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, '_')
    .slice(0, 40);
  const noteNorm = String(note || '').trim();
  if (!HR_DECISION_REASON_CODES.has(rc)) {
    return { ok: false, error: 'reasonCode is required for HR decisions.' };
  }
  if (noteNorm.length < 3) {
    return { ok: false, error: 'note is required for HR decisions.' };
  }
  const now = nowIso();
  if (!approve) {
    db.prepare(
      `UPDATE hr_requests SET status = 'rejected', hr_reviewer_user_id = ?, hr_reviewer_note = ?, hr_reviewed_at_iso = ? WHERE id = ?`
    ).run(actor.id, noteNorm || null, now, requestId);
    appendHrAuditEvent(db, {
      actorUserId: actor.id,
      actorDisplayName: actor.displayName || actor.username || '',
      action: 'hr.request.hr_reject',
      entityKind: 'hr_request',
      entityId: requestId,
      branchId: row.branch_id,
      reason: noteNorm || null,
      details: { kind: row.kind, decision: 'reject', reasonCode: rc },
    });
    return { ok: true };
  }
  db.prepare(
    `UPDATE hr_requests SET status = 'branch_manager_review', hr_reviewer_user_id = ?, hr_reviewer_note = ?, hr_reviewed_at_iso = ? WHERE id = ?`
  ).run(actor.id, noteNorm || null, now, requestId);
  appendHrAuditEvent(db, {
    actorUserId: actor.id,
    actorDisplayName: actor.displayName || actor.username || '',
    action: 'hr.request.hr_approve',
    entityKind: 'hr_request',
    entityId: requestId,
    branchId: row.branch_id,
    reason: noteNorm || null,
    details: { kind: row.kind, decision: 'approve', reasonCode: rc },
  });
  return { ok: true };
}

const DECISION_REASON_CODES = new Set([
  'documentation',
  'policy',
  'attendance',
  'performance',
  'finance',
  'other',
]);

function normalizeReasonCode(arg5) {
  return String(arg5 ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, '_')
    .slice(0, 40);
}

/**
 * Branch manager endorses request after HR cleared it (same branch scope).
 */
export function branchManagerEndorseRequest(db, requestId, actor, approve, note, reasonCode) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (row.status !== 'branch_manager_review') {
    return { ok: false, error: 'Request is not awaiting branch manager endorsement.' };
  }
  const rc = normalizeReasonCode(reasonCode);
  const noteNorm = String(note || '').trim();
  if (!DECISION_REASON_CODES.has(rc)) {
    return { ok: false, error: 'reasonCode is required for branch endorsement.' };
  }
  if (noteNorm.length < 3) {
    return { ok: false, error: 'note is required for branch endorsement.' };
  }
  const now = nowIso();
  if (!approve) {
    db.prepare(
      `UPDATE hr_requests SET status = 'rejected', manager_reviewer_user_id = ?, manager_note = ?, manager_reviewed_at_iso = ? WHERE id = ?`
    ).run(actor.id, noteNorm || null, now, requestId);
    appendHrAuditEvent(db, {
      actorUserId: actor.id,
      actorDisplayName: actor.displayName || actor.username || '',
      action: 'hr.request.branch_endorse_reject',
      entityKind: 'hr_request',
      entityId: requestId,
      branchId: row.branch_id,
      reason: noteNorm || null,
      details: { kind: row.kind, decision: 'reject', reasonCode: rc },
    });
    return { ok: true };
  }
  db.prepare(
    `UPDATE hr_requests SET status = 'gm_hr_review', manager_reviewer_user_id = ?, manager_note = ?, manager_reviewed_at_iso = ? WHERE id = ?`
  ).run(actor.id, noteNorm || null, now, requestId);
  appendHrAuditEvent(db, {
    actorUserId: actor.id,
    actorDisplayName: actor.displayName || actor.username || '',
    action: 'hr.request.branch_endorse_approve',
    entityKind: 'hr_request',
    entityId: requestId,
    branchId: row.branch_id,
    reason: noteNorm || null,
    details: { kind: row.kind, decision: 'approve', reasonCode: rc },
  });
  return { ok: true };
}

/**
 * GM HR (or legacy final approver) gives final approval; loans provision to finance here.
 */
export function gmHrReviewRequest(db, requestId, actor, approve, note, reasonCode) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (row.status !== 'gm_hr_review') {
    return { ok: false, error: 'Request is not awaiting GM HR approval.' };
  }
  const rc = normalizeReasonCode(reasonCode);
  const noteNorm = String(note || '').trim();
  if (!DECISION_REASON_CODES.has(rc)) {
    return { ok: false, error: 'reasonCode is required for GM HR decisions.' };
  }
  if (noteNorm.length < 3) {
    return { ok: false, error: 'note is required for GM HR decisions.' };
  }
  const now = nowIso();
  if (!approve) {
    db.prepare(
      `UPDATE hr_requests SET status = 'rejected', gm_hr_reviewer_user_id = ?, gm_hr_reviewer_note = ?, gm_hr_reviewed_at_iso = ? WHERE id = ?`
    ).run(actor.id, noteNorm || null, now, requestId);
    appendHrAuditEvent(db, {
      actorUserId: actor.id,
      actorDisplayName: actor.displayName || actor.username || '',
      action: 'hr.request.gm_hr_reject',
      entityKind: 'hr_request',
      entityId: requestId,
      branchId: row.branch_id,
      reason: noteNorm || null,
      details: { kind: row.kind, decision: 'reject', reasonCode: rc },
    });
    return { ok: true };
  }
  const isLoan = String(row.kind) === 'loan';
  if (isLoan) {
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE hr_requests SET status = 'approved', gm_hr_reviewer_user_id = ?, gm_hr_reviewer_note = ?, gm_hr_reviewed_at_iso = ? WHERE id = ?`
        ).run(actor.id, noteNorm || null, now, requestId);
        const refreshed = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
        const prov = provisionStaffLoanForFinanceQueue(db, actor, refreshed);
        if (!prov.ok) throw new Error(prov.error);
      })();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    appendHrAuditEvent(db, {
      actorUserId: actor.id,
      actorDisplayName: actor.displayName || actor.username || '',
      action: 'hr.request.gm_hr_approve',
      entityKind: 'hr_request',
      entityId: requestId,
      branchId: row.branch_id,
      reason: noteNorm || null,
      details: { kind: row.kind, financeProvisioned: true, decision: 'approve', reasonCode: rc },
    });
    return { ok: true };
  }
  db.prepare(
    `UPDATE hr_requests SET status = 'approved', gm_hr_reviewer_user_id = ?, gm_hr_reviewer_note = ?, gm_hr_reviewed_at_iso = ? WHERE id = ?`
  ).run(actor.id, noteNorm || null, now, requestId);
  appendHrAuditEvent(db, {
    actorUserId: actor.id,
    actorDisplayName: actor.displayName || actor.username || '',
    action: 'hr.request.gm_hr_approve',
    entityKind: 'hr_request',
    entityId: requestId,
    branchId: row.branch_id,
    reason: noteNorm || null,
    details: { kind: row.kind, decision: 'approve', reasonCode: rc },
  });
  return { ok: true };
}

/**
 * Back-compat: routes to branch endorsement or GM HR step from current status.
 */
export function managerReviewRequest(db, requestId, actor, approve, note) {
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  const rc = arguments[5];
  if (row.status === 'branch_manager_review') {
    return branchManagerEndorseRequest(db, requestId, actor, approve, note, rc);
  }
  if (row.status === 'gm_hr_review') {
    return gmHrReviewRequest(db, requestId, actor, approve, note, rc);
  }
  return { ok: false, error: 'Request is not awaiting branch manager or GM HR approval.' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ branchId: string; periodYyyymm: string; notes?: string; rows: object[] }} body
 */
export function uploadHrAttendance(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const branchId = String(body?.branchId || '').trim();
  const periodYyyymm = String(body?.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(periodYyyymm)) return { ok: false, error: 'periodYyyymm must be YYYYMM (e.g. 202603).' };
  if (!branchId) return { ok: false, error: 'branchId is required.' };
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length === 0) return { ok: false, error: 'rows must be a non-empty array.' };
  const branchUsers = new Set(
    db
      .prepare(`SELECT user_id FROM hr_staff_profiles WHERE branch_id = ?`)
      .all(branchId)
      .map((x) => String(x.user_id))
  );
  const invalidUserRows = rows.filter((r) => !branchUsers.has(String(r?.userId || '').trim()));
  if (invalidUserRows.length) {
    return { ok: false, error: `Attendance rows contain user(s) outside branch ${branchId}.` };
  }
  const id = newId('HRA');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_attendance_uploads (id, branch_id, period_yyyymm, uploaded_by_user_id, notes, rows_json, created_at_iso)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    id,
    branchId,
    periodYyyymm,
    actor.id,
    String(body?.notes ?? '').trim() || null,
    JSON.stringify(rows),
    now
  );
  const eventIns = db.prepare(
    `INSERT INTO hr_attendance_events (
      id, user_id, branch_id, event_date_iso, status, minutes_late, source_kind, source_id, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const monthDate = `${periodYyyymm.slice(0, 4)}-${periodYyyymm.slice(4)}-01`;
  for (const row of rows) {
    eventIns.run(
      newId('HRAE'),
      String(row.userId),
      branchId,
      monthDate,
      Number(row.absentDays) > 0 ? 'ABSENT_REPORTED' : 'PRESENT_REPORTED',
      Math.max(0, Math.round(Number(row.minutesLate) || 0)),
      'upload',
      id,
      now,
      actor.id
    );
  }
  appendHrAuditEvent(db, {
    actorUserId: actor.id,
    actorDisplayName: actor.displayName || actor.username || '',
    action: 'hr.attendance.upload',
    entityKind: 'hr_attendance_upload',
    entityId: id,
    branchId,
    details: { periodYyyymm, rows: rows.length },
  });
  return { ok: true, id };
}

export function listHrAttendance(db, scope) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_attendance_uploads WHERE 1=1`;
  const args = [];
  if (!scope.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(scope.branchId);
  }
  sql += ` ORDER BY created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    periodYyyymm: row.period_yyyymm,
    uploadedByUserId: row.uploaded_by_user_id,
    notes: row.notes,
    rows: safeJsonParse(row.rows_json, []),
    createdAtIso: row.created_at_iso,
  }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 */
export function getHrDailyRollCall(db, scope, branchId, dayIso) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const bid = String(branchId || '').trim();
  const day = String(dayIso || '').trim().slice(0, 10);
  if (!bid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: 'branchId and dayIso (YYYY-MM-DD) are required.' };
  }
  if (!scope.viewAll && String(scope.branchId || '') !== bid) {
    return { ok: false, error: 'Branch not in scope.' };
  }
  const row = db.prepare(`SELECT * FROM hr_daily_roll_calls WHERE branch_id = ? AND day_iso = ?`).get(bid, day);
  if (!row) return { ok: true, roll: null };
  return {
    ok: true,
    roll: {
      id: row.id,
      branchId: row.branch_id,
      dayIso: row.day_iso,
      rows: safeJsonParse(row.rows_json, []),
      notes: row.notes,
      createdAtIso: row.created_at_iso,
      updatedAtIso: row.updated_at_iso,
    },
  };
}

/**
 * Branch managers mark present / late per staff for a calendar day. Late days add to payroll attendance deduction (same daily rate as absent).
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {{ branchId: string; dayIso: string; rows: { userId: string; status?: string }[]; notes?: string }} body
 */
export function upsertHrDailyRollCall(db, actor, scope, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const branchId = String(body?.branchId || '').trim();
  const dayIso = String(body?.dayIso || '').trim().slice(0, 10);
  if (!branchId || !/^\d{4}-\d{2}-\d{2}$/.test(dayIso)) {
    return { ok: false, error: 'branchId and dayIso (YYYY-MM-DD) are required.' };
  }
  if (!scope.viewAll && String(scope.branchId || '') !== branchId) {
    return { ok: false, error: 'Branch not in scope.' };
  }
  const rawRows = Array.isArray(body?.rows) ? body.rows : [];
  const rowsNorm = rawRows
    .map((r) => ({
      userId: String(r?.userId || '').trim(),
      status: String(r?.status || 'present').toLowerCase() === 'late' ? 'late' : 'present',
    }))
    .filter((r) => r.userId);
  if (rowsNorm.length === 0) return { ok: false, error: 'rows must include at least one staff member.' };
  const branchUsers = new Set(
    db
      .prepare(`SELECT user_id FROM hr_staff_profiles WHERE branch_id = ?`)
      .all(branchId)
      .map((x) => String(x.user_id))
  );
  const outsiders = rowsNorm.filter((r) => !branchUsers.has(r.userId));
  if (outsiders.length) {
    return { ok: false, error: `Daily roll includes user(s) not assigned to branch ${branchId}.` };
  }
  const existing = db
    .prepare(`SELECT id, created_at_iso FROM hr_daily_roll_calls WHERE branch_id = ? AND day_iso = ?`)
    .get(branchId, dayIso);
  const now = nowIso();
  const id = existing?.id || newId('HRROLL');
  const createdAt = existing?.created_at_iso || now;
  const notes = String(body?.notes ?? '').trim() || null;
  if (existing) {
    db.prepare(
      `UPDATE hr_daily_roll_calls SET rows_json = ?, updated_at_iso = ?, recorded_by_user_id = ?, notes = ? WHERE id = ?`
    ).run(JSON.stringify(rowsNorm), now, actor.id, notes, id);
  } else {
    db.prepare(
      `INSERT INTO hr_daily_roll_calls (
        id, branch_id, day_iso, recorded_by_user_id, notes, rows_json, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, branchId, dayIso, actor.id, notes, JSON.stringify(rowsNorm), createdAt, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor.id,
    actorDisplayName: actor.displayName || actor.username || '',
    action: 'hr.daily_roll.upsert',
    entityKind: 'hr_daily_roll_call',
    entityId: id,
    branchId,
    details: { dayIso, rows: rowsNorm.length },
  });
  return { ok: true, id };
}

export function recomputeHrLeaveBalances(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const periodYyyymm = String(body.periodYyyymm || yyyymmFromIso(nowIso()) || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(periodYyyymm)) return { ok: false, error: 'periodYyyymm must be YYYYMM.' };
  const leaveType = String(body.leaveType || 'annual').trim().toLowerCase();
  const explicitAccrual =
    body?.accrualPerMonthDays !== undefined &&
    body?.accrualPerMonthDays !== null &&
    String(body.accrualPerMonthDays).trim() !== '';
  const users = db.prepare(`SELECT user_id, branch_id FROM hr_staff_profiles`).all();
  const adjustedExistingRows = db
    .prepare(
      `SELECT user_id, adjusted_days FROM hr_leave_balances WHERE leave_type = ? AND period_yyyymm = ?`
    )
    .all(leaveType, periodYyyymm);
  const adjustedByUser = new Map(adjustedExistingRows.map((r) => [String(r.user_id), Number(r.adjusted_days || 0)]));
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO hr_leave_balances (
      user_id, leave_type, period_yyyymm, opening_days, accrued_days, used_days, adjusted_days, closing_days, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const ledgerIns = db.prepare(
    `INSERT INTO hr_leave_accrual_ledger (
      id, user_id, leave_type, period_yyyymm, movement_kind, days, reference_id, note, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const usedByUser = new Map();
  const approvedLeave = db
    .prepare(
      `SELECT user_id, payload_json FROM hr_requests WHERE kind = 'leave' AND status = 'approved'`
    )
    .all();
  for (const row of approvedLeave) {
    const p = safeJsonParse(row.payload_json, {});
    const reqPeriod = String(p.startDateIso || p.startDate || '').slice(0, 7).replace('-', '');
    if (reqPeriod !== periodYyyymm) continue;
    const days = Math.max(0, Number(p.daysRequested) || 0);
    usedByUser.set(row.user_id, (usedByUser.get(row.user_id) || 0) + days);
  }
  const now = nowIso();
  const negative = [];
  for (const user of users) {
    let accrualPerMonth = 2;
    if (explicitAccrual) {
      accrualPerMonth = Math.max(0, Number(body.accrualPerMonthDays) || 0);
    } else if (leaveType === 'annual') {
      accrualPerMonth = annualLeaveEntitlementDaysForUser(db, user.user_id) / 12;
    }
    const used = Number(usedByUser.get(user.user_id) || 0);
    const previous = db
      .prepare(
        `SELECT closing_days FROM hr_leave_balances WHERE user_id = ? AND leave_type = ? AND period_yyyymm < ? ORDER BY period_yyyymm DESC LIMIT 1`
      )
      .get(user.user_id, leaveType, periodYyyymm);
    const opening = Number(previous?.closing_days || 0);
    const adjusted = Number(adjustedByUser.get(String(user.user_id)) || 0);
    const rawClosing = opening + accrualPerMonth - used + adjusted;
    if (rawClosing < 0) {
      negative.push({
        userId: String(user.user_id),
        openingDays: opening,
        accruedDays: accrualPerMonth,
        usedDays: used,
        adjustedDays: adjusted,
        closingDays: rawClosing,
      });
      continue;
    }
    const closing = Math.max(0, rawClosing);
    upsert.run(user.user_id, leaveType, periodYyyymm, opening, accrualPerMonth, used, adjusted, closing, now);
    ledgerIns.run(
      newId('HRLVL'),
      user.user_id,
      leaveType,
      periodYyyymm,
      'accrual_recompute',
      accrualPerMonth - used,
      null,
      `Recompute for ${periodYyyymm}`,
      now,
      actor?.id || null
    );
  }
  if (negative.length) {
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      actorDisplayName: actor?.displayName || actor?.username || null,
      action: 'hr.leave.recompute_blocked',
      entityKind: 'hr_leave_balances',
      entityId: periodYyyymm,
      reason: 'negative_balance',
      details: { leaveType, negative: negative.slice(0, 50) },
    });
    return {
      ok: false,
      code: 'NEGATIVE_LEAVE_BALANCE',
      error:
        'Leave recompute blocked: one or more staff would have a negative balance. Add an HR adjustment then retry.',
      negative,
    };
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.leave.recompute',
    entityKind: 'hr_leave_balances',
    entityId: periodYyyymm,
    details: { leaveType, users: users.length },
  });
  return { ok: true, periodYyyymm, leaveType, users: users.length };
}

export function adjustHrLeaveBalance(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body.userId || '').trim();
  const leaveType = String(body.leaveType || 'annual').trim().toLowerCase();
  const periodYyyymm = String(body.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  const days = Number(body.days);
  const note = String(body.note || '').trim() || null;
  if (!userId) return { ok: false, error: 'userId is required.' };
  if (!/^\d{6}$/.test(periodYyyymm)) return { ok: false, error: 'periodYyyymm must be YYYYMM.' };
  if (!Number.isFinite(days) || days === 0) return { ok: false, error: 'days must be a non-zero number.' };
  const now = nowIso();
  const current =
    db
      .prepare(
        `SELECT opening_days, accrued_days, used_days, adjusted_days, closing_days
         FROM hr_leave_balances WHERE user_id = ? AND leave_type = ? AND period_yyyymm = ?`
      )
      .get(userId, leaveType, periodYyyymm) || null;
  const previous = db
    .prepare(
      `SELECT closing_days FROM hr_leave_balances WHERE user_id = ? AND leave_type = ? AND period_yyyymm < ? ORDER BY period_yyyymm DESC LIMIT 1`
    )
    .get(userId, leaveType, periodYyyymm);
  const opening = current ? Number(current.opening_days || 0) : Number(previous?.closing_days || 0);
  const accrued = current ? Number(current.accrued_days || 0) : 0;
  const used = current ? Number(current.used_days || 0) : 0;
  const adjustedPrev = current ? Number(current.adjusted_days || 0) : 0;
  const adjustedNext = adjustedPrev + days;
  const closingNext = opening + accrued - used + adjustedNext;
  if (closingNext < 0) {
    return { ok: false, error: 'Adjustment would make balance negative.' };
  }
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO hr_leave_balances (
        user_id, leave_type, period_yyyymm, opening_days, accrued_days, used_days, adjusted_days, closing_days, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(userId, leaveType, periodYyyymm, opening, accrued, used, adjustedNext, closingNext, now);
    db.prepare(
      `INSERT INTO hr_leave_accrual_ledger (
        id, user_id, leave_type, period_yyyymm, movement_kind, days, reference_id, note, created_at_iso, created_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(newId('HRLVL'), userId, leaveType, periodYyyymm, 'manual_adjustment', days, null, note, now, actor?.id || null);
  })();
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.leave.adjust',
    entityKind: 'hr_leave_balances',
    entityId: `${userId}:${leaveType}:${periodYyyymm}`,
    details: { userId, leaveType, periodYyyymm, days, note },
  });
  return { ok: true, userId, leaveType, periodYyyymm, adjustedDays: adjustedNext, closingDays: closingNext };
}

/**
 * Attendance effect: absent days deduct (base/22) per working month assumption.
 */
/**
 * Staff loans that deduct this payroll period (disbursed, active, within repayment term).
 * @returns {{ total: number; loans: { hrRequestId: string; amountNgn: number; title: string }[] }}
 */
function activeStaffLoanBreakdown(db, userId) {
  const rows = db
    .prepare(`SELECT id, title, payload_json FROM hr_requests WHERE user_id = ? AND kind = 'loan' AND status = 'approved'`)
    .all(userId);
  const loans = [];
  for (const r of rows) {
    const p = safeJsonParse(r.payload_json, {});
    if (!p.deductionsActive || !p.loanDisbursedAtIso) continue;
    const monthsTotal = Math.round(Number(p.repaymentMonths) || 0);
    const cur = Math.round(Number(p.loanMonthsDeducted) || 0);
    if (monthsTotal > 0 && cur >= monthsTotal) continue;
    const principalRaw = p.principalOutstandingNgn;
    const trackedPrincipal = Number.isFinite(Number(principalRaw));
    if (trackedPrincipal && Math.round(Number(principalRaw)) <= 0) continue;
    let amountNgn = Math.round(Number(p.deductionPerMonthNgn) || 0);
    if (amountNgn <= 0) continue;
    if (trackedPrincipal && Math.round(Number(principalRaw)) > 0) {
      amountNgn = Math.min(amountNgn, Math.max(0, Math.round(Number(principalRaw))));
    }
    if (amountNgn <= 0) continue;
    loans.push({
      hrRequestId: r.id,
      amountNgn,
      title: String(r.title || '').trim() || r.id,
    });
  }
  const total = loans.reduce((s, x) => s + x.amountNgn, 0);
  return { total, loans };
}

function settleLoanAfterPayrollDeduction(db, loanId, userId, deductedNgn) {
  const loan = db
    .prepare(`SELECT id, payload_json FROM hr_requests WHERE id = ? AND user_id = ? AND kind = 'loan' AND status = 'approved'`)
    .get(loanId, userId);
  if (!loan) return;
  const p = safeJsonParse(loan.payload_json, {});
  if (!p.deductionsActive || !p.loanDisbursedAtIso) return;
  const ded = Math.max(0, Math.round(Number(deductedNgn) || 0));
  const merged = { ...p };

  const monthsTotal = Math.round(Number(p.repaymentMonths) || 0);
  if (monthsTotal > 0) {
    const cur = Math.round(Number(p.loanMonthsDeducted) || 0);
    if (cur < monthsTotal) {
      const nextCount = cur + 1;
      merged.loanMonthsDeducted = nextCount;
      if (nextCount >= monthsTotal) {
        merged.deductionsActive = false;
        merged.loanRepaidByScheduleAtIso = new Date().toISOString().slice(0, 10);
      }
    }
  }

  const prRaw = p.principalOutstandingNgn;
  if (Number.isFinite(Number(prRaw)) && Number(prRaw) > 0 && ded > 0) {
    const nextPr = Math.max(0, Math.round(Number(prRaw)) - ded);
    merged.principalOutstandingNgn = nextPr;
    if (nextPr <= 0) {
      merged.deductionsActive = false;
      merged.loanRepaidByPrincipalAtIso = new Date().toISOString().slice(0, 10);
    }
  }

  db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(JSON.stringify(merged), loan.id);
}

/**
 * When a payroll run is marked paid: count repayment months (if a term is set) and reduce principal by each
 * loan line’s deducted amount (`hr_payroll_line_loans.amount_ngn`).
 */
function incrementLoanMonthsFromPayrollRun(db, runId) {
  const items = db
    .prepare(`SELECT user_id, hr_request_id, amount_ngn FROM hr_payroll_line_loans WHERE run_id = ? AND amount_ngn > 0`)
    .all(runId);
  for (const item of items) {
    settleLoanAfterPayrollDeduction(db, item.hr_request_id, item.user_id, item.amount_ngn);
  }
}

function approvedLeaveWorkingDaysInPayrollMonth(db, userId, periodYyyymm) {
  if (!/^\d{6}$/.test(periodYyyymm)) return 0;
  const y = periodYyyymm.slice(0, 4);
  const mo = periodYyyymm.slice(4, 6);
  const monthStart = `${y}-${mo}-01`;
  const lastDay = new Date(Number(y), Number(mo), 0).getDate();
  const monthEnd = `${y}-${mo}-${String(lastDay).padStart(2, '0')}`;
  const rows = db
    .prepare(
      `SELECT l.start_date_iso, l.end_date_iso
       FROM hr_request_leave l
       JOIN hr_requests r ON r.id = l.request_id
       WHERE r.user_id = ? AND r.kind = 'leave' AND r.status = 'approved'`
    )
    .all(userId);
  let total = 0;
  for (const row of rows) {
    const s = String(row.start_date_iso || '').slice(0, 10);
    const e = String(row.end_date_iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) continue;
    const segStart = s > monthStart ? s : monthStart;
    const segEnd = e < monthEnd ? e : monthEnd;
    if (segStart > segEnd) continue;
    total += countWorkingDaysInclusive(db, segStart, segEnd);
  }
  return total;
}

function attendanceDeductionForUser(db, userId, branchId, periodYyyymm) {
  const prof = db.prepare(`SELECT base_salary_ngn FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const base = Math.round(Number(prof?.base_salary_ngn) || 0);
  const daily = base > 0 ? Math.round(base / 22) : 0;

  let absentDays = 0;
  const upload = db
    .prepare(
      `SELECT rows_json FROM hr_attendance_uploads WHERE branch_id = ? AND period_yyyymm = ? ORDER BY created_at_iso DESC LIMIT 1`
    )
    .get(branchId, periodYyyymm);
  if (upload) {
    const rows = safeJsonParse(upload.rows_json, []);
    const hit = rows.find((r) => String(r?.userId || '').trim() === userId);
    if (hit) absentDays = Math.max(0, Math.round(Number(hit.absentDays) || 0));
  }

  let lateDays = 0;
  if (branchId && periodYyyymm && /^\d{6}$/.test(periodYyyymm)) {
    const y = periodYyyymm.slice(0, 4);
    const m = periodYyyymm.slice(4, 6);
    const ym = `${y}-${m}`;
    const dayRows = db
      .prepare(`SELECT rows_json FROM hr_daily_roll_calls WHERE branch_id = ? AND substr(day_iso, 1, 7) = ?`)
      .all(branchId, ym);
    for (const dr of dayRows) {
      const list = safeJsonParse(dr.rows_json, []);
      const hit = list.find((x) => String(x?.userId || '').trim() === userId);
      if (hit && String(hit.status || '').toLowerCase() === 'late') lateDays += 1;
    }
  }

  // Approved exceptions can waive a day of absent/late deductions.
  let absentExceptions = 0;
  let lateExceptions = 0;
  if (periodYyyymm && /^\d{6}$/.test(periodYyyymm)) {
    const excRows = db
      .prepare(
        `SELECT payload_json
         FROM hr_requests
         WHERE user_id = ? AND kind = 'attendance_exception' AND status = 'approved'`
      )
      .all(userId);
    for (const r of excRows) {
      const p = safeJsonParse(r.payload_json, {});
      const dayIso = String(p.dayIso || p.dateIso || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayIso)) continue;
      const excPeriod = dayIso.slice(0, 7).replace('-', '');
      if (excPeriod !== periodYyyymm) continue;
      const excType = String(p.type || '').trim().toLowerCase();
      if (excType === 'absent') absentExceptions += 1;
      if (excType === 'late') lateExceptions += 1;
    }
  }
  const leaveWaive = approvedLeaveWorkingDaysInPayrollMonth(db, userId, periodYyyymm);
  const absentAfterLeave = Math.max(0, absentDays - Math.min(absentDays, leaveWaive));
  const effAbsent = Math.max(0, absentAfterLeave - absentExceptions);
  const effLate = Math.max(0, lateDays - lateExceptions);
  const deductionNgn = (effAbsent + effLate) * daily;
  return {
    absentDays,
    lateDays,
    absentExceptions,
    lateExceptions,
    leaveWaiveWorkingDays: leaveWaive,
    deductionNgn,
  };
}

export function createPayrollRun(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const periodYyyymm = String(body?.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(periodYyyymm)) return { ok: false, error: 'periodYyyymm must be YYYYMM.' };
  const id = newId('HRP');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, notes, created_at_iso, created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    periodYyyymm,
    'draft',
    Number(body?.taxPercent) >= 0 ? Number(body.taxPercent) : 7.5,
    Number(body?.pensionPercent) >= 0 ? Number(body.pensionPercent) : 8,
    String(body?.notes ?? '').trim() || null,
    now,
    actor.id
  );
  return { ok: true, id };
}

export function computePayrollRun(db, runId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const run = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status !== 'draft') return { ok: false, error: 'Only draft runs can be recomputed.' };
  const period = run.period_yyyymm;
  const taxP = Number(run.tax_percent) || 0;
  const penP = Number(run.pension_percent) || 0;

  db.prepare(`DELETE FROM hr_payroll_line_loans WHERE run_id = ?`).run(runId);
  db.prepare(`DELETE FROM hr_payroll_lines WHERE run_id = ?`).run(runId);

  const staff = db
    .prepare(
      `SELECT p.user_id, p.branch_id, p.base_salary_ngn, p.housing_allowance_ngn, p.transport_allowance_ngn,
              p.paye_tax_percent, p.pension_percent_override, p.profile_extra_json
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id AND u.status = 'active'`
    )
    .all();

  const ins = db.prepare(
    `INSERT INTO hr_payroll_lines (
      run_id, user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const insLoan = db.prepare(
    `INSERT INTO hr_payroll_line_loans (
      run_id, user_id, hr_request_id, period_yyyymm, amount_ngn, loan_title, computed_at_iso
    ) VALUES (?,?,?,?,?,?,?)`
  );
  const computedAt = nowIso();

  for (const s of staff) {
    const base = Math.round(Number(s.base_salary_ngn) || 0);
    const housing = Math.round(Number(s.housing_allowance_ngn) || 0);
    const transport = Math.round(Number(s.transport_allowance_ngn) || 0);
    const bonus = 0;
    const { deductionNgn } = attendanceDeductionForUser(db, s.user_id, s.branch_id, period);
    const gross = base + housing + transport + bonus - deductionNgn;
    const effTaxP =
      s.paye_tax_percent != null && Number.isFinite(Number(s.paye_tax_percent)) && Number(s.paye_tax_percent) >= 0
        ? Number(s.paye_tax_percent)
        : taxP;
    const effPenP =
      s.pension_percent_override != null &&
      Number.isFinite(Number(s.pension_percent_override)) &&
      Number(s.pension_percent_override) >= 0
        ? Number(s.pension_percent_override)
        : penP;
    const tax = Math.round((gross * effTaxP) / 100);
    const pension = Math.round((gross * effPenP) / 100);
    const extra = safeJsonParse(s.profile_extra_json, {});
    const comp = extra.compensationPackage || {};
    const discFix = Math.max(0, Math.round(Number(comp.monthlyDisciplinaryDeductionNgn) || 0));
    const { total: loanTotal, loans: loanParts } = activeStaffLoanBreakdown(db, s.user_id);
    const other = loanTotal + discFix;
    const net = gross - tax - pension - other;
    ins.run(runId, s.user_id, gross, bonus, deductionNgn, other, tax, pension, net);
    for (const ln of loanParts) {
      insLoan.run(runId, s.user_id, ln.hrRequestId, period, ln.amountNgn, ln.title, computedAt);
    }
  }
  return { ok: true };
}

const PAYROLL_RUN_STATUSES = new Set(['draft', 'locked', 'paid']);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [actor]
 */
export function approvePayrollRunByMd(db, runId, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  if (!userHasPermission(actor, 'hr.payroll.md_approve') && !userHasPermission(actor, '*')) {
    return { ok: false, error: 'Managing Director payroll approval permission required.' };
  }
  const run = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (String(run.status || '').toLowerCase() !== 'draft') {
    return { ok: false, error: 'Only draft runs can receive MD payroll approval.' };
  }
  const now = nowIso();
  db.prepare(`UPDATE hr_payroll_runs SET md_approved_at_iso = ?, md_approved_by_user_id = ? WHERE id = ?`).run(
    now,
    actor?.id ?? null,
    runId
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.payroll_run.md_approve',
    entityKind: 'hr_payroll_run',
    entityId: runId,
    details: { at: now },
  });
  return { ok: true, run: getPayrollRunById(db, runId) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {{ status?: string; taxPercent?: number; pensionPercent?: number; notes?: string | null }} body
 * @param {object} [actor]
 */
export function patchPayrollRun(db, runId, body, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const run = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };

  const signingPatch =
    body &&
    (Object.prototype.hasOwnProperty.call(body, 'signedPdfSha256') ||
      Object.prototype.hasOwnProperty.call(body, 'filingStatus') ||
      Object.prototype.hasOwnProperty.call(body, 'filingReference') ||
      Object.prototype.hasOwnProperty.call(body, 'filingAtIso') ||
      Object.prototype.hasOwnProperty.call(body, 'signatureKind') ||
      body.recordSignedNow === true);
  if (signingPatch) {
    const st = String(run.status || '').toLowerCase();
    if (st !== 'locked' && st !== 'paid') {
      return { ok: false, error: 'Signing and filing can only be updated on locked or paid payroll runs.' };
    }
    const signedPdfSha256 =
      body.signedPdfSha256 === null || body.signedPdfSha256 === ''
        ? null
        : body.signedPdfSha256 !== undefined
          ? String(body.signedPdfSha256).trim() || null
          : run.signed_pdf_sha256 ?? null;
    const filingStatus =
      body.filingStatus !== undefined ? String(body.filingStatus || '').trim() || null : run.filing_status ?? null;
    const filingReference =
      body.filingReference !== undefined
        ? String(body.filingReference || '').trim() || null
        : run.filing_reference ?? null;
    const filingAtIso =
      body.filingAtIso !== undefined ? String(body.filingAtIso || '').trim() || null : run.filing_at_iso ?? null;
    const signatureKind =
      body.signatureKind !== undefined ? String(body.signatureKind || '').trim() || null : run.signature_kind ?? null;
    let signedAtIso = run.signed_at_iso ?? null;
    let signedByUserId = run.signed_by_user_id ?? null;
    if (body.recordSignedNow === true) {
      signedAtIso = nowIso();
      signedByUserId = actor?.id ?? null;
    }
    try {
      db.prepare(
        `UPDATE hr_payroll_runs SET signed_at_iso = ?, signed_by_user_id = ?, signature_kind = ?, signed_pdf_sha256 = ?,
         filing_status = ?, filing_reference = ?, filing_at_iso = ? WHERE id = ?`
      ).run(
        signedAtIso,
        signedByUserId,
        signatureKind,
        signedPdfSha256,
        filingStatus,
        filingReference,
        filingAtIso,
        runId
      );
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      actorDisplayName: actor?.displayName || actor?.username || null,
      action: 'hr.payroll_run.signing',
      entityKind: 'hr_payroll_run',
      entityId: runId,
      details: { filingStatus, recordSignedNow: Boolean(body.recordSignedNow) },
    });
    return { ok: true, run: getPayrollRunById(db, runId) };
  }

  if (body?.status != null) {
    const ns = String(body.status).trim().toLowerCase();
    if (!PAYROLL_RUN_STATUSES.has(ns)) return { ok: false, error: 'Invalid status.' };
    if (run.status === 'paid' && ns !== 'paid') {
      return { ok: false, error: 'Paid runs cannot be changed to another status here.' };
    }
    // Policy: locked → draft is allowed (unlock for corrections + recompute). Paid is terminal.
    if (ns === 'draft' && run.status !== 'locked' && run.status !== 'draft') {
      return { ok: false, error: 'Only a locked run can be returned to draft.' };
    }
    if (ns === 'locked' && String(run.status || '').toLowerCase() === 'draft') {
      const mdOk = String(run.md_approved_at_iso || '').trim();
      if (!mdOk && !userHasPermission(actor, '*')) {
        return {
          ok: false,
          error: 'Managing Director must approve this payroll run before it can be locked.',
        };
      }
    }
    const wasPaid = run.status === 'paid';
    if (ns === 'draft' && String(run.status || '').toLowerCase() === 'locked') {
      db.prepare(
        `UPDATE hr_payroll_runs SET status = ?, md_approved_at_iso = NULL, md_approved_by_user_id = NULL WHERE id = ?`
      ).run(ns, runId);
    } else {
      db.prepare(`UPDATE hr_payroll_runs SET status = ? WHERE id = ?`).run(ns, runId);
    }
    if (ns === 'paid' && !wasPaid) {
      incrementLoanMonthsFromPayrollRun(db, runId);
    }
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      actorDisplayName: actor?.displayName || actor?.username || null,
      action: 'hr.payroll_run.status',
      entityKind: 'hr_payroll_run',
      entityId: runId,
      details: { from: String(run.status || ''), to: ns },
    });
    return { ok: true };
  }

  if (run.status !== 'draft') {
    return { ok: false, error: 'Only draft runs can edit tax, pension, or notes.' };
  }
  if (body?.taxPercent != null || body?.pensionPercent != null) {
    const t = body?.taxPercent != null ? Number(body.taxPercent) : Number(run.tax_percent);
    const p = body?.pensionPercent != null ? Number(body.pensionPercent) : Number(run.pension_percent);
    db.prepare(`UPDATE hr_payroll_runs SET tax_percent = ?, pension_percent = ? WHERE id = ?`).run(t, p, runId);
  }
  if (body?.notes !== undefined) {
    db.prepare(`UPDATE hr_payroll_runs SET notes = ? WHERE id = ?`).run(
      String(body.notes ?? '').trim() || null,
      runId
    );
  }
  return { ok: true };
}

export function listPayrollRuns(db) {
  if (!hrTablesReady(db)) return [];
  return db
    .prepare(`SELECT * FROM hr_payroll_runs ORDER BY created_at_iso DESC LIMIT 100`)
    .all()
    .map((row) => ({
      id: row.id,
      periodYyyymm: row.period_yyyymm,
      status: row.status,
      taxPercent: row.tax_percent,
      pensionPercent: row.pension_percent,
      notes: row.notes,
      createdAtIso: row.created_at_iso,
      createdByUserId: row.created_by_user_id,
      mdApprovedAtIso: row.md_approved_at_iso ?? null,
      mdApprovedByUserId: row.md_approved_by_user_id ?? null,
      signedAtIso: row.signed_at_iso ?? null,
      signedByUserId: row.signed_by_user_id ?? null,
      signatureKind: row.signature_kind ?? null,
      signedPdfSha256: row.signed_pdf_sha256 ?? null,
      filingStatus: row.filing_status ?? null,
      filingReference: row.filing_reference ?? null,
      filingAtIso: row.filing_at_iso ?? null,
    }));
}

export function listPayrollLines(db, runId) {
  if (!hrTablesReady(db)) return [];
  const loanRows = db
    .prepare(
      `SELECT user_id, hr_request_id, amount_ngn, loan_title FROM hr_payroll_line_loans WHERE run_id = ?`
    )
    .all(runId);
  const loansByUser = new Map();
  for (const lr of loanRows) {
    const uid = lr.user_id;
    if (!loansByUser.has(uid)) loansByUser.set(uid, []);
    loansByUser.get(uid).push({
      hrRequestId: lr.hr_request_id,
      amountNgn: lr.amount_ngn,
      title: lr.loan_title || lr.hr_request_id,
    });
  }
  return db
    .prepare(
      `SELECT l.*, u.display_name AS displayName
       FROM hr_payroll_lines l
       JOIN app_users u ON u.id = l.user_id
       WHERE l.run_id = ?
       ORDER BY u.display_name ASC`
    )
    .all(runId)
    .map((row) => {
      const g = Math.round(Number(row.gross_ngn) || 0);
      const tx = Math.round(Number(row.tax_ngn) || 0);
      return {
        userId: row.user_id,
        displayName: row.displayName,
        grossNgn: row.gross_ngn,
        bonusNgn: row.bonus_ngn,
        attendanceDeductionNgn: row.attendance_deduction_ngn,
        otherDeductionNgn: row.other_deduction_ngn,
        taxNgn: row.tax_ngn,
        pensionNgn: row.pension_ngn,
        netNgn: row.net_ngn,
        loanDeductions: loansByUser.get(row.user_id) || [],
        impliedTaxPercent: g > 0 ? Math.round((tx * 1000) / g) / 10 : null,
        impliedPensionPercent:
          g > 0 ? Math.round((Math.round(Number(row.pension_ngn) || 0) * 1000) / g) / 10 : null,
      };
    });
}

export function getPayrollRunById(db, runId) {
  if (!hrTablesReady(db)) return null;
  const row = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!row) return null;
  return {
    id: row.id,
    periodYyyymm: row.period_yyyymm,
    status: row.status,
    taxPercent: Number(row.tax_percent),
    pensionPercent: Number(row.pension_percent),
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    createdByUserId: row.created_by_user_id,
    mdApprovedAtIso: row.md_approved_at_iso ?? null,
    mdApprovedByUserId: row.md_approved_by_user_id ?? null,
    signedAtIso: row.signed_at_iso ?? null,
    signedByUserId: row.signed_by_user_id ?? null,
    signatureKind: row.signature_kind ?? null,
    signedPdfSha256: row.signed_pdf_sha256 ?? null,
    filingStatus: row.filing_status ?? null,
    filingReference: row.filing_reference ?? null,
    filingAtIso: row.filing_at_iso ?? null,
  };
}

/**
 * CSV for finance / treasury: net pay per employee, loan split, totals. Allowed when run is locked or paid.
 */
/**
 * Double-entry template for GL import (Dr payroll expense, Cr PAYE, pension, net pay).
 * Uses the same eligibility as treasury pack.
 */
export function exportPayrollGlJournalTemplateCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status !== 'locked' && run.status !== 'paid') {
    return { ok: false, error: 'Lock or mark this run paid before GL journal export.' };
  }
  const lines = listPayrollLines(db, runId);
  let expenseDr = 0;
  let taxCr = 0;
  let penCr = 0;
  let netCr = 0;
  for (const l of lines) {
    const g = Math.round(Number(l.grossNgn) || 0) + Math.round(Number(l.bonusNgn) || 0);
    const ad = Math.round(Number(l.attendanceDeductionNgn) || 0);
    const od = Math.round(Number(l.otherDeductionNgn) || 0);
    expenseDr += g - ad - od;
    taxCr += Math.round(Number(l.taxNgn) || 0);
    penCr += Math.round(Number(l.pensionNgn) || 0);
    netCr += Math.round(Number(l.netNgn) || 0);
  }
  const headers = ['account_code', 'account_name', 'debit_ngn', 'credit_ngn', 'memo'];
  const esc = (v) => {
    const t = String(v ?? '');
    if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const memoBase = `Payroll ${run.periodYyyymm} ${run.id}`;
  const rows = [
    ['6000', 'Payroll expense', expenseDr, 0, memoBase],
    ['2300', 'PAYE payable', 0, taxCr, memoBase],
    ['2400', 'Pension payable', 0, penCr, memoBase],
    ['2200', 'Net payroll payable', 0, netCr, memoBase],
  ];
  const csv = [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  return {
    ok: true,
    csv,
    filename: `gl-journal-payroll-${run.periodYyyymm}-${String(run.id).replace(/[^\w-]/g, '').slice(0, 12)}.csv`,
  };
}

export function exportPayrollTreasuryPackCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status !== 'locked' && run.status !== 'paid') {
    return { ok: false, error: 'Lock or mark this run paid before treasury export.' };
  }
  const lines = listPayrollLines(db, runId);
  const headers = [
    'period_yyyymm',
    'run_id',
    'run_status',
    'user_id',
    'display_name',
    'gross_ngn',
    'attendance_deduction_ngn',
    'other_deduction_ngn',
    'staff_loan_detail',
    'tax_ngn',
    'pension_ngn',
    'net_ngn',
  ];
  const esc = (v) => {
    const t = String(v ?? '');
    if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const rows = lines.map((l) => {
    const br = (l.loanDeductions || []).map((x) => `${x.hrRequestId}:${x.amountNgn}`).join(';');
    return [
      run.periodYyyymm,
      run.id,
      run.status,
      l.userId,
      l.displayName,
      l.grossNgn,
      l.attendanceDeductionNgn,
      l.otherDeductionNgn,
      br,
      l.taxNgn,
      l.pensionNgn,
      l.netNgn,
    ].map(esc);
  });
  let sumNet = 0;
  let sumOther = 0;
  for (const l of lines) {
    sumNet += Math.round(Number(l.netNgn) || 0);
    sumOther += Math.round(Number(l.otherDeductionNgn) || 0);
  }
  const summaryRow = [
    run.periodYyyymm,
    run.id,
    run.status,
    '',
    'TOTALS',
    '',
    '',
    sumOther,
    '',
    '',
    '',
    sumNet,
  ].map(esc);
  const csv = [headers.join(','), ...rows.map((r) => r.join(',')), summaryRow.join(',')].join('\r\n');
  return {
    ok: true,
    csv,
    filename: `treasury-payroll-${run.periodYyyymm}-${String(run.id).replace(/[^\w-]/g, '').slice(0, 12)}.csv`,
  };
}

export function exportPayrollPayslipsCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = listPayrollLines(db, runId);
  const headers = [
    'period_yyyymm',
    'run_id',
    'user_id',
    'display_name',
    'gross_ngn',
    'bonus_ngn',
    'attendance_deduction_ngn',
    'other_deduction_ngn',
    'tax_ngn',
    'pension_ngn',
    'net_ngn',
  ];
  const esc = (v) => {
    const t = String(v ?? '');
    if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const rows = lines.map((l) =>
    [
      run.periodYyyymm,
      run.id,
      l.userId,
      l.displayName,
      l.grossNgn,
      l.bonusNgn,
      l.attendanceDeductionNgn,
      l.otherDeductionNgn,
      l.taxNgn,
      l.pensionNgn,
      l.netNgn,
    ].map(esc)
  );
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return { ok: true, csv, filename: `payslips-${run.periodYyyymm}-${run.id}.csv` };
}

export function exportPayrollStatutoryPackCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = listPayrollLines(db, runId);
  const headers = ['period_yyyymm', 'run_id', 'user_id', 'display_name', 'tax_ngn', 'pension_ngn'];
  const esc = (v) => String(v ?? '');
  const rows = lines.map((l) =>
    [run.periodYyyymm, run.id, l.userId, l.displayName, l.taxNgn, l.pensionNgn].map(esc)
  );
  const totalTax = lines.reduce((s, l) => s + (Number(l.taxNgn) || 0), 0);
  const totalPension = lines.reduce((s, l) => s + (Number(l.pensionNgn) || 0), 0);
  rows.push([run.periodYyyymm, run.id, '', 'TOTAL', totalTax, totalPension]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return { ok: true, csv, filename: `statutory-${run.periodYyyymm}-${run.id}.csv` };
}

/**
 * Close a loan early or adjust repayment terms (post-disbursement). Audited in HTTP layer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 * @param {string} actorUserId
 * @param {{ closeLoan?: boolean; note?: string | null; deductionPerMonthNgn?: number; repaymentMonths?: number; principalOutstandingNgn?: number }} body
 */
export function patchHrLoanMaintenance(db, requestId, actorUserId, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (String(row.kind) !== 'loan' || row.status !== 'approved') {
    return { ok: false, error: 'Only approved loan requests can be maintained.' };
  }
  const p = safeJsonParse(row.payload_json, {});
  if (!p.loanDisbursedAtIso) return { ok: false, error: 'Loan is not disbursed yet.' };
  const merged = { ...p };
  const nowDay = nowIso().slice(0, 10);
  if (body?.closeLoan === true) {
    merged.deductionsActive = false;
    merged.principalOutstandingNgn = 0;
    merged.loanClosedEarlyAtIso = nowDay;
    merged.loanMaintenanceNote = String(body.note ?? '').trim() || null;
    merged.loanMaintenanceByUserId = actorUserId;
    merged.loanMaintenanceAtIso = nowIso();
  } else {
    if (body?.deductionPerMonthNgn != null) {
      merged.deductionPerMonthNgn = Math.max(0, Math.round(Number(body.deductionPerMonthNgn) || 0));
    }
    if (body?.repaymentMonths != null) {
      const nextMonths = Math.max(0, Math.round(Number(body.repaymentMonths) || 0));
      const done = Math.max(0, Math.round(Number(p.loanMonthsDeducted) || 0));
      if (nextMonths > 0 && done > nextMonths) {
        return { ok: false, error: 'repaymentMonths cannot be less than months already deducted.' };
      }
      merged.repaymentMonths = nextMonths;
    }
    if (body?.principalOutstandingNgn != null) {
      merged.principalOutstandingNgn = Math.max(0, Math.round(Number(body.principalOutstandingNgn) || 0));
    }
    merged.loanMaintenanceNote = String(body.note ?? '').trim() || null;
    merged.loanMaintenanceByUserId = actorUserId;
    merged.loanMaintenanceAtIso = nowIso();
  }
  db.prepare(`UPDATE hr_requests SET payload_json = ? WHERE id = ?`).run(JSON.stringify(merged), requestId);
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ userId: string; letterKind?: string }} body
 */
export function generateEmploymentLetter(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const u = db.prepare(`SELECT display_name, username FROM app_users WHERE id = ?`).get(userId);
  if (!u) return { ok: false, error: 'User not found.' };
  const p = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const jobTitle = p?.job_title || 'Staff';
  const dept = p?.department || 'General';
  const joined = p?.date_joined_iso || 'TBD';
  const company = 'Zarewa Aluminium and Plastics Ltd';
  const content = [
    `${company}`,
    '',
    `Date: ${nowIso().slice(0, 10)}`,
    '',
    `TO WHOM IT MAY CONCERN`,
    '',
    `RE: Letter of employment — ${u.display_name}`,
    '',
    `This is to certify that ${u.display_name} (${u.username}) is employed with ${company} as ${jobTitle} in ${dept}, effective from ${joined}.`,
    '',
    `This letter is issued at the request of the employee for official use.`,
    '',
    `Yours faithfully,`,
    `${actor.displayName || actor.username || 'HR'}`,
    `Human Resources (HQ)`,
  ].join('\n');

  const id = newId('HRL');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_employment_letters (id, user_id, letter_kind, content_text, issued_at_iso, issued_by_user_id)
     VALUES (?,?,?,?,?,?)`
  ).run(id, userId, String(body?.letterKind || 'employment').trim() || 'employment', content, now, actor.id);
  return { ok: true, id, contentText: content };
}

export function listEmploymentLetters(db, userId) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_employment_letters WHERE 1=1`;
  const args = [];
  if (userId) {
    sql += ` AND user_id = ?`;
    args.push(userId);
  }
  sql += ` ORDER BY issued_at_iso DESC LIMIT 100`;
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      letterKind: row.letter_kind,
      contentText: row.content_text,
      issuedAtIso: row.issued_at_iso,
      issuedByUserId: row.issued_by_user_id,
    }));
}

export function acceptHrPolicy(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || actor?.id || '').trim();
  const policyKey = String(body?.policyKey || 'employee_handbook').trim();
  const policyVersion = String(body?.policyVersion || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  if (!policyVersion) return { ok: false, error: 'policyVersion is required.' };
  const acceptedAtIso = nowIso();
  const signatureName = String(body?.signatureName || actor?.displayName || '').trim() || null;
  const context = body?.context != null ? body.context : {};
  const recordHash = sha256(`${userId}|${policyKey}|${policyVersion}|${acceptedAtIso}|${JSON.stringify(context)}`);
  const id = newId('HRACK');
  db.prepare(
    `INSERT INTO hr_policy_acknowledgements (
      id, user_id, policy_key, policy_version, accepted_at_iso, signature_name, accepted_by_user_id, context_json, record_hash
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    policyKey,
    policyVersion,
    acceptedAtIso,
    signatureName,
    actor?.id || userId,
    JSON.stringify(context),
    recordHash
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || userId,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.policy.accept',
    entityKind: 'hr_policy_acknowledgement',
    entityId: id,
    details: { policyKey, policyVersion, userId },
  });
  return { ok: true, id, acceptedAtIso, recordHash };
}

export function hasHrPolicyAcceptance(db, userId, policyKey, policyVersion) {
  if (!hrTablesReady(db)) return false;
  const uid = String(userId || '').trim();
  const key = String(policyKey || '').trim();
  const ver = String(policyVersion || '').trim();
  if (!uid || !key || !ver) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM hr_policy_acknowledgements
         WHERE user_id = ? AND policy_key = ? AND policy_version = ?
         LIMIT 1`
      )
      .get(uid, key, ver)
  );
}

export function listMissingHrPolicyAcceptances(db, userId, requiredPolicies = []) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  if (!Array.isArray(requiredPolicies) || requiredPolicies.length === 0) return [];
  return requiredPolicies.filter((p) => !hasHrPolicyAcceptance(db, uid, p.key, p.version));
}

export function listHrPolicyAcknowledgements(db, filter = {}) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_policy_acknowledgements WHERE 1=1`;
  const args = [];
  if (filter.userId) {
    sql += ` AND user_id = ?`;
    args.push(String(filter.userId).trim());
  }
  if (filter.policyKey) {
    sql += ` AND policy_key = ?`;
    args.push(String(filter.policyKey).trim());
  }
  sql += ` ORDER BY accepted_at_iso DESC LIMIT 300`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    userId: row.user_id,
    policyKey: row.policy_key,
    policyVersion: row.policy_version,
    acceptedAtIso: row.accepted_at_iso,
    signatureName: row.signature_name,
    acceptedByUserId: row.accepted_by_user_id,
    context: safeJsonParse(row.context_json, {}),
    recordHash: row.record_hash,
  }));
}

export function listHrLeaveBalances(db, filter = {}) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_leave_balances WHERE 1=1`;
  const args = [];
  if (filter.userId) {
    sql += ` AND user_id = ?`;
    args.push(String(filter.userId).trim());
  }
  if (filter.leaveType) {
    sql += ` AND leave_type = ?`;
    args.push(String(filter.leaveType).trim().toLowerCase());
  }
  if (filter.periodYyyymm) {
    sql += ` AND period_yyyymm = ?`;
    args.push(String(filter.periodYyyymm).trim().replace(/\D/g, '').slice(0, 6));
  }
  sql += ` ORDER BY period_yyyymm DESC LIMIT 400`;
  return db.prepare(sql).all(...args).map((row) => ({
    userId: row.user_id,
    leaveType: row.leave_type,
    periodYyyymm: row.period_yyyymm,
    openingDays: Number(row.opening_days || 0),
    accruedDays: Number(row.accrued_days || 0),
    usedDays: Number(row.used_days || 0),
    adjustedDays: Number(row.adjusted_days || 0),
    closingDays: Number(row.closing_days || 0),
    updatedAtIso: row.updated_at_iso,
  }));
}

export function listHrObservability(db, scope) {
  if (!hrTablesReady(db)) return { events: [], summary: {} };
  let sql = `SELECT * FROM hr_audit_events WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (branch_id = ? OR branch_id IS NULL)`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY occurred_at_iso DESC LIMIT 500`;
  const events = db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    atIso: row.occurred_at_iso,
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name,
    action: row.action,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    branchId: row.branch_id,
    reason: row.reason,
    details: safeJsonParse(row.details_json, {}),
    correlationId: row.correlation_id,
  }));
  const summary = {
    totalEvents: events.length,
    pendingHrReview: db.prepare(`SELECT COUNT(*) AS c FROM hr_requests WHERE status = 'hr_review'`).get().c,
    pendingBranchEndorse: db.prepare(`SELECT COUNT(*) AS c FROM hr_requests WHERE status = 'branch_manager_review'`).get().c,
    pendingGmHrReview: db.prepare(`SELECT COUNT(*) AS c FROM hr_requests WHERE status = 'gm_hr_review'`).get().c,
    pendingManagerReview:
      db.prepare(`SELECT COUNT(*) AS c FROM hr_requests WHERE status = 'branch_manager_review'`).get().c +
      db.prepare(`SELECT COUNT(*) AS c FROM hr_requests WHERE status = 'gm_hr_review'`).get().c,
    overdueRequests: listHrRequests(db, scope || { viewAll: true, branchId: DEFAULT_BRANCH_ID }, {})
      .filter((r) => r.slaState === 'overdue').length,
    eeo: eeoDecisionSummary(db, scope, { days: 120 }),
  };
  return { events, summary };
}

function eeoDecisionSummary(db, scope, opts = {}) {
  const days = Math.max(7, Math.round(Number(opts.days) || 120));
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let sql = `
    SELECT e.action, e.details_json, e.entity_id, r.kind, r.branch_id, p.department
    FROM hr_audit_events e
    LEFT JOIN hr_requests r ON r.id = e.entity_id
    LEFT JOIN hr_staff_profiles p ON p.user_id = r.user_id
    WHERE e.occurred_at_iso >= ?
      AND e.entity_kind = 'hr_request'
      AND e.action IN (
        'hr.request.hr_approve','hr.request.hr_reject',
        'hr.request.manager_approve','hr.request.manager_reject',
        'hr.request.branch_endorse_approve','hr.request.branch_endorse_reject',
        'hr.request.gm_hr_approve','hr.request.gm_hr_reject'
      )
  `;
  const args = [sinceIso];
  if (!scope?.viewAll) {
    sql += ` AND (r.branch_id = ? OR r.branch_id IS NULL)`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  const rows = db.prepare(sql).all(...args);
  const byKind = {};
  const byBranch = {};
  const byDept = {};
  let missingReasonCode = 0;
  for (const row of rows) {
    const details = safeJsonParse(row.details_json, {});
    const rc = String(details.reasonCode || '').trim();
    if (!rc) missingReasonCode += 1;
    const kind = String(row.kind || details.kind || 'unknown');
    const branchId = String(row.branch_id || '—');
    const dept = String(row.department || '—');
    const decision = String(details.decision || (String(row.action).includes('reject') ? 'reject' : 'approve'));
    byKind[kind] = byKind[kind] || { approve: 0, reject: 0, total: 0 };
    byKind[kind][decision] += 1;
    byKind[kind].total += 1;
    byBranch[branchId] = byBranch[branchId] || { approve: 0, reject: 0, total: 0 };
    byBranch[branchId][decision] += 1;
    byBranch[branchId].total += 1;
    byDept[dept] = byDept[dept] || { approve: 0, reject: 0, total: 0 };
    byDept[dept][decision] += 1;
    byDept[dept].total += 1;
  }
  return { windowDays: days, totalDecisions: rows.length, missingReasonCode, byKind, byBranch, byDepartment: byDept };
}

export function hrNextUatReadiness(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const queue = listHrDataCleanupQueue(db, scope);
  const obs = listHrObservability(db, scope);
  const hasSpecialNodes = ['mining_div', 'scholarship', 'chairman_staffs'].every((n) =>
    staff.some((s) => s.normalized?.orgNode === n || normalizeOrgNode(s.department) === n)
  );
  const qualityCoverage = staff.length
    ? Math.round((staff.filter((s) => !Object.values(s.qualityFlags || {}).some(Boolean)).length / staff.length) * 100)
    : 0;
  return {
    gates: {
      specialNodesPresent: hasSpecialNodes,
      cleanupPassDone: queue.length === 0,
      qualityCoveragePct: qualityCoverage,
      sensitiveMaskingReady: true,
      overdueRequests: Number(obs.summary?.overdueRequests || 0),
    },
    canCutover: hasSpecialNodes && qualityCoverage >= 85,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function getHrMeProfile(db, userId) {
  const u = db
    .prepare(
      `SELECT id, username, display_name, email, role_key, status, avatar_url FROM app_users WHERE id = ?`
    )
    .get(userId);
  if (!u) return { user: null, hr: null };
  const user = {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    roleKey: u.role_key,
    roleLabel: roleLabel(u.role_key),
    status: u.status,
    avatarUrl: u.avatar_url,
  };
  if (!hrTablesReady(db)) return { user, hr: null };
  const p = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!p) return { user, hr: null };
  const hr = {
    branchId: p.branch_id,
    employeeNo: p.employee_no,
    jobTitle: p.job_title,
    department: p.department,
    employmentType: p.employment_type,
    dateJoinedIso: p.date_joined_iso,
    probationEndIso: p.probation_end_iso,
    bankAccountName: p.bank_account_name,
    bankName: p.bank_name,
    bankAccountNoMasked: p.bank_account_no_masked,
    taxId: p.tax_id,
    pensionRsaPin: p.pension_rsa_pin,
    baseSalaryNgn: p.base_salary_ngn,
    housingAllowanceNgn: p.housing_allowance_ngn,
    transportAllowanceNgn: p.transport_allowance_ngn,
    minimumQualification: p.minimum_qualification,
    academicQualification: p.academic_qualification,
    promotionGrade: p.promotion_grade,
    welfareNotes: p.welfare_notes,
    trainingSummary: p.training_summary,
    bonusAccrualNote: p.bonus_accrual_note,
    payeTaxPercent: p.paye_tax_percent != null ? Number(p.paye_tax_percent) : null,
    pensionPercentOverride: p.pension_percent_override != null ? Number(p.pension_percent_override) : null,
    nextOfKin: safeJsonParse(p.next_of_kin_json, null),
    profileExtra: safeJsonParse(p.profile_extra_json, {}),
    selfServiceEligible: Number(p.self_service_eligible) === 1,
    lineManagerUserId: p.line_manager_user_id ?? null,
    leaveEntitlementBand: p.leave_entitlement_band ?? null,
  };
  return { user, hr };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function listHrStaffBranchHistory(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTablesReady(db)) return [];
  try {
    return db
      .prepare(
        `SELECT id, user_id AS userId, from_branch_id AS fromBranchId, to_branch_id AS toBranchId,
                effective_from_iso AS effectiveFromIso, reason, actor_user_id AS actorUserId, created_at_iso AS createdAtIso
         FROM hr_staff_branch_history WHERE user_id = ? ORDER BY created_at_iso DESC LIMIT 100`
      )
      .all(uid);
  } catch {
    return [];
  }
}

export function getHrInboxSummary(db, scope) {
  if (!hrTablesReady(db)) {
    return { ok: true, counts: { pendingHrReview: 0, pendingBranchEndorse: 0, pendingGmHrReview: 0, draftPayrollRuns: 0 } };
  }
  const obs = listHrObservability(db, scope);
  const draftPayroll = db.prepare(`SELECT COUNT(*) AS c FROM hr_payroll_runs WHERE status = 'draft'`).get().c;
  return {
    ok: true,
    counts: {
      pendingHrReview: obs.summary?.pendingHrReview ?? 0,
      pendingBranchEndorse: obs.summary?.pendingBranchEndorse ?? 0,
      pendingGmHrReview: obs.summary?.pendingGmHrReview ?? 0,
      overdueRequests: obs.summary?.overdueRequests ?? 0,
      draftPayrollRuns: draftPayroll,
    },
  };
}

export function listHrPublicHolidays(db) {
  try {
    return db.prepare(`SELECT day_iso AS dayIso, label, scope FROM hr_public_holidays ORDER BY day_iso ASC`).all();
  } catch {
    return [];
  }
}

export function putHrPublicHoliday(db, actor, body = {}) {
  const dayIso = String(body.dayIso || '').trim().slice(0, 10);
  const label = String(body.label || '').trim();
  const scope = String(body.scope || 'NG').trim() || 'NG';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayIso)) return { ok: false, error: 'dayIso must be YYYY-MM-DD.' };
  if (label.length < 2) return { ok: false, error: 'label is required.' };
  try {
    db.prepare(`INSERT OR REPLACE INTO hr_public_holidays (day_iso, label, scope) VALUES (?,?,?)`).run(dayIso, label, scope);
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      action: 'hr.public_holiday.upsert',
      entityKind: 'hr_public_holidays',
      entityId: `${dayIso}:${scope}`,
      details: { label },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function leaveOverlayForBranchDay(db, branchId, dayIso) {
  if (!hrTablesReady(db)) return [];
  const bid = String(branchId || '').trim();
  const day = String(dayIso || '').slice(0, 10);
  if (!bid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const users = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE branch_id = ?`).all(bid);
  return users.map((u) => {
    const x = isApprovedLeaveOnDay(db, String(u.user_id), day);
    return { userId: String(u.user_id), onLeave: Boolean(x.onLeave), leaveType: x.leaveType };
  });
}

export function listHrDisciplineCases(db, scope) {
  if (!hrTablesReady(db)) return [];
  try {
    let sql = `SELECT * FROM hr_discipline_cases WHERE 1=1`;
    const args = [];
    const subjectUserId = String(scope?.subjectUserId || '').trim();
    if (subjectUserId) {
      sql += ` AND user_id = ?`;
      args.push(subjectUserId);
    } else if (!scope?.viewAll) {
      sql += ` AND branch_id = ?`;
      args.push(scope?.branchId || DEFAULT_BRANCH_ID);
    }
    sql += ` ORDER BY opened_at_iso DESC LIMIT 200`;
    return db.prepare(sql).all(...args).map((row) => ({
      id: row.id,
      userId: row.user_id,
      branchId: row.branch_id,
      status: row.status,
      offenceCategory: row.offence_category,
      summary: row.summary,
      openedAtIso: row.opened_at_iso,
      openedByUserId: row.opened_by_user_id,
    }));
  } catch {
    return [];
  }
}

export function createHrDisciplineCase(db, actor, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body.userId || '').trim();
  const summary = String(body.summary || '').trim();
  if (!userId || summary.length < 3) return { ok: false, error: 'userId and summary are required.' };
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const branchId = String(body.branchId || prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const id = newId('HRDIS');
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO hr_discipline_cases (id, user_id, branch_id, status, offence_category, summary, opened_at_iso, opened_by_user_id)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      id,
      userId,
      branchId,
      String(body.status || 'open').trim() || 'open',
      String(body.offenceCategory || '').trim() || null,
      summary,
      now,
      actor?.id || null
    );
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      action: 'hr.discipline.case_open',
      entityKind: 'hr_discipline_case',
      entityId: id,
      branchId,
      details: { userId },
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function appendHrDisciplineEvent(db, actor, caseId, body = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const cid = String(caseId || '').trim();
  const eventKind = String(body.eventKind || 'note').trim();
  const note = String(body.note || '').trim();
  if (!cid || note.length < 2) return { ok: false, error: 'caseId and note are required.' };
  const id = newId('HRDISev');
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO hr_discipline_events (id, case_id, event_kind, note, actor_user_id, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(id, cid, eventKind, note, actor?.id || null, now);
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      action: 'hr.discipline.event',
      entityKind: 'hr_discipline_case',
      entityId: cid,
      details: { eventKind },
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function listHrDisciplineEvents(db, caseId) {
  try {
    return db
      .prepare(
        `SELECT id, case_id AS caseId, event_kind AS eventKind, note, actor_user_id AS actorUserId, created_at_iso AS createdAtIso
         FROM hr_discipline_events WHERE case_id = ? ORDER BY created_at_iso ASC`
      )
      .all(String(caseId || '').trim());
  } catch {
    return [];
  }
}

export function listHrAppraisalCycles(db) {
  try {
    return db
      .prepare(`SELECT id, label, year, due_by_iso AS dueByIso, status, created_at_iso AS createdAtIso FROM hr_appraisal_cycles ORDER BY year DESC`)
      .all();
  } catch {
    return [];
  }
}

export function createHrAppraisalCycle(db, actor, body = {}) {
  const id = newId('HRAPC');
  const now = nowIso();
  const year = Math.round(Number(body.year) || new Date().getFullYear());
  const label = String(body.label || `Appraisal ${year}`).trim();
  try {
    db.prepare(
      `INSERT INTO hr_appraisal_cycles (id, label, year, due_by_iso, status, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(id, label, year, String(body.dueByIso || '').trim().slice(0, 10) || null, 'open', now);
    appendHrAuditEvent(db, {
      actorUserId: actor?.id || null,
      action: 'hr.appraisal.cycle_create',
      entityKind: 'hr_appraisal_cycle',
      entityId: id,
      details: { year },
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function listHrAppraisalForms(db, cycleId) {
  try {
    return db
      .prepare(
        `SELECT id, cycle_id AS cycleId, subject_user_id AS subjectUserId, reviewer_user_id AS reviewerUserId,
                scores_json AS scoresJson, md_confirmed AS mdConfirmed, status, created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso
         FROM hr_appraisal_forms WHERE cycle_id = ?`
      )
      .all(String(cycleId || '').trim());
  } catch {
    return [];
  }
}

export function upsertHrAppraisalForm(db, actor, body = {}) {
  const cycleId = String(body.cycleId || '').trim();
  const subjectUserId = String(body.subjectUserId || '').trim();
  if (!cycleId || !subjectUserId) return { ok: false, error: 'cycleId and subjectUserId are required.' };
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM hr_appraisal_forms WHERE cycle_id = ? AND subject_user_id = ?`)
    .get(cycleId, subjectUserId);
  const scoresJson = body.scores != null ? JSON.stringify(body.scores) : null;
  try {
    if (existing) {
      db.prepare(
        `UPDATE hr_appraisal_forms SET reviewer_user_id = COALESCE(?, reviewer_user_id),
         scores_json = COALESCE(?, scores_json), md_confirmed = COALESCE(?, md_confirmed),
         status = COALESCE(?, status), updated_at_iso = ? WHERE id = ?`
      ).run(
        body.reviewerUserId !== undefined ? String(body.reviewerUserId || '').trim() || null : null,
        scoresJson,
        body.mdConfirmed !== undefined ? (body.mdConfirmed ? 1 : 0) : null,
        body.status !== undefined ? String(body.status || '').trim() || null : null,
        now,
        existing.id
      );
      return { ok: true, id: existing.id };
    }
    const id = newId('HRAPF');
    db.prepare(
      `INSERT INTO hr_appraisal_forms (id, cycle_id, subject_user_id, reviewer_user_id, scores_json, md_confirmed, status, created_at_iso, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      cycleId,
      subjectUserId,
      String(body.reviewerUserId || '').trim() || null,
      scoresJson,
      body.mdConfirmed ? 1 : 0,
      String(body.status || 'draft').trim() || 'draft',
      now,
      now
    );
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function listHrFeedbackNotes(db, subjectUserId) {
  try {
    return db
      .prepare(
        `SELECT id, subject_user_id AS subjectUserId, author_user_id AS authorUserId, body, created_at_iso AS createdAtIso
         FROM hr_feedback_notes WHERE subject_user_id = ? ORDER BY created_at_iso DESC LIMIT 100`
      )
      .all(String(subjectUserId || '').trim());
  } catch {
    return [];
  }
}

export function createHrFeedbackNote(db, actor, body = {}) {
  const subjectUserId = String(body.subjectUserId || '').trim();
  const text = String(body.body || '').trim();
  if (!subjectUserId || text.length < 2) return { ok: false, error: 'subjectUserId and body are required.' };
  const id = newId('HRFB');
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO hr_feedback_notes (id, subject_user_id, author_user_id, body, created_at_iso)
       VALUES (?,?,?,?,?)`
    ).run(id, subjectUserId, actor?.id || null, text, now);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function runHrScheduledJobs(db) {
  if (!hrTablesReady(db)) return { ok: false, error: 'no_hr' };
  try {
    const row = db
      .prepare(`SELECT finished_at_iso FROM hr_job_runs WHERE job_key = ? ORDER BY started_at_iso DESC LIMIT 1`)
      .get('hr.daily_tick');
    const last = row?.finished_at_iso ? Date.parse(String(row.finished_at_iso)) : 0;
    if (last && Date.now() - last < 60 * 60 * 1000) return { ok: true, skipped: true };
    const id = newId('HRJOB');
    const now = nowIso();
    db.prepare(
      `INSERT INTO hr_job_runs (id, job_key, started_at_iso, finished_at_iso, status, detail_json) VALUES (?,?,?,?,?,?)`
    ).run(id, 'hr.daily_tick', now, now, 'ok', JSON.stringify({ tick: true }));
    return { ok: true, jobId: id };
  } catch {
    return { ok: false, error: 'job_table' };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {'active' | 'inactive'} status
 * @param {string} actorUserId
 */
export function setAppUserAccountStatus(db, userId, status, actorUserId) {
  const s = String(status || '').trim().toLowerCase();
  if (s !== 'active' && s !== 'inactive') {
    return { ok: false, error: 'Status must be active or inactive.' };
  }
  if (userId === actorUserId) {
    return { ok: false, error: 'You cannot change your own account status.' };
  }
  const row = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(userId);
  if (!row) return { ok: false, error: 'User not found.' };
  db.prepare(`UPDATE app_users SET status = ? WHERE id = ?`).run(s, userId);
  return { ok: true };
}

export function deleteHrRequestDraft(db, requestId, userId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (row.user_id !== userId) return { ok: false, error: 'Not your request.' };
  if (row.status !== 'draft') return { ok: false, error: 'Only drafts can be deleted.' };
  db.prepare(`DELETE FROM hr_requests WHERE id = ?`).run(requestId);
  return { ok: true };
}

export function registerNewStaffWithProfile(db, actorUserId, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const created = createAppUserRecord(db, {
    username: body.username,
    displayName: body.displayName,
    password: body.password,
    roleKey: body.roleKey,
    workspaceDepartment: body.workspaceDepartment,
  });
  if (!created.ok) return created;
  const up = upsertHrStaffProfile(db, actorUserId, {
    userId: created.userId,
    branchId: String(body?.branchId || '').trim() || DEFAULT_BRANCH_ID,
    employeeNo: body?.employeeNo,
    jobTitle: body?.jobTitle,
    department: body?.department,
    employmentType: body?.employmentType || 'permanent',
    dateJoinedIso: body?.dateJoinedIso,
    baseSalaryNgn: body?.baseSalaryNgn ?? 0,
    housingAllowanceNgn: body?.housingAllowanceNgn ?? 0,
    transportAllowanceNgn: body?.transportAllowanceNgn ?? 0,
    minimumQualification: body?.minimumQualification,
    academicQualification: body?.academicQualification,
  });
  if (!up.ok) return up;
  return { ok: true, userId: created.userId, profile: up.profile };
}

/**
 * Seed default profiles so payroll and branch filters work on demo DBs.
 * @param {import('better-sqlite3').Database} db
 */
export function seedHrIfEmpty(db) {
  if (!hrTablesReady(db)) return;
  const c = db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles`).get().c;
  if (c > 0) return;
  const now = nowIso();
  const users = db.prepare(`SELECT id, username FROM app_users WHERE status = 'active'`).all();
  const ins = db.prepare(
    `INSERT INTO hr_staff_profiles (
      user_id, branch_id, employee_no, job_title, department, employment_type, date_joined_iso,
      base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, minimum_qualification, promotion_grade,
      updated_at_iso, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const u of users) {
    const branch = u.username === 'branch.manager' ? 'BR-YL' : 'BR-KD';
    const no = `EMP-${String(u.id).replace(/\W/g, '').slice(-6).toUpperCase()}`;
    ins.run(
      u.id,
      branch,
      no,
      'Team member',
      'Operations',
      'permanent',
      '2024-01-15',
      250_000,
      40_000,
      20_000,
      'Role-aligned minimum (see HR manual)',
      'Grade TBD',
      now,
      null
    );
  }
  const leaveDemo = JSON.stringify({
    leaveRecord: {
      periodYear: new Date().getFullYear().toString(),
      annualEntitlementDays: 21,
      daysUsedApproved: 4,
      personnelFileRef: 'HR-PF-DEMO (sample — HR replaces with your file ref)',
    },
  });
  db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ? WHERE profile_extra_json IS NULL`).run(leaveDemo);
}
