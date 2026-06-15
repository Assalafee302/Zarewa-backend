/**
 * Phase 8 — basic bulk old-staff Excel import.
 * @module server/hrStaffBulkImport
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { updateAppUserStatus } from './auth.js';
import { appendHrAuditEvent, hrTablesReady, registerNewStaffWithProfile, upsertHrStaffProfile } from './hrOps.js';
import { lookupHrSalaryMatrixRow } from './hrCompensationOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { createHrNotification } from './hrNotifications.js';
import { listHrDesignations } from './hrMasterData.js';

export const BULK_IMPORT_DEFAULT_PASSWORD = 'Zarewa@123';

/** Physical branch for HQ, scholarship, and chairman/domestic payroll groups. */
export const BULK_IMPORT_HQ_BRANCH = { id: 'BR-KD', code: 'KD', name: 'Kaduna (HQ)' };

export const BULK_IMPORT_BRANCH_GUIDE = [
  {
    staffType: 'Kaduna branch staff (NOT HQ)',
    workLocation: 'Branch',
    branchCode: 'BR-KD',
    branchName: 'Kaduna',
    notes: 'Factory/branch operations in Kaduna. Work Location must be Branch — not HQ.',
  },
  {
    staffType: 'Yola branch staff',
    workLocation: 'Branch',
    branchCode: 'BR-YL',
    branchName: 'Yola Factory',
    notes: 'Yola factory / branch staff.',
  },
  {
    staffType: 'Maiduguri branch staff',
    workLocation: 'Branch',
    branchCode: 'BR-MDG',
    branchName: 'Maiduguri Factory',
    notes: 'Maiduguri factory / branch staff.',
  },
  {
    staffType: 'HQ staff (central office)',
    workLocation: 'HQ',
    branchCode: 'BR-KD',
    branchName: 'Head Office',
    notes: 'Central HQ roles (Finance HQ, HR HQ, Procurement, MD office). Work Location must be HQ.',
  },
  {
    staffType: 'Scholarship beneficiaries',
    workLocation: 'HQ',
    branchCode: 'BR-KD',
    branchName: 'Head Office',
    notes: 'Department should include Scholarship or School.',
  },
  {
    staffType: 'Chairman / domestic staff',
    workLocation: 'HQ',
    branchCode: 'BR-KD',
    branchName: 'Head Office',
    notes: 'Department should include Chairman or Domestic.',
  },
];

const DOMESTIC_ROLE_TITLES = new Set(
  ['cook', 'driver', 'housekeeper', 'cleaner', 'gardener', 'security', 'steward', 'nanny', 'domestic assistant', 'other'].map(
    (s) => s.toLowerCase()
  )
);

/** Uploaded spreadsheet titles → canonical Zarewa job titles. */
const JOB_TITLE_ALIASES = {
  'acct officer': 'Accounts Officer',
  'account officer': 'Accounts Officer',
  'accounts off': 'Accounts Officer',
  'accts officer': 'Accounts Officer',
  'accountant': 'Accountant',
  'chief accountant': 'Chief Accountant',
  'head of accounts': 'Head of Accounts',
  'finance officer': 'Finance Officer',
  'finance manager': 'Finance Manager',
  'cashier': 'Cashier',
  'cash office': 'Cashier',
  'sales rep': 'Sales Officer',
  'sales representative': 'Sales Officer',
  'sales man': 'Sales Officer',
  'salesman': 'Sales Officer',
  'sales officer': 'Sales Officer',
  'marketing officer': 'Sales Officer',
  'marketer': 'Sales Officer',
  bm: 'Branch Manager',
  'branch mgr': 'Branch Manager',
  'branch manager': 'Branch Manager',
  'sales manager': 'Sales Manager',
  'commercial manager': 'Sales Manager',
  'operations officer': 'Operations Officer',
  'operations manager': 'Operations Manager',
  'production manager': 'Production Manager',
  'factory manager': 'Factory Manager',
  'machine operator': 'Machine Operator',
  operator: 'Machine Operator',
  'store keeper': 'Store Keeper',
  storekeeper: 'Store Keeper',
  'warehouse supervisor': 'Warehouse Supervisor',
  'procurement officer': 'Procurement Officer',
  buyer: 'Procurement Officer',
  'hr officer': 'HR Officer',
  'human resource officer': 'HR Officer',
  'hr manager': 'HR Manager',
  'hr admin': 'HR Administrator',
  'admin officer': 'Administrative Officer',
  secretary: 'Secretary',
  'office assistant': 'Office Assistant',
  driver: 'Driver',
  'company driver': 'Driver',
  cook: 'Cook',
  chef: 'Cook',
  housekeeper: 'Housekeeper',
  'house keeper': 'Housekeeper',
  cleaner: 'Cleaner',
  gardener: 'Gardener',
  security: 'Security Officer',
  'security guard': 'Security Officer',
  'security officer': 'Security Officer',
  nanny: 'Nanny',
  steward: 'Steward',
  'domestic assistant': 'Domestic Assistant',
  'domestic staff': 'Domestic Assistant',
  ceo: 'CEO',
  'chief executive': 'CEO',
  'chief executive officer': 'CEO',
  'managing director': 'Managing Director',
  'general manager': 'General Manager',
  gm: 'General Manager',
  'asst branch manager': 'Assistant Branch Manager',
  'assistant branch manager': 'Assistant Branch Manager',
  'asst store keeper': 'Assistant Store Keeper',
  'assistant store keeper': 'Assistant Store Keeper',
  estimator: 'Estimator',
  'factory worker': 'Factory Worker',
  operatpr: 'Machine Operator',
  'operator ii': 'Machine Operator',
  'operator i i': 'Machine Operator',
  'machine operator ii': 'Machine Operator',
  intern: 'Intern',
  nysc: 'NYSC Intern',
  scholarship: 'Scholarship Beneficiary',
  scholaship: 'Scholarship Beneficiary',
  'site engineer': 'Site Engineer',
  'truck driver': 'Truck Driver',
  'it officer': 'IT Officer',
  'logistics officer': 'Logistics Officer',
  'warehouse officer': 'Warehouse Officer',
};

/** At least one of firstName, surname, displayName, or employeeNumber must be present per row. */
export const BULK_IMPORT_COLUMNS = [
  { key: 'firstName', header: 'First Name', required: false },
  { key: 'surname', header: 'Surname', required: false },
  { key: 'displayName', header: 'Display Name', required: false },
  { key: 'phoneNumber', header: 'Phone Number', required: false },
  { key: 'email', header: 'Email', required: false },
  { key: 'employeeNumber', header: 'Employee Number', required: false },
  { key: 'workLocation', header: 'Work Location', required: false },
  { key: 'branchCode', header: 'Branch Code', required: false },
  { key: 'branchName', header: 'Branch Name', required: false },
  { key: 'departmentCode', header: 'Department Code', required: false },
  { key: 'departmentName', header: 'Department Name', required: false },
  { key: 'designation', header: 'Designation / Job Title', required: false },
  { key: 'employmentType', header: 'Employment Type', required: false },
  { key: 'employmentStatus', header: 'Employment Status', required: false },
  { key: 'dateJoined', header: 'Date Joined', required: false },
  { key: 'basicSalary', header: 'Basic Salary', required: false },
  { key: 'bankName', header: 'Bank Name', required: false },
  { key: 'bankCode', header: 'Bank Code', required: false },
  { key: 'accountNumber', header: 'Account Number', required: false },
  { key: 'accountName', header: 'Account Name', required: false },
  { key: 'gender', header: 'Gender', required: false },
  { key: 'dateOfBirth', header: 'Date of Birth', required: false },
  { key: 'residentialAddress', header: 'Residential Address', required: false },
  { key: 'nextOfKinName', header: 'Next of Kin Name', required: false },
  { key: 'nextOfKinPhone', header: 'Next of Kin Phone', required: false },
  { key: 'highestQualification', header: 'Highest Qualification', required: false },
  { key: 'designationCode', header: 'Designation Code', required: false },
  { key: 'payrollGroup', header: 'Payroll Group', required: false },
  { key: 'salaryLevel', header: 'Salary Level', required: false },
  { key: 'salaryStep', header: 'Salary Step', required: false },
  { key: 'payAdditionNgn', header: 'Pay Addition (NGN)', required: false },
  { key: 'compensationVarianceType', header: 'Variance Type', required: false },
  { key: 'compensationVarianceNotes', header: 'Variance Notes', required: false },
];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function normHeader(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[_#]/g, ' ')
    .trim();
}

function parseDateIso(v) {
  if (v instanceof Date && !Number.isNaN(+v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const utc = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(utc);
    if (!Number.isNaN(+d)) return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}

function mapRow(raw, headerMap) {
  const get = (key) => {
    const col = headerMap[key];
    if (!col) return '';
    const v = raw[col];
    if (key === 'accountNumber') return String(v ?? '').trim();
    return v == null ? '' : String(v).trim();
  };
  return {
    firstName: get('firstName'),
    surname: get('surname'),
    displayName: get('displayName'),
    phoneNumber: get('phoneNumber'),
    email: get('email'),
    employeeNumber: get('employeeNumber'),
    workLocation: get('workLocation'),
    branchCode: get('branchCode'),
    branchName: get('branchName'),
    departmentCode: get('departmentCode'),
    departmentName: get('departmentName'),
    designation: get('designation'),
    employmentType: get('employmentType'),
    employmentStatus: get('employmentStatus'),
    dateJoined: parseDateIso(raw[headerMap.dateJoined]),
    basicSalary: get('basicSalary'),
    bankName: get('bankName'),
    bankCode: get('bankCode'),
    accountNumber: get('accountNumber'),
    accountName: get('accountName'),
    gender: get('gender'),
    dateOfBirth: parseDateIso(raw[headerMap.dateOfBirth]),
    residentialAddress: get('residentialAddress'),
    nextOfKinName: get('nextOfKinName'),
    nextOfKinPhone: get('nextOfKinPhone'),
    highestQualification: get('highestQualification'),
    designationCode: get('designationCode'),
    payrollGroup: get('payrollGroup'),
    salaryLevel: get('salaryLevel'),
    salaryStep: get('salaryStep'),
    payAdditionNgn: get('payAdditionNgn'),
    compensationVarianceType: get('compensationVarianceType'),
    compensationVarianceNotes: get('compensationVarianceNotes'),
  };
}

function buildHeaderMap(sheetHeaders) {
  const map = {};
  for (const col of BULK_IMPORT_COLUMNS) {
    const want = normHeader(col.header);
    for (const h of sheetHeaders) {
      if (normHeader(h) === want) {
        map[col.key] = h;
        break;
      }
    }
  }
  return map;
}

export function buildBulkImportTemplateXlsx() {
  const headers = BULK_IMPORT_COLUMNS.map((c) => c.header);
  const kadunaBranchSample = [
    'Amina',
    'Bello',
    'Amina Bello',
    '08030000001',
    'amina.bello@example.com',
    'KD-001',
    'Branch',
    'BR-KD',
    'Kaduna',
    'SAL',
    'Sales',
    'Sales Officer',
    'permanent',
    'active',
    '2020-01-15',
    '150000',
    '',
    '',
    '',
    '',
    'Female',
    '1990-05-01',
    'Kaduna',
    'Ibrahim Bello',
    '08030000002',
    'B.Sc Business',
    'SO',
    'branch_ops',
    '3',
    '1',
    '',
    '',
    '',
  ];
  const hqSample = [
    'Musa',
    'Ibrahim',
    'Musa Ibrahim',
    '08030000003',
    'musa.ibrahim@example.com',
    'HQ-010',
    'HQ',
    'BR-KD',
    'Head Office',
    'FIN',
    'Finance HQ',
    'Accountant',
    'permanent',
    'active',
    '2019-06-01',
    '280000',
    '',
    '',
    '',
    '',
    'Male',
    '1985-03-12',
    'Kaduna',
    '',
    '',
    'B.Sc Accounting',
    'HOA',
    'branch_ops',
    '5',
    '1',
    '300000',
    'multi_role_consolidation',
    'Head Accountant + acting desks',
  ];
  const guideHeaders = ['Staff type', 'Work Location', 'Branch Code', 'Branch Name', 'Notes'];
  const guideRows = BULK_IMPORT_BRANCH_GUIDE.map((g) => [
    g.staffType,
    g.workLocation,
    g.branchCode,
    g.branchName,
    g.notes || '',
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, kadunaBranchSample, hqSample]);
  const guideWs = XLSX.utils.aoa_to_sheet([guideHeaders, ...guideRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Staff Import');
  XLSX.utils.book_append_sheet(wb, guideWs, 'Branch guide');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function lookupBranchId(db, codeOrId, name) {
  const code = String(codeOrId || '').trim();
  if (code) {
    const b = db.prepare(`SELECT id FROM branches WHERE id = ? OR code = ? LIMIT 1`).get(code, code);
    if (b) return b.id;
  }
  const nameQ = String(name || '').trim();
  if (nameQ) {
    const b = db.prepare(`SELECT id FROM branches WHERE name LIKE ? LIMIT 1`).get(`%${nameQ}%`);
    if (b) return b.id;
  }
  return null;
}

function resolveBranchId(db, row, scope) {
  const payrollGroup = detectStaffPayrollGroup(row);
  if (['scholarship', 'chairman_staffs', 'mining_div', 'hq_admin'].includes(payrollGroup)) {
    return null;
  }
  const bag = normTitleToken(
    `${row.workLocation || ''} ${row.branchCode || ''} ${row.branchName || ''} ${row.departmentName || ''}`
  );
  if (bag.includes('hq') || bag.includes('head office') || bag.includes('kaduna hq')) {
    return lookupBranchId(db, BULK_IMPORT_HQ_BRANCH.id, BULK_IMPORT_HQ_BRANCH.name) || BULK_IMPORT_HQ_BRANCH.id;
  }
  const mapped = lookupBranchId(db, row.branchCode, row.branchName);
  if (mapped) return mapped;
  if (bag.includes('yola')) return lookupBranchId(db, 'BR-YL', 'Yola') || 'BR-YL';
  if (bag.includes('maiduguri') || bag.includes('maig')) return lookupBranchId(db, 'BR-MDG', 'Maiduguri') || 'BR-MDG';
  if (bag.includes('jalingo')) return lookupBranchId(db, row.branchCode, row.branchName) || DEFAULT_BRANCH_ID;
  if (bag.includes('kaduna') || bag.includes('kd')) return lookupBranchId(db, 'BR-KD', 'Kaduna') || DEFAULT_BRANCH_ID;
  return scope?.branchId || DEFAULT_BRANCH_ID;
}

const VALID_EMPLOYMENT_TYPES = new Set(['permanent', 'contract', 'casual', 'intern', 'temporary']);
const VALID_GENDERS = new Set(['male', 'female', 'other']);
const VALID_EMPLOYMENT_STATUSES = new Set(['active', 'probation', 'suspended', 'inactive', 'terminated', 'resigned']);

function sanitizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

function sanitizePhone(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  return String(v ?? '').trim();
}

function sanitizeEmploymentType(v) {
  const s = normTitleToken(v);
  if (!s) return '';
  if (s.includes('permanent') || s.includes('full')) return 'permanent';
  if (s.includes('contract') || s.includes('temp')) return 'contract';
  if (s.includes('casual')) return 'casual';
  if (s.includes('intern') || s.includes('siwes')) return 'intern';
  if (VALID_EMPLOYMENT_TYPES.has(s)) return s;
  return '';
}

function sanitizeEmploymentStatus(v) {
  const s = normTitleToken(v);
  if (!s) return '';
  if (VALID_EMPLOYMENT_STATUSES.has(s)) return s;
  if (s.includes('active')) return 'active';
  if (s.includes('probation')) return 'probation';
  return '';
}

function sanitizeGender(v) {
  const s = normTitleToken(v);
  if (!s) return '';
  if (s.startsWith('m')) return 'male';
  if (s.startsWith('f')) return 'female';
  if (VALID_GENDERS.has(s)) return s;
  return '';
}

function sanitizeSalary(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0);
  return n > 0 ? String(n) : '';
}

function sanitizeAccountNumber(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 12) return '';
  return digits;
}

function sanitizePayrollGroup(v) {
  const s = String(v || '').trim().toLowerCase();
  const allowed = new Set(['branch_ops', 'hq_admin', 'mining_div', 'scholarship', 'chairman_staffs']);
  return allowed.has(s) ? s : '';
}

function sanitizePosInt(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[^\d]/g, '')) || 0);
  return n >= 1 && n <= 9 ? String(n) : '';
}

function sanitizeVarianceType(v) {
  const s = String(v || '').trim().toLowerCase();
  const allowed = new Set([
    'merit_outstanding',
    'scarce_skill_retention',
    'multi_role_consolidation',
    'director_emolument',
    'acting_allowance',
    'market_adjustment',
    'special_occasion',
  ]);
  return allowed.has(s) ? s : String(v || '').trim() || '';
}

/** Drop or normalize values that do not match import spec — never block import for these. */
export function sanitizeImportRow(row) {
  const out = { ...row };
  out.email = sanitizeEmail(out.email);
  out.phoneNumber = sanitizePhone(out.phoneNumber);
  out.employmentType = sanitizeEmploymentType(out.employmentType);
  out.employmentStatus = sanitizeEmploymentStatus(out.employmentStatus);
  out.gender = sanitizeGender(out.gender);
  out.basicSalary = sanitizeSalary(out.basicSalary);
  out.payrollGroup = sanitizePayrollGroup(out.payrollGroup);
  out.salaryLevel = sanitizePosInt(out.salaryLevel);
  out.salaryStep = sanitizePosInt(out.salaryStep) || (out.salaryLevel ? '1' : '');
  out.payAdditionNgn = sanitizeSalary(out.payAdditionNgn);
  out.compensationVarianceType = sanitizeVarianceType(out.compensationVarianceType);
  out.designationCode = String(out.designationCode || '').trim().toUpperCase();
  const joined = parseDateIso(out.dateJoined);
  out.dateJoined = joined || '';
  const dob = parseDateIso(out.dateOfBirth);
  out.dateOfBirth = dob || '';
  const acct = sanitizeAccountNumber(out.accountNumber);
  out.accountNumber = acct;
  if (!acct) out.bankCode = '';
  return out;
}

function normTitleToken(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function slugToken(s, max = 30) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, max);
}

function buildDesignationIndex(db) {
  const designations = listHrDesignations(db, { includeInactive: false });
  const byNormTitle = new Map();
  const byCode = new Map();
  for (const d of designations) {
    byNormTitle.set(normTitleToken(d.title), d);
    const note = String(d.salaryRangeNote || '');
    const codeMatch = note.match(/Code:\s*([A-Za-z0-9_-]+)/i);
    if (codeMatch) byCode.set(codeMatch[1].toUpperCase(), d);
  }
  return { designations, byNormTitle, byCode };
}

function resolveDesignationByCode(code, designationIndex) {
  const token = String(code || '').trim().toUpperCase();
  if (!token || !designationIndex?.byCode) return null;
  return designationIndex.byCode.get(token) || null;
}

function canonicalDomesticTitle(raw) {
  const norm = normTitleToken(raw);
  if (!norm) return null;
  if (DOMESTIC_ROLE_TITLES.has(norm)) return toTitleCase(norm === 'other' ? 'Domestic Assistant' : norm);
  for (const role of DOMESTIC_ROLE_TITLES) {
    if (norm.includes(role)) return toTitleCase(role === 'other' ? 'Domestic Assistant' : role);
  }
  return null;
}

export function resolveUploadedJobTitle(rawTitle, designationIndex) {
  const raw = String(rawTitle || '').trim();
  if (!raw) {
    return { jobTitle: null, designationId: null, titleCorrected: false, originalTitle: '', matchKind: 'missing' };
  }
  const norm = normTitleToken(raw);
  const aliasTarget = JOB_TITLE_ALIASES[norm];
  const candidate = aliasTarget || raw;
  const candidateNorm = normTitleToken(candidate);

  const exact = designationIndex.byNormTitle.get(candidateNorm);
  if (exact) {
    return {
      jobTitle: exact.title,
      designationId: exact.id,
      titleCorrected: exact.title !== raw,
      originalTitle: raw,
      matchKind: 'master_exact',
    };
  }

  let best = null;
  let bestScore = 0;
  for (const d of designationIndex.designations) {
    const dn = normTitleToken(d.title);
    if (!dn || (!dn.includes(candidateNorm) && !candidateNorm.includes(dn))) continue;
    const score = Math.min(dn.length, candidateNorm.length) / Math.max(dn.length, candidateNorm.length);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  if (best && bestScore >= 0.55) {
    return {
      jobTitle: best.title,
      designationId: best.id,
      titleCorrected: best.title !== raw,
      originalTitle: raw,
      matchKind: 'master_fuzzy',
    };
  }

  const domestic = canonicalDomesticTitle(candidate);
  if (domestic) {
    return {
      jobTitle: domestic,
      designationId: null,
      titleCorrected: domestic !== raw,
      originalTitle: raw,
      matchKind: 'domestic',
    };
  }

  const cleaned = aliasTarget ? aliasTarget : toTitleCase(raw);
  return {
    jobTitle: cleaned,
    designationId: null,
    titleCorrected: cleaned !== raw,
    originalTitle: raw,
    matchKind: aliasTarget ? 'alias' : 'free_text',
  };
}

export function detectStaffPayrollGroup(row) {
  const bag = normTitleToken(
    `${row.departmentName || ''} ${row.departmentCode || ''} ${row.workLocation || ''} ${row.designation || ''}`
  );
  if (bag.includes('scholar') || bag.includes('school fee') || bag.includes('student')) return 'scholarship';
  if (
    bag.includes('chairman') ||
    bag.includes('domestic') ||
    canonicalDomesticTitle(row.designation) ||
    DOMESTIC_ROLE_TITLES.has(normTitleToken(row.designation))
  ) {
    return 'chairman_staffs';
  }
  if (bag.includes('mining')) return 'mining_div';
  if (
    bag.includes('head office') ||
    bag.includes('hq ') ||
    bag === 'hq' ||
    (bag.includes('administrative') && bag.includes('hq'))
  ) {
    return 'hq_admin';
  }
  return 'branch_ops';
}

export function mapRoleKeyFromJob(jobTitle, department, payrollGroup) {
  const s = normTitleToken(`${jobTitle || ''} ${department || ''}`);
  if (payrollGroup === 'scholarship' || payrollGroup === 'chairman_staffs') return 'sales_staff';
  if (!s) return 'sales_staff';
  if (/\bceo\b|chief executive/.test(s)) return 'ceo';
  if (/managing director|\bmd\b/.test(s)) return 'md';
  if (/general manager|\bgm\b/.test(s)) return 'sales_manager';
  if (/human\s*resource|^hr\b|hr\s*admin|personnel/.test(s)) return 'hr_admin';
  if (/finance|accountant|account\s*officer|treasury/.test(s)) return 'finance_manager';
  if (/cashier|cash\s*office/.test(s)) return 'cashier';
  if (/branch\s*manager|\bbm\b/.test(s)) return 'sales_manager';
  if (/sales\s*manager|commercial\s*manager/.test(s)) return 'sales_manager';
  if (/procurement|buyer/.test(s)) return 'operations_officer';
  if (/operation|production|factory|logistics|warehouse|machine|store/.test(s)) return 'operations_officer';
  if (/driver|security|cleaner|cook|housekeeper|gardener|nanny|steward|domestic/.test(s)) return 'sales_staff';
  if (/viewer|read\s*only|audit/.test(s)) return 'viewer';
  if (/sales|marketer|rep|officer/.test(s)) return 'sales_staff';
  return 'sales_staff';
}

export function buildSurnameIdUsername(row, rowNum, usedUsernames) {
  const surname = slugToken(row.surname || deriveDisplayName(row).split(/\s+/).pop(), 24);
  const empId = slugToken(String(row.employeeNumber || '').replace(/^emp[-\s]*/i, ''), 20);
  let base = '';
  if (surname && empId) base = `${surname}.${empId}`;
  else if (surname) base = `${surname}.r${rowNum}`;
  else if (empId) base = `staff.${empId}`;
  else base = slugUsername(deriveDisplayName(row), row.employeeNumber);
  let username = base.slice(0, 48);
  let suffix = 0;
  while (usedUsernames.has(username)) {
    suffix += 1;
    username = `${base}${suffix}`.slice(0, 48);
  }
  usedUsernames.add(username);
  return username;
}

function deriveDisplayName(row) {
  const explicit = String(row.displayName || '').trim();
  if (explicit) return explicit;
  const composed = `${String(row.firstName || '').trim()} ${String(row.surname || '').trim()}`.trim();
  if (composed) return composed;
  const empNo = String(row.employeeNumber || '').trim();
  if (empNo) return `Staff ${empNo}`;
  return '';
}

function isBlankImportRow(row) {
  return !Object.values(row).some((v) => String(v ?? '').trim());
}

function collectExistingPhones(db) {
  const phones = new Set();
  const phoneToUserId = new Map();
  const rows = db
    .prepare(`SELECT user_id, profile_extra_json FROM hr_staff_profiles WHERE profile_extra_json IS NOT NULL AND trim(profile_extra_json) != ''`)
    .all();
  for (const row of rows) {
    try {
      const extra = JSON.parse(row.profile_extra_json);
      const phone = String(extra?.personal?.phone || '').trim();
      if (phone) {
        phones.add(phone);
        phoneToUserId.set(phone, row.user_id);
      }
    } catch {
      /* ignore malformed profile JSON */
    }
  }
  return { phones, phoneToUserId };
}

function normalizeImportMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'replace' ? 'replace' : 'update';
}

export function countActiveHrStaffForImportClean(db) {
  if (!hrTablesReady(db)) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM app_users u
         INNER JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.status = 'active' AND u.role_key NOT IN ('admin', 'md')`
      )
      .get()?.c || 0
  );
}

function suspendActiveHrStaffBeforeReplace(db, actorUserId) {
  const rows = db
    .prepare(
      `SELECT u.id FROM app_users u
       INNER JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE u.status = 'active' AND u.role_key NOT IN ('admin', 'md')`
    )
    .all();
  let suspended = 0;
  for (const row of rows) {
    const r = updateAppUserStatus(db, row.id, 'suspended', { actorUserId });
    if (r.ok) suspended += 1;
  }
  return suspended;
}

function buildExistingStaffMaps(db) {
  const employeeNoToUserId = new Map();
  const userIdToUsername = new Map();
  const rows = db
    .prepare(
      `SELECT trim(p.employee_no) AS employeeNo, p.user_id AS userId, lower(trim(u.username)) AS username
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id
       WHERE p.employee_no IS NOT NULL AND trim(p.employee_no) != ''`
    )
    .all();
  for (const row of rows) {
    if (row.employeeNo) employeeNoToUserId.set(String(row.employeeNo), row.userId);
    if (row.userId && row.username) userIdToUsername.set(row.userId, row.username);
  }
  return { employeeNoToUserId, userIdToUsername };
}

function buildEmailToUserIdMap(db) {
  const emailToUserId = new Map();
  const rows = db
    .prepare(`SELECT id, lower(trim(email)) AS email FROM app_users WHERE email IS NOT NULL AND trim(email) != ''`)
    .all();
  for (const row of rows) {
    if (row.email) emailToUserId.set(row.email, row.id);
  }
  return emailToUserId;
}

function rowToProfileBody(db, row, scope, { userId, includeCredentials = true } = {}) {
  const displayName = deriveDisplayName(row);
  const hasNextOfKin = String(row.nextOfKinName || row.nextOfKinPhone || '').trim();
  const payrollGroup =
    row.payrollGroup || row.resolvedPayrollGroup || detectStaffPayrollGroup(row);
  const salaryLevel = row.salaryLevel ? Number(row.salaryLevel) : null;
  const salaryStep = row.salaryStep ? Number(row.salaryStep) : salaryLevel ? 1 : null;
  const payAdditionFromColumn = row.payAdditionNgn ? Math.round(Number(row.payAdditionNgn) || 0) : null;
  let payAdditionNgn = payAdditionFromColumn;
  const basicSalaryNgn = row.basicSalary ? Math.round(Number(String(row.basicSalary).replace(/[^\d.]/g, '')) || 0) : 0;

  if (salaryLevel && salaryStep && payAdditionNgn == null && basicSalaryNgn > 0) {
    const matrixRow = lookupHrSalaryMatrixRow(db, payrollGroup, salaryLevel, salaryStep);
    if (matrixRow) {
      const matrixTotal =
        Math.round(Number(matrixRow.baseSalaryNgn) || 0) +
        Math.round(Number(matrixRow.housingAllowanceNgn) || 0) +
        Math.round(Number(matrixRow.transportAllowanceNgn) || 0);
      if (basicSalaryNgn > matrixTotal) payAdditionNgn = basicSalaryNgn - matrixTotal;
    }
  }

  const body = {
    ...(userId ? { userId } : {}),
    displayName,
    firstName: row.firstName || undefined,
    surname: row.surname || undefined,
    personalEmail: row.email || undefined,
    phone: row.phoneNumber || undefined,
    employeeNo: row.employeeNumber || undefined,
    branchId: row.branchId || resolveBranchId(db, row, scope),
    jobTitle: row.mappedJobTitle || row.designation || undefined,
    designationId: row.designationId || undefined,
    department: row.departmentName || row.departmentCode || undefined,
    employmentType: row.employmentType || undefined,
    employmentStatus: row.employmentStatus || undefined,
    workLocation: row.workLocation || undefined,
    dateJoinedIso: row.dateJoined || undefined,
    payrollGroup,
    gender: row.gender || undefined,
    dateOfBirthIso: row.dateOfBirth || undefined,
    dateOfBirth: row.dateOfBirth || undefined,
    residentialAddress: row.residentialAddress || undefined,
    minimumQualification: row.highestQualification || undefined,
    bankName: row.bankName || undefined,
    bankAccountName: row.accountName || undefined,
    bankAccountNoMasked: row.accountNumber ? `****${String(row.accountNumber).slice(-4)}` : undefined,
    nextOfKin: hasNextOfKin ? { name: row.nextOfKinName || null, phone: row.nextOfKinPhone || null } : undefined,
    selfServiceEligible: true,
  };

  if (salaryLevel && salaryStep) {
    body.salaryLevel = salaryLevel;
    body.salaryStep = salaryStep;
    body.applyMatrixPay = true;
    if (payAdditionNgn != null && payAdditionNgn > 0) {
      body.payAdditionNgn = payAdditionNgn;
      if (row.compensationVarianceType) body.compensationVarianceType = row.compensationVarianceType;
      if (row.compensationVarianceNotes) body.compensationVarianceNotes = row.compensationVarianceNotes;
      else if (payAdditionFromColumn == null) {
        body.compensationVarianceType = body.compensationVarianceType || 'multi_role_consolidation';
        body.compensationVarianceNotes = 'Imported from legacy basic salary above matrix — review.';
      }
    }
  } else if (basicSalaryNgn > 0) {
    body.baseSalaryNgn = basicSalaryNgn;
  }

  if (includeCredentials) {
    body.username = row.proposedUsername;
    body.password = String(process.env.ZAREWA_STAFF_IMPORT_PASSWORD || BULK_IMPORT_DEFAULT_PASSWORD).trim();
    body.roleKey =
      row.roleKey || mapRoleKeyFromJob(row.mappedJobTitle, row.departmentName || row.departmentCode, payrollGroup);
  }
  return body;
}

function validateRow(db, row, rowNum, existingKeys, designationIndex, usedUsernames, importMode = 'update') {
  const errors = [];
  const warnings = [];
  const mode = normalizeImportMode(importMode);
  const displayName = deriveDisplayName(row);
  if (!displayName) {
    errors.push({
      field: 'displayName',
      message: 'At least one of Display Name, First Name, Surname, or Employee Number is required',
    });
  }
  const empNo = String(row.employeeNumber || '').trim();
  let importAction = 'create';
  let existingUserId = null;
  let existingUsername = null;

  if (empNo && existingKeys.employeeNosInFile?.has(empNo)) {
    errors.push({ field: 'employeeNumber', message: 'Duplicate employee number in this file' });
  }
  if (empNo && existingKeys.employeeNoToUserId?.has(empNo)) {
    importAction = 'update';
    existingUserId = existingKeys.employeeNoToUserId.get(empNo);
    existingUsername = existingKeys.userIdToUsername?.get(existingUserId) || null;
  } else if (empNo && mode === 'update' && existingKeys.employeeNos?.has(empNo)) {
    errors.push({ field: 'employeeNumber', message: 'Duplicate employee number' });
  }

  const email = String(row.email || '').trim().toLowerCase();
  if (email) {
    const owner = existingKeys.emailToUserId?.get(email);
    if (owner && owner !== existingUserId) errors.push({ field: 'email', message: 'Duplicate email' });
  }
  const phone = String(row.phoneNumber || '').trim();
  if (phone) {
    const owner = existingKeys.phoneToUserId?.get(phone);
    if (owner && owner !== existingUserId) errors.push({ field: 'phoneNumber', message: 'Duplicate phone' });
  }
  const branchId = resolveBranchId(db, row, {});

  const titleResolved = resolveUploadedJobTitle(row.designation, designationIndex);
  const codeMatch = resolveDesignationByCode(row.designationCode, designationIndex);
  const resolvedTitle =
    codeMatch != null
      ? {
          jobTitle: codeMatch.title,
          designationId: codeMatch.id,
          titleCorrected: codeMatch.title !== row.designation,
          originalTitle: row.designation || row.designationCode,
          matchKind: 'master_code',
        }
      : titleResolved;
  const payrollGroup =
    row.payrollGroup || detectStaffPayrollGroup({ ...row, designation: resolvedTitle.jobTitle || row.designation });
  const roleKey = mapRoleKeyFromJob(
    resolvedTitle.jobTitle || row.designation,
    row.departmentName || row.departmentCode,
    payrollGroup
  );
  const proposedUsername = existingUsername || buildSurnameIdUsername(row, rowNum, usedUsernames);
  if (!existingUsername && mode !== 'replace' && existingKeys.usernames?.has(proposedUsername)) {
    errors.push({ field: 'username', message: `Username "${proposedUsername}" already exists` });
  }
  if (row.designationCode && !codeMatch) {
    warnings.push({ field: 'designationCode', message: `Unknown designation code "${row.designationCode}" — using job title match` });
  }
  if (row.payAdditionNgn && !row.salaryLevel) {
    warnings.push({ field: 'payAdditionNgn', message: 'Pay addition ignored without salary level/step — set level or use legacy pay backfill' });
  }
  if (importAction === 'update') {
    warnings.push({ field: 'employeeNumber', message: 'Existing employee — profile will be updated' });
  }

  return {
    errors,
    warnings,
    branchId,
    displayName,
    proposedUsername,
    mappedJobTitle: resolvedTitle.jobTitle,
    designationId: resolvedTitle.designationId,
    titleCorrected: resolvedTitle.titleCorrected,
    originalJobTitle: resolvedTitle.originalTitle,
    payrollGroup,
    resolvedPayrollGroup: payrollGroup,
    salaryLevel: row.salaryLevel || null,
    salaryStep: row.salaryStep || null,
    payAdditionNgn: row.payAdditionNgn || null,
    compensationVarianceType: row.compensationVarianceType || null,
    compensationVarianceNotes: row.compensationVarianceNotes || null,
    roleKey,
    importAction,
    existingUserId,
  };
}

export function previewBulkStaffImport(db, buffer, scope = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const importMode = normalizeImportMode(scope.importMode);
  const wb = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return { ok: false, error: 'Excel file is empty.' };
  const headerMap = buildHeaderMap(Object.keys(rows[0] || {}));
  const existingNos = new Set(
    db.prepare(`SELECT trim(employee_no) AS n FROM hr_staff_profiles WHERE employee_no IS NOT NULL AND trim(employee_no) != ''`).all().map((r) => r.n)
  );
  const existingEmails = new Set(
    db.prepare(`SELECT lower(trim(email)) AS e FROM app_users WHERE email IS NOT NULL`).all().map((r) => r.e).filter(Boolean)
  );
  const { phones: existingPhones, phoneToUserId } = collectExistingPhones(db);
  const emailToUserId = buildEmailToUserIdMap(db);
  const existingUsernames = new Set(
    db.prepare(`SELECT lower(trim(username)) AS u FROM app_users`).all().map((r) => r.u).filter(Boolean)
  );
  const { employeeNoToUserId, userIdToUsername } = buildExistingStaffMaps(db);
  const designationIndex = buildDesignationIndex(db);
  const usedUsernames = new Set(importMode === 'replace' ? [] : existingUsernames);
  const employeeNosInFile = new Set();
  const preview = [];
  let valid = 0;
  let failed = 0;
  let duplicates = 0;
  let needsCleanup = 0;
  let skippedBlank = 0;
  let titlesCorrected = 0;
  let updateCount = 0;
  let createCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const mapped = sanitizeImportRow(mapRow(rows[i], headerMap));
    if (isBlankImportRow(mapped)) {
      skippedBlank += 1;
      continue;
    }
    const rowNum = i + 2;
    const keys = {
      employeeNos: importMode === 'replace' ? new Set() : existingNos,
      employeeNosInFile,
      employeeNoToUserId,
      userIdToUsername,
      emails: importMode === 'replace' ? new Set() : existingEmails,
      emailToUserId,
      phones: importMode === 'replace' ? new Set() : existingPhones,
      phoneToUserId,
      usernames: importMode === 'replace' ? new Set() : existingUsernames,
    };
    const {
      errors,
      warnings,
      branchId,
      displayName,
      proposedUsername,
      mappedJobTitle,
      designationId,
      titleCorrected,
      originalJobTitle,
      payrollGroup,
      roleKey,
      importAction,
      existingUserId,
    } = validateRow(db, mapped, rowNum, keys, designationIndex, usedUsernames, importMode);
    if (errors.some((e) => e.message.includes('Duplicate') || e.field === 'username')) duplicates += 1;
    if (warnings.length) needsCleanup += 1;
    if (titleCorrected) titlesCorrected += 1;
    if (errors.length) failed += 1;
    else valid += 1;
    if (!errors.length && importAction === 'update') updateCount += 1;
    if (!errors.length && importAction === 'create') createCount += 1;
    preview.push({
      rowNum,
      ...mapped,
      displayName: displayName || mapped.displayName,
      branchId,
      branchCodeResolved: branchId,
      proposedUsername,
      mappedJobTitle: mappedJobTitle || mapped.designation || null,
      designationId: designationId || null,
      titleCorrected: Boolean(titleCorrected),
      originalJobTitle: originalJobTitle || mapped.designation || null,
      payrollGroup,
      roleKey,
      importAction,
      existingUserId: existingUserId || null,
      errors,
      warnings,
      valid: errors.length === 0,
    });
    const empNo = String(mapped.employeeNumber || '').trim();
    if (empNo) employeeNosInFile.add(empNo);
    if (importMode !== 'replace' && empNo) existingNos.add(empNo);
    if (mapped.email) existingEmails.add(String(mapped.email).trim().toLowerCase());
    if (mapped.phoneNumber) existingPhones.add(String(mapped.phoneNumber).trim());
    if (proposedUsername) usedUsernames.add(proposedUsername);
  }
  const totalRows = preview.length;
  const flatErrors = preview.flatMap((r) =>
    r.errors.map((e) => ({ row: r.rowNum, column: e.field, message: e.message }))
  );
  const needsCleanupRows = preview.filter((r) => r.warnings.length > 0).map((r) => ({ row: r.rowNum, warnings: r.warnings }));
  const titleMappings = preview
    .filter((r) => r.titleCorrected && r.originalJobTitle && r.mappedJobTitle)
    .map((r) => ({
      row: r.rowNum,
      from: r.originalJobTitle,
      to: r.mappedJobTitle,
      username: r.proposedUsername,
    }));
  const staffToSuspend = importMode === 'replace' ? countActiveHrStaffForImportClean(db) : 0;
  return {
    ok: true,
    importMode,
    preview,
    summary: {
      total: totalRows,
      valid,
      failed,
      duplicates,
      needsCleanup,
      skipped: skippedBlank,
      titlesCorrected,
      updateCount,
      createCount,
      staffToSuspend,
    },
    totalRows,
    validCount: valid,
    failedCount: failed,
    duplicateCount: duplicates,
    updateCount,
    createCount,
    staffToSuspend,
    titlesCorrected,
    defaultPasswordNote: 'New accounts use Zarewa@123 and must change password on first login.',
    errors: flatErrors,
    needsCleanup: needsCleanupRows,
    titleMappings,
    branchGuide: BULK_IMPORT_BRANCH_GUIDE,
  };
}

function slugUsername(displayName, employeeNo) {
  const base = String(displayName || employeeNo || 'staff')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40);
  return base || `staff.${String(employeeNo || '').replace(/\W/g, '') || 'user'}`;
}

export function commitBulkStaffImport(db, actor, buffer, scope = {}) {
  const importMode = normalizeImportMode(scope.importMode);
  const prev = previewBulkStaffImport(db, buffer, { ...scope, importMode });
  if (!prev.ok) return prev;
  const runId = newId('HRIMP');
  const now = nowIso();
  let suspended = 0;
  if (importMode === 'replace') {
    suspended = suspendActiveHrStaffBeforeReplace(db, actor?.id);
  }
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const results = [];
  for (const row of prev.preview) {
    try {
      if (!row.valid) {
        skipped += 1;
        results.push({ rowNum: row.rowNum, status: 'skipped', errors: row.errors });
        continue;
      }
      const displayName = deriveDisplayName(row);

      if (row.importAction === 'update' && row.existingUserId) {
        db.prepare(`UPDATE app_users SET display_name = ?, status = 'active' WHERE id = ?`).run(
          displayName,
          row.existingUserId
        );
        const profilePatch = rowToProfileBody(db, row, scope, {
          userId: row.existingUserId,
          includeCredentials: false,
        });
        const up = upsertHrStaffProfile(db, actor?.id, profilePatch, { skipEnrichedReturn: true });
        if (!up.ok) {
          skipped += 1;
          results.push({ rowNum: row.rowNum, status: 'failed', error: up.error });
          continue;
        }
        updated += 1;
        results.push({
          rowNum: row.rowNum,
          status: 'updated',
          userId: row.existingUserId,
          username: row.proposedUsername,
          mappedJobTitle: profilePatch.jobTitle || null,
          roleKey: row.roleKey,
        });
        continue;
      }

      let username = row.proposedUsername || buildSurnameIdUsername(row, row.rowNum, new Set());
      let suffix = 0;
      const baseUsername = username;
      while (db.prepare(`SELECT 1 FROM app_users WHERE lower(trim(username)) = ?`).get(username)) {
        suffix += 1;
        username = `${baseUsername}${suffix}`.slice(0, 48);
      }
      const body = rowToProfileBody(db, { ...row, proposedUsername: username }, scope, { includeCredentials: true });
      body.username = username;
      body.displayName = displayName;
    let r = registerNewStaffWithProfile(db, actor?.id, body, { skipProfileFetch: true });
    if (!r.ok && String(r.error || '').toLowerCase().includes('username already exists')) {
      const orphan = db
        .prepare(
          `SELECT u.id FROM app_users u
           LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
           WHERE lower(trim(u.username)) = ? AND p.user_id IS NULL
           LIMIT 1`
        )
        .get(String(username).toLowerCase());
      if (orphan?.id) {
        try {
          db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(orphan.id);
          db.prepare(`DELETE FROM app_users WHERE id = ?`).run(orphan.id);
        } catch {
          /* ignore */
        }
        r = registerNewStaffWithProfile(db, actor?.id, body, { skipProfileFetch: true });
      }
    }
    if (!r.ok) {
      skipped += 1;
      results.push({ rowNum: row.rowNum, status: 'failed', error: r.error });
      continue;
    }
      imported += 1;
      results.push({
        rowNum: row.rowNum,
        status: 'imported',
        userId: r.userId,
        username,
        mappedJobTitle: body.jobTitle || null,
        roleKey: body.roleKey,
      });
      if (row.warnings?.length) {
        try {
          createHrNotification(db, {
            userId: actor?.id,
            kind: 'import_cleanup',
            title: 'Staff import needs cleanup',
            body: `${body.displayName} — review master data mapping.`,
            routePath: `/hr/employees/${encodeURIComponent(r.userId)}`,
            entityKind: 'hr_staff_profile',
            entityId: r.userId,
          });
        } catch {
          /* notifications are optional */
        }
      }
    } catch (e) {
      skipped += 1;
      results.push({
        rowNum: row.rowNum,
        status: 'failed',
        error: String(e?.message || e || 'Unexpected import error'),
      });
    }
  }
  try {
    if (hrTableExists(db, 'hr_staff_import_runs')) {
      db.prepare(
        `INSERT INTO hr_staff_import_runs (id, actor_user_id, imported_count, skipped_count, failed_count, summary_json, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        runId,
        actor?.id,
        imported,
        skipped,
        prev.summary.failed,
        JSON.stringify({ results, summary: prev.summary, importMode, suspended }),
        now
      );
    }
    appendHrAuditEvent(db, {
      actorUserId: actor?.id,
      action: 'hr.bulk_staff.import',
      entityKind: 'hr_staff_import_run',
      entityId: runId,
      details: { imported, updated, suspended, skipped, total: prev.summary.total, importMode },
    });
  } catch (e) {
    console.error('[hrStaffBulkImport] run log failed', e);
  }
  const commitFailed = results.filter((r) => r.status === 'failed').length;
  return {
    ok: true,
    runId,
    importMode,
    imported,
    updated,
    suspended,
    skipped,
    failed: prev.summary.failed + commitFailed,
    previewFailed: prev.summary.failed,
    commitFailed,
    duplicates: prev.summary.duplicates,
    needsCleanup: prev.summary.needsCleanup,
    total: prev.summary.total,
    results,
  };
}

export function listBulkImportRuns(db, limit = 20) {
  if (!hrTableExists(db, 'hr_staff_import_runs')) return [];
  return db
    .prepare(
      `SELECT id, actor_user_id AS actorUserId, imported_count AS importedCount, skipped_count AS skippedCount,
              failed_count AS failedCount, created_at_iso AS createdAtIso
       FROM hr_staff_import_runs ORDER BY created_at_iso DESC LIMIT ?`
    )
    .all(Math.min(100, Math.max(1, limit)));
}
