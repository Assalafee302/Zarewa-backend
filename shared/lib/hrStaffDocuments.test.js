import { describe, expect, it } from 'vitest';
import { buildHrStaffOnboardingChecklist } from './hrStaffDocuments.js';

describe('buildHrStaffOnboardingChecklist', () => {
  it('flags missing identity and documents', () => {
    const r = buildHrStaffOnboardingChecklist({
      ninNumber: '123',
      nextOfKin: { name: 'A', phone: '080' },
      avatarUrl: null,
      uploadedDocKinds: ['fslc'],
    });
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('passportPhoto');
    expect(r.missing).toContain('ninNumber');
    expect(r.missing.some((m) => m.startsWith('doc:'))).toBe(true);
  });

  it('passes when all requirements met', () => {
    const r = buildHrStaffOnboardingChecklist({
      ninNumber: '12345678901',
      nextOfKin: { name: 'Jane Doe', phone: '08012345678' },
      avatarUrl: 'data:image/png;base64,abc',
      uploadedDocKinds: [
        'birth_certificate',
        'fslc',
        'secondary_certificate',
        'tertiary_qualification',
        'guarantor_form',
        'nin_slip',
      ],
    });
    expect(r.complete).toBe(true);
    expect(r.missing).toHaveLength(0);
  });
});
