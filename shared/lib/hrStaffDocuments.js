/**
 * HR employee file — required onboarding documents and identity fields.
 */

export const HR_STAFF_DOC_KINDS = [
  { value: 'birth_certificate', label: 'Birth certificate', accept: '.pdf,.png,.jpg,.jpeg,.webp' },
  { value: 'fslc', label: 'FSLC (First School Leaving Certificate)', accept: '.pdf,.png,.jpg,.jpeg,.webp' },
  { value: 'secondary_certificate', label: 'Secondary school certificate (WAEC/NECO)', accept: '.pdf,.png,.jpg,.jpeg,.webp' },
  {
    value: 'tertiary_qualification',
    label: 'Degree / ND / HND / professional qualification',
    accept: '.pdf,.png,.jpg,.jpeg,.webp',
  },
  { value: 'guarantor_form', label: 'Guarantor form(s)', accept: '.pdf,.png,.jpg,.jpeg,.webp' },
  { value: 'nin_slip', label: 'NIN slip / NIN card', accept: '.pdf,.png,.jpg,.jpeg,.webp' },
];

export const HR_REQUIRED_DOC_KINDS = HR_STAFF_DOC_KINDS.map((d) => d.value);

export const HR_STAFF_IDENTITY_FIELDS = ['ninNumber', 'nextOfKin'];

/** @param {string} kind */
export function hrStaffDocKindLabel(kind) {
  return HR_STAFF_DOC_KINDS.find((d) => d.value === kind)?.label || kind;
}

/**
 * @param {{
 *   ninNumber?: string | null;
 *   nextOfKin?: { name?: string; phone?: string; relationship?: string; address?: string } | null;
 *   avatarUrl?: string | null;
 *   uploadedDocKinds?: string[];
 * }} input
 */
export function buildHrStaffOnboardingChecklist(input = {}) {
  const missing = [];
  const missingLabels = [];

  const nin = String(input.ninNumber || '').trim();
  if (!nin || nin.length < 11) {
    missing.push('ninNumber');
    missingLabels.push('NIN number');
  }

  const nok = input.nextOfKin && typeof input.nextOfKin === 'object' ? input.nextOfKin : null;
  const nokName = String(nok?.name || '').trim();
  const nokPhone = String(nok?.phone || '').trim();
  if (!nokName || nokPhone.length < 7) {
    missing.push('nextOfKin');
    missingLabels.push('Next of kin (name & phone)');
  }

  const avatar = String(input.avatarUrl || '').trim();
  if (!avatar) {
    missing.push('passportPhoto');
    missingLabels.push('Passport photograph');
  }

  const uploaded = new Set((input.uploadedDocKinds || []).map((k) => String(k)));
  for (const kind of HR_REQUIRED_DOC_KINDS) {
    if (!uploaded.has(kind)) {
      missing.push(`doc:${kind}`);
      missingLabels.push(hrStaffDocKindLabel(kind));
    }
  }

  return {
    complete: missing.length === 0,
    missing,
    missingLabels,
  };
}
