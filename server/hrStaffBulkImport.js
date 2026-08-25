/**
 * Phase 8 — basic bulk old-staff Excel import.
 * @module server/hrStaffBulkImport
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { updateAppUserStatus } from './auth.js';
import { appendHrAuditEvent, hrTablesReady, registerNewStaffWithProfile, upsertHrStaffProfile } from './hrOps.js';
import { lookupHrSalaryMatrixRow } from './hrCompensationOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { createHrNotification } from './hrNotifications.js';
import { listHrDesignations } from './hrMasterData.js';
import {
  createEmployeeNumberAllocator,
  employeeNumberToUsername,
  getDefaultStaffNumberConfig,
  normalizeEmployeeNumberForSave,
  normalizeStaffNumberConfig,
} from '../shared/lib/hrEmployeeNumber.js';
import { getStaffNumberConfig } from './hrStaffNumbering.js';
import { EMPLOYEE_DIRECTORY_GROUPS, isBeneficiaryOnlyPayrollGroup, normalizePayrollGroup } from '../shared/lib/hrStaffCohorts.js';
import { BENEFICIARY_NO_LOGIN_ERROR } from './hrStaffAccessPolicy.js';
import { listStaffIdentityRows } from './hr/staffIdentityUniqueness.js';
import {
  namesLookSuspicious,
  normalizeStaffAccountKey,
  normalizeStaffEmailKey,
  normalizeStaffNinKey,
  normalizeStaffPhoneKey,
} from '../shared/lib/hrStaffIdentity.js';

export const BULK_IMPORT_DEFAULT_PASSWORD = ''; // no shared default — use env or one-time random

/** One-time temp password for imported logins when ZAREWA_STAFF_IMPORT_PASSWORD is unset. */
export function generateStaffImportTempPassword() {
  return `Zw-${crypto.randomBytes(12).toString('base64url')}`;
}

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
  {
    key: 'username',
    header: 'Username (existing login)',
    required: false,
  },
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
  { key: 'middleName', header: 'Middle Name', required: false },
  { key: 'maritalStatus', header: 'Marital Status', required: false },
  { key: 'stateOfOrigin', header: 'State of Origin', required: false },
  { key: 'localGovernment', header: 'Local Government', required: false },
  { key: 'nationality', header: 'Nationality', required: false },
  { key: 'bloodGroup', header: 'Blood Group', required: false },
  { key: 'nin', header: 'NIN', required: false },
  { key: 'taxId', header: 'Tax ID / TIN', required: false },
  { key: 'pensionRsaPin', header: 'Pension RSA PIN', required: false },
  { key: 'institution', header: 'Institution', required: false },
  { key: 'courseField', header: 'Course / Field', required: false },
  { key: 'yearCompleted', header: 'Year Completed', required: false },
  { key: 'professionalCertificates', header: 'Professional Certificates', required: false },
  { key: 'probationEnd', header: 'Probation End Date', required: false },
  { key: 'confirmationDate', header: 'Confirmation Date', required: false },
  { key: 'contractEnd', header: 'Contract End Date', required: false },
  { key: 'actingEndDate', header: 'Acting End Date', required: false },
  { key: 'lineManagerUsername', header: 'Line Manager Username', required: false },
  { key: 'supervisorName', header: 'Supervisor Name', required: false },
  { key: 'roleKey', header: 'System Role Key', required: false },
  { key: 'leaveEntitlementBand', header: 'Leave Entitlement Band', required: false },
  { key: 'nhisNumber', header: 'NHIS Number', required: false },
  { key: 'pensionAdministrator', header: 'Pension Administrator', required: false },
  { key: 'promotionGrade', header: 'Promotion Grade', required: false },
  { key: 'hrInternalNotes', header: 'HR Internal Notes', required: false },
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
    username: get('username').toLowerCase(),
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
    middleName: get('middleName'),
    maritalStatus: get('maritalStatus'),
    stateOfOrigin: get('stateOfOrigin'),
    localGovernment: get('localGovernment'),
    nationality: get('nationality'),
    bloodGroup: get('bloodGroup'),
    nin: get('nin'),
    taxId: get('taxId'),
    pensionRsaPin: get('pensionRsaPin'),
    institution: get('institution'),
    courseField: get('courseField'),
    yearCompleted: get('yearCompleted'),
    professionalCertificates: get('professionalCertificates'),
    probationEnd: parseDateIso(raw[headerMap.probationEnd]),
    confirmationDate: parseDateIso(raw[headerMap.confirmationDate]),
    contractEnd: parseDateIso(raw[headerMap.contractEnd]),
    actingEndDate: parseDateIso(raw[headerMap.actingEndDate]),
    lineManagerUsername: get('lineManagerUsername').toLowerCase(),
    supervisorName: get('supervisorName'),
    roleKey: get('roleKey'),
    leaveEntitlementBand: get('leaveEntitlementBand'),
    nhisNumber: get('nhisNumber'),
    pensionAdministrator: get('pensionAdministrator'),
    promotionGrade: get('promotionGrade'),
    hrInternalNotes: get('hrInternalNotes'),
  };
}

const COLUMN_HEADER_ALIASES = {
  firstName: ['first name', 'firstname', 'given name', 'forename'],
  surname: ['surname', 'last name', 'lastname', 'family name'],
  displayName: ['display name', 'full name', 'staff name', 'name'],
  email: ['email', 'e-mail', 'e mail', 'email address', 'mail'],
  username: [
    'username (existing login)',
    'username',
    'login',
    'user id',
    'erp username',
    'legacy username',
    'existing login',
    'existing username',
    'system username',
  ],
  employeeNumber: [
    'employee number',
    'employee id',
    'employee no',
    'emp no',
    'emp id',
    'staff id',
    'staff number',
    'id number',
  ],
  phoneNumber: ['phone', 'mobile', 'phone number', 'mobile number', 'telephone', 'contact number'],
  dateJoined: [
    'date joined',
    'join date',
    'start date',
    'date of join',
    'date of joining',
    'joining date',
    'employment date',
  ],
  dateOfBirth: ['date of birth', 'dob', 'birth date', 'birthdate', 'birth day'],
  highestQualification: ['qualification', 'highest qualification', 'education', 'academic qualification'],
  designation: ['job title', 'designation', 'title', 'position', 'job role', 'role title'],
  lineManagerUsername: ['line manager', 'line manager username', 'manager username', 'supervisor username'],
  taxId: ['tax id', 'tin', 'tax identification', 'tax identification number'],
  pensionRsaPin: ['rsa pin', 'pension pin', 'pension rsa pin', 'pension pin number'],
  branchName: ['branch name', 'branch', 'location', 'office', 'work branch', 'site'],
  branchCode: ['branch code', 'branch id', 'branch ref'],
  departmentName: ['department name', 'department', 'dept', 'dept name', 'unit', 'division'],
  departmentCode: ['department code', 'dept code'],
  workLocation: ['work location', 'location type', 'hq or branch'],
  employmentType: ['employment type', 'emp type', 'contract type'],
  employmentStatus: ['employment status', 'emp status', 'staff status'],
  basicSalary: ['basic salary', 'salary', 'monthly salary', 'gross salary'],
  bankName: ['bank name', 'bank'],
  accountNumber: ['account number', 'bank account number', 'bank account no', 'account no', 'acct number'],
  accountName: ['account name', 'bank account name', 'acct name'],
  roleKey: ['system role key', 'role key', 'role', 'system role', 'login role', 'app role', 'user role'],
  gender: ['gender', 'sex'],
  salaryLevel: ['salary level', 'job grade', 'grade', 'level'],
  nin: ['nin', 'national id', 'national identification number'],
  nextOfKinName: ['next of kin name', 'next of kin', 'nok name', 'kin name'],
  nextOfKinPhone: ['next of kin phone', 'nok phone', 'kin phone'],
  residentialAddress: ['residential address', 'address', 'home address'],
  payrollGroup: ['payroll group', 'pay group'],
};

const STAFF_HEADER_SIGNALS = [
  'first name',
  'surname',
  'last name',
  'display name',
  'employee id',
  'employee number',
  'username',
  'email',
  'e mail',
  'job title',
];

function headerKeysLookLikeStaffRow(keys) {
  const norms = keys.map((k) => normHeader(k)).filter(Boolean);
  if (!norms.length) return false;
  let hits = 0;
  for (const signal of STAFF_HEADER_SIGNALS) {
    if (norms.some((k) => k === signal || k.includes(signal))) hits += 1;
  }
  return hits >= 2;
}

function rowsFromSheetAoA(sheet) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!aoa.length) return [];
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(aoa.length, 8); i += 1) {
    const cells = (aoa[i] || []).map((c) => String(c ?? '').trim()).filter(Boolean);
    if (headerKeysLookLikeStaffRow(cells)) {
      headerRowIdx = i;
      break;
    }
  }
  const headers = (aoa[headerRowIdx] || []).map((h, idx) => {
    const label = String(h ?? '').trim();
    return label || `Column_${idx + 1}`;
  });
  const rows = [];
  for (let i = headerRowIdx + 1; i < aoa.length; i += 1) {
    const line = aoa[i] || [];
    if (!line.some((c) => String(c ?? '').trim())) continue;
    const row = {};
    headers.forEach((h, colIdx) => {
      row[h] = line[colIdx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function scoreStaffImportRows(rows) {
  if (!rows?.length) return 0;
  const keys = Object.keys(rows[0] || {});
  let score = headerKeysLookLikeStaffRow(keys) ? 20 : 0;
  const sample = rows.slice(0, 30);
  for (const row of sample) {
    const bag = Object.values(row)
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    if (!bag.length) continue;
    score += 1;
    const joined = bag.join(' ').toLowerCase();
    if (/\b(emp|zap)\w*\d+/i.test(joined)) score += 2;
    if (/@/.test(joined)) score += 1;
  }
  return score;
}

/**
 * Reads the best worksheet and normalises header row detection for legacy uploads.
 * @param {Buffer} buffer
 */
export function readBulkImportWorkbookRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellText: true, cellDates: true });
  let best = { rows: [], sheetName: '', score: -1 };
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    let rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length || !headerKeysLookLikeStaffRow(Object.keys(rows[0] || {}))) {
      rows = rowsFromSheetAoA(sheet);
    }
    const score = scoreStaffImportRows(rows);
    if (score > best.score) best = { rows, sheetName, score };
  }
  return best;
}

function buildHeaderMap(sheetHeaders) {
  const map = {};
  for (const col of BULK_IMPORT_COLUMNS) {
    const wants = new Set([normHeader(col.header), ...(COLUMN_HEADER_ALIASES[col.key] || []).map(normHeader)]);
    for (const h of sheetHeaders) {
      if (wants.has(normHeader(h))) {
        map[col.key] = h;
        break;
      }
    }
  }
  return map;
}

export function describeBulkImportHeaderMap(sheetHeaders) {
  const map = buildHeaderMap(sheetHeaders);
  const matched = Object.entries(map).map(([key, header]) => ({ key, header }));
  const used = new Set(matched.map((m) => m.header));
  const unmatched = sheetHeaders.filter((h) => String(h || '').trim() && !used.has(h));
  return { matched, unmatched, map };
}

function enrichMappedRowFromExtras(mapped, raw) {
  const out = { ...mapped };
  const readLoose = (aliases) => {
    const wants = new Set(aliases.map((a) => normHeader(a)));
    for (const h of Object.keys(raw)) {
      if (wants.has(normHeader(h))) return String(raw[h] ?? '').trim();
    }
    return '';
  };
  if (!out.departmentName) {
    const division = readLoose(['division']);
    const unit = readLoose(['unit']);
    out.departmentName = [division, unit].filter(Boolean).join(' / ') || out.departmentName;
  }
  if (!out.workLocation && out.branchName) {
    const b = normHeader(out.branchName);
    if (b.includes('hq') || b.includes('head office')) out.workLocation = 'HQ';
    else if (b) out.workLocation = 'Branch';
  }
  if (!out.displayName && out.firstName && out.surname) {
    out.displayName = `${out.firstName} ${out.surname}`.trim();
  }
  return out;
}

export function buildBulkImportTemplateXlsx() {
  const headers = BULK_IMPORT_COLUMNS.map((c) => c.header);
  const padRow = (cells) => {
    const row = [...cells];
    while (row.length < headers.length) row.push('');
    return row.slice(0, headers.length);
  };
  const kadunaBranchSample = padRow([
    'Amina',
    'Bello',
    'Amina Bello',
    '08030000001',
    'amina.bello@example.com',
    'ZAPKD006',
    'bello.zapkd006',
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
  ]);
  const hqSample = padRow([
    'Musa',
    'Ibrahim',
    'Musa Ibrahim',
    '08030000003',
    'musa.ibrahim@example.com',
    'ZAPKD010',
    '',
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
  ]);
  const legacyLinkSample = padRow([
    '',
    '',
    'John Okoro',
    '08030000099',
    'john.okoro@example.com',
    'ZAPYL015',
    'john.okoro',
    'Branch',
    'BR-YL',
    'Yola Factory',
    'SAL',
    'Sales',
    'Sales Officer',
    'permanent',
    'active',
    '2018-03-01',
    '120000',
    '',
    '',
    '',
    '',
    'Male',
    '',
    '',
    '',
    '',
    '',
    'SO',
    'branch_ops',
    '2',
    '1',
    '',
    '',
    '',
  ]);
  const guideHeaders = ['Staff type', 'Work Location', 'Branch Code', 'Branch Name', 'Notes'];
  const guideRows = BULK_IMPORT_BRANCH_GUIDE.map((g) => [
    g.staffType,
    g.workLocation,
    g.branchCode,
    g.branchName,
    g.notes || '',
  ]);
  const legacyGuideHeaders = ['Step', 'Instruction'];
  const legacyGuideRows = [
    ['1', 'Only fill columns you have data for — blank cells are left empty on the employee record.'],
    ['2', 'Username column is only for linking an existing login — new staff get login = employee ID (e.g. zapkd001).'],
    ['3', 'Use Update & add mode — do not create a second login for the same person.'],
    ['4', 'Preview & validate before import — review each row, then confirm import.'],
    ['5', 'Never delete a login that created sales, office, or finance records — merge duplicates into it instead.'],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, kadunaBranchSample, hqSample, legacyLinkSample]);
  const guideWs = XLSX.utils.aoa_to_sheet([guideHeaders, ...guideRows]);
  const legacyWs = XLSX.utils.aoa_to_sheet([legacyGuideHeaders, ...legacyGuideRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Staff Import');
  XLSX.utils.book_append_sheet(wb, legacyWs, 'Legacy link guide');
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
    return lookupBranchId(db, BULK_IMPORT_HQ_BRANCH.id, BULK_IMPORT_HQ_BRANCH.name) || BULK_IMPORT_HQ_BRANCH.id;
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
  if (bag.includes('jalingo')) return lookupBranchId(db, row.branchCode, row.branchName);
  if (bag.includes('kaduna') || bag.includes('kd')) {
    return lookupBranchId(db, 'BR-KD', 'Kaduna') || 'BR-KD';
  }
  const scoped = String(scope?.branchId || '').trim();
  return scoped || null;
}

const VALID_EMPLOYMENT_TYPES = new Set(['permanent', 'contract', 'casual', 'intern', 'temporary']);
const VALID_GENDERS = new Set(['male', 'female', 'other']);
const VALID_EMPLOYMENT_STATUSES = new Set(['active', 'probation', 'suspended', 'inactive', 'terminated', 'resigned', 'retired', 'exited']);

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
  if (s.includes('retir')) return 'retired';
  if (s.includes('resign')) return 'resigned';
  if (s.includes('termin')) return 'terminated';
  if (s.includes('exit') || s.includes('separat') || s.includes('left')) return 'exited';
  if (s.includes('inactive') || s.includes('inactiv')) return 'inactive';
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
  const s = normalizePayrollGroup(v);
  return EMPLOYEE_DIRECTORY_GROUPS.includes(s) ? s : '';
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
  out.probationEnd = parseDateIso(out.probationEnd) || '';
  out.confirmationDate = parseDateIso(out.confirmationDate) || '';
  out.contractEnd = parseDateIso(out.contractEnd) || '';
  out.actingEndDate = parseDateIso(out.actingEndDate) || '';
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
  const pg = String(payrollGroup || '').trim();
  if (pg === 'mining_div') {
    return 'hr_portal_only';
  }
  const s = normTitleToken(`${jobTitle || ''} ${department || ''}`);
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

export function buildEmployeeIdUsername(employeeNumber, rowNum, usedUsernames) {
  let username = employeeNumberToUsername(employeeNumber, rowNum) || `staff.r${rowNum}`;
  const base = username;
  let suffix = 0;
  while (usedUsernames.has(username)) {
    suffix += 1;
    username = `${base}${suffix}`.slice(0, 48);
  }
  usedUsernames.add(username);
  return username;
}

/** @deprecated Use buildEmployeeIdUsername — login matches employee ID. */
export function buildSurnameIdUsername(row, rowNum, usedUsernames) {
  return buildEmployeeIdUsername(row.employeeNumber, rowNum, usedUsernames);
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

function collectExistingIdentityOwners(db) {
  const phoneToUserId = new Map();
  const emailToUserId = new Map();
  const ninToUserId = new Map();
  const accountToUserId = new Map();
  const nameRows = [];
  for (const row of listStaffIdentityRows(db)) {
    if (row.keys.phone) phoneToUserId.set(row.keys.phone, row.userId);
    if (row.keys.email) emailToUserId.set(row.keys.email, row.userId);
    if (row.keys.nin) ninToUserId.set(row.keys.nin, row.userId);
    if (row.keys.account) accountToUserId.set(row.keys.account, row.userId);
    nameRows.push({ userId: row.userId, displayName: row.displayName, employeeNo: row.employeeNo, nameForMatch: row.nameForMatch });
  }
  return { phoneToUserId, emailToUserId, ninToUserId, accountToUserId, nameRows };
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

function buildUsernameToUserIdMap(db) {
  const usernameToUserId = new Map();
  const rows = db
    .prepare(`SELECT id, lower(trim(username)) AS username FROM app_users WHERE username IS NOT NULL AND trim(username) != ''`)
    .all();
  for (const row of rows) {
    if (row.username) usernameToUserId.set(row.username, row.id);
  }
  return usernameToUserId;
}

function resolveLineManagerUserId(db, username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return db.prepare(`SELECT id FROM app_users WHERE lower(trim(username)) = ? LIMIT 1`).get(u)?.id || null;
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
    middleName: row.middleName || undefined,
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
    probationEndIso: row.probationEnd || undefined,
    confirmationDateIso: row.confirmationDate || undefined,
    contractEndIso: row.contractEnd || undefined,
    actingEndDateIso: row.actingEndDate || undefined,
    payrollGroup,
    gender: row.gender || undefined,
    dateOfBirthIso: row.dateOfBirth || undefined,
    dateOfBirth: row.dateOfBirth || undefined,
    residentialAddress: row.residentialAddress || undefined,
    minimumQualification: row.highestQualification || undefined,
    maritalStatus: row.maritalStatus || undefined,
    stateOfOrigin: row.stateOfOrigin || undefined,
    localGovernment: row.localGovernment || undefined,
    nationality: row.nationality || undefined,
    bloodGroup: row.bloodGroup || undefined,
    institution: row.institution || undefined,
    courseField: row.courseField || undefined,
    yearCompleted: row.yearCompleted || undefined,
    professionalCertificates: row.professionalCertificates || undefined,
    taxId: row.taxId || undefined,
    pensionRsaPin: row.pensionRsaPin || undefined,
    ninNumber: row.nin || undefined,
    nhisNumber: row.nhisNumber || undefined,
    pensionAdministrator: row.pensionAdministrator || undefined,
    promotionGrade: row.promotionGrade || undefined,
    supervisorName: row.supervisorName || undefined,
    leaveEntitlementBand: row.leaveEntitlementBand || undefined,
    hrInternalNotes: row.hrInternalNotes || undefined,
    bankName: row.bankName || undefined,
    bankAccountName: row.accountName || undefined,
    bankAccountNo: row.accountNumber || undefined,
    bankAccountNoMasked: row.accountNumber ? `****${String(row.accountNumber).slice(-4)}` : undefined,
    nextOfKin: hasNextOfKin ? { name: row.nextOfKinName || null, phone: row.nextOfKinPhone || null } : undefined,
    selfServiceEligible: true,
  };
  const lineManagerUserId = resolveLineManagerUserId(db, row.lineManagerUsername);
  if (lineManagerUserId) body.lineManagerUserId = lineManagerUserId;

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
    const fromEnv = String(process.env.ZAREWA_STAFF_IMPORT_PASSWORD || '').trim();
    body.password = fromEnv || generateStaffImportTempPassword();
    body.mustChangePassword = true;
    body.roleKey =
      row.roleKey ||
      row.resolvedRoleKey ||
      mapRoleKeyFromJob(row.mappedJobTitle, row.departmentName || row.departmentCode, payrollGroup);
  }
  return body;
}

function validateRow(db, row, rowNum, existingKeys, designationIndex, usedUsernames, importMode = 'update') {
  const errors = [];
  const warnings = [];
  const mode = normalizeImportMode(importMode);
  let displayName = deriveDisplayName(row);
  if (!displayName) {
    displayName = `Staff import row ${rowNum}`;
    warnings.push({
      field: 'displayName',
      message: 'No name supplied — placeholder display name used; update after import',
    });
  }
  const staffNumberConfig = existingKeys.staffNumberConfig || getDefaultStaffNumberConfig();
  const branchIdForEmp = resolveBranchId(db, row, {});
  const empNoRaw = String(row.employeeNumber || '').trim();
  let empNo = empNoRaw
    ? normalizeEmployeeNumberForSave(empNoRaw, staffNumberConfig, { branchId: branchIdForEmp, db })
    : '';
  if (empNo && empNo !== empNoRaw) {
    row.employeeNumber = empNo;
    warnings.push({
      field: 'employeeNumber',
      message: `Formatted as ${empNo}`,
    });
  }
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

  const explicitLogin = String(row.username || '').trim().toLowerCase();
  if (explicitLogin) {
    const owner = existingKeys.usernameToUserId?.get(explicitLogin);
    if (!owner) {
      warnings.push({
        field: 'username',
        message: `No login found for "${explicitLogin}" — a new account will be created`,
      });
    } else if (!existingUserId) {
      importAction = 'update';
      existingUserId = owner;
      existingUsername = explicitLogin;
      warnings.push({
        field: 'username',
        message: 'Existing login — HR profile will be linked to this account (audit history preserved)',
      });
    } else if (existingUserId !== owner) {
      errors.push({
        field: 'username',
        message: 'Employee number and username refer to different accounts — fix the row or merge duplicates first',
      });
    }
  }

  const email = normalizeStaffEmailKey(row.email);
  if (email) {
    const owner = existingKeys.emailToUserId?.get(email);
    if (owner && owner !== existingUserId) errors.push({ field: 'email', message: 'Duplicate email' });
    if (existingKeys.emailsInFile?.has(email)) errors.push({ field: 'email', message: 'Duplicate email in this file' });
  }
  const phone = normalizeStaffPhoneKey(row.phoneNumber);
  if (phone) {
    const owner = existingKeys.phoneToUserId?.get(phone);
    if (owner && owner !== existingUserId) errors.push({ field: 'phoneNumber', message: 'Duplicate phone' });
    if (existingKeys.phonesInFile?.has(phone)) errors.push({ field: 'phoneNumber', message: 'Duplicate phone in this file' });
  }
  const nin = normalizeStaffNinKey(row.nin);
  if (nin) {
    const owner = existingKeys.ninToUserId?.get(nin);
    if (owner && owner !== existingUserId) errors.push({ field: 'nin', message: 'Duplicate NIN' });
    if (existingKeys.ninsInFile?.has(nin)) errors.push({ field: 'nin', message: 'Duplicate NIN in this file' });
  }
  const account = normalizeStaffAccountKey(row.accountNumber);
  if (account) {
    const owner = existingKeys.accountToUserId?.get(account);
    if (owner && owner !== existingUserId) errors.push({ field: 'accountNumber', message: 'Duplicate account number' });
    if (existingKeys.accountsInFile?.has(account)) {
      errors.push({ field: 'accountNumber', message: 'Duplicate account number in this file' });
    }
  }
  if (displayName && Array.isArray(existingKeys.nameRows)) {
    for (const other of existingKeys.nameRows) {
      if (other.userId === existingUserId) continue;
      const hit = namesLookSuspicious(displayName, other.nameForMatch || other.displayName);
      if (!hit) continue;
      warnings.push({
        field: 'displayName',
        message: `Name looks similar to ${other.displayName || other.userId}${
          other.employeeNo ? ` (${other.employeeNo})` : ''
        } — confirm this is not the same person`,
      });
      break;
    }
  }
  const branchId = resolveBranchId(db, row, {});
  if (!branchId) {
    errors.push({
      field: 'branchCode',
      message:
        'Branch is required — set Branch Code (e.g. BR-YL), Branch Name, or Work Location (Yola / Kaduna / Maiduguri). Rows are never assigned to Kaduna by default.',
    });
  }

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
  if (isBeneficiaryOnlyPayrollGroup(payrollGroup)) {
    errors.push({ field: 'payrollGroup', message: BENEFICIARY_NO_LOGIN_ERROR });
  }
  const roleKey =
    String(row.roleKey || '').trim() ||
    mapRoleKeyFromJob(
      resolvedTitle.jobTitle || row.designation,
      row.departmentName || row.departmentCode,
      payrollGroup
    );
  if (!empNo && importAction === 'create' && existingKeys.employeeNumberAllocator) {
    empNo = existingKeys.employeeNumberAllocator.next({ branchId });
    row.employeeNumber = empNo;
    warnings.push({
      field: 'employeeNumber',
      message: `Assigned employee ID ${empNo}`,
    });
  }
  let proposedUsername =
    existingUsername ||
    explicitLogin ||
    buildEmployeeIdUsername(empNo, rowNum, usedUsernames);
  if (!existingUsername && !explicitLogin && mode !== 'replace' && existingKeys.usernames?.has(proposedUsername)) {
    const base = proposedUsername;
    let suffix = 1;
    while (existingKeys.usernames.has(`${base}${suffix}`.slice(0, 48))) suffix += 1;
    proposedUsername = `${base}${suffix}`.slice(0, 48);
    warnings.push({
      field: 'username',
      message: `Username adjusted to "${proposedUsername}" — original was already taken`,
    });
  }
  if (row.lineManagerUsername && !resolveLineManagerUserId(db, row.lineManagerUsername)) {
    warnings.push({
      field: 'lineManagerUsername',
      message: `Line manager "${row.lineManagerUsername}" not found — field will be left blank`,
    });
  }
  if (row.designationCode && !codeMatch) {
    warnings.push({ field: 'designationCode', message: `Unknown designation code "${row.designationCode}" — using job title match` });
  }
  if (row.payAdditionNgn && !row.salaryLevel) {
    warnings.push({ field: 'payAdditionNgn', message: 'Pay addition ignored without salary level/step — set level or use legacy pay backfill' });
  }
  if (importAction === 'update' && !explicitLogin) {
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
  const { rows, sheetName } = readBulkImportWorkbookRows(buffer);
  if (!rows.length) {
    return {
      ok: false,
      error:
        'No staff rows found. Put headers in row 1 (First Name, Surname, Employee ID, Username, etc.) and data from row 2. Save as .xlsx.',
    };
  }
  const headerMap = buildHeaderMap(Object.keys(rows[0] || {}));
  const headerInfo = describeBulkImportHeaderMap(Object.keys(rows[0] || {}));
  if (!headerInfo.matched.length) {
    return {
      ok: false,
      error:
        'Could not match any column headers. Use First Name, Surname, Employee ID or Employee Number, Username, Email, Branch, Job Title, Date of Join.',
      detectedHeaders: Object.keys(rows[0] || {}).filter((h) => String(h).trim()),
    };
  }
  const existingNos = new Set(
    db.prepare(`SELECT trim(employee_no) AS n FROM hr_staff_profiles WHERE employee_no IS NOT NULL AND trim(employee_no) != ''`).all().map((r) => r.n)
  );
  const existingEmails = new Set(
    db.prepare(`SELECT lower(trim(email)) AS e FROM app_users WHERE email IS NOT NULL`).all().map((r) => r.e).filter(Boolean)
  );
  const identityOwners = collectExistingIdentityOwners(db);
  const emailToUserId = buildEmailToUserIdMap(db);
  for (const [k, v] of identityOwners.emailToUserId) emailToUserId.set(k, v);
  const phoneToUserId = identityOwners.phoneToUserId;
  const ninToUserId = identityOwners.ninToUserId;
  const accountToUserId = identityOwners.accountToUserId;
  const nameRows = identityOwners.nameRows;
  const usernameToUserId = buildUsernameToUserIdMap(db);
  const existingUsernames = new Set(
    db.prepare(`SELECT lower(trim(username)) AS u FROM app_users`).all().map((r) => r.u).filter(Boolean)
  );
  const { employeeNoToUserId, userIdToUsername } = buildExistingStaffMaps(db);
  const designationIndex = buildDesignationIndex(db);
  const staffNumberConfig = normalizeStaffNumberConfig(getStaffNumberConfig(db));
  const employeeNumberAllocator = createEmployeeNumberAllocator(db, staffNumberConfig, {
    takenFormatted: new Set(importMode === 'replace' ? [] : [...existingNos]),
  });
  const usedUsernames = new Set(importMode === 'replace' ? [] : existingUsernames);
  const employeeNosInFile = new Set();
  const emailsInFile = new Set();
  const phonesInFile = new Set();
  const ninsInFile = new Set();
  const accountsInFile = new Set();
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
    const mapped = enrichMappedRowFromExtras(
      sanitizeImportRow(mapRow(rows[i], headerMap)),
      rows[i],
      headerMap
    );
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
      emailToUserId: importMode === 'replace' ? new Map() : emailToUserId,
      usernameToUserId,
      phoneToUserId: importMode === 'replace' ? new Map() : phoneToUserId,
      ninToUserId: importMode === 'replace' ? new Map() : ninToUserId,
      accountToUserId: importMode === 'replace' ? new Map() : accountToUserId,
      nameRows: importMode === 'replace' ? [] : nameRows,
      emailsInFile,
      phonesInFile,
      ninsInFile,
      accountsInFile,
      usernames: importMode === 'replace' ? new Set() : existingUsernames,
      staffNumberConfig,
      employeeNumberAllocator,
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
      resolvedRoleKey: roleKey,
      importAction,
      existingUserId: existingUserId || null,
      employeeNumber: mapped.employeeNumber || '',
      errors,
      warnings,
      valid: errors.length === 0,
    });
    const empNo = String(mapped.employeeNumber || '').trim();
    if (empNo) employeeNosInFile.add(empNo);
    if (importMode !== 'replace' && empNo) existingNos.add(empNo);
    const emailKey = normalizeStaffEmailKey(mapped.email);
    if (emailKey) emailsInFile.add(emailKey);
    const phoneKey = normalizeStaffPhoneKey(mapped.phoneNumber);
    if (phoneKey) phonesInFile.add(phoneKey);
    const ninKey = normalizeStaffNinKey(mapped.nin);
    if (ninKey) ninsInFile.add(ninKey);
    const accountKey = normalizeStaffAccountKey(mapped.accountNumber);
    if (accountKey) accountsInFile.add(accountKey);
    if (mapped.email) existingEmails.add(String(mapped.email).trim().toLowerCase());
    if (proposedUsername) usedUsernames.add(proposedUsername);
  }
  const totalRows = preview.length;
  if (!totalRows && rows.length) {
    return {
      ok: false,
      error: `Found ${rows.length} spreadsheet row(s) on sheet "${sheetName || 'Sheet1'}" but none contained staff data. Check that names or employee IDs are filled in.`,
      detectedHeaders: Object.keys(rows[0] || {}).filter((h) => String(h).trim()),
      matchedColumns: headerInfo.matched,
      skippedBlank,
    };
  }
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
  const previewTable = preview.slice(0, 200).map((r) => ({
    row: r.rowNum,
    name: r.displayName || '—',
    employeeId: r.employeeNumber || '—',
    action: r.importAction === 'update' ? 'Update' : 'Create',
    username: r.proposedUsername || '—',
    jobTitle: r.mappedJobTitle || r.designation || '—',
    branch: r.branchId || '—',
    status: r.valid ? 'Ready' : 'Blocked',
    warningCount: r.warnings?.length || 0,
    errorCount: r.errors?.length || 0,
  }));
  return {
    ok: true,
    importMode,
    sheetName: sheetName || null,
    matchedColumns: headerInfo.matched,
    unmatchedHeaders: headerInfo.unmatched.slice(0, 40),
    preview,
    previewTable,
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
    defaultPasswordNote:
      'New accounts get a one-time random password (or ZAREWA_STAFF_IMPORT_PASSWORD) and must change it on first login.',
    errors: flatErrors,
    needsCleanup: needsCleanupRows,
    titleMappings,
    branchGuide: BULK_IMPORT_BRANCH_GUIDE,
  };
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
        if (row.roleKey) {
          db.prepare(`UPDATE app_users SET display_name = ?, status = 'active', role_key = ? WHERE id = ?`).run(
            displayName,
            row.roleKey,
            row.existingUserId
          );
        } else {
          db.prepare(`UPDATE app_users SET display_name = ?, status = 'active' WHERE id = ?`).run(
            displayName,
            row.existingUserId
          );
        }
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

      let username = row.proposedUsername || buildEmployeeIdUsername(row.employeeNumber, row.rowNum, new Set());
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
