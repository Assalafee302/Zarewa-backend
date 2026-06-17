/**
 * Zarewa org desk keys, designation → office mapping, director eligibility.
 * @module server/hrOrgConstants
 */

/** Workflow desk keys (memos / work items) — see docs/HR/ZAREWA-ORG-STRUCTURE-AND-TITLES.md */
export const HR_FUNCTIONAL_OFFICES = [
  { key: 'executive', label: 'Managing Director / Executive' },
  { key: 'office_admin', label: 'General Administration' },
  { key: 'branch_manager', label: 'Branch Manager' },
  { key: 'sales', label: 'Sales & Customer Service' },
  { key: 'operations', label: 'Operations & Store' },
  { key: 'production', label: 'Production Unit' },
  { key: 'procurement', label: 'Procurement & Supply' },
  { key: 'finance', label: 'Finance & Treasury' },
  { key: 'hr', label: 'Human Resources' },
  { key: 'maintenance', label: 'Maintenance & Engineering' },
  { key: 'reports', label: 'Management Information' },
];

/** Primary designations that may hold a corporate / board title. */
export const DIRECTOR_CORPORATE_DESIGNATION_IDS = new Set([
  'desig_md',
  'desig_edo',
  'desig_edf',
  'desig_edc',
]);

/** Designation IDs that imply an acting (temporary) appointment. */
export const ACTING_DESIGNATION_IDS = new Set([
  'desig_actbm',
  'desig_actsk',
  'desig_actmd',
  'desig_actsso',
  'desig_actpo',
  'desig_actacct',
  'desig_acthro',
]);

/** @type {Record<string, string>} designation id → functional office key */
export const DESIGNATION_OFFICE_KEYS = {
  desig_md: 'executive',
  desig_actmd: 'executive',
  desig_edo: 'executive',
  desig_edf: 'finance',
  desig_edc: 'sales',
  desig_gmhr: 'hr',
  desig_hrm: 'hr',
  desig_hro: 'hr',
  desig_ahro: 'hr',
  desig_hra: 'hr',
  desig_acthro: 'hr',
  desig_hrrep: 'hr',
  desig_hoa: 'finance',
  desig_acct: 'finance',
  desig_aacct: 'finance',
  desig_actacct: 'finance',
  desig_adm: 'office_admin',
  desig_csec: 'office_admin',
  desig_eamd: 'executive',
  desig_bm: 'branch_manager',
  desig_abm: 'branch_manager',
  desig_dbm: 'branch_manager',
  desig_actbm: 'branch_manager',
  desig_so: 'sales',
  desig_sa: 'sales',
  desig_aso: 'sales',
  desig_sso: 'sales',
  desig_ssup: 'sales',
  desig_actsso: 'sales',
  desig_st: 'sales',
  desig_cso: 'sales',
  desig_acso: 'sales',
  desig_sk: 'operations',
  desig_ask: 'operations',
  desig_ssk: 'operations',
  desig_actsk: 'operations',
  desig_ps: 'production',
  desig_pm: 'production',
  desig_apm: 'production',
  desig_qco: 'production',
  desig_op: 'production',
  desig_aop: 'production',
  desig_fa: 'production',
  desig_csh: 'finance',
  desig_acsh: 'finance',
  desig_bac: 'finance',
  desig_po: 'procurement',
  desig_hop: 'procurement',
  desig_apo: 'procurement',
  desig_actpo: 'procurement',
  desig_mm: 'maintenance',
  desig_msup: 'maintenance',
  desig_mtech: 'maintenance',
  desig_amtech: 'maintenance',
  desig_drv: 'office_admin',
  desig_sdrv: 'office_admin',
  desig_sec: 'office_admin',
  desig_ssec: 'office_admin',
  desig_cln: 'office_admin',
};

const OFFICE_LABELS = Object.fromEntries(HR_FUNCTIONAL_OFFICES.map((o) => [o.key, o.label]));

export function officeKeyLabel(key) {
  return OFFICE_LABELS[String(key || '').trim()] || String(key || '').replace(/_/g, ' ');
}

/**
 * @param {{ designationId?: string; compensationVarianceType?: string; prevExtra?: object; corporateTitle?: string; boardMember?: boolean }} opts
 */
export function isDirectorCorporateEligible(opts = {}) {
  const designationId = String(opts.designationId || '').trim();
  if (opts.boardMember === true) return true;
  if (DIRECTOR_CORPORATE_DESIGNATION_IDS.has(designationId)) return true;
  if (String(opts.compensationVarianceType || '').trim() === 'director_emolument') return true;
  if (String(opts.prevExtra?.employmentMeta?.corporateTitle || '').trim()) return true;
  return false;
}

/**
 * @param {object} roleInput
 * @param {{ titleById?: Record<string, string> }} [ctx]
 */
export function normalizeSecondaryRole(roleInput, ctx = {}) {
  const designationId = String(roleInput?.designationId || '').trim() || null;
  const titleById = ctx.titleById || {};
  const role =
    (designationId && titleById[designationId]) ||
    String(roleInput?.role || roleInput?.title || '').trim();
  const officeKey =
    (designationId && DESIGNATION_OFFICE_KEYS[designationId]) ||
    String(roleInput?.officeKey || '').trim() ||
    null;
  const acting =
    Boolean(roleInput?.acting) || (designationId ? ACTING_DESIGNATION_IDS.has(designationId) : false);
  return {
    designationId,
    role,
    officeKey,
    branchId: String(roleInput?.branchId || '').trim() || null,
    acting,
    endDateIso: String(roleInput?.endDateIso || '').trim().slice(0, 10) || null,
    notes: String(roleInput?.notes || '').trim() || null,
  };
}

/**
 * Merged functional desks for one staff member (primary + secondary hats).
 * @param {{ designationId?: string; jobTitle?: string; branchId?: string; profileExtra?: object }} staff
 */
export function buildStaffMergedOffices(staff) {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.officeKey}|${entry.branchId || ''}|${entry.primary ? 'P' : 'S'}|${entry.role}`;
    if (!entry.officeKey || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const primaryDes = String(staff?.designationId || '').trim();
  if (primaryDes) {
    push({
      officeKey: DESIGNATION_OFFICE_KEYS[primaryDes] || null,
      role: staff?.jobTitle || null,
      branchId: staff?.branchId || null,
      primary: true,
      acting: ACTING_DESIGNATION_IDS.has(primaryDes),
      label: officeKeyLabel(DESIGNATION_OFFICE_KEYS[primaryDes]),
    });
  }

  const secondary = staff?.profileExtra?.employmentMeta?.secondaryRoles;
  if (Array.isArray(secondary)) {
    for (const sr of secondary) {
      if (!sr?.role && !sr?.designationId) continue;
      push({
        officeKey: sr.officeKey || (sr.designationId ? DESIGNATION_OFFICE_KEYS[sr.designationId] : null),
        role: sr.role || null,
        branchId: sr.branchId || null,
        primary: false,
        acting: Boolean(sr.acting),
        label: officeKeyLabel(sr.officeKey || DESIGNATION_OFFICE_KEYS[sr.designationId]),
      });
    }
  }

  return out.filter((o) => o.officeKey || o.role);
}
