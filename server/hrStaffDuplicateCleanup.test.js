import { describe, expect, it } from 'vitest';
import { pickCanonicalLoginForNameDuplicate, pickCanonicalStaffMember, usernameIdentityStem, usernameSuffixPenalty } from './hrStaffDuplicateCleanup.js';

describe('hrStaffDuplicateCleanup', () => {
  it('penalizes numbered username suffixes from retry imports', () => {
    expect(usernameSuffixPenalty('okoro.5', '5')).toBe(0);
    expect(usernameSuffixPenalty('okoro.51', '5')).toBeGreaterThan(usernameSuffixPenalty('okoro.5', '5'));
  });

  it('keeps canonical username without suffix for same employee number', () => {
    const keep = pickCanonicalStaffMember([
      {
        userId: 'u1',
        username: 'okoro.51',
        status: 'active',
        employeeNo: '5',
        jobTitle: 'Operator',
      },
      {
        userId: 'u2',
        username: 'okoro.5',
        status: 'active',
        employeeNo: '5',
        jobTitle: 'Operator',
        dateJoinedIso: '2020-01-01',
      },
    ]);
    expect(keep.userId).toBe('u2');
  });

  it('usernameIdentityStem drops numeric suffixes only', () => {
    expect(usernameIdentityStem('okoro.51')).toBe('okoro');
    expect(usernameIdentityStem('john.doe')).toBe('john.doe');
  });

  it('keeps the original login when a stub and a full file share a display name', () => {
    const keep = pickCanonicalLoginForNameDuplicate([
      {
        userId: 'original',
        username: 'musa.okoro',
        status: 'active',
        lastLoginAtIso: '2026-08-01T10:00:00.000Z',
        createdAtIso: '2024-01-01T00:00:00.000Z',
        employeeNo: 'ZAPKD099',
        jobTitle: '',
        dateJoinedIso: '',
        baseSalaryNgn: 0,
      },
      {
        userId: 'clone',
        username: 'okoro.12',
        status: 'active',
        lastLoginAtIso: '',
        createdAtIso: '2026-08-20T00:00:00.000Z',
        employeeNo: 'ZAPKD012',
        jobTitle: 'Store Keeper',
        dateJoinedIso: '2020-01-01',
        baseSalaryNgn: 80000,
      },
    ]);
    expect(keep.userId).toBe('original');
  });
});
