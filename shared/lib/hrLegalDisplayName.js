/**
 * Legal display name from HR personal name parts.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/hrLegalDisplayName.js
 * @param {{ firstName?: string; middleName?: string; surname?: string }} personal
 */
export function composeLegalDisplayName(personal = {}) {
  return [personal.firstName, personal.middleName, personal.surname]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Fields an employee must complete before submitting their profile for HR review.
 * @param {object} staff — enriched staff / hr row with profileExtra, nextOfKin, etc.
 * @returns {{ ok: boolean; missing: { id: string; label: string }[] }}
 */
export function validateEmployeeProfileSubmit(staff) {
  if (!staff) return { ok: false, missing: [{ id: 'profile', label: 'HR profile' }] };

  const personal = staff.profileExtra?.personal || {};
  const nok = staff.nextOfKin || {};
  const checks = [
    { id: 'firstName', label: 'First name', ok: Boolean(String(personal.firstName || '').trim()) },
    { id: 'surname', label: 'Surname', ok: Boolean(String(personal.surname || '').trim()) },
    { id: 'phone', label: 'Phone number', ok: Boolean(String(personal.phone || '').trim()) },
    { id: 'gender', label: 'Gender', ok: Boolean(String(staff.gender || '').trim()) },
    { id: 'dateOfBirth', label: 'Date of birth', ok: Boolean(String(staff.dateOfBirthIso || staff.dateOfBirth || '').trim()) },
    {
      id: 'ninNumber',
      label: 'NIN (11 digits)',
      ok: /^\d{11}$/.test(String(staff.ninNumber || '').replace(/\D/g, '')),
    },
    {
      id: 'bvnNumber',
      label: 'BVN (11 digits)',
      ok: /^\d{11}$/.test(String(staff.bvnNumber || '').replace(/\D/g, '')),
    },
    { id: 'residentialAddress', label: 'Residential address', ok: Boolean(String(personal.residentialAddress || '').trim()) },
    { id: 'nextOfKinName', label: 'Next of kin name', ok: Boolean(String(nok.name || '').trim()) },
    { id: 'nextOfKinPhone', label: 'Next of kin phone', ok: Boolean(String(nok.phone || '').trim()) },
    { id: 'nextOfKinRelationship', label: 'Next of kin relationship', ok: Boolean(String(nok.relationship || '').trim()) },
    {
      id: 'qualification',
      label: 'Highest qualification',
      ok: Boolean(String(staff.minimumQualification || staff.academicQualification || '').trim()),
    },
  ];

  const missing = checks.filter((c) => !c.ok).map(({ id, label }) => ({ id, label }));
  return { ok: missing.length === 0, missing };
}
