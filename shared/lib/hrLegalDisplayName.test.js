import { describe, expect, it } from 'vitest';
import { composeLegalDisplayName, validateEmployeeProfileSubmit } from './hrLegalDisplayName.js';

describe('hrLegalDisplayName', () => {
  it('composes full name from parts', () => {
    expect(composeLegalDisplayName({ firstName: 'John', middleName: 'A.', surname: 'Okonkwo' })).toBe(
      'John A. Okonkwo'
    );
    expect(composeLegalDisplayName({ firstName: 'Jane', surname: 'Doe' })).toBe('Jane Doe');
  });

  it('validates required employee submit fields', () => {
    const staff = {
      gender: 'female',
      dateOfBirthIso: '1990-01-01',
      ninNumber: '12345678901',
      bvnNumber: '10987654321',
      minimumQualification: 'B.Sc',
      profileExtra: {
        personal: {
          firstName: 'Ada',
          surname: 'Bello',
          phone: '08012345678',
          residentialAddress: '12 Main St',
        },
      },
      nextOfKin: { name: 'Mama Bello', phone: '08098765432', relationship: 'Mother' },
    };
    expect(validateEmployeeProfileSubmit(staff).ok).toBe(true);
    expect(validateEmployeeProfileSubmit({}).ok).toBe(false);
  });
});
