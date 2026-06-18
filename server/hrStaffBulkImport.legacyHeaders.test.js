import { describe, expect, it, beforeEach } from 'vitest';
import XLSX from 'xlsx';
import { describeBulkImportHeaderMap, previewBulkStaffImport, readBulkImportWorkbookRows } from './hrStaffBulkImport.js';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';

describe('hrStaffBulkImport legacy headers', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
  });

  it('maps common legacy column titles from customer spreadsheets', () => {
    const headers = [
      'First Name',
      'Surname',
      'Display Name',
      'Email',
      'Employee ID',
      'Username',
      'Password',
      'Gender',
      'Birth Date',
      'Branch',
      'Division',
      'Unit',
      'Department',
      'Job Title',
      'Job Grade',
      'Employment Status',
      'Employment Type',
      'Date of Join',
      'Basic Salary',
      'Bank Name',
      'Bank Account Number',
      'Account Name',
      'Role',
    ];
    const info = describeBulkImportHeaderMap(headers);
    const keys = new Set(info.matched.map((m) => m.key));
    expect(keys.has('firstName')).toBe(true);
    expect(keys.has('surname')).toBe(true);
    expect(keys.has('email')).toBe(true);
    expect(keys.has('employeeNumber')).toBe(true);
    expect(keys.has('username')).toBe(true);
    expect(keys.has('branchName')).toBe(true);
    expect(keys.has('departmentName')).toBe(true);
    expect(keys.has('designation')).toBe(true);
    expect(keys.has('dateJoined')).toBe(true);
    expect(keys.has('roleKey')).toBe(true);
    expect(keys.has('accountNumber')).toBe(true);
  });

  it('reads rows and previews legacy workbook buffer', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [
        'First Name',
        'Surname',
        'Email',
        'Employee ID',
        'Username',
        'Branch',
        'Department',
        'Job Title',
        'Date of Join',
        'Role',
      ],
      [
        'Sani',
        'Muhammad',
        'sani@example.com',
        'EMP001',
        'sani.muhammad',
        'HQ',
        'Security',
        'Security Guard',
        '2020-01-15',
        'sales_staff',
      ],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Staff');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const parsed = readBulkImportWorkbookRows(buf);
    expect(parsed.rows.length).toBe(1);

    const preview = previewBulkStaffImport(db, buf, { importMode: 'update' });
    expect(preview.ok).toBe(true);
    expect(preview.totalRows).toBe(1);
    expect(preview.validCount).toBe(1);
    expect(preview.matchedColumns?.length).toBeGreaterThan(5);
  });
});
