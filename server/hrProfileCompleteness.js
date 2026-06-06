/**
 * Employee profile completeness scoring by section (Phase 5A).
 * @module server/hrProfileCompleteness
 */

import { HR_REQUIRED_DOC_KINDS } from '../shared/lib/hrStaffDocuments.js';

function pct(filled, total) {
  if (!total) return 100;
  return Math.round((filled / total) * 100);
}

/**
 * @param {object} staff — enriched staff row from listHrStaff / getHrStaffOne
 * @param {{ handbookAcknowledged?: boolean; uploadedDocKinds?: string[] }} [ctx]
 */
export function computeProfileCompleteness(staff, ctx = {}) {
  if (!staff) {
    return { overallPct: 0, sections: [], missingCritical: [] };
  }
  const personal = staff.profileExtra?.personal || {};
  const uploaded = new Set(ctx.uploadedDocKinds || staff.documents?.map((d) => d.docKind) || []);

  const sections = [
    {
      id: 'personal',
      label: 'Personal data',
      fixTab: 'employment',
      checks: [
        Boolean(staff.displayName || personal.firstName),
        Boolean(staff.gender),
        Boolean(staff.dateOfBirthIso || staff.dateOfBirth),
        Boolean(staff.email || personal.email),
        Boolean(personal.phone || personal.mobilePhone),
        Boolean(staff.ninNumber),
      ],
    },
    {
      id: 'employment',
      label: 'Employment details',
      fixTab: 'employment',
      checks: [
        Boolean(staff.employeeNo),
        Boolean(staff.jobTitle),
        Boolean(staff.department),
        Boolean(staff.branchId),
        Boolean(staff.dateJoinedIso),
        Boolean(staff.employmentType),
        Boolean(staff.lineManagerUserId || staff.lineManagerDisplayName),
      ],
    },
    {
      id: 'payroll',
      label: 'Salary / payroll',
      fixTab: 'compensation',
      checks: [
        Boolean(staff.payrollGroup),
        staff.salaryLevel != null || staff.salaryStep != null,
        Number(staff.baseSalaryNgn) > 0,
      ],
    },
    {
      id: 'bank',
      label: 'Bank details',
      fixTab: 'compensation',
      checks: [Boolean(staff.bankName), Boolean(staff.bankAccountName), Boolean(staff.bankAccountNoMasked)],
    },
    {
      id: 'statutory',
      label: 'Tax / pension / NHIS',
      fixTab: 'compensation',
      checks: [
        Boolean(staff.taxId),
        Boolean(staff.pensionRsaPin),
        Boolean(staff.nhisProvider) || Number(staff.nhisDeductionNgn) > 0,
      ],
    },
    {
      id: 'nok',
      label: 'Next of kin',
      fixTab: 'employment',
      checks: [
        Boolean(staff.nextOfKin?.name),
        Boolean(staff.nextOfKin?.phone),
        Boolean(staff.nextOfKin?.relationship),
      ],
    },
    {
      id: 'qualifications',
      label: 'Qualifications',
      fixTab: 'employment',
      checks: [Boolean(staff.minimumQualification || staff.academicQualification)],
    },
    {
      id: 'documents',
      label: 'Documents',
      fixTab: 'documents',
      checks: HR_REQUIRED_DOC_KINDS.map((k) => uploaded.has(k)),
    },
    {
      id: 'policies',
      label: 'Policy acknowledgements',
      fixTab: 'documents',
      checks: [Boolean(ctx.handbookAcknowledged ?? staff.complianceBadges?.handbookAcknowledged)],
    },
  ].map((s) => ({
    ...s,
    filled: s.checks.filter(Boolean).length,
    total: s.checks.length,
    pct: pct(s.checks.filter(Boolean).length, s.checks.length),
    complete: s.checks.every(Boolean),
  }));

  const overallPct = Math.round(sections.reduce((sum, s) => sum + s.pct, 0) / sections.length);
  const missingCritical = [];
  if (!(staff.employeeNo && staff.jobTitle && staff.department && staff.branchId && staff.dateJoinedIso)) {
    missingCritical.push('core_employment');
  }
  if (!staff.ninNumber) missingCritical.push('nin');
  if (!staff.nextOfKin?.name) missingCritical.push('next_of_kin');
  if (sections.find((s) => s.id === 'documents')?.pct < 100) missingCritical.push('documents');

  return { overallPct, sections, missingCritical };
}
