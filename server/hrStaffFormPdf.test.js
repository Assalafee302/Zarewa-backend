import { describe, expect, it } from 'vitest';
import {
  buildStaffRegistrationFormLines,
  exportBlankStaffRegistrationFormPdf,
  exportStaffRegistrationFormPdf,
} from './hrStaffFormPdf.js';

function makeDb(staff) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) return { get: () => ({ 1: 1 }) };
      return {
        get() {
          return null;
        },
        all() {
          if (s.includes('hr_staff_profiles') && s.includes('app_users')) {
            return staff ? [staff] : [];
          }
          return [];
        },
      };
    },
  };
}

describe('hrStaffFormPdf', () => {
  it('returns not found when staff missing', () => {
    const db = makeDb(null);
    const r = exportStaffRegistrationFormPdf(db, 'missing');
    expect(r.ok).toBe(false);
  });

  it('builds board-style sections with site ticks', () => {
    const lines = buildStaffRegistrationFormLines({
      userId: 'U1',
      employeeNo: 'ZAP-001',
      branchId: 'BR-YL',
      displayName: 'Jane Doe',
      department: 'Sales',
      jobTitle: 'Sales Officer',
      fileCompleteness: { percent: 80, done: 8, total: 10 },
    });
    const text = lines.join('\n');
    expect(text).toContain('SECTION A');
    expect(text).toContain('[X] Yola');
    expect(text).toContain('ZAP-001');
  });

  it('builds a PDF for a staff record', () => {
    const db = makeDb({
      userId: 'U1',
      username: 'jane',
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      roleKey: 'sales_staff',
      status: 'active',
      branchId: 'BR-KD',
      employeeNo: 'ZAP-001',
      jobTitle: 'Sales Officer',
      department: 'Sales',
      employmentType: 'permanent',
      dateJoinedIso: '2024-01-15',
      profileExtra: { personal: { phone: '08012345678' } },
      nextOfKin: { name: 'John Doe', phone: '08087654321' },
      selfServiceEligible: true,
      profileLocked: false,
      yearsOfService: 2,
    });
    const r = exportStaffRegistrationFormPdf(db, 'U1');
    expect(r.ok).toBe(true);
    expect(r.filename).toMatch(/staff-registration/);
    const buf = Buffer.from(r.pdf);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('exports blank template PDF', () => {
    const r = exportBlankStaffRegistrationFormPdf();
    expect(r.ok).toBe(true);
    expect(r.filename).toContain('Staff-Registration');
    expect(Buffer.from(r.pdf).slice(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
