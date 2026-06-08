import { describe, expect, it } from 'vitest';
import { pickCanonicalStaffMember, usernameSuffixPenalty } from './hrStaffDuplicateCleanup.js';

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
});
