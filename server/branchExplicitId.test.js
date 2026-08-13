import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { requireExplicitBranchId } from './branches.js';
import { previewExpenseBulkImport } from './expenseBulkImport.js';
import { importCoilLotsFromSpreadsheet } from './writeOps.js';
import { previewBulkStaffImport } from './hrStaffBulkImport.js';
import XLSX from 'xlsx';

describe('requireExplicitBranchId', () => {
  it('rejects empty branch id', () => {
    expect(requireExplicitBranchId('', 'coil import').ok).toBe(false);
    expect(requireExplicitBranchId(null, 'customer').error).toMatch(/never assigned to Kaduna/i);
  });

  it('accepts explicit branch id', () => {
    const r = requireExplicitBranchId('BR-YL', 'coil import');
    expect(r.ok).toBe(true);
    expect(r.branchId).toBe('BR-YL');
  });
});

describe('onboarding import branch guards', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
  });

  it('expense bulk import preview rejects missing branchId', () => {
    const r = previewExpenseBulkImport(
      db,
      [{ include: true, date: '2026-08-01', amountNgn: 1000, category: 'Office supplies' }],
      null,
      { branchId: '' }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/branchId is required/i);
  });

  it('coil import rejects missing branchId', () => {
    const r = importCoilLotsFromSpreadsheet(db, { rows: [{ coilNo: 'YL-001', currentKg: 500 }] }, '', null);
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/branchId is required/i);
  });

  it('HR bulk import flags rows without branch cues', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['First Name', 'Surname', 'Job Title', 'Date of Join'],
      ['Amina', 'Bello', 'Store Keeper', '2026-08-01'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Staff Import');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = previewBulkStaffImport(db, buf, { importMode: 'update' });
    expect(r.ok).toBe(true);
    const row = r.preview?.[0];
    expect(row?.branchId).toBeFalsy();
    expect(row?.errors?.some((e) => String(e.message || e).includes('Branch is required'))).toBe(true);
  });
});
