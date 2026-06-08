import crypto from 'node:crypto';
import { canUseAllBranchesRollup, createAppUserRecord, roleLabel, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  annualLeaveEntitlementDaysForUser,
  calculateSeveranceEntitlement,
  countWorkingDaysInclusive,
  getHrPolicyPayload,
  isApprovedLeaveOnDay,
  validateStaffLoanApplication,
} from './hrBusinessRules.js';
import { provisionStaffLoanForFinanceQueue } from './writeOps.js';
import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { enrichStaffWithOnboarding } from './hrStaffDocuments.js';
import { enrichStaffWithLifecycle } from './hrStaffLifecycle.js';
import { buildHrOrgChart, hrStaffReportingContext } from '../shared/lib/hrOrgChart.js';
import {
  notifyAppraisalFormOpened,
  notifyHrRequestOutcome,
  notifyPayrollRunStatus,
} from './hrNotifications.js';
import { encryptBankAccount, maskBankAccount, decryptBankAccount, storedBankToMasked } from './hrBankCrypto.js';
import { getHrDepartment, getHrDesignation } from './hrMasterData.js';
import { getDepartmentHeadDepartmentIds, resolveHrScopeMode } from './hrTeamScope.js';
import { bankAccountNameMatchesStaff, computeProfileCompleteness } from './hrProfileCompleteness.js';
import { hrCoreTablesReady, hrTableExists } from './hrTableChecks.js';

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

export function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} v */
function normalizeRollTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
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
    bankAccountNameMismatch:
      Boolean(String(row.bankAccountName || '').trim()) && !bankAccountNameMatchesStaff(row),
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
  return hrCoreTablesReady(db);
}

/**
 * @param {{ user: object; workspaceBranchId?: string; workspaceViewAll?: boolean }} req
 */
export function hrListScope(req) {
  const viewAll = Boolean(req.workspaceViewAll) && canUseAllBranchesRollup(req.user);
  const branchId = String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
  const scopeMode = resolveHrScopeMode(req.user, req.query?.scope);
  const actorUserId = String(req.user?.id || '').trim() || null;
  return { viewAll, branchId, scopeMode, actorUserId };
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
           u.avatar_url AS avatarUrl,
           p.branch_id AS branchId, p.employee_no AS employeeNo, p.job_title AS jobTitle, p.department,
           p.department_id AS departmentId, p.designation_id AS designationId,
           p.employment_type AS employmentType, p.date_joined_iso AS dateJoinedIso,
           p.contract_end_iso AS contractEndIso,
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
           p.nin_number AS ninNumber,
           p.gender, p.date_of_birth AS dateOfBirthIso, p.nhis_provider AS nhisProvider,
           p.nhis_deduction_ngn AS nhisDeductionNgn,
           p.profile_extra_json AS profileExtraJson,
           p.line_manager_user_id AS lineManagerUserId,
           p.leave_entitlement_band AS leaveEntitlementBand,
           p.payroll_group AS payrollGroup,
           p.salary_level AS salaryLevel,
           p.salary_step AS salaryStep
    FROM app_users u
    LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
    WHERE 1=1
  `;
  const args = [];
  if (!includeInactive) {
    sql += ` AND u.status = 'active'`;
  }
  if (!viewAll) {
    const scopeMode = scope.scopeMode || 'branch';
    const actorUserId = scope.actorUserId;
    if (scopeMode === 'team' && actorUserId) {
      sql += ` AND p.line_manager_user_id = ?`;
      args.push(actorUserId);
    } else if (scopeMode === 'department' && actorUserId) {
      const deptIds = getDepartmentHeadDepartmentIds(db, actorUserId);
      if (deptIds.length) {
        const ph = deptIds.map(() => '?').join(',');
        sql += ` AND (p.department_id IN (${ph}) OR p.line_manager_user_id = ?)`;
        args.push(...deptIds, actorUserId);
      } else {
        sql += ` AND p.line_manager_user_id = ?`;
        args.push(actorUserId);
      }
    } else if (includeUnassigned) {
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
  return rows.map((row) => {
    const base = {
      ...row,
      selfServiceEligible: Boolean(Number(row.selfServiceEligible)),
      nextOfKin: safeJsonParse(row.nextOfKinJson, null),
      nextOfKinJson: undefined,
      profileExtra: safeJsonParse(row.profileExtraJson, {}),
      profileExtraJson: undefined,
      ...buildStaffDerived(row, complianceByUserId),
    };
    const compliance = complianceByUserId.get(String(row.userId)) || {};
    base.profileCompleteness = computeProfileCompleteness(base, {
      handbookAcknowledged: compliance.handbookAcknowledged,
    });
    return base;
  });
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
  const staff = list.find((s) => s.userId === userId) ?? null;
  if (!staff) return null;
  const reporting = hrStaffReportingContext(list, userId);
  const enriched = enrichStaffWithLifecycle(enrichStaffWithOnboarding(db, staff, staff.avatarUrl));
  return {
    ...enriched,
    lineManager: reporting.lineManager,
    lineManagerDisplayName: reporting.lineManager?.displayName || null,
    directReports: reporting.directReports,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string; includeUnassigned?: boolean }} scope
 */
export function getHrOrgChart(db, scope) {
  if (!hrTablesReady(db)) return { roots: [], orphans: [], total: 0 };
  const staff = listHrStaff(db, scope, { includeInactive: false });
  return buildHrOrgChart(staff);
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
export function upsertHrStaffProfile(db, actorUserId, body, opts = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const allowInactive = Boolean(opts.allowInactive);
  const u = allowInactive
    ? db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(userId)
    : db.prepare(`SELECT id FROM app_users WHERE id = ? AND status = 'active'`).get(userId);
  if (!u) return { ok: false, error: allowInactive ? 'User not found.' : 'User not found or inactive.' };

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

  const nullablePosInt = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
  };

  const payrollGroup =
    body?.payrollGroup !== undefined
      ? String(body.payrollGroup || '').trim() || null
      : prevRow?.payroll_group ?? null;
  const salaryLevel =
    body?.salaryLevel !== undefined ? nullablePosInt(body.salaryLevel) : prevRow?.salary_level ?? null;
  const salaryStep =
    body?.salaryStep !== undefined ? nullablePosInt(body.salaryStep) : prevRow?.salary_step ?? null;

  let departmentId =
    body?.departmentId !== undefined
      ? String(body.departmentId || '').trim() || null
      : prevRow?.department_id ?? null;
  let designationId =
    body?.designationId !== undefined
      ? String(body.designationId || '').trim() || null
      : prevRow?.designation_id ?? null;
  let department =
    body?.department !== undefined ? String(body.department ?? '').trim() || null : prevRow?.department ?? null;
  let jobTitle =
    body?.jobTitle !== undefined ? String(body.jobTitle ?? '').trim() || null : prevRow?.job_title ?? null;
  let resolvedSalaryLevel = salaryLevel;
  let resolvedSalaryStep = salaryStep;
  let resolvedPromotionGrade =
    body?.promotionGrade !== undefined
      ? String(body.promotionGrade ?? '').trim() || null
      : prevRow?.promotion_grade ?? null;

  if (departmentId) {
    const dept = getHrDepartment(db, departmentId);
    if (dept?.name) department = dept.name;
  }
  if (designationId) {
    const des = getHrDesignation(db, designationId);
    if (des) {
      if (des.title) jobTitle = des.title;
      if (body?.salaryLevel === undefined && des.defaultSalaryLevel != null) {
        resolvedSalaryLevel = des.defaultSalaryLevel;
      }
      if (body?.salaryStep === undefined && des.defaultSalaryStep != null) {
        resolvedSalaryStep = des.defaultSalaryStep;
      }
      if (body?.promotionGrade === undefined && des.seniorityBand) {
        resolvedPromotionGrade = des.seniorityBand;
      }
    }
  }

  const prevExtra = safeJsonParse(prevExtraRow?.profile_extra_json, {});
  const personalPatch = body?.personal && typeof body.personal === 'object' ? body.personal : null;
  const profileExtraMerged = (() => {
    if (body?.profileExtra != null) return body.profileExtra;
    const extra = { ...prevExtra };
    if (personalPatch) extra.personal = { ...(extra.personal || {}), ...personalPatch };
    if (body?.employmentStatus !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), employmentStatus: body.employmentStatus || null };
    }
    if (body?.workLocation !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), workLocation: String(body.workLocation || '').trim() || null };
    }
    if (body?.confirmationDateIso !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), confirmationDateIso: body.confirmationDateIso || null };
    }
    if (body?.hrInternalNotes !== undefined) {
      extra.hrNotes = { ...(extra.hrNotes || {}), internalRemarks: body.hrInternalNotes || null };
    }
    if (body?.specialConditions !== undefined) {
      extra.hrNotes = { ...(extra.hrNotes || {}), specialConditions: body.specialConditions || null };
    }
    if (body?.supervisorName !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), supervisorName: body.supervisorName || null };
    }
    if (body?.salaryStatus !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), salaryStatus: body.salaryStatus || null };
    }
    if (body?.payrollRemarks !== undefined) {
      extra.employmentMeta = { ...(extra.employmentMeta || {}), payrollRemarks: body.payrollRemarks || null };
    }
    if (body?.pensionAdministrator !== undefined) {
      extra.statutory = { ...(extra.statutory || {}), pensionAdministrator: body.pensionAdministrator || null };
    }
    if (body?.nhisNumber !== undefined) {
      extra.statutory = { ...(extra.statutory || {}), nhisNumber: body.nhisNumber || null };
    }
    if (body?.professionalCertificates !== undefined) {
      extra.qualifications = { ...(extra.qualifications || {}), professionalCertificates: body.professionalCertificates || null };
    }
    if (body?.firstName !== undefined || body?.phone !== undefined) {
      extra.personal = {
        ...(extra.personal || {}),
        ...(body.firstName !== undefined ? { firstName: String(body.firstName || '').trim() || null } : {}),
        ...(body.middleName !== undefined ? { middleName: String(body.middleName || '').trim() || null } : {}),
        ...(body.surname !== undefined ? { surname: String(body.surname || '').trim() || null } : {}),
        ...(body.phone !== undefined ? { phone: String(body.phone || '').trim() || null } : {}),
        ...(body.personalEmail !== undefined ? { email: String(body.personalEmail || '').trim() || null } : {}),
        ...(body.maritalStatus !== undefined ? { maritalStatus: String(body.maritalStatus || '').trim() || null } : {}),
        ...(body.residentialAddress !== undefined ? { residentialAddress: String(body.residentialAddress || '').trim() || null } : {}),
        ...(body.stateOfOrigin !== undefined ? { stateOfOrigin: String(body.stateOfOrigin || '').trim() || null } : {}),
        ...(body.localGovernment !== undefined ? { localGovernment: String(body.localGovernment || '').trim() || null } : {}),
        ...(body.nationality !== undefined ? { nationality: String(body.nationality || '').trim() || null } : {}),
        ...(body.bloodGroup !== undefined ? { bloodGroup: String(body.bloodGroup || '').trim() || null } : {}),
        ...(body.institution !== undefined ? { institution: String(body.institution || '').trim() || null } : {}),
        ...(body.courseField !== undefined ? { courseField: String(body.courseField || '').trim() || null } : {}),
        ...(body.yearCompleted !== undefined ? { yearCompleted: String(body.yearCompleted || '').trim() || null } : {}),
      };
    }
    return Object.keys(extra).length ? extra : prevExtraRow ? prevExtra : null;
  })();

  const row = {
    user_id: userId,
    branch_id: branchId,
    employee_no: String(body?.employeeNo ?? '').trim() || null,
    job_title: jobTitle,
    department,
    department_id: departmentId,
    designation_id: designationId,
    employment_type: String(body?.employmentType ?? '').trim() || null,
    date_joined_iso: String(body?.dateJoinedIso ?? '').trim() || null,
    probation_end_iso: String(body?.probationEndIso ?? '').trim() || null,
    bank_account_name: String(body?.bankAccountName ?? '').trim() || null,
    bank_name: String(body?.bankName ?? '').trim() || null,
    bank_account_no_masked: String(body?.bankAccountNoMasked ?? '').trim() || null,
    tax_id: String(body?.taxId ?? '').trim() || null,
    pension_rsa_pin: String(body?.pensionRsaPin ?? '').trim() || null,
    next_of_kin_json:
      body?.nextOfKin !== undefined
        ? body.nextOfKin != null
          ? JSON.stringify(body.nextOfKin)
          : null
        : prevRow?.next_of_kin_json ?? null,
    nin_number:
      body?.ninNumber !== undefined
        ? String(body.ninNumber ?? '').trim() || null
        : prevRow?.nin_number ?? null,
    base_salary_ngn: Math.max(0, Math.round(Number(body?.baseSalaryNgn) || 0)),
    housing_allowance_ngn: Math.max(0, Math.round(Number(body?.housingAllowanceNgn) || 0)),
    transport_allowance_ngn: Math.max(0, Math.round(Number(body?.transportAllowanceNgn) || 0)),
    bonus_accrual_note: String(body?.bonusAccrualNote ?? '').trim() || null,
    minimum_qualification: String(body?.minimumQualification ?? '').trim() || null,
    academic_qualification: String(body?.academicQualification ?? '').trim() || null,
    promotion_grade: resolvedPromotionGrade,
    welfare_notes: String(body?.welfareNotes ?? '').trim() || null,
    training_summary: String(body?.trainingSummary ?? '').trim() || null,
    paye_tax_percent: nullableNonNegNumber(body?.payeTaxPercent),
    pension_percent_override: nullableNonNegNumber(body?.pensionPercentOverride),
    profile_extra_json:
      profileExtraMerged != null
        ? JSON.stringify(profileExtraMerged)
        : prevExtraRow
          ? prevExtraRow.profile_extra_json
          : null,
    updated_at_iso: now,
    updated_by_user_id: actorUserId,
    self_service_eligible: selfServiceEligible,
    line_manager_user_id: lineManagerUserId,
    leave_entitlement_band: leaveEntitlementBand,
    payroll_group: payrollGroup,
    salary_level: resolvedSalaryLevel,
    salary_step: resolvedSalaryStep,
    // New Phase 10 fields
    gender:
      body?.gender !== undefined
        ? String(body.gender ?? '').trim() || null
        : prevRow?.gender ?? null,
    date_of_birth:
      body?.dateOfBirth !== undefined
        ? String(body.dateOfBirth ?? '').trim() || null
        : body?.dateOfBirthIso !== undefined
          ? String(body.dateOfBirthIso ?? '').trim() || null
          : prevRow?.date_of_birth ?? null,
    contract_end_iso:
      body?.contractEndIso !== undefined
        ? String(body.contractEndIso ?? '').trim() || null
        : prevRow?.contract_end_iso ?? null,
    nhis_deduction_ngn:
      body?.nhisDeductionNgn !== undefined
        ? nullableNonNegNumber(body.nhisDeductionNgn) ?? 0
        : body?.nhisMonthlyDeductionNgn !== undefined
          ? nullableNonNegNumber(body.nhisMonthlyDeductionNgn) ?? 0
          : prevRow?.nhis_deduction_ngn ?? 0,
    nhis_provider:
      body?.nhisProvider !== undefined
        ? String(body.nhisProvider ?? '').trim() || null
        : prevRow?.nhis_provider ?? null,
  };

  if (existing) {
    const prevBranchId = prevRow?.branch_id ? String(prevRow.branch_id) : null;
    try {
      db.prepare(
        `UPDATE hr_staff_profiles SET
          branch_id=@branch_id, employee_no=@employee_no, job_title=@job_title, department=@department,
          department_id=@department_id, designation_id=@designation_id,
          employment_type=@employment_type, date_joined_iso=@date_joined_iso, probation_end_iso=@probation_end_iso,
          bank_account_name=@bank_account_name, bank_name=@bank_name, bank_account_no_masked=@bank_account_no_masked,
          tax_id=@tax_id, pension_rsa_pin=@pension_rsa_pin, next_of_kin_json=@next_of_kin_json, nin_number=@nin_number,
          base_salary_ngn=@base_salary_ngn, housing_allowance_ngn=@housing_allowance_ngn,
          transport_allowance_ngn=@transport_allowance_ngn, bonus_accrual_note=@bonus_accrual_note,
          minimum_qualification=@minimum_qualification, academic_qualification=@academic_qualification,
          promotion_grade=@promotion_grade,
          welfare_notes=@welfare_notes, training_summary=@training_summary,
          paye_tax_percent=@paye_tax_percent, pension_percent_override=@pension_percent_override,
          profile_extra_json=@profile_extra_json,
          self_service_eligible=@self_service_eligible,
          line_manager_user_id=@line_manager_user_id, leave_entitlement_band=@leave_entitlement_band,
          payroll_group=@payroll_group, salary_level=@salary_level, salary_step=@salary_step,
          gender=@gender, date_of_birth=@date_of_birth, contract_end_iso=@contract_end_iso,
          nhis_deduction_ngn=@nhis_deduction_ngn, nhis_provider=@nhis_provider,
          updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
        WHERE user_id=@user_id`
      ).run(row);
    } catch {
      // Fallback for old DBs where new columns may not exist yet (migration should have run)
      db.prepare(
        `UPDATE hr_staff_profiles SET
          branch_id=@branch_id, employee_no=@employee_no, job_title=@job_title, department=@department,
          department_id=@department_id, designation_id=@designation_id,
          employment_type=@employment_type, date_joined_iso=@date_joined_iso, probation_end_iso=@probation_end_iso,
          bank_account_name=@bank_account_name, bank_name=@bank_name, bank_account_no_masked=@bank_account_no_masked,
          tax_id=@tax_id, pension_rsa_pin=@pension_rsa_pin, next_of_kin_json=@next_of_kin_json, nin_number=@nin_number,
          base_salary_ngn=@base_salary_ngn, housing_allowance_ngn=@housing_allowance_ngn,
          transport_allowance_ngn=@transport_allowance_ngn, bonus_accrual_note=@bonus_accrual_note,
          minimum_qualification=@minimum_qualification, academic_qualification=@academic_qualification,
          promotion_grade=@promotion_grade,
          welfare_notes=@welfare_notes, training_summary=@training_summary,
          paye_tax_percent=@paye_tax_percent, pension_percent_override=@pension_percent_override,
          profile_extra_json=@profile_extra_json,
          self_service_eligible=@self_service_eligible,
          line_manager_user_id=@line_manager_user_id, leave_entitlement_band=@leave_entitlement_band,
          payroll_group=@payroll_group, salary_level=@salary_level, salary_step=@salary_step,
          updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
        WHERE user_id=@user_id`
      ).run(row);
    }
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
    try {
      db.prepare(
        `INSERT INTO hr_staff_profiles (
          user_id, branch_id, employee_no, job_title, department, department_id, designation_id,
          employment_type, date_joined_iso, probation_end_iso,
          bank_account_name, bank_name, bank_account_no_masked, tax_id, pension_rsa_pin, next_of_kin_json, nin_number,
          base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, bonus_accrual_note,
          minimum_qualification, academic_qualification, promotion_grade, welfare_notes, training_summary,
          paye_tax_percent, pension_percent_override, profile_extra_json, self_service_eligible,
          line_manager_user_id, leave_entitlement_band, payroll_group, salary_level, salary_step,
          gender, date_of_birth, contract_end_iso, nhis_deduction_ngn, nhis_provider,
          updated_at_iso, updated_by_user_id
        ) VALUES (
          @user_id, @branch_id, @employee_no, @job_title, @department, @department_id, @designation_id,
          @employment_type, @date_joined_iso, @probation_end_iso,
          @bank_account_name, @bank_name, @bank_account_no_masked, @tax_id, @pension_rsa_pin, @next_of_kin_json, @nin_number,
          @base_salary_ngn, @housing_allowance_ngn, @transport_allowance_ngn, @bonus_accrual_note,
          @minimum_qualification, @academic_qualification, @promotion_grade, @welfare_notes, @training_summary,
          @paye_tax_percent, @pension_percent_override, @profile_extra_json, @self_service_eligible,
          @line_manager_user_id, @leave_entitlement_band, @payroll_group, @salary_level, @salary_step,
          @gender, @date_of_birth, @contract_end_iso, @nhis_deduction_ngn, @nhis_provider,
          @updated_at_iso, @updated_by_user_id
        )`
      ).run(row);
    } catch {
      // Fallback for old DBs where new columns may not exist yet
      db.prepare(
        `INSERT INTO hr_staff_profiles (
          user_id, branch_id, employee_no, job_title, department, employment_type, date_joined_iso, probation_end_iso,
          bank_account_name, bank_name, bank_account_no_masked, tax_id, pension_rsa_pin, next_of_kin_json, nin_number,
          base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, bonus_accrual_note,
          minimum_qualification, academic_qualification, promotion_grade, welfare_notes, training_summary,
          paye_tax_percent, pension_percent_override, profile_extra_json, self_service_eligible,
          line_manager_user_id, leave_entitlement_band, payroll_group, salary_level, salary_step,
          updated_at_iso, updated_by_user_id
        ) VALUES (
          @user_id, @branch_id, @employee_no, @job_title, @department, @employment_type, @date_joined_iso, @probation_end_iso,
          @bank_account_name, @bank_name, @bank_account_no_masked, @tax_id, @pension_rsa_pin, @next_of_kin_json, @nin_number,
          @base_salary_ngn, @housing_allowance_ngn, @transport_allowance_ngn, @bonus_accrual_note,
          @minimum_qualification, @academic_qualification, @promotion_grade, @welfare_notes, @training_summary,
          @paye_tax_percent, @pension_percent_override, @profile_extra_json, @self_service_eligible,
          @line_manager_user_id, @leave_entitlement_band, @payroll_group, @salary_level, @salary_step,
          @updated_at_iso, @updated_by_user_id
        )`
      ).run(row);
    }
  }
  if (existing && prevRow) {
    const before = compensationSnapshotFromProfileRow(prevRow);
    const after = compensationSnapshotFromProfileRow(row);
    if (compensationChanged(before, after)) {
      const reason =
        String(body?.salaryChangeReason || body?.reason || '').trim() || 'Compensation update';
      insertHrSalaryHistoryRow(db, actorUserId, userId, {
        effectiveFromIso: String(body?.effectiveFromIso || '').slice(0, 10) || now.slice(0, 10),
        salaryLevel: after.salaryLevel,
        salaryStep: after.salaryStep,
        baseSalaryNgn: after.baseSalaryNgn,
        housingAllowanceNgn: after.housingAllowanceNgn,
        transportAllowanceNgn: after.transportAllowanceNgn,
        reason,
      });
    }
  }

  if (body?.bankAccountNo !== undefined || body?.bankCode !== undefined) {
    try {
      if (body?.bankAccountNo !== undefined) {
        const plain = String(body.bankAccountNo || '').replace(/\s/g, '');
        if (plain) {
          const encrypted = encryptBankAccount(plain);
          const masked = maskBankAccount(plain);
          db.prepare(
            `UPDATE hr_staff_profiles SET bank_account_no = ?, bank_account_no_masked = ? WHERE user_id = ?`
          ).run(encrypted, masked, userId);
        } else {
          db.prepare(
            `UPDATE hr_staff_profiles SET bank_account_no = NULL, bank_account_no_masked = NULL WHERE user_id = ?`
          ).run(userId);
        }
      }
      if (body?.bankCode !== undefined) {
        db.prepare(`UPDATE hr_staff_profiles SET bank_code = ? WHERE user_id = ?`).run(
          body?.bankCode != null ? String(body.bankCode).trim() || null : prevRow?.bank_code ?? null,
          userId
        );
      }
    } catch {
      /* column may not exist pre-migration */
    }
  }

  appendHrAuditEvent(db, {
    actorUserId,
    action: existing ? 'hr.staff.profile_updated' : 'hr.staff.profile_created',
    entityKind: 'hr_staff_profile',
    entityId: userId,
    branchId,
    details: { employeeNo: row.employee_no, jobTitle: row.job_title },
  });
  return {
    ok: true,
    profile: opts.skipEnrichedReturn ? null : getHrStaffOne(db, userId),
  };
}

function compensationSnapshotFromProfileRow(row) {
  if (!row) return null;
  return {
    baseSalaryNgn: Math.round(Number(row.base_salary_ngn) || 0),
    housingAllowanceNgn: Math.round(Number(row.housing_allowance_ngn) || 0),
    transportAllowanceNgn: Math.round(Number(row.transport_allowance_ngn) || 0),
    salaryLevel: row.salary_level != null ? Number(row.salary_level) : null,
    salaryStep: row.salary_step != null ? Number(row.salary_step) : null,
  };
}

function compensationChanged(before, after) {
  if (!before || !after) return false;
  return (
    before.baseSalaryNgn !== after.baseSalaryNgn ||
    before.housingAllowanceNgn !== after.housingAllowanceNgn ||
    before.transportAllowanceNgn !== after.transportAllowanceNgn ||
    before.salaryLevel !== after.salaryLevel ||
    before.salaryStep !== after.salaryStep
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {string} userId
 * @param {object} entry
 */
export function insertHrSalaryHistoryRow(db, actorUserId, userId, entry) {
  if (!hrTablesReady(db)) return null;
  const id = newId('HRSH');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_salary_history (
      id, user_id, effective_from_iso, salary_level, salary_step,
      base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, reason, actor_user_id, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    String(entry.effectiveFromIso || '').slice(0, 10) || now.slice(0, 10),
    entry.salaryLevel != null ? Math.round(Number(entry.salaryLevel)) : null,
    entry.salaryStep != null ? Math.round(Number(entry.salaryStep)) : null,
    Math.round(Number(entry.baseSalaryNgn) || 0),
    Math.round(Number(entry.housingAllowanceNgn) || 0),
    Math.round(Number(entry.transportAllowanceNgn) || 0),
    String(entry.reason || '').trim() || null,
    actorUserId,
    now
  );
  return id;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {number} [limit]
 */
export function listHrSalaryHistory(db, userId, limit = 40) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTablesReady(db)) return [];
  const cap = Math.min(100, Math.max(1, Math.round(Number(limit) || 40)));
  try {
    return db
      .prepare(
        `SELECT id, user_id AS userId, effective_from_iso AS effectiveFromIso,
                salary_level AS salaryLevel, salary_step AS salaryStep,
                base_salary_ngn AS baseSalaryNgn, housing_allowance_ngn AS housingAllowanceNgn,
                transport_allowance_ngn AS transportAllowanceNgn, reason, actor_user_id AS actorUserId,
                created_at_iso AS createdAtIso
         FROM hr_salary_history WHERE user_id = ? ORDER BY effective_from_iso DESC, created_at_iso DESC LIMIT ?`
      )
      .all(uid, cap);
  } catch {
    return [];
  }
}

/**
 * Record a salary increment (updates profile + history row).
 * @param {import('better-sqlite3').Database} db
 * @param {string} actorUserId
 * @param {string} userId
 * @param {object} body
 */
export function applyHrSalaryIncrement(db, actorUserId, userId, body) {
  const reason = String(body?.reason || '').trim();
  if (reason.length < 3) return { ok: false, error: 'Reason is required (minimum 3 characters).' };
  return upsertHrStaffProfile(db, actorUserId, {
    userId,
    effectiveFromIso: String(body?.effectiveFromIso || '').slice(0, 10),
    salaryChangeReason: reason,
    payrollGroup: body?.payrollGroup,
    salaryLevel: body?.salaryLevel,
    salaryStep: body?.salaryStep,
    baseSalaryNgn: body?.baseSalaryNgn,
    housingAllowanceNgn: body?.housingAllowanceNgn,
    transportAllowanceNgn: body?.transportAllowanceNgn,
  });
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
    const exceptionalLoan = Boolean(p.exceptionalLoan);
    if (!exceptionalLoan) {
      const loanVal = validateStaffLoanApplication(db, userId, { amountNgn, repaymentMonths });
      if (!loanVal.ok) {
        return { ok: false, error: loanVal.error || 'Loan does not meet policy.' };
      }
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

export function hrReviewRequest(db, requestId, actor, approve, note, reasonCode) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (!row) return { ok: false, error: 'Request not found.' };
  if (row.status !== 'hr_review') {
    return { ok: false, error: 'Request is not awaiting HR review.' };
  }
  const rc = normalizeReasonCode(reasonCode);
  const noteNorm = String(note || '').trim();
  if (!DECISION_REASON_CODES.has(rc)) {
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
    const rejected = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
    if (rejected && (rejected.kind === 'leave' || rejected.kind === 'loan')) {
      notifyHrRequestOutcome(db, rejected, 'rejected');
    }
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
    const rejected = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
    if (rejected && (rejected.kind === 'leave' || rejected.kind === 'loan')) {
      notifyHrRequestOutcome(db, rejected, 'rejected');
    }
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
    const rejected = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
    if (rejected && (rejected.kind === 'leave' || rejected.kind === 'loan')) {
      notifyHrRequestOutcome(db, rejected, 'rejected');
    }
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
    const approved = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
    if (approved && (approved.kind === 'leave' || approved.kind === 'loan')) {
      notifyHrRequestOutcome(db, approved, 'approved');
    }
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
  const approved = db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get(requestId);
  if (approved && (approved.kind === 'leave' || approved.kind === 'loan')) {
    notifyHrRequestOutcome(db, approved, 'approved');
  }
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
    .map((r) => {
      const userId = String(r?.userId || '').trim();
      if (!userId) return null;
      const statusRaw = String(r?.status || 'present').toLowerCase();
      const status = statusRaw === 'late' || statusRaw === 'absent' ? statusRaw : 'present';
      const inTime = normalizeRollTime(r?.inTime);
      const outTime = normalizeRollTime(r?.outTime);
      return { userId, status, ...(inTime ? { inTime } : {}), ...(outTime ? { outTime } : {}) };
    })
    .filter(Boolean);
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

/**
 * HR review queue: projected attendance deductions for a payroll month (no auto-apply).
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {string} periodYyyymm
 */
export function listHrAttendanceDeductionPreview(db, scope, periodYyyymm) {
  if (!hrTablesReady(db)) return [];
  const period = String(periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(period)) return [];
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const out = [];
  for (const s of staff) {
    const preview = attendanceDeductionForUser(db, s.userId, s.branchId, period);
    if (
      preview.absentDays <= 0 &&
      preview.lateDays <= 0 &&
      preview.deductionNgn <= 0
    ) {
      continue;
    }
    const pendingException = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hr_requests
         WHERE user_id = ? AND kind = 'attendance_exception'
           AND status IN ('draft','hr_review','branch_manager_review','gm_hr_review')`
      )
      .get(s.userId)?.c;
    out.push({
      userId: s.userId,
      displayName: s.displayName,
      employeeNo: s.employeeNo,
      branchId: s.branchId,
      jobTitle: s.jobTitle,
      ...preview,
      pendingExceptionRequests: Number(pendingException) || 0,
      recommendation:
        'Review lateness/absence before payroll lock. Deductions apply at payroll run only — raise an attendance exception request if warranted.',
    });
  }
  out.sort((a, b) => (b.deductionNgn || 0) - (a.deductionNgn || 0));
  return out;
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

function salaryMatrixReady(db) {
  return Boolean(
    hrTablesReady(db) &&
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_salary_matrix'`).get()
  );
}

export function listHrSalaryMatrix(db) {
  if (!salaryMatrixReady(db)) return [];
  return db
    .prepare(
      `SELECT id, payroll_group AS payrollGroup, salary_level AS salaryLevel, salary_step AS salaryStep,
              base_salary_ngn AS baseSalaryNgn, housing_allowance_ngn AS housingAllowanceNgn,
              transport_allowance_ngn AS transportAllowanceNgn, effective_from_iso AS effectiveFromIso, notes
       FROM hr_salary_matrix ORDER BY payroll_group ASC, salary_level ASC, salary_step ASC`
    )
    .all();
}

export function upsertHrSalaryMatrixRow(db, actor, body = {}) {
  if (!salaryMatrixReady(db)) return { ok: false, error: 'Salary matrix not initialised.' };
  const payrollGroup = String(body.payrollGroup || 'branch_ops').trim();
  const salaryLevel = Math.round(Number(body.salaryLevel) || 0);
  const salaryStep = Math.round(Number(body.salaryStep) || 0);
  if (!payrollGroup || salaryLevel < 1 || salaryStep < 1) {
    return { ok: false, error: 'payrollGroup, salaryLevel, and salaryStep are required.' };
  }
  const existing = db
    .prepare(
      `SELECT id FROM hr_salary_matrix WHERE payroll_group = ? AND salary_level = ? AND salary_step = ?`
    )
    .get(payrollGroup, salaryLevel, salaryStep);
  const id = existing?.id || newId('HRMX');
  const now = nowIso();
  db.prepare(
    `INSERT OR REPLACE INTO hr_salary_matrix (
      id, payroll_group, salary_level, salary_step, base_salary_ngn, housing_allowance_ngn,
      transport_allowance_ngn, effective_from_iso, notes, updated_at_iso, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    payrollGroup,
    salaryLevel,
    salaryStep,
    Math.max(0, Math.round(Number(body.baseSalaryNgn) || 0)),
    Math.max(0, Math.round(Number(body.housingAllowanceNgn) || 0)),
    Math.max(0, Math.round(Number(body.transportAllowanceNgn) || 0)),
    String(body.effectiveFromIso || '').trim().slice(0, 10) || null,
    String(body.notes ?? '').trim() || null,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function listHrBranchPayrollContributions(db, periodYyyymm) {
  if (!salaryMatrixReady(db)) return [];
  const period = String(periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(period)) return [];
  const branchRows = db
    .prepare(
      `SELECT DISTINCT p.branch_id AS branchId FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id AND u.status = 'active'
       WHERE p.branch_id IS NOT NULL AND trim(p.branch_id) != ''`
    )
    .all();
  const out = [];
  for (const b of branchRows) {
    const branchId = String(b.branchId || '').trim();
    const sumRow = db
      .prepare(
        `SELECT SUM(COALESCE(p.base_salary_ngn,0) + COALESCE(p.housing_allowance_ngn,0) + COALESCE(p.transport_allowance_ngn,0)) AS expectedNgn
         FROM hr_staff_profiles p JOIN app_users u ON u.id = p.user_id AND u.status = 'active'
         WHERE p.branch_id = ?`
      )
      .get(branchId);
    const expectedNgn = Math.round(Number(sumRow?.expectedNgn) || 0);
    const existing = db
      .prepare(`SELECT * FROM hr_branch_payroll_contributions WHERE branch_id = ? AND period_yyyymm = ?`)
      .get(branchId, period);
    out.push({
      id: existing?.id || null,
      branchId,
      periodYyyymm: period,
      expectedNgn,
      contributedNgn: Math.round(Number(existing?.contributed_ngn) || 0),
      status: existing?.status || (expectedNgn > 0 && !existing ? 'pending' : 'pending'),
      notes: existing?.notes || null,
      markedAtIso: existing?.marked_at_iso || null,
      outstandingNgn: Math.max(0, expectedNgn - Math.round(Number(existing?.contributed_ngn) || 0)),
    });
  }
  out.sort((a, b) => (b.outstandingNgn || 0) - (a.outstandingNgn || 0));
  return out;
}

export function upsertHrBranchPayrollContribution(db, actor, body = {}) {
  if (!salaryMatrixReady(db)) return { ok: false, error: 'Branch contributions not initialised.' };
  const branchId = String(body.branchId || '').trim();
  const periodYyyymm = String(body.periodYyyymm || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!branchId || !/^\d{6}$/.test(periodYyyymm)) {
    return { ok: false, error: 'branchId and periodYyyymm (YYYYMM) are required.' };
  }
  const contributedNgn = Math.max(0, Math.round(Number(body.contributedNgn) || 0));
  const status = String(body.status || 'recorded').trim().toLowerCase();
  const allowed = new Set(['pending', 'partial', 'recorded', 'waived']);
  if (!allowed.has(status)) return { ok: false, error: 'Invalid contribution status.' };
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM hr_branch_payroll_contributions WHERE branch_id = ? AND period_yyyymm = ?`)
    .get(branchId, periodYyyymm);
  const id = existing?.id || newId('HRBC');
  const list = listHrBranchPayrollContributions(db, periodYyyymm);
  const row = list.find((r) => r.branchId === branchId);
  const expectedNgn = row?.expectedNgn ?? Math.round(Number(body.expectedNgn) || 0);
  if (existing) {
    db.prepare(
      `UPDATE hr_branch_payroll_contributions SET contributed_ngn = ?, status = ?, notes = ?,
       marked_at_iso = ?, marked_by_user_id = ?, updated_at_iso = ? WHERE id = ?`
    ).run(
      contributedNgn,
      status,
      String(body.notes ?? '').trim() || null,
      now,
      actor?.id || null,
      now,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO hr_branch_payroll_contributions (
        id, branch_id, period_yyyymm, expected_ngn, contributed_ngn, status, notes,
        marked_at_iso, marked_by_user_id, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      branchId,
      periodYyyymm,
      expectedNgn,
      contributedNgn,
      status,
      String(body.notes ?? '').trim() || null,
      now,
      actor?.id || null,
      now,
      now
    );
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.branch_contribution.upsert',
    entityKind: 'hr_branch_payroll_contribution',
    entityId: id,
    branchId,
    details: { periodYyyymm, contributedNgn, status },
  });
  return { ok: true, id };
}

/** Aggregate totals for a payroll run (preview / summary cards). */
export function getPayrollRunTotals(db, runId) {
  const lines = listPayrollLines(db, runId);
  let gross = 0;
  let net = 0;
  let tax = 0;
  let pension = 0;
  let attendanceDed = 0;
  let otherDed = 0;
  for (const l of lines) {
    gross += Math.round(Number(l.grossNgn) || 0);
    net += Math.round(Number(l.netNgn) || 0);
    tax += Math.round(Number(l.taxNgn) || 0);
    pension += Math.round(Number(l.pensionNgn) || 0);
    attendanceDed += Math.round(Number(l.attendanceDeductionNgn) || 0);
    otherDed += Math.round(Number(l.otherDeductionNgn) || 0);
  }
  return {
    headcount: lines.length,
    grossTotalNgn: gross,
    netTotalNgn: net,
    taxTotalNgn: tax,
    pensionTotalNgn: pension,
    attendanceDeductionTotalNgn: attendanceDed,
    otherDeductionTotalNgn: otherDed,
  };
}

/** Payslip lines for one user across locked/paid runs. */
export function listHrPayslipsForUser(db, userId, limit = 24) {
  if (!hrTablesReady(db)) return [];
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const cap = Math.min(100, Math.max(1, Math.round(Number(limit) || 24)));
  const rows = db
    .prepare(
      `SELECT r.id AS runId, r.period_yyyymm AS periodYyyymm, r.status AS runStatus,
              u.display_name AS displayName,
              l.gross_ngn AS grossNgn, l.bonus_ngn AS bonusNgn, l.net_ngn AS netNgn, l.tax_ngn AS taxNgn,
              l.pension_ngn AS pensionNgn, l.attendance_deduction_ngn AS attendanceDeductionNgn,
              l.other_deduction_ngn AS otherDeductionNgn
       FROM hr_payroll_lines l
       JOIN hr_payroll_runs r ON r.id = l.run_id
       JOIN app_users u ON u.id = l.user_id
       WHERE l.user_id = ? AND r.status IN ('locked', 'paid')
       ORDER BY r.period_yyyymm DESC LIMIT ?`
    )
    .all(uid, cap);
  return rows.map((row) => ({
    userId: uid,
    runId: row.runId,
    periodYyyymm: row.periodYyyymm,
    runStatus: row.runStatus,
    displayName: row.displayName,
    grossNgn: row.grossNgn,
    bonusNgn: row.bonusNgn,
    netNgn: row.netNgn,
    taxNgn: row.taxNgn,
    pensionNgn: row.pensionNgn,
    attendanceDeductionNgn: row.attendanceDeductionNgn,
    otherDeductionNgn: row.otherDeductionNgn,
  }));
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

  let totalGross = 0;
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
    const extraHold = safeJsonParse(s.profile_extra_json, {});
    const salaryHeld = ['held', 'suspended'].includes(
      String(extraHold?.employmentMeta?.salaryStatus || '').toLowerCase()
    );
    if (salaryHeld) {
      try {
        db.prepare(
          `UPDATE hr_payroll_lines SET pay_hold = 1, hold_reason = ?, net_ngn = 0 WHERE run_id = ? AND user_id = ?`
        ).run(extraHold?.employmentMeta?.payrollHoldReason || 'Salary on hold', runId, s.user_id);
      } catch {
        /* pay_hold column optional until migrate */
      }
    }
    for (const ln of loanParts) {
      insLoan.run(runId, s.user_id, ln.hrRequestId, period, ln.amountNgn, ln.title, computedAt);
    }
    totalGross += Math.max(0, gross);
  }

  // Compute ITF and NSITF employer levies (1% each of total gross payroll)
  const itfNgn = Math.round(totalGross * 0.01);
  const nsitfNgn = Math.round(totalGross * 0.01);
  try {
    db.prepare(`UPDATE hr_payroll_runs SET itf_ngn = ?, nsitf_ngn = ? WHERE id = ?`).run(itfNgn, nsitfNgn, runId);
  } catch {
    /* itf_ngn/nsitf_ngn columns may not exist on very old DBs — migration adds them */
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

/** GM HR payroll approval (primary lock gate alongside MD). */
export function approvePayrollRunByGmHr(db, runId, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  if (
    !userHasPermission(actor, 'hr.payroll.gm_approve') &&
    !userHasPermission(actor, '*')
  ) {
    return { ok: false, error: 'GM HR payroll approval permission required.' };
  }
  const run = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (String(run.status || '').toLowerCase() !== 'draft') {
    return { ok: false, error: 'Only draft runs can receive GM HR payroll approval.' };
  }
  const now = nowIso();
  try {
    db.prepare(`UPDATE hr_payroll_runs SET gm_approved_at_iso = ?, gm_approved_by_user_id = ? WHERE id = ?`).run(
      now,
      actor?.id ?? null,
      runId
    );
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.payroll_run.gm_approve',
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
      const gmOk = String(run.gm_approved_at_iso || '').trim();
      const mdOk = String(run.md_approved_at_iso || '').trim();
      if (!gmOk && !mdOk && !userHasPermission(actor, '*')) {
        return {
          ok: false,
          error: 'GM HR or Managing Director must approve this payroll run before it can be locked.',
        };
      }
    }
    const wasPaid = run.status === 'paid';
    if (ns === 'draft' && String(run.status || '').toLowerCase() === 'locked') {
      db.prepare(
        `UPDATE hr_payroll_runs SET status = ?, md_approved_at_iso = NULL, md_approved_by_user_id = NULL,
         gm_approved_at_iso = NULL, gm_approved_by_user_id = NULL WHERE id = ?`
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
    if (ns === 'locked' || ns === 'paid') {
      const updatedRun = getPayrollRunById(db, runId);
      const userIds = listPayrollLines(db, runId).map((l) => l.userId).filter(Boolean);
      if (updatedRun && userIds.length) {
        notifyPayrollRunStatus(db, updatedRun, ns, userIds);
      }
    }
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
      gmApprovedAtIso: row.gm_approved_at_iso ?? null,
      gmApprovedByUserId: row.gm_approved_by_user_id ?? null,
      signedAtIso: row.signed_at_iso ?? null,
      signedByUserId: row.signed_by_user_id ?? null,
      signatureKind: row.signature_kind ?? null,
      signedPdfSha256: row.signed_pdf_sha256 ?? null,
      filingStatus: row.filing_status ?? null,
      filingReference: row.filing_reference ?? null,
      filingAtIso: row.filing_at_iso ?? null,
      itfNgn: row.itf_ngn != null ? Number(row.itf_ngn) : 0,
      nsitfNgn: row.nsitf_ngn != null ? Number(row.nsitf_ngn) : 0,
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
    gmApprovedAtIso: row.gm_approved_at_iso ?? null,
    gmApprovedByUserId: row.gm_approved_by_user_id ?? null,
    signedAtIso: row.signed_at_iso ?? null,
    signedByUserId: row.signed_by_user_id ?? null,
    signatureKind: row.signature_kind ?? null,
    signedPdfSha256: row.signed_pdf_sha256 ?? null,
    filingStatus: row.filing_status ?? null,
    filingReference: row.filing_reference ?? null,
    filingAtIso: row.filing_at_iso ?? null,
    itfNgn: row.itf_ngn != null ? Number(row.itf_ngn) : 0,
    nsitfNgn: row.nsitf_ngn != null ? Number(row.nsitf_ngn) : 0,
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

const NIGERIAN_BANK_CODES = {
  gtbank: '058',
  'guaranty trust': '058',
  uba: '033',
  zenith: '057',
  access: '044',
  'first bank': '011',
  fidelity: '070',
  stanbic: '221',
  union: '032',
  wema: '035',
  sterling: '232',
  fcmb: '214',
  keystone: '082',
  polaris: '076',
};

function resolveBankCode(bankName, storedCode) {
  if (storedCode) return String(storedCode).trim();
  const key = String(bankName || '').toLowerCase();
  for (const [name, code] of Object.entries(NIGERIAN_BANK_CODES)) {
    if (key.includes(name)) return code;
  }
  return '';
}

function payrollLinesWithProfile(db, runId) {
  if (!hrTablesReady(db)) return [];
  const loanRows = db
    .prepare(`SELECT user_id, hr_request_id, amount_ngn, loan_title FROM hr_payroll_line_loans WHERE run_id = ?`)
    .all(runId);
  const loansByUser = new Map();
  for (const lr of loanRows) {
    if (!loansByUser.has(lr.user_id)) loansByUser.set(lr.user_id, []);
    loansByUser.get(lr.user_id).push({
      hrRequestId: lr.hr_request_id,
      amountNgn: lr.amount_ngn,
      title: lr.loan_title || lr.hr_request_id,
    });
  }
  return db
    .prepare(
      `SELECT l.*, u.display_name AS displayName,
              p.employee_no AS employeeNo, p.branch_id AS branchId, p.department, p.job_title AS jobTitle,
              p.bank_account_name AS bankAccountName, p.bank_name AS bankName,
              p.bank_account_no AS bankAccountNo, p.bank_account_no_masked AS bankAccountNoMasked,
              p.bank_code AS bankCode, p.payroll_group AS payrollGroup
       FROM hr_payroll_lines l
       JOIN app_users u ON u.id = l.user_id
       LEFT JOIN hr_staff_profiles p ON p.user_id = l.user_id
       WHERE l.run_id = ?
       ORDER BY u.display_name ASC`
    )
    .all(runId)
    .map((row) => {
      const acctRaw = row.bankAccountNo
        ? decryptBankAccount(row.bankAccountNo)
        : String(row.bankAccountNoMasked || '');
      const acct = String(acctRaw || '').replace(/\s/g, '');
      const loanTotal = (loansByUser.get(row.user_id) || []).reduce(
        (s, x) => s + Math.round(Number(x.amountNgn) || 0),
        0
      );
      return {
        userId: row.user_id,
        displayName: row.displayName,
        employeeNo: row.employeeNo,
        branchId: row.branchId,
        department: row.department,
        jobTitle: row.jobTitle,
        grossNgn: row.gross_ngn,
        bonusNgn: row.bonus_ngn,
        attendanceDeductionNgn: row.attendance_deduction_ngn,
        otherDeductionNgn: row.other_deduction_ngn,
        taxNgn: row.tax_ngn,
        pensionNgn: row.pension_ngn,
        netNgn: row.net_ngn,
        loanDeductions: loansByUser.get(row.user_id) || [],
        loanDeductionTotalNgn: loanTotal,
        bankAccountName: row.bankAccountName,
        bankName: row.bankName,
        bankAccountNo: acct,
        bankCode: resolveBankCode(row.bankName, row.bankCode),
        held: Math.round(Number(row.net_ngn) || 0) <= 0,
      };
    });
}

function csvEsc(v) {
  const t = String(v ?? '');
  if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

/** Bank bulk salary upload format for treasury. */
export function exportPayrollBankUploadCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (!['locked', 'paid', 'gm_approved', 'md_approved'].includes(String(run.status || ''))) {
    return { ok: false, error: 'Approve and lock payroll before bank export.' };
  }
  const lines = payrollLinesWithProfile(db, runId).filter((l) => !l.held && l.netNgn > 0);
  const missing = lines.filter((l) => !l.bankAccountNo || l.bankAccountNo.length < 10);
  if (missing.length) {
    return {
      ok: false,
      error: `${missing.length} staff missing valid bank account numbers. Update profiles before export.`,
      missingStaff: missing.slice(0, 10).map((l) => l.displayName),
    };
  }
  const narration = `Zarewa Salary ${run.periodYyyymm}`;
  const headers = ['Receiver Name', 'Receiver Account No', 'Amount', 'Sender Narration', 'Bank Code'];
  const rows = lines.map((l) =>
    [
      l.bankAccountName || l.displayName,
      l.bankAccountNo,
      Math.round(Number(l.netNgn) || 0),
      narration,
      l.bankCode || '',
    ].map(csvEsc)
  );
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return {
    ok: true,
    csv,
    filename: `bank-upload-salary-${run.periodYyyymm}.csv`,
  };
}

/** HR/GM/MD payroll approval report before bank payment. */
export function exportPayrollHrApprovalCsv(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = payrollLinesWithProfile(db, runId);
  const headers = [
    'Employee Name',
    'Employee No',
    'Branch/HQ',
    'Department',
    'Designation',
    'Gross Salary',
    'Loan Deduction',
    'Other Deductions',
    'Net Salary',
    'Remark',
  ];
  let sumGross = 0;
  let sumLoan = 0;
  let sumOther = 0;
  let sumNet = 0;
  const rows = lines.map((l) => {
    const gross = Math.round(Number(l.grossNgn) || 0) + Math.round(Number(l.bonusNgn) || 0);
    const loan = l.loanDeductionTotalNgn;
    const other =
      Math.round(Number(l.attendanceDeductionNgn) || 0) +
      Math.round(Number(l.otherDeductionNgn) || 0) +
      Math.round(Number(l.taxNgn) || 0) +
      Math.round(Number(l.pensionNgn) || 0);
    const net = Math.round(Number(l.netNgn) || 0);
    sumGross += gross;
    sumLoan += loan;
    sumOther += other;
    sumNet += net;
    const remark = l.held ? 'HELD' : l.bankAccountNo ? '' : 'MISSING BANK';
    return [
      l.displayName,
      l.employeeNo || '',
      l.branchId || 'HQ',
      l.department || '',
      l.jobTitle || '',
      gross,
      loan,
      other,
      net,
      remark,
    ].map(csvEsc);
  });
  const summary = [
    '',
    '',
    '',
    '',
    'TOTALS',
    sumGross,
    sumLoan,
    sumOther,
    sumNet,
    '',
  ].map(csvEsc);
  const meta = [
    `# Zarewa Aluminium & Plastics Ltd — Payroll Approval Report`,
    `# Period: ${run.periodYyyymm} · Run: ${run.id} · Status: ${run.status}`,
    `# Generated: ${new Date().toISOString().slice(0, 19)}`,
    '',
  ];
  const csv = [...meta, headers.join(','), ...rows.map((r) => r.join(',')), summary.join(',')].join('\r\n');
  return {
    ok: true,
    csv,
    filename: `hr-approval-payroll-${run.periodYyyymm}.csv`,
  };
}

function formatNgnPdf(n) {
  return `NGN ${(Math.round(Number(n) || 0)).toLocaleString('en-NG')}`;
}

/** @param {{ periodYyyymm: string; id: string; status: string }} run */
function buildPayslipPdfPage(run, l) {
  return {
    lines: [
      'Zarewa Aluminium and Plastics Ltd',
      'PAYSLIP (CONFIDENTIAL)',
      `Period: ${run.periodYyyymm}`,
      '',
      `Employee: ${l.displayName || l.userId}`,
      `Staff ID: ${l.userId}`,
      '',
      `Gross pay: ${formatNgnPdf(l.grossNgn)}`,
      `Bonus: ${formatNgnPdf(l.bonusNgn)}`,
      `Attendance deduction: ${formatNgnPdf(l.attendanceDeductionNgn)}`,
      `Other deduction: ${formatNgnPdf(l.otherDeductionNgn)}`,
      `PAYE tax: ${formatNgnPdf(l.taxNgn)}`,
      `Pension: ${formatNgnPdf(l.pensionNgn)}`,
      `Net pay: ${formatNgnPdf(l.netNgn)}`,
      '',
      `Payroll run: ${run.id}`,
      `Status: ${run.status}`,
    ],
  };
}

export function exportPayrollPayslipsPdf(db, runId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = listPayrollLines(db, runId);
  const pages = lines.map((l) => buildPayslipPdfPage(run, l));
  const pdf = buildSimpleTextPdf(pages.length ? pages : [{ lines: ['No payroll lines in this run.'] }]);
  return {
    ok: true,
    pdf,
    filename: `payslips-${run.periodYyyymm}-${run.id}.pdf`,
    contentType: 'application/pdf',
  };
}

export function exportSinglePayslipPdf(db, runId, userId) {
  const run = getPayrollRunById(db, runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId is required.' };
  const lines = listPayrollLines(db, runId);
  const line = lines.find((l) => l.userId === uid);
  if (!line) return { ok: false, error: 'No payslip line for this employee in this run.' };
  const pdf = buildSimpleTextPdf([buildPayslipPdfPage(run, line)]);
  const safeUid = uid.replace(/[^\w-]/g, '').slice(0, 16);
  return {
    ok: true,
    pdf,
    filename: `payslip-${run.periodYyyymm}-${safeUid}.pdf`,
    contentType: 'application/pdf',
  };
}

export function exportEmploymentLetterPdf(db, letterId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_employment_letters WHERE id = ?`).get(letterId);
  if (!row) return { ok: false, error: 'Letter not found.' };
  const lines = String(row.content_text || '').split(/\r?\n/);
  const pdf = buildSimpleTextPdf([{ lines: lines.length ? lines : ['(empty letter)'] }]);
  const kind = String(row.letter_kind || 'employment').replace(/[^\w-]+/g, '-');
  return {
    ok: true,
    pdf,
    filename: `${kind}-${letterId}.pdf`,
    contentType: 'application/pdf',
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
  const headers = ['period_yyyymm', 'run_id', 'user_id', 'display_name', 'tax_ngn', 'pension_ngn', 'itf_ngn_employer', 'nsitf_ngn_employer'];
  const esc = (v) => String(v ?? '');
  const rows = lines.map((l) =>
    [run.periodYyyymm, run.id, l.userId, l.displayName, l.taxNgn, l.pensionNgn, '', ''].map(esc)
  );
  const totalTax = lines.reduce((s, l) => s + (Number(l.taxNgn) || 0), 0);
  const totalPension = lines.reduce((s, l) => s + (Number(l.pensionNgn) || 0), 0);
  // ITF and NSITF are run-level employer costs (not per-line)
  const runItf = Number(run.itfNgn) || 0;
  const runNsitf = Number(run.nsitfNgn) || 0;
  rows.push([run.periodYyyymm, run.id, '', 'TOTAL', totalTax, totalPension, runItf, runNsitf].map(esc));
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  return { ok: true, csv, filename: `statutory-${run.periodYyyymm}-${run.id}.csv` };
}

/**
 * Apply a half-month (or other) bonus to all lines in a payroll run.
 * bonusType: 'half_month'
 */
export function applyBonusToPayrollRun(db, runId, bonusType, actorUser) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const run = db.prepare('SELECT * FROM hr_payroll_runs WHERE id=?').get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status === 'locked' || run.status === 'paid') return { ok: false, error: 'Cannot modify a locked or paid payroll run.' };
  const lines = db.prepare('SELECT pl.user_id, sp.base_salary_ngn FROM hr_payroll_lines pl JOIN hr_staff_profiles sp ON sp.user_id = pl.user_id WHERE pl.run_id=?').all(runId);
  const stmt = db.prepare('UPDATE hr_payroll_lines SET bonus_ngn=?, net_ngn=net_ngn+(? - bonus_ngn) WHERE run_id=? AND user_id=?');
  let updated = 0;
  for (const line of lines) {
    const bonus = Math.round((Number(line.base_salary_ngn) || 0) * 0.5);
    stmt.run(bonus, bonus, runId, line.user_id);
    updated++;
  }
  appendHrAuditEvent(db, { actorUserId: actorUser?.id, actorDisplayName: actorUser?.displayName, action: 'payroll.bonus_applied', entityKind: 'payroll_run', entityId: runId, details: { bonusType, updated } });
  return { ok: true, updated, bonusType };
}

/**
 * Year-end carry-over of unused annual leave to the following year.
 * targetYear: the year being closed (e.g. 2025)
 */
export function runLeaveYearEndCarryOver(db, actorUser, targetYear) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const period = String(targetYear) + '12'; // December of target year
  const balances = db.prepare(
    `SELECT * FROM hr_leave_balances WHERE leave_type='annual' AND period_yyyymm=?`
  ).all(period);
  let processed = 0, forfeited = 0;
  const nextPeriod = String(Number(targetYear) + 1) + '01';
  for (const bal of balances) {
    const carryDays = Math.min(bal.closing_days || 0, 21); // max carry = 21 days (senior entitlement)
    const forfeitedDays = Math.max(0, (bal.closing_days || 0) - carryDays);
    if (carryDays > 0) {
      const existing = db.prepare(`SELECT * FROM hr_leave_balances WHERE user_id=? AND leave_type='annual' AND period_yyyymm=?`).get(bal.user_id, nextPeriod);
      if (!existing) {
        db.prepare(`INSERT INTO hr_leave_balances (user_id, leave_type, period_yyyymm, opening_days, accrued_days, used_days, adjusted_days, closing_days, updated_at_iso) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(bal.user_id, 'annual', nextPeriod, carryDays, 0, 0, 0, carryDays, new Date().toISOString());
      }
    }
    if (forfeitedDays > 0) forfeited++;
    processed++;
  }
  appendHrAuditEvent(db, { actorUserId: actorUser?.id, action: 'leave.year_end_carryover', entityKind: 'leave_balances', details: { targetYear, processed, forfeited } });
  return { ok: true, processed, forfeited };
}

/**
 * Returns dashboard alert collections: probation ending, contracts expiring, birthdays,
 * anniversaries, documents expiring, training expiring.
 */
export function getHrDashboardAlerts(db) {
  if (!hrTablesReady(db)) return { probationEnding: [], contractsExpiring: [], birthdaysThisWeek: [], anniversariesThisWeek: [], docsExpiring: [], trainingExpiring: [] };
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const in30 = new Date(now); in30.setDate(now.getDate() + 30);
  const in30Iso = in30.toISOString().slice(0, 10);
  const in60 = new Date(now); in60.setDate(now.getDate() + 60);
  const in60Iso = in60.toISOString().slice(0, 10);

  // Probation ending within 30 days
  const probationEnding = db.prepare(`
    SELECT sp.user_id, u.display_name, sp.probation_end_iso, sp.job_title, sp.branch_id
    FROM hr_staff_profiles sp JOIN users u ON u.id=sp.user_id
    WHERE sp.probation_end_iso BETWEEN ? AND ? AND sp.status='active'
  `).all(todayIso, in30Iso);

  // Contracts expiring within 60 days
  let contractsExpiring = [];
  try {
    contractsExpiring = db.prepare(`
      SELECT sp.user_id, u.display_name, sp.contract_end_iso, sp.job_title, sp.branch_id
      FROM hr_staff_profiles sp JOIN users u ON u.id=sp.user_id
      WHERE sp.contract_end_iso BETWEEN ? AND ? AND sp.employment_type='contract' AND sp.status='active'
    `).all(todayIso, in60Iso);
  } catch { /* contract_end_iso may not exist yet */ }

  // Birthdays this week
  let birthdaysThisWeek = [];
  try {
    const dayOfYear = (d) => { const s = new Date(d.getFullYear(), 0, 0); return Math.floor((d - s) / (1000 * 60 * 60 * 24)); };
    const todayDoy = dayOfYear(now);
    const allDob = db.prepare(`SELECT sp.user_id, u.display_name, sp.date_of_birth FROM hr_staff_profiles sp JOIN app_users u ON u.id=sp.user_id WHERE sp.date_of_birth IS NOT NULL AND u.status='active'`).all();
    birthdaysThisWeek = allDob.filter(r => {
      const dob = new Date(r.date_of_birth);
      const dobDoy = dayOfYear(new Date(now.getFullYear(), dob.getMonth(), dob.getDate()));
      return dobDoy >= todayDoy && dobDoy <= todayDoy + 7;
    });
  } catch { /* date_of_birth may not exist yet */ }

  // Work anniversaries this week
  let anniversariesThisWeek = [];
  try {
    const dayOfYear = (d) => { const s = new Date(d.getFullYear(), 0, 0); return Math.floor((d - s) / (1000 * 60 * 60 * 24)); };
    const todayDoy = dayOfYear(now);
    const allJoined = db.prepare(`SELECT sp.user_id, u.display_name, sp.date_joined_iso FROM hr_staff_profiles sp JOIN app_users u ON u.id=sp.user_id WHERE sp.date_joined_iso IS NOT NULL AND u.status='active'`).all();
    anniversariesThisWeek = allJoined.filter(r => {
      const joined = new Date(r.date_joined_iso);
      const thisDoy = dayOfYear(new Date(now.getFullYear(), joined.getMonth(), joined.getDate()));
      const years = now.getFullYear() - joined.getFullYear();
      return thisDoy >= todayDoy && thisDoy <= todayDoy + 7 && years > 0;
    }).map(r => ({ ...r, years: now.getFullYear() - new Date(r.date_joined_iso).getFullYear() }));
  } catch {}

  // Documents expiring within 60 days
  let docsExpiring = [];
  try {
    docsExpiring = db.prepare(`
      SELECT d.user_id, u.display_name, d.doc_kind, d.file_name, d.expiry_date_iso
      FROM hr_staff_documents d JOIN app_users u ON u.id=d.user_id
      WHERE d.expiry_date_iso BETWEEN ? AND ?
      ORDER BY d.expiry_date_iso ASC
    `).all(todayIso, in60Iso);
  } catch { /* expiry_date_iso may not exist yet */ }

  // Training records expiring within 60 days
  let trainingExpiring = [];
  try {
    trainingExpiring = db.prepare(`
      SELECT tr.user_id, u.display_name, tr.course_name, tr.expiry_at_iso
      FROM hr_training_records tr JOIN app_users u ON u.id=tr.user_id
      WHERE tr.expiry_at_iso BETWEEN ? AND ? AND tr.completion_status='completed'
      ORDER BY tr.expiry_at_iso ASC
    `).all(todayIso, in60Iso);
  } catch {}

  return { probationEnding, contractsExpiring, birthdaysThisWeek, anniversariesThisWeek, docsExpiring, trainingExpiring };
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

/**
 * Generate staff loan agreement letter for an approved loan request.
 * Stored in hr_employment_letters with letter_kind staff_loan_agreement.
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ requestId: string }} body
 */
export function generateStaffLoanAgreementLetter(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const requestId = String(body?.requestId || '').trim();
  if (!requestId) return { ok: false, error: 'requestId is required.' };
  const row = db
    .prepare(
      `SELECT r.id, r.user_id, r.status, r.branch_id,
              l.amount_ngn, l.repayment_months, l.deduction_per_month_ngn, l.purpose
       FROM hr_requests r
       JOIN hr_request_loan l ON l.request_id = r.id
       WHERE r.id = ? AND r.kind = 'loan'`
    )
    .get(requestId);
  if (!row) return { ok: false, error: 'Loan request not found.' };
  if (String(row.status) !== 'approved') {
    return { ok: false, error: 'Loan agreement can only be generated for approved requests.' };
  }
  const userId = row.user_id;
  const u = db.prepare(`SELECT display_name, username FROM app_users WHERE id = ?`).get(userId);
  if (!u) return { ok: false, error: 'Employee not found.' };
  const p = db.prepare(`SELECT job_title, department FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const company = 'Zarewa Aluminium and Plastics Ltd';
  const amount = Math.round(Number(row.amount_ngn) || 0);
  const months = Math.round(Number(row.repayment_months) || 0);
  const monthly = Math.round(Number(row.deduction_per_month_ngn) || 0);
  const fmt = (n) => `NGN ${n.toLocaleString('en-NG')}`;
  const content = [
    company,
    '',
    `Date: ${nowIso().slice(0, 10)}`,
    '',
    `STAFF LOAN AGREEMENT`,
    '',
    `Reference: ${requestId}`,
    '',
    `This agreement is between ${company} ("the Company") and ${u.display_name} ("the Employee").`,
    '',
    `1. Loan amount: ${fmt(amount)}`,
    `2. Purpose: ${String(row.purpose || 'Staff loan as approved by HR').trim()}`,
    `3. Repayment period: ${months} month(s) via payroll deduction`,
    `4. Monthly deduction: ${fmt(monthly)} (subject to payroll availability)`,
    `5. Work location / branch: ${String(row.branch_id || 'as assigned').trim()}`,
    `6. Job title: ${p?.job_title || 'Staff'}${p?.department ? ` (${p.department})` : ''}`,
    '',
    `The Employee agrees that outstanding balance may be recovered from final salary or benefits if employment ends before full repayment, in accordance with company policy and applicable law.`,
    '',
    `Signed for the Company:`,
    `${actor.displayName || actor.username || 'Human Resources'}`,
    'Human Resources (HQ)',
    '',
    `Employee acknowledgement: ${u.display_name}`,
    'Signature: _________________________   Date: _________________',
  ].join('\n');

  const id = newId('HRL');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_employment_letters (id, user_id, letter_kind, content_text, issued_at_iso, issued_by_user_id)
     VALUES (?,?,?,?,?,?)`
  ).run(id, userId, 'staff_loan_agreement', content, now, actor.id);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    actorDisplayName: actor?.displayName || actor?.username || null,
    action: 'hr.loan.agreement_letter',
    entityKind: 'hr_employment_letter',
    entityId: id,
    branchId: row.branch_id,
    details: { requestId, userId, amountNgn: amount },
  });
  return { ok: true, id, contentText: content, requestId };
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
    canCutover: hasSpecialNodes && qualityCoverage >= 85 && queue.length === 0,
    blockers: [
      !hasSpecialNodes ? 'Map special org nodes (mining, scholarship, chairman staff).' : null,
      qualityCoverage < 85 ? `Profile quality below 85% (${qualityCoverage}%).` : null,
      queue.length > 0 ? `${queue.length} data cleanup item(s) remain.` : null,
      Number(obs.summary?.overdueRequests || 0) > 0
        ? `${obs.summary.overdueRequests} overdue HR request(s).`
        : null,
    ].filter(Boolean),
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
    ninNumber: p.nin_number ?? null,
    profileExtra: safeJsonParse(p.profile_extra_json, {}),
    selfServiceEligible: Number(p.self_service_eligible) === 1,
    lineManagerUserId: p.line_manager_user_id ?? null,
    leaveEntitlementBand: p.leave_entitlement_band ?? null,
  };
  const mgrId = p.line_manager_user_id ? String(p.line_manager_user_id) : '';
  if (mgrId) {
    const mgr = db
      .prepare(`SELECT u.id AS userId, u.display_name AS displayName, p.job_title AS jobTitle FROM app_users u
                LEFT JOIN hr_staff_profiles p ON p.user_id = u.id WHERE u.id = ?`)
      .get(mgrId);
    if (mgr) {
      hr.lineManager = {
        userId: mgr.userId,
        displayName: mgr.displayName || mgr.userId,
        jobTitle: mgr.jobTitle || null,
      };
      hr.lineManagerDisplayName = hr.lineManager.displayName;
    }
  }
  const directReports = db
    .prepare(
      `SELECT u.id AS userId, u.display_name AS displayName, p.job_title AS jobTitle
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE p.line_manager_user_id = ? AND u.status = 'active'
       ORDER BY u.display_name ASC`
    )
    .all(userId);
  hr.directReports = directReports;
  return { user, hr };
}

/**
 * Audit trail for an employee (requests + profile events).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {number} [limit]
 */
export function listHrAuditEventsForStaff(db, userId, limit = 50) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTablesReady(db)) return [];
  const cap = Math.min(200, Math.max(1, Math.round(Number(limit) || 50)));
  try {
    const rows = db
      .prepare(
        `SELECT e.id, e.occurred_at_iso AS atIso, e.actor_user_id AS actorUserId, e.actor_display_name AS actorDisplayName,
                e.action, e.entity_kind AS entityKind, e.entity_id AS entityId, e.branch_id AS branchId, e.reason, e.details_json AS detailsJson
         FROM hr_audit_events e
         WHERE (e.entity_kind = 'hr_staff_profile' AND e.entity_id = ?)
            OR (e.entity_kind = 'staff' AND e.entity_id = ?)
            OR e.entity_id IN (SELECT id FROM hr_requests WHERE user_id = ?)
         ORDER BY e.occurred_at_iso DESC
         LIMIT ?`
      )
      .all(uid, uid, uid, cap);
    return rows.map((row) => ({
      ...row,
      details: safeJsonParse(row.detailsJson, {}),
      detailsJson: undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Global HR audit log (scoped by branch when not HQ).
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {{ limit?: number; fromIso?: string; toIso?: string; action?: string }} [opts]
 */
export function listHrAuditEventsGlobal(db, scope, opts = {}) {
  if (!hrTablesReady(db)) return [];
  const cap = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 150)));
  let sql = `SELECT e.id, e.occurred_at_iso AS atIso, e.actor_user_id AS actorUserId, e.actor_display_name AS actorDisplayName,
                    e.action, e.entity_kind AS entityKind, e.entity_id AS entityId, e.branch_id AS branchId, e.reason, e.details_json AS detailsJson
             FROM hr_audit_events e WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (e.branch_id = ? OR e.branch_id IS NULL)`;
    args.push(scope?.branchId || 'HQ');
  }
  if (opts.fromIso) {
    sql += ` AND e.occurred_at_iso >= ?`;
    args.push(String(opts.fromIso));
  }
  if (opts.toIso) {
    sql += ` AND e.occurred_at_iso <= ?`;
    args.push(String(opts.toIso));
  }
  if (opts.action) {
    sql += ` AND e.action LIKE ?`;
    args.push(`%${String(opts.action).trim()}%`);
  }
  sql += ` ORDER BY e.occurred_at_iso DESC LIMIT ?`;
  args.push(cap);
  try {
    return db.prepare(sql).all(...args).map((row) => ({
      ...row,
      details: safeJsonParse(row.detailsJson, {}),
      detailsJson: undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
/**
 * Recent branch transfers for HR operations (scoped by branch when not HQ).
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll: boolean; branchId: string }} scope
 * @param {number} [limit]
 */
export function listRecentBranchTransfers(db, scope, limit = 150) {
  if (!hrTablesReady(db)) return [];
  const cap = Math.min(300, Math.max(1, Math.round(Number(limit) || 150)));
  try {
    let sql = `
      SELECT h.id, h.user_id AS userId, h.from_branch_id AS fromBranchId, h.to_branch_id AS toBranchId,
             h.effective_from_iso AS effectiveFromIso, h.reason, h.actor_user_id AS actorUserId,
             h.created_at_iso AS createdAtIso,
             u.display_name AS staffDisplayName, u.username AS staffUsername, p.employee_no AS employeeNo
      FROM hr_staff_branch_history h
      JOIN app_users u ON u.id = h.user_id
      LEFT JOIN hr_staff_profiles p ON p.user_id = h.user_id
      WHERE 1=1`;
    const args = [];
    if (!scope.viewAll) {
      sql += ` AND (h.from_branch_id = ? OR h.to_branch_id = ?)`;
      args.push(scope.branchId, scope.branchId);
    }
    sql += ` ORDER BY h.created_at_iso DESC LIMIT ?`;
    args.push(cap);
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}

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
    const cycle = db
      .prepare(`SELECT id, label, due_by_iso AS dueByIso FROM hr_appraisal_cycles WHERE id = ?`)
      .get(cycleId);
    if (cycle) notifyAppraisalFormOpened(db, subjectUserId, cycle);
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

export function registerNewStaffWithProfile(db, actorUserId, body, opts = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const {
    username,
    displayName,
    password,
    roleKey,
    workspaceDepartment,
    applicantId: _applicantId,
    skipProfileFetch: _skipInBody,
    ...profileFields
  } = body || {};
  const skipProfileFetch = Boolean(opts.skipProfileFetch || _skipInBody);
  const created = createAppUserRecord(db, {
    username,
    displayName,
    password,
    roleKey,
    workspaceDepartment,
  });
  if (!created.ok) return created;
  const up = upsertHrStaffProfile(
    db,
    actorUserId,
    {
      ...profileFields,
      userId: created.userId,
      branchId: String(profileFields?.branchId || '').trim() || DEFAULT_BRANCH_ID,
      employmentType: profileFields?.employmentType || 'permanent',
      baseSalaryNgn: profileFields?.baseSalaryNgn ?? 0,
      housingAllowanceNgn: profileFields?.housingAllowanceNgn ?? 0,
      transportAllowanceNgn: profileFields?.transportAllowanceNgn ?? 0,
    },
    { skipEnrichedReturn: skipProfileFetch }
  );
  if (!up.ok) return up;
  return { ok: true, userId: created.userId, profile: up.profile };
}

function hrPhase6TablesReady(db) {
  return hrTableExists(db, 'hr_beneficiaries');
}

export function listHrBeneficiaries(db, scope) {
  if (!hrPhase6TablesReady(db)) return [];
  let sql = `SELECT * FROM hr_beneficiaries WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (branch_id = ? OR branch_id IS NULL)`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY display_name ASC LIMIT 500`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    beneficiaryType: row.beneficiary_type,
    branchId: row.branch_id,
    monthlyAmountNgn: Number(row.monthly_amount_ngn) || 0,
    status: row.status,
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  }));
}

export function upsertHrBeneficiary(db, actorUserId, body) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'HR benefits tables not initialised.' };
  const displayName = String(body?.displayName || '').trim();
  if (displayName.length < 2) return { ok: false, error: 'Display name is required.' };
  const now = nowIso();
  const id = String(body?.id || '').trim() || newId('HRBEN');
  const existing = db.prepare(`SELECT id FROM hr_beneficiaries WHERE id = ?`).get(id);
  const branchId = String(body?.branchId || '').trim() || null;
  const row = {
    id,
    user_id: String(body?.userId || '').trim() || null,
    display_name: displayName,
    beneficiary_type: String(body?.beneficiaryType || 'allowance').trim() || 'allowance',
    branch_id: branchId,
    monthly_amount_ngn: Math.max(0, Math.round(Number(body?.monthlyAmountNgn) || 0)),
    status: String(body?.status || 'active').trim() || 'active',
    notes: String(body?.notes || '').trim() || null,
    updated_at_iso: now,
    created_by_user_id: actorUserId,
  };
  if (existing) {
    db.prepare(
      `UPDATE hr_beneficiaries SET user_id=@user_id, display_name=@display_name, beneficiary_type=@beneficiary_type,
       branch_id=@branch_id, monthly_amount_ngn=@monthly_amount_ngn, status=@status, notes=@notes, updated_at_iso=@updated_at_iso
       WHERE id=@id`
    ).run({ ...row, id });
  } else {
    db.prepare(
      `INSERT INTO hr_beneficiaries (id, user_id, display_name, beneficiary_type, branch_id, monthly_amount_ngn, status, notes, created_at_iso, updated_at_iso, created_by_user_id)
       VALUES (@id,@user_id,@display_name,@beneficiary_type,@branch_id,@monthly_amount_ngn,@status,@notes,@created_at_iso,@updated_at_iso,@created_by_user_id)`
    ).run({ ...row, created_at_iso: now });
  }
  const saved = db.prepare(`SELECT * FROM hr_beneficiaries WHERE id = ?`).get(id);
  return {
    ok: true,
    beneficiary: saved
      ? {
          id: saved.id,
          userId: saved.user_id,
          displayName: saved.display_name,
          beneficiaryType: saved.beneficiary_type,
          branchId: saved.branch_id,
          monthlyAmountNgn: Number(saved.monthly_amount_ngn) || 0,
          status: saved.status,
          notes: saved.notes,
        }
      : null,
  };
}

export function listHrBenefitPayments(db, periodYyyymm) {
  if (!hrPhase6TablesReady(db)) return [];
  const p = String(periodYyyymm || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(p)) return [];
  return db
    .prepare(
      `SELECT bp.*, b.display_name, b.beneficiary_type FROM hr_benefit_payments bp
       JOIN hr_beneficiaries b ON b.id = bp.beneficiary_id WHERE bp.period_yyyymm = ? ORDER BY b.display_name`
    )
    .all(p)
    .map((row) => ({
      id: row.id,
      beneficiaryId: row.beneficiary_id,
      displayName: row.display_name,
      beneficiaryType: row.beneficiary_type,
      periodYyyymm: row.period_yyyymm,
      amountNgn: Number(row.amount_ngn) || 0,
      status: row.status,
      paidAtIso: row.paid_at_iso,
      notes: row.notes,
    }));
}

export function recordHrBenefitPayment(db, actorUserId, body) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'HR benefits tables not initialised.' };
  const beneficiaryId = String(body?.beneficiaryId || '').trim();
  const periodYyyymm = String(body?.periodYyyymm || '').replace(/\D/g, '').slice(0, 6);
  if (!beneficiaryId) return { ok: false, error: 'beneficiaryId is required.' };
  if (!/^\d{6}$/.test(periodYyyymm)) return { ok: false, error: 'periodYyyymm must be YYYYMM.' };
  const ben = db.prepare(`SELECT id, monthly_amount_ngn FROM hr_beneficiaries WHERE id = ?`).get(beneficiaryId);
  if (!ben) return { ok: false, error: 'Beneficiary not found.' };
  const amountNgn = Math.max(0, Math.round(Number(body?.amountNgn ?? ben.monthly_amount_ngn) || 0));
  const now = nowIso();
  const id = newId('HRBPAY');
  db.prepare(
    `INSERT INTO hr_benefit_payments (id, beneficiary_id, period_yyyymm, amount_ngn, status, paid_at_iso, notes, created_at_iso, created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(beneficiary_id, period_yyyymm) DO UPDATE SET
       amount_ngn=excluded.amount_ngn, status=excluded.status, paid_at_iso=excluded.paid_at_iso, notes=excluded.notes`
  ).run(
    id,
    beneficiaryId,
    periodYyyymm,
    amountNgn,
    String(body?.status || 'scheduled').trim() || 'scheduled',
    body?.markPaid ? now : null,
    String(body?.notes || '').trim() || null,
    now,
    actorUserId
  );
  return { ok: true, payments: listHrBenefitPayments(db, periodYyyymm) };
}

export function listHrIncidentMemos(db, scope) {
  if (!hrPhase6TablesReady(db)) return [];
  let sql = `SELECT m.*, u.display_name AS staffDisplayName FROM hr_incident_memos m JOIN app_users u ON u.id = m.user_id WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND m.branch_id = ?`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY m.incident_date_iso DESC, m.created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    userId: row.user_id,
    staffDisplayName: row.staffDisplayName,
    reportedByUserId: row.reported_by_user_id,
    incidentDateIso: row.incident_date_iso,
    summary: row.summary,
    status: row.status,
    disciplinaryEventId: row.disciplinary_event_id,
    createdAtIso: row.created_at_iso,
  }));
}

export function createHrIncidentMemo(db, actorUserId, body) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'HR incident tables not initialised.' };
  const userId = String(body?.userId || '').trim();
  const summary = String(body?.summary || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  if (summary.length < 3) return { ok: false, error: 'Summary must be at least 3 characters.' };
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const branchId = String(body?.branchId || prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const now = nowIso();
  const id = newId('HRINC');
  const dateIso = String(body?.incidentDateIso || '').slice(0, 10) || now.slice(0, 10);
  db.prepare(
    `INSERT INTO hr_incident_memos (id, branch_id, user_id, reported_by_user_id, incident_date_iso, summary, status, created_at_iso, updated_at_iso)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, branchId, userId, actorUserId, dateIso, summary, 'open', now, now);
  return { ok: true, memo: listHrIncidentMemos(db, { viewAll: true, branchId }).find((m) => m.id === id) };
}

export function escalateHrIncidentToDiscipline(db, memoId, actorUserId, body = {}) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'HR incident tables not initialised.' };
  const memo = db.prepare(`SELECT * FROM hr_incident_memos WHERE id = ?`).get(memoId);
  if (!memo) return { ok: false, error: 'Incident memo not found.' };
  const r = appendHrDisciplinaryEvent(db, memo.user_id, {
    kind: String(body?.kind || 'incident').trim() || 'incident',
    dateIso: memo.incident_date_iso,
    summary: String(body?.summary || memo.summary).trim(),
  }, actorUserId);
  if (!r.ok) return r;
  const eventId = r.events?.[0]?.id || null;
  const now = nowIso();
  db.prepare(
    `UPDATE hr_incident_memos SET status = 'escalated', disciplinary_event_id = ?, updated_at_iso = ? WHERE id = ?`
  ).run(eventId, now, memoId);
  return { ok: true, eventId, events: r.events };
}

export function listHrTransferRecommendations(db, scope) {
  if (!hrPhase6TablesReady(db)) return [];
  let sql = `SELECT t.*, u.display_name AS staffDisplayName FROM hr_transfer_recommendations t JOIN app_users u ON u.id = t.user_id WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND (t.from_branch_id = ? OR t.to_branch_id = ?)`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID, scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY t.created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    userId: row.user_id,
    staffDisplayName: row.staffDisplayName,
    fromBranchId: row.from_branch_id,
    toBranchId: row.to_branch_id,
    reason: row.reason,
    status: row.status,
    recommendedByUserId: row.recommended_by_user_id,
    createdAtIso: row.created_at_iso,
  }));
}

export function createHrTransferRecommendation(db, actorUserId, body) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'Transfer recommendation tables not initialised.' };
  const userId = String(body?.userId || '').trim();
  const toBranchId = String(body?.toBranchId || '').trim();
  const reason = String(body?.reason || '').trim();
  if (!userId || !toBranchId) return { ok: false, error: 'userId and toBranchId are required.' };
  if (reason.length < 3) return { ok: false, error: 'Reason must be at least 3 characters.' };
  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const fromBranchId = String(prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const now = nowIso();
  const id = newId('HRTR');
  db.prepare(
    `INSERT INTO hr_transfer_recommendations (id, user_id, from_branch_id, to_branch_id, reason, status, recommended_by_user_id, created_at_iso)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, userId, fromBranchId, toBranchId, reason, 'pending', actorUserId, now);
  return { ok: true, recommendation: listHrTransferRecommendations(db, { viewAll: true, branchId: fromBranchId }).find((t) => t.id === id) };
}

export function reviewHrTransferRecommendation(db, actorUserId, id, body) {
  if (!hrPhase6TablesReady(db)) return { ok: false, error: 'Transfer recommendation tables not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_transfer_recommendations WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Recommendation not found.' };
  const status = String(body?.status || '').trim();
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return { ok: false, error: 'status must be approved, rejected, or pending.' };
  }
  const now = nowIso();
  db.prepare(
    `UPDATE hr_transfer_recommendations SET status = ?, reviewed_at_iso = ?, reviewed_by_user_id = ? WHERE id = ?`
  ).run(status, now, actorUserId, id);
  if (status === 'approved') {
    upsertHrStaffProfile(db, actorUserId, {
      userId: row.user_id,
      branchId: row.to_branch_id,
      branchChangeReason: `Transfer recommendation approved: ${row.reason}`,
    });
  }
  return { ok: true };
}

export function listHrLeaveCalendar(db, scope, fromIso, toIso) {
  if (!hrTablesReady(db)) return [];
  const from = String(fromIso || '').slice(0, 10);
  const to = String(toIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
  let sql = `
    SELECT r.user_id AS userId, u.display_name AS displayName, r.branch_id AS branchId,
           l.leave_type AS leaveType, l.start_date_iso AS startDateIso, l.end_date_iso AS endDateIso,
           l.days_requested AS daysRequested, r.title, r.id AS requestId
    FROM hr_requests r
    JOIN hr_request_leave l ON l.request_id = r.id
    JOIN app_users u ON u.id = r.user_id
    WHERE r.kind = 'leave' AND r.status = 'approved'
      AND l.end_date_iso >= ? AND l.start_date_iso <= ?
  `;
  const args = [from, to];
  if (!scope?.viewAll) {
    sql += ` AND r.branch_id = ?`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY l.start_date_iso ASC`;
  return db.prepare(sql).all(...args);
}

export function listExceptionalLoanQueue(db, scope) {
  return listHrRequests(db, scope, { kind: 'loan' }).filter(
    (r) => r.status === 'gm_hr_review' || Boolean(r.payload?.exceptionalLoan)
  );
}

export function listRecentOrgSalaryChanges(db, scope, limit = 30) {
  if (!hrTablesReady(db)) return [];
  let sql = `
    SELECT h.*, u.display_name AS displayName, p.branch_id AS branchId
    FROM hr_salary_history h
    JOIN app_users u ON u.id = h.user_id
    LEFT JOIN hr_staff_profiles p ON p.user_id = h.user_id
    WHERE 1=1
  `;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND p.branch_id = ?`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY h.created_at_iso DESC LIMIT ?`;
  args.push(Math.min(100, Math.max(1, Math.round(Number(limit) || 30))));
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.displayName,
    branchId: row.branch_id,
    effectiveFromIso: row.effective_from_iso,
    baseSalaryNgn: row.base_salary_ngn,
    reason: row.reason,
    createdAtIso: row.created_at_iso,
  }));
}

export function getHrReportsSummary(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const runs = listPayrollRuns(db).filter((r) => !scope?.viewAll || true);
  const byStatus = {};
  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] || 0) + 1;
  }
  const obs = listHrObservability(db, scope);
  return {
    staffActive: staff.filter((s) => String(s.status) === 'active').length,
    staffIncomplete: staff.filter((s) => (s.criticalMissing || []).length > 0).length,
    payrollRunsByStatus: byStatus,
    inbox: obs.summary,
    recentSalaryChanges: listRecentOrgSalaryChanges(db, scope, 15),
    beneficiaries: hrPhase6TablesReady(db) ? listHrBeneficiaries(db, scope).length : 0,
    openIncidents: hrPhase6TablesReady(db)
      ? db.prepare(`SELECT COUNT(*) AS c FROM hr_incident_memos WHERE status = 'open'`).get().c
      : 0,
  };
}

export function listDraftPayrollRunIds(db) {
  if (!hrTablesReady(db)) return [];
  return db
    .prepare(`SELECT id, period_yyyymm, status FROM hr_payroll_runs WHERE status = 'draft' ORDER BY created_at_iso DESC`)
    .all()
    .map((r) => ({ id: r.id, periodYyyymm: r.period_yyyymm, status: r.status }));
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

  // Seed default salary matrix from handbook if matrix is empty
  if (salaryMatrixReady(db)) {
    const matrixCount = db.prepare('SELECT COUNT(*) as cnt FROM hr_salary_matrix').get();
    if ((matrixCount?.cnt || 0) === 0) {
      const defaultMatrix = [
        { level: 1, label: 'Cleaners / Security / Factory Workers', min_ngn: 15000, max_ngn: 18000 },
        { level: 2, label: 'Supervisors / Store / Operators', min_ngn: 25000, max_ngn: 30000 },
        { level: 3, label: 'Marketers / Estimators', min_ngn: 30000, max_ngn: 35000 },
        { level: 4, label: 'Accountants', min_ngn: 30000, max_ngn: 40000 },
        { level: 5, label: 'Branch Managers', min_ngn: 40000, max_ngn: 55000 },
        { level: 6, label: 'Senior Managers / Directors', min_ngn: 50000, max_ngn: 70000 },
        { level: 7, label: 'Executive Directors', min_ngn: 70000, max_ngn: 100000 },
      ];
      const ins = db.prepare(`INSERT OR IGNORE INTO hr_salary_matrix (id, payroll_group, salary_level, salary_step, base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, notes, updated_at_iso) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const r of defaultMatrix) {
        ins.run(newId('HRMXSEED'), 'branch_ops', r.level, 1, r.min_ngn, 0, 0, r.label, now);
      }
    }
  }
}

// ── CHAIRMAN SCHOOL FEES ──────────────────────────────────────
export function listChairmanSchoolFees(db) {
  return db.prepare(`SELECT * FROM hr_chairman_school_fees ORDER BY created_at_iso DESC`).all();
}
export function upsertChairmanSchoolFee(db, actorUser, data) {
  const now = nowIso();
  if (data.id) {
    db.prepare(`UPDATE hr_chairman_school_fees SET child_name=?,school_name=?,term=?,academic_year=?,fee_amount_ngn=?,fee_type=?,payment_status=?,amount_paid_ngn=?,payment_date_iso=?,notes=?,updated_at_iso=? WHERE id=?`)
      .run(data.childName,data.schoolName,data.term,data.academicYear,data.feeAmountNgn||0,data.feeType||'tuition',data.paymentStatus||'pending',data.amountPaidNgn||0,data.paymentDateIso||null,data.notes||null,now,data.id);
    return { ok:true, id:data.id };
  }
  const id = newId('CHSF');
  db.prepare(`INSERT INTO hr_chairman_school_fees (id,child_name,school_name,term,academic_year,fee_amount_ngn,fee_type,payment_status,amount_paid_ngn,payment_date_iso,notes,created_at_iso,created_by_user_id,updated_at_iso) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,data.childName,data.schoolName,data.term,data.academicYear,data.feeAmountNgn||0,data.feeType||'tuition',data.paymentStatus||'pending',data.amountPaidNgn||0,data.paymentDateIso||null,data.notes||null,now,actorUser.id,now);
  return { ok:true, id };
}
export function deleteChairmanSchoolFee(db, id) {
  db.prepare(`DELETE FROM hr_chairman_school_fees WHERE id=?`).run(id);
  return { ok:true };
}

// ── CHAIRMAN EXPENSES ────────────────────────────────────────
export function listChairmanExpenses(db, periodYyyymm) {
  if (periodYyyymm) return db.prepare(`SELECT * FROM hr_chairman_expenses WHERE period_yyyymm=? ORDER BY created_at_iso DESC`).all(periodYyyymm);
  return db.prepare(`SELECT * FROM hr_chairman_expenses ORDER BY created_at_iso DESC`).all();
}
export function upsertChairmanExpense(db, actorUser, data) {
  const now = nowIso();
  if (data.id) {
    db.prepare(`UPDATE hr_chairman_expenses SET expense_type=?,description=?,amount_ngn=?,quantity=?,unit=?,period_yyyymm=?,payment_status=?,payment_date_iso=?,vendor_name=?,notes=? WHERE id=?`)
      .run(data.expenseType,data.description,data.amountNgn||0,data.quantity||1,data.unit||null,data.periodYyyymm,data.paymentStatus||'pending',data.paymentDateIso||null,data.vendorName||null,data.notes||null,data.id);
    return { ok:true, id:data.id };
  }
  const id = newId('CHEX');
  db.prepare(`INSERT INTO hr_chairman_expenses (id,expense_type,description,amount_ngn,quantity,unit,period_yyyymm,payment_status,payment_date_iso,vendor_name,notes,created_at_iso,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,data.expenseType,data.description,data.amountNgn||0,data.quantity||1,data.unit||null,data.periodYyyymm,data.paymentStatus||'pending',data.paymentDateIso||null,data.vendorName||null,data.notes||null,now,actorUser.id);
  return { ok:true, id };
}
export function deleteChairmanExpense(db, id) {
  db.prepare(`DELETE FROM hr_chairman_expenses WHERE id=?`).run(id);
  return { ok:true };
}

// ── ID CARDS ─────────────────────────────────────────────────
export function listHrIdCardRequests(db, userId) {
  const sql = `SELECT r.*, u.display_name AS displayName, u.email,
    p.employee_no AS employeeNo, p.job_title AS jobTitle, p.department, p.branch_id AS branchId,
    u.avatar_url AS avatarUrl
    FROM hr_id_cards r
    LEFT JOIN app_users u ON u.id = r.user_id
    LEFT JOIN hr_staff_profiles p ON p.user_id = r.user_id`;
  if (userId) {
    return db.prepare(`${sql} WHERE r.user_id=? ORDER BY r.requested_at_iso DESC`).all(userId);
  }
  return db.prepare(`${sql} ORDER BY r.requested_at_iso DESC`).all();
}
export function createHrIdCardRequest(db, actorUser, data) {
  const id = newId('IDC');
  const now = nowIso();
  const uid = String(data?.userId || actorUser?.id || '').trim();
  if (!uid) return { ok: false, error: 'Employee is required.' };
  db.prepare(
    `INSERT INTO hr_id_cards (
      id, user_id, request_type, reason, status, requested_at_iso, notes,
      blood_group, emergency_contact, replacement_reason, lost_damaged_flag
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    uid,
    data.requestType || 'new',
    data.reason || data.replacementReason || null,
    'pending',
    now,
    data.notes || null,
    data.bloodGroup || null,
    data.emergencyContact || null,
    data.replacementReason || null,
    data.lostDamaged ? 1 : 0
  );
  return { ok: true, id };
}
export function patchHrIdCardRequest(db, actorUser, requestId, data) {
  const now = nowIso();
  const row = db.prepare(`SELECT * FROM hr_id_cards WHERE id=?`).get(requestId);
  if (!row) return { ok: false, error: 'ID card request not found.' };
  const status = data.status || row.status;
  const tempIssued = data.tempCardIssued ? 1 : row.temp_card_issued;
  try {
    db.prepare(
      `UPDATE hr_id_cards SET status=?, processed_at_iso=?, collected_at_iso=?, processed_by_user_id=?,
       notes=?, temp_card_issued=?, temp_card_issued_at_iso=?, issue_date_iso=?, expiry_date_iso=?,
       approved_by_user_id=?, printed_by_user_id=?
       WHERE id=?`
    ).run(
      status,
      data.status && data.status !== 'pending' ? now : row.processed_at_iso,
      data.status === 'collected' ? now : row.collected_at_iso,
      actorUser.id,
      data.notes ?? row.notes,
      tempIssued,
      data.tempCardIssued ? now : row.temp_card_issued_at_iso,
      data.issueDateIso ?? row.issue_date_iso,
      data.expiryDateIso ?? row.expiry_date_iso,
      data.status === 'ready' || data.status === 'collected' ? actorUser.id : row.approved_by_user_id,
      data.printed ? actorUser.id : row.printed_by_user_id,
      requestId
    );
  } catch {
    db.prepare(
      `UPDATE hr_id_cards SET status=?, processed_at_iso=?, collected_at_iso=?, processed_by_user_id=?, notes=?, temp_card_issued=?, temp_card_issued_at_iso=? WHERE id=?`
    ).run(
      status,
      data.status ? now : row.processed_at_iso,
      data.status === 'collected' ? now : row.collected_at_iso,
      actorUser.id,
      data.notes || row.notes,
      tempIssued,
      data.tempCardIssued ? now : row.temp_card_issued_at_iso,
      requestId
    );
  }
  return { ok: true };
}

export function getStaffSeverancePreview(db, userId) {
  const profile = db.prepare(`SELECT base_salary_ngn, date_joined_iso FROM hr_staff_profiles WHERE user_id=?`).get(userId);
  if (!profile) return { ok: false, error: 'Staff profile not found.' };
  const joinedMs = Date.parse(String(profile.date_joined_iso || '').slice(0, 10));
  if (!Number.isFinite(joinedMs)) return { ok: false, error: 'Invalid join date.' };
  const yearsOfService = (Date.now() - joinedMs) / (365.25 * 24 * 60 * 60 * 1000);
  const annualSalary = (Number(profile.base_salary_ngn) || 0) * 12;
  const entitlement = calculateSeveranceEntitlement(yearsOfService, annualSalary);
  return { ok: true, yearsOfService: Math.floor(yearsOfService * 10) / 10, annualSalary, ...entitlement };
}

export function getStaffDisciplinaryQueryCount(db, userId) {
  const events = db.prepare(
    `SELECT discipline_kind, created_at_iso FROM hr_discipline_events WHERE user_id=? ORDER BY created_at_iso ASC`
  ).all(userId);
  // Also check hr_disciplinary_events table (older pattern)
  let allEvents = [...events];
  try {
    const alt = db.prepare(`SELECT discipline_kind, created_at_iso FROM hr_disciplinary_events WHERE user_id=? ORDER BY created_at_iso ASC`).all(userId);
    allEvents = [...allEvents, ...alt];
  } catch { /* table may not exist */ }
  const queries = allEvents.filter(e => String(e.discipline_kind||'').toLowerCase().includes('query'));
  const warnings = allEvents.filter(e => String(e.discipline_kind||'').toLowerCase().includes('warning'));
  const suspensions = allEvents.filter(e => String(e.discipline_kind||'').toLowerCase().includes('suspension'));
  const queryCount = queries.length;
  let consequence = null;
  if (queryCount >= 3) consequence = 'termination_due';
  else if (queryCount === 2) consequence = 'promotion_blocked';
  else if (queryCount === 1) consequence = 'none';
  return {
    queryCount,
    warningCount: warnings.length,
    suspensionCount: suspensions.length,
    consequence,
    consequenceLabel: queryCount >= 3 ? 'Termination recommended (3rd query)' : queryCount === 2 ? 'Next promotion blocked (2nd query)' : null,
    promotionBlocked: queryCount >= 2,
    terminationDue: queryCount >= 3,
  };
}

// ── ANALYTICS ─────────────────────────────────────────────────

export function getAttendanceTrends(db, branchId, months) {
  // Returns last N months of attendance summary per branch
  const results = [];
  const now = new Date();
  for (let i = 0; i < (months || 6); i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const startIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const endIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;

    let query = `SELECT status, COUNT(*) as cnt FROM hr_attendance_events WHERE event_date_iso BETWEEN ? AND ?`;
    const params = [startIso, endIso];
    if (branchId) { query += ' AND branch_id=?'; params.push(branchId); }
    query += ' GROUP BY status';

    const rows = db.prepare(query).all(...params);
    const summary = { period: yyyymm, label: d.toLocaleString('en', { month: 'short', year: '2-digit' }), present: 0, absent: 0, late: 0, on_leave: 0 };
    for (const r of rows) {
      const s = String(r.status || '').toLowerCase();
      if (s === 'present') summary.present = r.cnt;
      else if (s === 'absent') summary.absent = r.cnt;
      else if (s === 'late') summary.late = r.cnt;
      else if (s === 'on_leave' || s === 'leave') summary.on_leave = r.cnt;
    }
    const total = summary.present + summary.absent + summary.late + summary.on_leave;
    summary.attendanceRate = total > 0 ? Math.round((summary.present / total) * 100) : 0;
    results.push(summary);
  }
  return results.reverse(); // chronological
}

export function getChronicAbsentees(db, branchId, thresholdDays) {
  // Staff with more than N absent days in the last 90 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  let query = `
    SELECT ae.user_id, u.display_name, sp.branch_id, sp.job_title, COUNT(*) as absent_days
    FROM hr_attendance_events ae
    JOIN users u ON u.id = ae.user_id
    JOIN hr_staff_profiles sp ON sp.user_id = ae.user_id
    WHERE ae.status = 'absent' AND ae.event_date_iso >= ?
  `;
  const params = [cutoffIso];
  if (branchId) { query += ' AND ae.branch_id=?'; params.push(branchId); }
  query += ` GROUP BY ae.user_id HAVING absent_days >= ? ORDER BY absent_days DESC`;
  params.push(thresholdDays || 5);
  return db.prepare(query).all(...params);
}

export function getLoanPortfolioAnalytics(db) {
  // Active loans summary
  const activeLoans = db.prepare(`
    SELECT r.user_id, u.display_name, sp.branch_id, sp.job_title,
           rl.amount_ngn, rl.repayment_months, rl.deduction_per_month_ngn,
           r.created_at_iso, r.status
    FROM hr_requests r
    JOIN hr_request_loan rl ON rl.request_id = r.id
    JOIN users u ON u.id = r.user_id
    JOIN hr_staff_profiles sp ON sp.user_id = r.user_id
    WHERE r.kind = 'loan' AND r.status = 'approved'
    ORDER BY rl.amount_ngn DESC
  `).all();

  // By branch summary
  const byBranch = {};
  for (const l of activeLoans) {
    if (!byBranch[l.branch_id]) byBranch[l.branch_id] = { branchId: l.branch_id, count: 0, totalNgn: 0, monthlyDeductNgn: 0 };
    byBranch[l.branch_id].count++;
    byBranch[l.branch_id].totalNgn += Number(l.amount_ngn) || 0;
    byBranch[l.branch_id].monthlyDeductNgn += Number(l.deduction_per_month_ngn) || 0;
  }

  const totalOutstanding = activeLoans.reduce((s, l) => s + (Number(l.amount_ngn) || 0), 0);
  const totalMonthlyDeductions = activeLoans.reduce((s, l) => s + (Number(l.deduction_per_month_ngn) || 0), 0);

  return {
    activeCount: activeLoans.length,
    totalOutstandingNgn: totalOutstanding,
    totalMonthlyDeductionsNgn: totalMonthlyDeductions,
    byBranch: Object.values(byBranch),
    loans: activeLoans,
  };
}

export function getPayrollVarianceAlerts(db, runId, thresholdPct) {
  const threshold = Number(thresholdPct) || 20; // default 20% change flags alert
  // Get current run lines
  const currentLines = db.prepare(`SELECT user_id, gross_ngn, net_ngn FROM hr_payroll_lines WHERE run_id=?`).all(runId);
  if (!currentLines.length) return { alerts: [], checked: 0 };

  // Get the previous run
  const currentRun = db.prepare(`SELECT period_yyyymm FROM hr_payroll_runs WHERE id=?`).get(runId);
  if (!currentRun) return { alerts: [], checked: 0 };

  const prevRun = db.prepare(`SELECT id FROM hr_payroll_runs WHERE period_yyyymm < ? AND status != 'draft' ORDER BY period_yyyymm DESC LIMIT 1`).get(currentRun.period_yyyymm);
  if (!prevRun) return { alerts: [], checked: currentLines.length, note: 'No previous run to compare.' };

  const prevLines = db.prepare(`SELECT user_id, gross_ngn, net_ngn FROM hr_payroll_lines WHERE run_id=?`).all(prevRun.id);
  const prevByUser = {};
  for (const p of prevLines) prevByUser[p.user_id] = p;

  const alerts = [];
  for (const curr of currentLines) {
    const prev = prevByUser[curr.user_id];
    if (!prev) { alerts.push({ userId: curr.user_id, type: 'new_staff', currentGross: curr.gross_ngn, previousGross: 0, changePct: 100 }); continue; }
    if (prev.gross_ngn === 0) continue;
    const changePct = Math.abs(((curr.gross_ngn - prev.gross_ngn) / prev.gross_ngn) * 100);
    if (changePct >= threshold) {
      alerts.push({ userId: curr.user_id, type: curr.gross_ngn > prev.gross_ngn ? 'increase' : 'decrease', currentGross: curr.gross_ngn, previousGross: prev.gross_ngn, changePct: Math.round(changePct * 10) / 10 });
    }
  }
  // Check for staff in prev but not in current (dropped off)
  for (const prev of prevLines) {
    if (!currentLines.find(c => c.user_id === prev.user_id)) {
      alerts.push({ userId: prev.user_id, type: 'missing_staff', currentGross: 0, previousGross: prev.gross_ngn, changePct: -100 });
    }
  }
  return { alerts, checked: currentLines.length, threshold };
}

export function getStaffTurnoverTrend(db, months) {
  const results = [];
  const now = new Date();
  for (let i = 0; i < (months || 12); i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const startIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const endIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
    const label = d.toLocaleString('en', { month: 'short', year: '2-digit' });
    const period = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const joiners = db.prepare(`SELECT COUNT(*) as cnt FROM hr_staff_profiles WHERE date_joined_iso BETWEEN ? AND ?`).get(startIso, endIso)?.cnt || 0;
    // Leavers: check lifecycle separation last_working_day in this period
    // Since lifecycle is in JSON, we count staff whose status changed to separated in this period
    const leavers = db.prepare(`SELECT COUNT(*) as cnt FROM hr_staff_profiles WHERE status='separated' AND updated_at_iso BETWEEN ? AND ?`).get(startIso + 'T00:00:00', endIso + 'T23:59:59')?.cnt || 0;
    results.push({ period, label, joiners, leavers, net: joiners - leavers });
  }
  return results.reverse();
}

export function getHeadcountSummary(db) {
  const all = db.prepare(`
    SELECT sp.user_id, sp.branch_id, sp.department, sp.employment_type, sp.status, sp.gender, sp.job_title,
           sp.date_joined_iso, u.display_name
    FROM hr_staff_profiles sp JOIN app_users u ON u.id=sp.user_id
    WHERE sp.status='active' OR u.status='active'
  `).all();

  const total = all.length;
  const byBranch = {}; const byDept = {}; const byType = {}; const byGender = { male: 0, female: 0, other: 0, unknown: 0 };
  for (const s of all) {
    byBranch[s.branch_id] = (byBranch[s.branch_id] || 0) + 1;
    byDept[s.department || 'Unknown'] = (byDept[s.department || 'Unknown'] || 0) + 1;
    byType[s.employment_type || 'Unknown'] = (byType[s.employment_type || 'Unknown'] || 0) + 1;
    const g = String(s.gender || '').toLowerCase();
    if (g === 'male') byGender.male++;
    else if (g === 'female') byGender.female++;
    else if (g === 'other') byGender.other++;
    else byGender.unknown++;
  }
  return { total, byBranch, byDepartment: byDept, byEmploymentType: byType, byGender, staff: all };
}

export function detectThreeDayNoShows(db, branchId) {
  // Get last 5 working days of attendance events
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const events = db.prepare(
    `SELECT user_id, event_date_iso, status FROM hr_attendance_events WHERE branch_id=? AND event_date_iso >= ? AND status='absent' ORDER BY user_id, event_date_iso`
  ).all(branchId || null, cutoffIso);
  // Group consecutive absences per user
  const byUser = {};
  for (const e of events) {
    if (!byUser[e.user_id]) byUser[e.user_id] = [];
    byUser[e.user_id].push(e.event_date_iso);
  }
  const flagged = [];
  for (const [userId, dates] of Object.entries(byUser)) {
    // Check for 3+ consecutive absent days
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = Date.parse(dates[i - 1]);
      const curr = Date.parse(dates[i]);
      if ((curr - prev) <= 2 * 24 * 60 * 60 * 1000) { streak++; } // allow weekend gap
      else { streak = 1; }
      if (streak >= 3) { flagged.push({ userId, consecutiveDays: streak, lastAbsentDate: dates[i] }); break; }
    }
  }
  return flagged;
}
