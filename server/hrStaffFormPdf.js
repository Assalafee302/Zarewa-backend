/**
 * Printable staff registration form (board staff form alignment).
 * @module server/hrStaffFormPdf
 */

import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { getHrStaffOne } from './hrOps.js';

const SITE_LABELS = [
  { match: (id) => !id || id === 'HQ' || id === 'KD' || id === 'BR-KD' || id.includes('KADUNA'), label: 'Kaduna (HQ)' },
  { match: (id) => id === 'YL' || id === 'BR-YL' || id.includes('YOLA'), label: 'Yola' },
  { match: (id) => id === 'MDG' || id === 'BR-MDG' || id.includes('MAIDUGURI'), label: 'Maiduguri' },
];

function blank(n = 28) {
  return '_'.repeat(n);
}

function val(value, n = 28) {
  const s = value == null || value === '' ? '' : String(value).trim();
  return s || blank(n);
}

function siteLine(branchId) {
  const id = String(branchId || '').trim().toUpperCase();
  const parts = SITE_LABELS.map((s) => `[${id && s.match(id) ? 'X' : ' '}] ${s.label}`);
  return `Place of work: ${parts.join('   ')}`;
}

function row2(leftLabel, leftVal, rightLabel, rightVal) {
  return `${leftLabel}: ${val(leftVal, 22)}    ${rightLabel}: ${val(rightVal, 22)}`;
}

/**
 * Build printable lines for staff registration form.
 * @param {object|null} staff enriched staff from getHrStaffOne; null for blank template
 */
export function buildStaffRegistrationFormLines(staff = null) {
  const personal = staff?.profileExtra?.personal || {};
  const nok = staff?.nextOfKin || {};
  const surname = personal.surname || (staff?.displayName || '').split(' ').slice(-1)[0] || '';
  const firstName = personal.firstName || (staff?.displayName || '').split(' ')[0] || '';
  const middleName = personal.middleName || '';

  const lines = [
    'ZAREWA ALUMINIUM & PLASTICS LTD',
    'STAFF INFORMATION / REGISTRATION FORM',
    '================================================================',
    staff ? `Form ref: ${staff.employeeNo || staff.userId}   Printed: ${new Date().toISOString().slice(0, 10)}` : 'Form ref: _______________   Date: _______________',
    '',
    siteLine(staff?.branchId || staff?.normalized?.branchId),
    row2('Staff number', staff?.employeeNo, 'Date joined', staff?.dateJoinedIso),
    '',
    'SECTION A — PERSONAL PARTICULARS',
    '----------------------------------------------------------------',
    row2('Surname', surname, 'First name', firstName),
    row2('Other names', middleName, 'Gender', staff?.gender),
    row2('Date of birth', staff?.dateOfBirthIso || personal.dateOfBirthIso, 'Marital status', personal.maritalStatus),
    row2('Phone', personal.phone, 'Email', personal.email || staff?.email),
    `Residential address: ${val(personal.residentialAddress, 52)}`,
    row2('State of origin', personal.stateOfOrigin, 'L.G.A.', personal.localGovernment),
    row2('Nationality', personal.nationality || 'Nigerian', 'Blood group', personal.bloodGroup),
    row2('NIN', staff?.ninNumber, 'BVN', staff?.bvnNumber ? '(on file)' : ''),
    '',
    'SECTION B — EMPLOYMENT',
    '----------------------------------------------------------------',
    row2('Department', staff?.department, 'Job title', staff?.jobTitle),
    row2('Employment type', staff?.employmentType, 'Probation ends', staff?.probationEndIso),
    row2('Contract end', staff?.contractEndIso, 'Line manager', staff?.lineManagerDisplayName),
    row2('Leave band', staff?.leaveEntitlementBand, 'Payroll group', staff?.payrollGroup),
    row2('Salary level', staff?.salaryLevel, 'Step', staff?.salaryStep),
    '',
    'SECTION C — QUALIFICATIONS',
    '----------------------------------------------------------------',
    row2('Highest qualification', staff?.academicQualification || staff?.minimumQualification, 'Year', personal.yearCompleted),
    `Institution: ${val(personal.institution, 30)}    Course: ${val(personal.courseField, 24)}`,
    '',
    'SECTION D — BANK DETAILS (for payroll)',
    '----------------------------------------------------------------',
    row2('Bank name', staff?.bankName, 'Account name', staff?.bankAccountName),
    `Account number: ${val(staff?.bankAccountNoMasked || (staff?.bankAccountNo ? '(on file)' : ''), 24)}`,
    '',
    'SECTION E — STATUTORY',
    '----------------------------------------------------------------',
    row2('Tax ID', staff?.taxId, 'Pension RSA PIN', staff?.pensionRsaPin),
    `NHIS provider: ${val(staff?.nhisProvider, 40)}`,
    '',
    'SECTION F — NEXT OF KIN / EMERGENCY CONTACT',
    '----------------------------------------------------------------',
    row2('Name', nok.name, 'Relationship', nok.relationship),
    row2('Phone', nok.phone, 'Alt. phone', nok.altPhone),
    `Address: ${val(nok.address, 52)}`,
    '',
    'SECTION G — DECLARATIONS',
    '----------------------------------------------------------------',
    'I confirm that the information given above is true and complete to the best of',
    'my knowledge. I understand that false information may lead to disciplinary action.',
    '',
    'Employee signature: ___________________________   Date: ____________',
    '',
    'HR received by: _______________________________   Date: ____________',
    '',
    staff?.fileCompleteness
      ? `File completeness at print: ${staff.fileCompleteness.percent}% (${staff.fileCompleteness.done}/${staff.fileCompleteness.total} items)`
      : 'HR use only — attach passport photograph and verified ID copies.',
  ];
  return lines;
}

function chunkLines(lines, size = 44) {
  const pages = [];
  for (let i = 0; i < lines.length; i += size) {
    pages.push({ lines: lines.slice(i, i + size) });
  }
  return pages.length ? pages : [{ lines: ['(empty)'] }];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function exportStaffRegistrationFormPdf(db, userId) {
  const staff = getHrStaffOne(db, userId);
  if (!staff) return { ok: false, error: 'Staff not found.' };
  const pdf = buildSimpleTextPdf(chunkLines(buildStaffRegistrationFormLines(staff)));
  const slug = String(staff.employeeNo || userId).replace(/[^\w.-]+/g, '-');
  return {
    ok: true,
    pdf,
    filename: `staff-registration-${slug}.pdf`,
    contentType: 'application/pdf',
  };
}

/** Blank template for manual completion or scanning. */
export function exportBlankStaffRegistrationFormPdf() {
  const pdf = buildSimpleTextPdf(chunkLines(buildStaffRegistrationFormLines(null)));
  return {
    ok: true,
    pdf,
    filename: 'Zarewa-Staff-Registration-Form.pdf',
    contentType: 'application/pdf',
  };
}
