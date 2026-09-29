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
    const row = { userId: 'U1', ninNumber: '12345678901' };
    const out = redactStaffProfile(row, { canViewSensitive: false, canViewIdentity: false });
    expect(out.ninNumber).toBeNull();
  });

  it('keeps national IDs for self-service subject', () => {
    const row = { userId: 'U1', ninNumber: '12345678901' };
    const out = redactStaffProfile(row, {
      canViewSensitive: false,
      canViewIdentity: true,
      isSelf: true,
    });
    expect(out.ninNumber).toBe('12345678901');
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

  it('strips nested pay figures from profileExtra when compensation is redacted', () => {
    const row = {
      userId: 'U1',
      baseSalaryNgn: 900000,
      profileExtra: {
        compensation: { payAdditionNgn: 200000, matrixTotalNgn: 700000 },
        compensationVariance: { actualTotalNgn: 900000, varianceNgn: 200000 },
        compensationPackage: { baseNgn: 900000 },
        preferredName: 'Ada',
      },
    };
    const out = redactStaffProfile(row, { canViewSensitive: false });
    expect(out.baseSalaryNgn).toBeNull();
    expect(out.profileExtra.compensation).toBeUndefined();
    expect(out.profileExtra.compensationVariance).toBeUndefined();
    expect(out.profileExtra.compensationPackage).toBeUndefined();
    expect(out.profileExtra.preferredName).toBe('Ada');
  });

  it('keeps nested pay figures for viewers who can see compensation', () => {
    const row = {
      userId: 'U1',
      profileExtra: { compensationVariance: { actualTotalNgn: 900000 } },
    };
    const out = redactStaffProfile(row, { canViewSensitive: true });
    expect(out.profileExtra.compensationVariance.actualTotalNgn).toBe(900000);
  });
});
