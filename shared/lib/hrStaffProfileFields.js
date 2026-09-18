/**
 * Personal / identity fields staff (or a scoped Team HR assistant) may write.
 * Bank, salary, payroll group, and role stay HR-admin only.
 */

export const HR_SELF_SERVICE_PROFILE_FIELDS = [
  'ninNumber',
  'firstName',
  'middleName',
  'surname',
  'phone',
  'personalEmail',
  'maritalStatus',
  'residentialAddress',
  'stateOfOrigin',
  'localGovernment',
  'nationality',
  'bloodGroup',
  'gender',
  'dateOfBirthIso',
  'minimumQualification',
  'academicQualification',
  'professionalCertificates',
  'institution',
  'courseField',
  'yearCompleted',
  'nextOfKin',
  'nextOfKinName',
  'nextOfKinPhone',
  'nextOfKinRelationship',
  'nextOfKinAddress',
  'nextOfKinAltPhone',
];

/** Next-of-kin fields that fold into `nextOfKin` when the object is omitted. */
export const HR_NEXT_OF_KIN_FLAT_FIELDS = [
  'nextOfKinName',
  'nextOfKinPhone',
  'nextOfKinRelationship',
  'nextOfKinAddress',
  'nextOfKinAltPhone',
];
