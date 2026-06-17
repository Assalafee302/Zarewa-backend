import { describe, expect, it } from 'vitest';
import { redactPayrollLine, redactStaffProfile } from './hrRedaction.js';

describe('hrRedaction', () => {
  it('redacts salary fields for unauthorized viewers', () => {
    const row = {
      userId: 'U1',
      baseSalaryNgn: 250000,
      bankName: 'GTBank',
      payeTaxPercent: 7.5,
    };
    const out = redactStaffProfile(row, { canViewSensitive: false });
    expect(out.baseSalaryNgn).toBeNull();
    expect(out.bankName).toBeNull();
    expect(out.compensationRedacted).toBe(true);
  });

  it('keeps salary fields for authorized viewers', () => {
    const row = { userId: 'U1', baseSalaryNgn: 250000 };
    const out = redactStaffProfile(row, { canViewSensitive: true });
    expect(out.baseSalaryNgn).toBe(250000);
  });

  it('redacts payroll line amounts', () => {
    const line = { userId: 'U1', grossNgn: 300000, netNgn: 250000 };
    const out = redactPayrollLine(line, { canViewSensitive: false });
    expect(out.grossNgn).toBeNull();
    expect(out.netNgn).toBeNull();
    expect(out.amountsRedacted).toBe(true);
  });

  it('redacts national IDs for non-privileged viewers', () => {
    const row = { userId: 'U1', ninNumber: '12345678901', bvnNumber: '22222222222' };
    const out = redactStaffProfile(row, { canViewSensitive: false, canViewIdentity: false });
    expect(out.ninNumber).toBeNull();
    expect(out.bvnNumber).toBeNull();
  });

  it('keeps national IDs for self-service subject', () => {
    const row = { userId: 'U1', ninNumber: '12345678901', bvnNumber: '22222222222' };
    const out = redactStaffProfile(row, {
      canViewSensitive: false,
      canViewIdentity: true,
      isSelf: true,
    });
    expect(out.ninNumber).toBe('12345678901');
    expect(out.bvnNumber).toBe('22222222222');
  });

  it('strips HR-only notes from profileExtra for self', () => {
    const row = {
      userId: 'U1',
      profileExtra: {
        hrNotes: { internalRemarks: 'Do not share' },
        disciplinaryEvents: [{ id: 'x' }],
      },
    };
    const out = redactStaffProfile(row, {
      canViewSensitive: false,
      canViewIdentity: true,
      isSelf: true,
      canViewHrNotes: false,
      canViewDiscipline: true,
    });
    expect(out.profileExtra.hrNotes).toBeUndefined();
    expect(out.profileExtra.disciplinaryEvents).toHaveLength(1);
  });
});
