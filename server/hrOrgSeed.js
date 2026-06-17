/**
 * Seed Zarewa standard departments, designations, and salary matrix rows.
 * @module server/hrOrgSeed
 */

import { HR_FUNCTIONAL_OFFICES, DESIGNATION_OFFICE_KEYS, DIRECTOR_CORPORATE_DESIGNATION_IDS } from './hrOrgConstants.js';
import { hrMasterDataTablesReady } from './hrMasterData.js';
import { salaryMatrixReady } from './hrCompensationOps.js';

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} p
 */
function des(p) {
  const {
    duties,
    reporting,
    qualification,
    skills,
    dutiesResponsibilities,
    reportingLine,
    requiredQualification,
    skillsRequired,
    ...rest
  } = p;
  return {
    minServiceYears: 0,
    titleTier: 'officer',
    isActing: false,
    dutiesResponsibilities: dutiesResponsibilities || duties || null,
    reportingLine: reportingLine || reporting || null,
    requiredQualification: requiredQualification || qualification || null,
    skillsRequired: skillsRequired || skills || null,
    ...rest,
    officeKey: p.officeKey || DESIGNATION_OFFICE_KEYS[p.id] || null,
  };
}

const DEPARTMENTS = [
  { id: 'dept_exec', code: 'EXEC', name: 'Executive', branchScope: 'HQ', description: 'Managing Director and executive office' },
  { id: 'dept_hr', code: 'HR', name: 'Human Resources', branchScope: 'HQ', description: 'HR and people operations' },
  { id: 'dept_fin', code: 'FIN', name: 'Finance & Accounts', branchScope: 'HQ', description: 'Finance, treasury, and accounts' },
  { id: 'dept_adm', code: 'ADM', name: 'Administration', branchScope: 'HQ', description: 'Office administration' },
  { id: 'dept_branch', code: 'BRANCH', name: 'Branch Management', branchScope: 'BRANCH', description: 'Factory branch leadership' },
  { id: 'dept_sales', code: 'SALES', name: 'Sales & Commercial', branchScope: 'BRANCH', description: 'Sales and customer service' },
  { id: 'dept_ops', code: 'OPS', name: 'Operations & Production', branchScope: 'BRANCH', description: 'Store, production, and logistics floor' },
  { id: 'dept_proc', code: 'PROC', name: 'Procurement & Supply', branchScope: 'HQ', description: 'Purchasing and vendor management' },
  { id: 'dept_maint', code: 'MAINT', name: 'Maintenance', branchScope: 'BRANCH', description: 'Plant and premises maintenance' },
];

/** @type {ReturnType<typeof des>[]} */
const DESIGNATIONS = [
  des({
    id: 'desig_md',
    code: 'MD',
    departmentCode: 'EXEC',
    title: 'Managing Director',
    level: 7,
    step: 1,
    grade: 'G6-G7',
    seniority: 'leadership',
    siteScope: 'HQ',
    notes: 'Executive + procurement owner',
    titleTier: 'executive',
    minServiceYears: 5,
    qualification: 'B.Sc. or equivalent; relevant experience (≥10% shareholding is a board/governance requirement)',
    duties: 'Oversees all company operations, procurement, logistics, and distribution. Reports to Chairman.',
  }),
  des({ id: 'desig_actmd', code: 'ACTMD', departmentCode: 'EXEC', title: 'Acting Managing Director', level: 7, step: 1, grade: 'G6-G7', seniority: 'leadership', siteScope: 'HQ', notes: 'Board/MD letter only; max 90 days', titleTier: 'acting', minServiceYears: 5, isActing: true }),
  des({ id: 'desig_edo', code: 'EDO', departmentCode: 'EXEC', title: 'Executive Director – Operations', level: 6, step: 1, grade: 'G6-G7', seniority: 'leadership', siteScope: 'HQ', notes: 'Company-wide operations', titleTier: 'executive', minServiceYears: 5 }),
  des({ id: 'desig_edf', code: 'EDF', departmentCode: 'EXEC', title: 'Executive Director – Finance', level: 6, step: 1, grade: 'G6-G7', seniority: 'leadership', siteScope: 'HQ', notes: 'Company-wide finance', titleTier: 'executive', minServiceYears: 5 }),
  des({ id: 'desig_edc', code: 'EDC', departmentCode: 'EXEC', title: 'Executive Director – Commercial', level: 6, step: 1, grade: 'G6-G7', seniority: 'leadership', siteScope: 'HQ', notes: 'Company-wide commercial', titleTier: 'executive', minServiceYears: 5 }),
  des({
    id: 'desig_gmhr',
    code: 'GMHR',
    departmentCode: 'HR',
    title: 'General Manager – Human Resources',
    level: 6,
    step: 1,
    grade: 'G5-G6',
    seniority: 'leadership',
    siteScope: 'HQ',
    notes: 'Final HR approvals',
    titleTier: 'executive',
    minServiceYears: 10,
    qualification: 'B.Sc. or equivalent with minimum 10 years relevant HR experience',
    duties: 'HR management, recruitment, staff welfare, discipline, transfers, and appraisals. Coordinates GMHR review of leave without pay.',
    reporting: 'Managing Director',
  }),
  des({ id: 'desig_csec', code: 'CSEC', departmentCode: 'ADM', title: 'Company Secretary / Admin Manager', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'HQ', notes: 'Governance and HQ admin', titleTier: 'manager', minServiceYears: 4 }),
  des({ id: 'desig_eamd', code: 'EAMD', departmentCode: 'EXEC', title: 'Executive Assistant to MD', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'HQ', notes: 'Diary and confidential correspondence', titleTier: 'officer', minServiceYears: 2 }),
  des({
    id: 'desig_hoa',
    code: 'HOA',
    departmentCode: 'FIN',
    title: 'Head Accountant',
    level: 5,
    step: 1,
    grade: 'G4-G5',
    seniority: 'leadership',
    siteScope: 'HQ',
    notes: 'Finance + procurement paperwork support',
    titleTier: 'manager',
    minServiceYears: 4,
    qualification: 'HND or B.Sc. in Accounting or equivalent',
    duties: 'Financial records, monthly reconciliation, branch oversight, audit coordination.',
    reporting: 'Managing Director',
  }),
  des({
    id: 'desig_acct',
    code: 'ACCT',
    departmentCode: 'FIN',
    title: 'Accountant',
    level: 4,
    step: 1,
    grade: 'G3-G4',
    seniority: 'senior',
    siteScope: 'HQ',
    notes: 'GL, vouchers, reporting',
    titleTier: 'officer',
    minServiceYears: 2,
    qualification: 'HND or equivalent minimum',
    duties: 'Financial records, reconciliation, branch ledger oversight.',
    reporting: 'Managing Director / Head Accountant',
  }),
  des({
    id: 'desig_aud',
    code: 'AUD',
    departmentCode: 'FIN',
    title: 'Internal Auditor',
    level: 4,
    step: 1,
    grade: 'G3-G4',
    seniority: 'senior',
    siteScope: 'HQ',
    notes: 'Monthly document review and branch visits',
    titleTier: 'officer',
    minServiceYears: 3,
    qualification: 'HND or professional accounting qualification',
    duties: 'Monthly audits by document review and branch visits. Coordinates with Accountant and reports to MD.',
    reporting: 'Managing Director',
  }),
  des({ id: 'desig_aacct', code: 'AACCT', departmentCode: 'FIN', title: 'Assistant Accountant', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'HQ', notes: 'Voucher prep — no payment approval', titleTier: 'assistant' }),
  des({ id: 'desig_actacct', code: 'ACTACCT', departmentCode: 'FIN', title: 'Acting Accountant', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'HQ', notes: 'Min HND + 2 yrs; BM + HQ Finance notify', titleTier: 'acting', minServiceYears: 2, isActing: true }),
  des({ id: 'desig_hrm', code: 'HRM', departmentCode: 'HR', title: 'HR Manager / HR & Admin Manager', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'HQ', notes: 'Staff files, recruitment, attendance', titleTier: 'manager', minServiceYears: 4 }),
  des({ id: 'desig_hro', code: 'HRO', departmentCode: 'HR', title: 'HR Officer', level: 3, step: 1, grade: 'G3-G4', seniority: 'mid', siteScope: 'HQ', notes: 'Day-to-day HR', titleTier: 'officer', minServiceYears: 1 }),
  des({ id: 'desig_ahro', code: 'AHRO', departmentCode: 'HR', title: 'Assistant HR Officer', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'HQ', notes: 'Files and leave forms — no discipline', titleTier: 'assistant' }),
  des({ id: 'desig_hra', code: 'HRA', departmentCode: 'HR', title: 'HR Admin Assistant', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'HQ', notes: 'Data capture, ID cards', titleTier: 'assistant' }),
  des({ id: 'desig_acthro', code: 'ACTHRO', departmentCode: 'HR', title: 'Acting HR Officer', level: 3, step: 1, grade: 'G3-G4', seniority: 'mid', siteScope: 'HQ', notes: 'Cover leave; GM HR copied on discipline', titleTier: 'acting', minServiceYears: 1, isActing: true }),
  des({ id: 'desig_hrrep', code: 'HRREP', departmentCode: 'HR', title: 'HR Representative (Branch)', level: 2, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Roll call and first referral only', titleTier: 'officer', minServiceYears: 1 }),
  des({
    id: 'desig_adm',
    code: 'ADM',
    departmentCode: 'ADM',
    title: 'Administration Officer',
    level: 3,
    step: 1,
    grade: 'G2-G3',
    seniority: 'mid',
    siteScope: 'HQ',
    notes: 'Files, minutes, correspondence',
    titleTier: 'officer',
    minServiceYears: 1,
    qualification: 'Diploma with computer literacy',
    duties: 'Custodian of company files and documents. Maintains staff files, meeting minutes, and correspondence.',
    reporting: 'General Manager – Human Resources',
  }),
  des({
    id: 'desig_bm',
    code: 'BM',
    departmentCode: 'BRANCH',
    title: 'Branch Manager',
    level: 5,
    step: 1,
    grade: 'G4-G5',
    seniority: 'leadership',
    siteScope: 'Branch',
    notes: 'Full branch authority',
    titleTier: 'manager',
    minServiceYears: 5,
    qualification: 'Diploma or equivalent',
    duties:
      'Branch operations and staff supervision. Monthly sales target minimum 20,000 metres. Branch operations spending limit ₦100,000 (refunds per MD policy up to ₦1,000,000).',
    reporting: 'Managing Director (operations); Head Accountant (finance); GM HR (people)',
  }),
  des({
    id: 'desig_abm',
    code: 'ABM',
    departmentCode: 'BRANCH',
    title: 'Assistant Branch Manager',
    level: 4,
    step: 1,
    grade: 'G3-G4',
    seniority: 'senior',
    siteScope: 'Branch',
    notes: 'BM backup; may double as Admin Officer',
    titleTier: 'deputy',
    minServiceYears: 3,
    duties: 'Supports Branch Manager; acts as BM in absence; may perform admin officer duties.',
    reporting: 'Branch Manager',
  }),
  des({ id: 'desig_dbm', code: 'DBM', departmentCode: 'BRANCH', title: 'Deputy Branch Manager', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Formal successor to BM', titleTier: 'deputy', minServiceYears: 3 }),
  des({ id: 'desig_actbm', code: 'ACTBM', departmentCode: 'BRANCH', title: 'Acting Branch Manager', level: 4, step: 1, grade: 'G3-G5', seniority: 'senior', siteScope: 'Branch', notes: 'Temporary cover; min L4 + 3 yrs branch', titleTier: 'acting', minServiceYears: 3, isActing: true }),
  des({
    id: 'desig_so',
    code: 'SO',
    departmentCode: 'SALES',
    title: 'Sales Officer / Estimator',
    level: 3,
    step: 1,
    grade: 'G2-G3',
    seniority: 'mid',
    siteScope: 'Branch',
    notes: 'Quotations and customers',
    titleTier: 'officer',
    minServiceYears: 1,
    qualification: 'Diploma with computer skills',
    skills: 'Good communication and client service',
    duties: 'Client interfacing, estimates, quotations, and customer satisfaction.',
    reporting: 'Branch Manager',
  }),
  des({ id: 'desig_aso', code: 'ASO', departmentCode: 'SALES', title: 'Assistant Sales Officer', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Draft quotes — no price exception', titleTier: 'assistant' }),
  des({ id: 'desig_sa', code: 'SA', departmentCode: 'SALES', title: 'Sales Assistant', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Draft quotes — no price exception', titleTier: 'assistant' }),
  des({ id: 'desig_ssup', code: 'SSUP', departmentCode: 'SALES', title: 'Sales Supervisor', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Leads sales officers', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_sso', code: 'SSO', departmentCode: 'SALES', title: 'Senior Sales Officer', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Lead sales when no ABM', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_actsso', code: 'ACTSSO', departmentCode: 'SALES', title: 'Acting Sales Supervisor', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Temporary; supervisor countersigns quotes', titleTier: 'acting', minServiceYears: 2, isActing: true }),
  des({ id: 'desig_st', code: 'ST', departmentCode: 'SALES', title: 'Sales Trainee', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Shadowing only', titleTier: 'trainee' }),
  des({ id: 'desig_cso', code: 'CSO', departmentCode: 'SALES', title: 'Customer Service Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Customer enquiries and order follow-up', titleTier: 'officer', minServiceYears: 1 }),
  des({ id: 'desig_acso', code: 'ACSO', departmentCode: 'SALES', title: 'Assistant Customer Service Officer', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Support desk — no exceptions', titleTier: 'assistant' }),
  des({
    id: 'desig_sk',
    code: 'SK',
    departmentCode: 'OPS',
    title: 'Store Keeper / Inventory & Production Officer',
    level: 3,
    step: 1,
    grade: 'G2-G3',
    seniority: 'mid',
    siteScope: 'Branch',
    notes: 'Stock, GRN, factory supervision (combined hat on branch sites)',
    titleTier: 'officer',
    minServiceYears: 1,
    qualification: 'ND or equivalent',
    duties: 'Inventory management, production records, and supervision of factory staff.',
    reporting: 'Branch Manager',
  }),
  des({ id: 'desig_ask', code: 'ASK', departmentCode: 'OPS', title: 'Assistant Store Keeper', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Receiving help', titleTier: 'assistant' }),
  des({ id: 'desig_ssk', code: 'SSK', departmentCode: 'OPS', title: 'Senior Store Keeper', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Store + light production coord', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_actsk', code: 'ACTSK', departmentCode: 'OPS', title: 'Acting Store Keeper', level: 2, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Temporary cover only', titleTier: 'acting', minServiceYears: 1, isActing: true }),
  des({ id: 'desig_ps', code: 'PS', departmentCode: 'OPS', title: 'Production Supervisor', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Cutting and machines', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_pm', code: 'PM', departmentCode: 'OPS', title: 'Production Manager', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'Branch', notes: 'Large site production lead', titleTier: 'manager', minServiceYears: 4 }),
  des({ id: 'desig_apm', code: 'APM', departmentCode: 'OPS', title: 'Assistant Production Manager', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Deputy to production manager', titleTier: 'deputy', minServiceYears: 2 }),
  des({ id: 'desig_qco', code: 'QCO', departmentCode: 'OPS', title: 'Quality Control Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Conversion variance, incident first review', titleTier: 'officer', minServiceYears: 2 }),
  des({ id: 'desig_op', code: 'OP', departmentCode: 'OPS', title: 'Machine Operator', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Production floor', titleTier: 'officer' }),
  des({ id: 'desig_aop', code: 'AOP', departmentCode: 'OPS', title: 'Assistant Operator', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Production helpers', titleTier: 'assistant' }),
  des({ id: 'desig_fa', code: 'FA', departmentCode: 'OPS', title: 'Factory Assistant', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Helpers', titleTier: 'trainee' }),
  des({ id: 'desig_hop', code: 'HOP', departmentCode: 'PROC', title: 'Head of Procurement', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'HQ', notes: 'Supplier strategy and high-value PO policy', titleTier: 'manager', minServiceYears: 4 }),
  des({ id: 'desig_po', code: 'PO', departmentCode: 'PROC', title: 'Procurement Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'HQ', notes: 'PO processing and vendor follow-up', titleTier: 'officer', minServiceYears: 1 }),
  des({ id: 'desig_apo', code: 'APO', departmentCode: 'PROC', title: 'Assistant Procurement Officer', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'HQ', notes: 'RFQ prep — no PO release', titleTier: 'assistant' }),
  des({ id: 'desig_actpo', code: 'ACTPO', departmentCode: 'PROC', title: 'Acting Procurement Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'HQ', notes: 'Vacancy cover; MD cap on PO value', titleTier: 'acting', minServiceYears: 1, isActing: true }),
  des({
    id: 'desig_csh',
    code: 'CSH',
    departmentCode: 'FIN',
    title: 'Cashier',
    level: 3,
    step: 1,
    grade: 'G2-G3',
    seniority: 'mid',
    siteScope: 'Branch',
    notes: 'Receipts and approved payouts',
    titleTier: 'officer',
    minServiceYears: 1,
    qualification: 'ND or equivalent',
    duties: 'Daily cash transactions and receipts as approved by Branch Manager. Must maintain integrity and discipline.',
    reporting: 'Branch Manager and Accountant',
  }),
  des({ id: 'desig_acsh', code: 'ACSH', departmentCode: 'FIN', title: 'Assistant Cashier', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Till support', titleTier: 'assistant' }),
  des({ id: 'desig_bac', code: 'BAC', departmentCode: 'FIN', title: 'Branch Accountant', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Larger branch only', titleTier: 'officer', minServiceYears: 2 }),
  des({ id: 'desig_mm', code: 'MM', departmentCode: 'MAINT', title: 'Maintenance Manager', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Plant and premises upkeep', titleTier: 'manager', minServiceYears: 3 }),
  des({ id: 'desig_msup', code: 'MSUP', departmentCode: 'MAINT', title: 'Maintenance Supervisor / Engineer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Work orders and downtime', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_mtech', code: 'MTECH', departmentCode: 'MAINT', title: 'Maintenance Technician', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Repairs', titleTier: 'officer' }),
  des({ id: 'desig_amtech', code: 'AMTECH', departmentCode: 'MAINT', title: 'Assistant Technician', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Workshop support', titleTier: 'assistant' }),
  des({ id: 'desig_drv', code: 'DRV', departmentCode: 'ADM', title: 'Driver', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'All', notes: 'Deliveries', titleTier: 'officer' }),
  des({ id: 'desig_sdrv', code: 'SDRV', departmentCode: 'ADM', title: 'Lead Driver', level: 2, step: 2, grade: 'G1-G2', seniority: 'senior', siteScope: 'All', notes: 'Shift lead — not management', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_sec', code: 'SEC', departmentCode: 'ADM', title: 'Security Guard', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'All', notes: 'Gate and watch', titleTier: 'trainee' }),
  des({ id: 'desig_ssec', code: 'SSEC', departmentCode: 'ADM', title: 'Senior Security', level: 2, step: 1, grade: 'G1-G2', seniority: 'senior', siteScope: 'All', notes: 'Shift lead', titleTier: 'supervisor', minServiceYears: 2 }),
  des({ id: 'desig_cln', code: 'CLN', departmentCode: 'ADM', title: 'Cleaner', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'All', notes: 'Premises cleaning', titleTier: 'trainee' }),
];

const MATRIX_LEVELS = [
  { level: 1, label: 'Cleaners / Security / Factory Workers', base: 150_000, housing: 0, transport: 0 },
  { level: 2, label: 'Supervisors / Store / Operators', base: 250_000, housing: 40_000, transport: 20_000 },
  { level: 3, label: 'Marketers / Estimators / Officers', base: 300_000, housing: 40_000, transport: 20_000 },
  { level: 4, label: 'Senior Officers / Assistant BM', base: 380_000, housing: 50_000, transport: 25_000 },
  { level: 5, label: 'Branch Managers / Head Accountant', base: 450_000, housing: 60_000, transport: 30_000 },
  { level: 6, label: 'Senior Managers / GM HR', base: 550_000, housing: 80_000, transport: 35_000 },
  { level: 7, label: 'Executive Directors / MD', base: 700_000, housing: 100_000, transport: 40_000 },
];

const PAYROLL_MATRIX_GROUPS = ['branch_ops', 'hq_admin', 'mining_div', 'scholarship', 'chairman_staffs'];

/** Per-group multiplier on branch baseline matrix (base/housing/transport). */
export const PAYROLL_MATRIX_GROUP_SCALES = {
  branch_ops: { scale: 1, label: 'Branch operations baseline' },
  hq_admin: { scale: 1, label: 'HQ admin (same baseline as branch)' },
  mining_div: { scale: 1.1, label: 'Mining division hardship uplift (+10%)' },
  scholarship: { scale: 0.65, label: 'Scholarship stipend band (65% of branch)' },
  chairman_staffs: { scale: 0.75, label: 'Chairman domestic staff band (75% of branch)' },
};

/**
 * Idempotent seed of Zarewa org standard catalog.
 * @param {import('better-sqlite3').Database} db
 */
export function seedZarewaOrgStandard(db) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data tables missing.' };
  const now = nowIso();
  let departmentsUpserted = 0;
  let designationsUpserted = 0;
  let matrixUpserted = 0;

  const insDept = db.prepare(
    `INSERT INTO hr_departments (id, name, code, branch_scope, head_user_id, description, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
     VALUES (@id, @name, @code, @branch_scope, NULL, @description, 1, @now, @now, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, code=excluded.code, branch_scope=excluded.branch_scope,
       description=excluded.description, active=1, updated_at_iso=excluded.updated_at_iso`
  );

  for (const d of DEPARTMENTS) {
    insDept.run({
      id: d.id,
      name: d.name,
      code: d.code,
      branch_scope: d.branchScope,
      description: d.description,
      now,
    });
    departmentsUpserted += 1;
  }

  const deptByCode = Object.fromEntries(DEPARTMENTS.map((d) => [d.code, d.id]));

  const desigCols = db.prepare(`PRAGMA table_info(hr_designations)`).all().map((c) => c.name);
  const hasTenureCols =
    desigCols.includes('min_service_years') &&
    desigCols.includes('title_tier') &&
    desigCols.includes('functional_office_key');

  const insDes = hasTenureCols
    ? db.prepare(
        `INSERT INTO hr_designations (id, title, department_id, grade_category, seniority_band, default_salary_level, default_salary_step,
          job_description, duties_responsibilities, reporting_line, required_qualification, skills_required, working_conditions,
          salary_range_note, min_service_years, title_tier, functional_office_key, is_acting,
          active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
         VALUES (@id, @title, @department_id, @grade_category, @seniority_band, @default_salary_level, @default_salary_step,
          @job_description, @duties_responsibilities, @reporting_line, @required_qualification, @skills_required, NULL, @salary_range_note, @min_service_years, @title_tier, @functional_office_key, @is_acting,
          1, @now, @now, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, department_id=excluded.department_id, grade_category=excluded.grade_category,
           seniority_band=excluded.seniority_band, default_salary_level=excluded.default_salary_level,
           default_salary_step=excluded.default_salary_step, job_description=excluded.job_description,
           duties_responsibilities=excluded.duties_responsibilities, reporting_line=excluded.reporting_line,
           required_qualification=excluded.required_qualification, skills_required=excluded.skills_required,
           salary_range_note=excluded.salary_range_note, min_service_years=excluded.min_service_years,
           title_tier=excluded.title_tier, functional_office_key=excluded.functional_office_key,
           is_acting=excluded.is_acting, active=1, updated_at_iso=excluded.updated_at_iso`
      )
    : db.prepare(
        `INSERT INTO hr_designations (id, title, department_id, grade_category, seniority_band, default_salary_level, default_salary_step,
          job_description, duties_responsibilities, reporting_line, required_qualification, skills_required, working_conditions,
          salary_range_note, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
         VALUES (@id, @title, @department_id, @grade_category, @seniority_band, @default_salary_level, @default_salary_step,
          @job_description, NULL, NULL, NULL, NULL, NULL, @salary_range_note, 1, @now, @now, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, department_id=excluded.department_id, grade_category=excluded.grade_category,
           seniority_band=excluded.seniority_band, default_salary_level=excluded.default_salary_level,
           default_salary_step=excluded.default_salary_step, job_description=excluded.job_description,
           salary_range_note=excluded.salary_range_note, active=1, updated_at_iso=excluded.updated_at_iso`
      );

  for (const d of DESIGNATIONS) {
    const payload = {
      id: d.id,
      title: d.title,
      department_id: deptByCode[d.departmentCode] || null,
      grade_category: d.grade,
      seniority_band: d.seniority,
      default_salary_level: d.level,
      default_salary_step: d.step,
      job_description: d.notes,
      duties_responsibilities: d.dutiesResponsibilities,
      reporting_line: d.reportingLine,
      required_qualification: d.requiredQualification,
      skills_required: d.skillsRequired,
      salary_range_note: `Site: ${d.siteScope}. Code: ${d.code}. Tier: ${d.titleTier}.`,
      now,
    };
    if (hasTenureCols) {
      Object.assign(payload, {
        min_service_years: d.minServiceYears ?? 0,
        title_tier: d.titleTier || 'officer',
        functional_office_key: d.officeKey || null,
        is_acting: d.isActing ? 1 : 0,
      });
    }
    insDes.run(payload);
    designationsUpserted += 1;
  }

  if (salaryMatrixReady(db)) {
    const STEP_SCALE = {
      1: { base: 1, housing: 1, transport: 1 },
      2: { base: 1.08, housing: 1.05, transport: 1 },
      3: { base: 1.15, housing: 1.1, transport: 1 },
    };
    const insMx = db.prepare(
      `INSERT INTO hr_salary_matrix (id, payroll_group, salary_level, salary_step, base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, notes, updated_at_iso, updated_by_user_id)
       VALUES (@id, @payrollGroup, @level, @step, @base, @housing, @transport, @notes, @now, NULL)
       ON CONFLICT(payroll_group, salary_level, salary_step) DO UPDATE SET
         base_salary_ngn=excluded.base_salary_ngn, housing_allowance_ngn=excluded.housing_allowance_ngn,
         transport_allowance_ngn=excluded.transport_allowance_ngn, notes=excluded.notes, updated_at_iso=excluded.updated_at_iso`
    );
    for (const payrollGroup of PAYROLL_MATRIX_GROUPS) {
      const groupScale = PAYROLL_MATRIX_GROUP_SCALES[payrollGroup]?.scale ?? 1;
      const groupLabel = PAYROLL_MATRIX_GROUP_SCALES[payrollGroup]?.label || payrollGroup;
      for (const r of MATRIX_LEVELS) {
        for (const step of [1, 2, 3]) {
          const scale = STEP_SCALE[step];
          insMx.run({
            id: `hrmx_${payrollGroup}_L${r.level}_S${step}`,
            payrollGroup,
            level: r.level,
            step,
            base: Math.round(r.base * scale.base * groupScale),
            housing: Math.round(r.housing * scale.housing * groupScale),
            transport: Math.round(r.transport * scale.transport * groupScale),
            notes: `${groupLabel} · ${r.label} — step ${step}`,
            now,
          });
          matrixUpserted += 1;
        }
      }
    }
  }

  return {
    ok: true,
    departmentsUpserted,
    designationsUpserted,
    matrixUpserted,
  };
}

export function getZarewaOrgCatalogMeta() {
  return {
    departments: DEPARTMENTS.length,
    designations: DESIGNATIONS.length,
    matrixLevels: MATRIX_LEVELS.length,
    matrixSteps: 3,
    matrixPayrollGroups: PAYROLL_MATRIX_GROUPS,
    matrixPayrollGroupScales: PAYROLL_MATRIX_GROUP_SCALES,
    functionalOffices: HR_FUNCTIONAL_OFFICES,
    designationOfficeKeys: DESIGNATION_OFFICE_KEYS,
    directorCorporateDesignationIds: [...DIRECTOR_CORPORATE_DESIGNATION_IDS],
    docPath: 'docs/HR/ZAREWA-ORG-STRUCTURE-AND-TITLES.md',
  };
}
