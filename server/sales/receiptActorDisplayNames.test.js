import { describe, expect, it } from 'vitest';
import { personNameForLoginRow } from './receiptActorDisplayNames.js';

describe('personNameForLoginRow', () => {
  it('replaces a Cashier role title with the HR legal name', () => {
    expect(
      personNameForLoginRow({
        display_name: 'Cashier',
        role_key: 'cashier',
        profile_extra_json: JSON.stringify({ personal: { firstName: 'Hauwa', surname: 'Bello' } }),
      })
    ).toBe('Hauwa Bello');
  });

  it('keeps a real login display name', () => {
    expect(
      personNameForLoginRow({
        display_name: 'Musa Ibrahim',
        role_key: 'cashier',
        profile_extra_json: JSON.stringify({ personal: { firstName: 'Hauwa', surname: 'Bello' } }),
      })
    ).toBe('Musa Ibrahim');
  });
});
