/**
 * Phase 8 — basic bulk old-staff Excel import.
 * @module server/hrStaffBulkImport
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendHrAuditEvent, hrTablesReady, registerNewStaffWithProfile } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { createHrNotification } from './hrNotifications.js';
import { listHrDepartments, listHrDesignations } from './hrMasterData.js';

export const BULK_IMPORT_COLUMNS = [
  { key: 'firstName', header: 'First Name', required: true },
  { key: 'surname', header: 'Surname', required: true },
  { key: 'displayName', header: 'Display Name', required: true },
  { key: 'phoneNumber', header: 'Phone Number', required: true },
  { key: 'email', header: 'Email', required: false },
  { key: 'employeeNumber', header: 'Employee Number', required: false },
  { key: 'workLocation', header: 'Work Location', required: true },
  { key: 'branchCode', header: 'Branch Code', required: false },
  { key: 'branchName', header: 'Branch Name', required: false },
  { key: 'departmentCode', header: 'Department Code', required: false },
  { key: 'departmentName', header: 'Department Name', required: false },
  { key: 'designation', header: 'Designation / Job Title', required: true },
  { key: 'employmentType', header: 'Employment Type', required: true },
  { key: 'employmentStatus', header: 'Employment Status', required: true },
  { key: 'dateJoined', header: 'Date Joined', required: true },
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
  const sample = [
    'Amina',
    'Bello',
    'Amina Bello',
    '08030000001',
    'amina.bello@example.com',
    '',
    'Branch',
    'BR-KD',
    'Kaduna',
    'FIN',
    'Finance',
    'Accounts Officer',
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
    'B.Sc Accounting',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Staff Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function resolveBranchId(db, row, scope) {
  const code = String(row.branchCode || '').trim();
  const name = String(row.branchName || '').trim();
  if (code) {
    const b = db.prepare(`SELECT id FROM branches WHERE id = ? OR code = ? LIMIT 1`).get(code, code);
    if (b) return b.id;
  }
  if (name) {
    const b = db.prepare(`SELECT id FROM branches WHERE name LIKE ? LIMIT 1`).get(`%${name}%`);
    if (b) return b.id;
  }
  if (String(row.workLocation || '').toLowerCase().includes('hq')) return 'BR-HQ';
  return scope?.branchId || DEFAULT_BRANCH_ID;
}

function validateRow(db, row, rowNum, existingKeys) {
  const errors = [];
  const warnings = [];
  if (!row.firstName) errors.push({ field: 'firstName', message: 'First name required' });
  if (!row.surname) errors.push({ field: 'surname', message: 'Surname required' });
  if (!row.displayName) errors.push({ field: 'displayName', message: 'Display name required' });
  if (!row.phoneNumber) errors.push({ field: 'phoneNumber', message: 'Phone required' });
  if (!row.designation) errors.push({ field: 'designation', message: 'Designation required' });
  if (!row.employmentType) errors.push({ field: 'employmentType', message: 'Employment type required' });
  if (!row.employmentStatus) errors.push({ field: 'employmentStatus', message: 'Employment status required' });
  if (!row.dateJoined) errors.push({ field: 'dateJoined', message: 'Valid date joined required' });
  const empNo = String(row.employeeNumber || '').trim();
  if (empNo && existingKeys.employeeNos.has(empNo)) {
    errors.push({ field: 'employeeNumber', message: 'Duplicate employee number' });
  }
  const email = String(row.email || '').trim().toLowerCase();
  if (email && existingKeys.emails.has(email)) {
    errors.push({ field: 'email', message: 'Duplicate email' });
  }
  const phone = String(row.phoneNumber || '').trim();
  if (phone && existingKeys.phones.has(phone)) {
    errors.push({ field: 'phoneNumber', message: 'Duplicate phone' });
  }
  const branchId = resolveBranchId(db, row, {});
  if (!branchId) warnings.push({ field: 'branchCode', message: 'Branch not mapped — will use default' });
  if (row.departmentName && !row.departmentCode) {
    warnings.push({ field: 'departmentName', message: 'Department free-text — flag for cleanup' });
  }
  return { errors, warnings, branchId };
}

export function previewBulkStaffImport(db, buffer, scope = {}) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
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
  const existingPhones = new Set(
    db.prepare(`SELECT trim(phone) AS p FROM hr_staff_profiles WHERE phone IS NOT NULL`).all().map((r) => r.p).filter(Boolean)
  );
  const preview = [];
  let valid = 0;
  let failed = 0;
  let duplicates = 0;
  let needsCleanup = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const mapped = mapRow(rows[i], headerMap);
    const rowNum = i + 2;
    const keys = { employeeNos: existingNos, emails: existingEmails, phones: existingPhones };
    const { errors, warnings, branchId } = validateRow(db, mapped, rowNum, keys);
    if (errors.some((e) => e.message.includes('Duplicate'))) duplicates += 1;
    if (warnings.length) needsCleanup += 1;
    if (errors.length) failed += 1;
    else valid += 1;
    preview.push({ rowNum, ...mapped, branchId, errors, warnings, valid: errors.length === 0 });
    if (mapped.employeeNumber) existingNos.add(String(mapped.employeeNumber).trim());
    if (mapped.email) existingEmails.add(String(mapped.email).trim().toLowerCase());
    if (mapped.phoneNumber) existingPhones.add(String(mapped.phoneNumber).trim());
  }
  return {
    ok: true,
    preview,
    summary: { total: rows.length, valid, failed, duplicates, needsCleanup, skipped: 0 },
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
  const prev = previewBulkStaffImport(db, buffer, scope);
  if (!prev.ok) return prev;
  const runId = newId('HRIMP');
  const now = nowIso();
  const importPassword = String(process.env.ZAREWA_STAFF_IMPORT_PASSWORD || 'Zarewa@Import2026!').trim();
  let imported = 0;
  let skipped = 0;
  const results = [];
  for (const row of prev.preview) {
    if (!row.valid) {
      skipped += 1;
      results.push({ rowNum: row.rowNum, status: 'skipped', errors: row.errors });
      continue;
    }
    const displayName = row.displayName || `${row.firstName} ${row.surname}`.trim();
    let username = slugUsername(displayName, row.employeeNumber);
    let suffix = 0;
    while (db.prepare(`SELECT 1 FROM app_users WHERE username = ?`).get(username)) {
      suffix += 1;
      username = `${slugUsername(displayName, row.employeeNumber)}${suffix}`;
    }
    const body = {
      username,
      displayName,
      password: importPassword,
      roleKey: 'sales_staff',
      email: row.email || undefined,
      phone: row.phoneNumber,
      employeeNo: row.employeeNumber || undefined,
      branchId: row.branchId || resolveBranchId(db, row, scope),
      jobTitle: row.designation,
      department: row.departmentName || row.departmentCode || 'General',
      employmentType: row.employmentType,
      employmentStatus: row.employmentStatus,
      dateJoinedIso: row.dateJoined,
      baseSalaryNgn: row.basicSalary ? Math.round(Number(String(row.basicSalary).replace(/[^\d.]/g, '')) || 0) : 0,
      gender: row.gender || undefined,
      dateOfBirthIso: row.dateOfBirth || undefined,
      minimumQualification: row.highestQualification || undefined,
      bankName: row.bankName || undefined,
      bankAccountName: row.accountName || displayName,
      bankAccountNoMasked: row.accountNumber ? `****${String(row.accountNumber).slice(-4)}` : undefined,
      selfServiceEligible: true,
    };
    const r = registerNewStaffWithProfile(db, actor?.id, body);
    if (!r.ok) {
      skipped += 1;
      results.push({ rowNum: row.rowNum, status: 'failed', error: r.error });
      continue;
    }
    imported += 1;
    results.push({ rowNum: row.rowNum, status: 'imported', userId: r.userId });
    if (row.warnings?.length) {
      createHrNotification(db, {
        userId: actor?.id,
        kind: 'import_cleanup',
        title: 'Staff import needs cleanup',
        body: `${body.displayName} — review master data mapping.`,
        routePath: `/hr/employees/${encodeURIComponent(r.userId)}`,
        entityKind: 'hr_staff_profile',
        entityId: r.userId,
      });
    }
  }
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
      JSON.stringify({ results, summary: prev.summary }),
      now,
    );
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.bulk_staff.import',
    entityKind: 'hr_staff_import_run',
    entityId: runId,
    details: { imported, skipped, total: prev.summary.total },
  });
  return {
    ok: true,
    runId,
    imported,
    skipped,
    failed: prev.summary.failed,
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
