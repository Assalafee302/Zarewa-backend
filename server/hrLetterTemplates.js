/**
 * HR employment letter body templates (Phase 2).
 * @module server/hrLetterTemplates
 */

const COMPANY = 'Zarewa Aluminium and Plastics Ltd';

function todayLabel() {
  return new Date().toLocaleDateString('en-NG', { day: '2-digit', month: 'long', year: 'numeric' });
}

function staffBlock(staff) {
  const name = staff.displayName || staff.username || 'Staff Member';
  const lines = [
    name,
    staff.employeeNo ? `Employee No: ${staff.employeeNo}` : null,
    staff.jobTitle ? `Job Title: ${staff.jobTitle}` : null,
    staff.department ? `Department: ${staff.department}` : null,
    staff.branchId ? `Branch: ${staff.branchId}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * @param {string} letterKind
 * @param {object} staff — displayName, username, employeeNo, jobTitle, department, branchId, dateJoinedIso, baseSalaryNgn
 * @param {Record<string, string>} extra
 */
export function buildHrLetterContent(letterKind, staff, extra = {}) {
  const kind = String(letterKind || 'employment').trim().toLowerCase();
  const name = staff.displayName || staff.username || 'Staff Member';
  const job = staff.jobTitle || 'Staff';
  const dept = staff.department || 'General';
  const joined = staff.dateJoinedIso || extra.effectiveDate || 'TBD';
  const salary = extra.newSalary || extra.salaryAmount || staff.baseSalaryNgn;
  const fmtSalary = salary != null && salary !== '' ? `NGN ${Math.round(Number(salary) || 0).toLocaleString('en-NG')}` : 'as per payroll record';
  const date = todayLabel();

  const templates = {
    employment: () => [
      COMPANY, '', `Date: ${date}`, '', 'TO WHOM IT MAY CONCERN', '',
      `RE: Employment Confirmation — ${name}`, '',
      `This is to certify that ${name} is employed with ${COMPANY} as ${job} in ${dept}, effective from ${joined}.`,
      '', 'This letter is issued at the request of the employee for official use.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    appointment: () => [
      COMPANY, '', `Date: ${date}`, '', name, dept, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `We are pleased to appoint you to the position of ${extra.newJobTitle || job} in ${dept}, effective ${extra.effectiveDate || joined}.`,
      `Your employment is subject to company policies, probation requirements, and satisfactory performance.`,
      '', 'Please sign and return the enclosed acceptance form.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    confirmation: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Following satisfactory completion of your probation period, we confirm your appointment as ${job} in ${dept}, effective ${extra.effectiveDate || date}.`,
      '', 'Congratulations and we wish you continued success with the company.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    probation_extension: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Your probation period is extended to ${extra.newProbationEnd || extra.effectiveDate || 'TBD'}.`,
      `Reason: ${extra.reason || 'Further assessment of performance and conduct is required.'}`,
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ],
    salary_increment: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `We write to inform you that your monthly basic salary has been reviewed to ${fmtSalary}, effective ${extra.effectiveDate || date}.`,
      extra.reason ? `Reason: ${extra.reason}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    training_approval: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are approved to attend: ${extra.courseTitle || 'Training programme'}.`,
      extra.trainingDates ? `Dates: ${extra.trainingDates}` : '',
      extra.venue ? `Venue: ${extra.venue}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    leave_approval: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Your ${extra.leaveType || 'leave'} request from ${extra.startDate || '—'} to ${extra.endDate || '—'} has been approved.`,
      extra.daysRequested ? `Days approved: ${extra.daysRequested}` : '',
      extra.balanceAfter != null ? `Leave balance after approval: ${extra.balanceAfter} day(s)` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    leave_rejection: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Your ${extra.leaveType || 'leave'} request from ${extra.startDate || '—'} to ${extra.endDate || '—'} cannot be approved at this time.`,
      extra.rejectionReason ? `Reason: ${extra.rejectionReason}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    dismissal: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Further to disciplinary proceedings, your employment with ${COMPANY} is terminated with effect from ${extra.terminationDate || date}.`,
      extra.terminationReason ? `Grounds: ${extra.terminationReason}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    resignation_acceptance: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `We acknowledge receipt of your resignation. Your last working day will be ${extra.lastWorkingDay || extra.effectiveDate || 'TBD'}.`,
      'Please complete exit clearance and return all company property before your departure.',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ],
    exit_clearance: () => [
      COMPANY, '', `Date: ${date}`, '', 'EXIT CLEARANCE FORM', '',
      `Employee: ${name}`, `Employee No: ${staff.employeeNo || '—'}`, `Department: ${dept}`, '',
      `Separation type: ${extra.separationType || '—'}`, `Last working day: ${extra.lastWorkingDay || '—'}`, '',
      'Finance clearance: _______________', 'Admin/IT clearance: _______________', 'HR final clearance: _______________',
      '', 'Property returned (see attached checklist).',
    ],
    return_of_property: () => [
      COMPANY, '', `Date: ${date}`, '', 'RETURN OF COMPANY PROPERTY', '',
      `Employee: ${name}`, `Employee No: ${staff.employeeNo || '—'}`, '',
      'The following company property has been returned in satisfactory condition:', '',
      extra.propertyList || '1. _______________________________', '',
      'Received by: _________________________   Date: _________________',
    ],
    confidentiality_pledge: () => [
      COMPANY, '', 'CONFIDENTIALITY PLEDGE', '',
      `I, ${name}, employee of ${COMPANY}, undertake to keep confidential all company information, customer data, and trade secrets.`,
      'I understand that breach may lead to disciplinary action including termination.', '',
      'Signed: _________________________   Date: _________________',
    ],
    handbook_receipt: () => [
      COMPANY, '', 'EMPLOYEE HANDBOOK RECEIPT AND ACCEPTANCE', '',
      `I, ${name}, confirm that I have received and read the ${COMPANY} Employee Handbook (version ${extra.handbookVersion || '2026'}).`,
      'I agree to comply with its policies and procedures.', '',
      'Signed: _________________________   Date: _________________',
    ],
    certificate_of_service: () => [
      COMPANY, '', `Date: ${date}`, '', 'TO WHOM IT MAY CONCERN', '',
      `CERTIFICATE OF SERVICE`, '',
      `This is to certify that ${name} was employed by ${COMPANY} as ${job} in ${dept} from ${joined} to ${extra.lastWorkingDay || 'present'}.`,
      `${name} ${extra.conductNote || 'conducted themselves satisfactorily'} during the period of employment.`,
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ],
    experience: () => [
      COMPANY, '', `Date: ${date}`, '', 'TO WHOM IT MAY CONCERN', '',
      `This is to certify that ${name} was employed with ${COMPANY} as ${job}${dept ? ` (${dept})` : ''} from ${joined}.`,
      extra.purposeOfLetter ? `Purpose: ${extra.purposeOfLetter}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
  };

  const fn = templates[kind];
  if (fn) return fn().join('\n');
  return templates.employment().join('\n');
}

export { COMPANY };
