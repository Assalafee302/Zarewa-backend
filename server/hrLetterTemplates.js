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
    transfer_inter_branch: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are hereby notified of your transfer from ${extra.fromBranch || staff.branchId || '—'} to ${extra.toBranch || '—'}, effective ${extra.effectiveDate || date}.`,
      extra.toDepartment ? `New department: ${extra.toDepartment}` : '',
      extra.toDesignation ? `New designation: ${extra.toDesignation}` : '',
      extra.reason ? `Reason: ${extra.reason}` : '',
      '', 'Please report to your new line manager on the effective date.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    transfer_in_branch: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `This letter confirms your transfer within ${extra.fromBranch || staff.branchId || 'your branch'} from ${extra.fromDepartment || dept} to ${extra.toDepartment || '—'}, effective ${extra.effectiveDate || date}.`,
      extra.toDesignation ? `New designation: ${extra.toDesignation}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    transfer_hq_to_branch: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are assigned from HQ to ${extra.toBranch || 'branch operations'}, effective ${extra.effectiveDate || date}.`,
      extra.toDepartment ? `Department: ${extra.toDepartment}` : '',
      extra.toDesignation ? `Designation: ${extra.toDesignation}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    transfer_branch_to_hq: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are transferred from ${extra.fromBranch || 'branch'} to HQ, effective ${extra.effectiveDate || date}.`,
      extra.toDepartment ? `HQ department: ${extra.toDepartment}` : '',
      extra.toDesignation ? `Designation: ${extra.toDesignation}` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    transfer_temporary: () => [
      COMPANY, '', `Date: ${date}`, '', name, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are temporarily assigned to ${extra.toBranch || extra.toDepartment || '—'} from ${extra.effectiveDate || date} until ${extra.endDate || 'further notice'}.`,
      extra.reason ? `Purpose: ${extra.reason}` : '',
      '', 'This assignment does not alter your permanent terms unless stated otherwise.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    query: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      `RE: QUERY — ${extra.caseNumber ? `Case ${extra.caseNumber}` : 'Disciplinary Matter'}`, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are required to explain in writing the following matter:`,
      extra.incidentDescription || extra.offenseDescription || 'See attached case file.',
      '',
      extra.responseDeadline ? `Please submit your written response by ${extra.responseDeadline}.` : 'Please submit your written response within 48 hours.',
      'Failure to respond may be treated as misconduct under company policy.',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    warning: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      `RE: ${extra.warningLevel || 'WRITTEN'} WARNING`, '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Following investigation of the matter dated ${extra.incidentDate || extra.effectiveDate || 'recent'}, you are issued a ${extra.warningLevel || 'written'} warning.`,
      extra.offenseDescription || extra.incidentDescription || 'Details are recorded in your HR file.',
      '', 'Further breaches may lead to suspension or termination.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    final_warning: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: FINAL WRITTEN WARNING', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `This is a final written warning. ${extra.offenseDescription || 'Serious misconduct has been established.'}`,
      'Any further breach will result in dismissal without further notice.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    suspension: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: SUSPENSION FROM DUTY', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are suspended from duty with effect from ${extra.suspensionFrom || extra.effectiveDate || date}${extra.suspensionTo ? ` until ${extra.suspensionTo}` : ''}, with full pay withheld as per policy.`,
      extra.suspensionReason || extra.offenseDescription || 'Pending completion of disciplinary investigation.',
      '', 'You must not enter company premises without HR authorisation.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    termination: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: TERMINATION OF EMPLOYMENT', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Your employment with ${COMPANY} is terminated with effect from ${extra.terminationDate || extra.effectiveDate || date}.`,
      extra.terminationReason ? `Grounds: ${extra.terminationReason}` : '',
      '', 'Please return all company property and complete exit clearance.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    promotion: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: PROMOTION', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `We are pleased to inform you of your promotion to ${extra.newJobTitle || job}, effective ${extra.effectiveDate || date}.`,
      extra.newSalary ? `Your revised monthly basic salary is ${fmtSalary}.` : '',
      '', 'Congratulations on this achievement.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
    salary: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: SALARY CONFIRMATION', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `This confirms your current monthly basic salary as ${fmtSalary}, effective ${extra.effectiveDate || joined}.`,
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ],
    introduction: () => [
      COMPANY, '', `Date: ${date}`, '', 'TO WHOM IT MAY CONCERN', '',
      `RE: INTRODUCTION — ${name}`, '',
      `${name} (${staff.employeeNo ? `Employee No: ${staff.employeeNo}` : job}) is an employee of ${COMPANY} and is authorised to ${extra.purposeOfLetter || 'represent the company on official business'}.`,
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ],
    hearing_invitation: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: DISCIPLINARY HEARING INVITATION', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You are invited to a disciplinary hearing on ${extra.hearingDate || 'TBD'} at ${extra.hearingVenue || 'HR office'}.`,
      extra.incidentDescription || 'The matter under review is recorded in your case file.',
      'You may be accompanied by a colleague or union representative.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    investigation_notice: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: DISCIPLINARY INVESTIGATION', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `An investigation has been opened regarding: ${extra.incidentDescription || 'a workplace matter'}.`,
      extra.caseNumber ? `Case reference: ${extra.caseNumber}.` : '',
      'You are required to cooperate fully and may be interviewed as part of this process.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    layoff: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: LAYOFF / RETRENCHMENT NOTICE', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `Due to ${extra.reason || 'operational requirements'}, your position may be affected effective ${extra.effectiveDate || date}.`,
      'HR will discuss settlement terms and exit clearance with you.', '',
      'Yours faithfully,', 'Human Resources (HQ)',
    ],
    code_of_conduct_receipt: () => [
      COMPANY, '', 'CODE OF CONDUCT — ACKNOWLEDGEMENT', '',
      `I, ${name}, confirm receipt of the ${COMPANY} Code of Conduct and agree to abide by its standards.`,
      '', 'Signed: _________________________   Date: _________________',
    ],
    anti_harassment_ack: () => [
      COMPANY, '', 'ANTI-HARASSMENT POLICY — ACKNOWLEDGEMENT', '',
      `I, ${name}, acknowledge the ${COMPANY} anti-harassment policy and understand reporting channels.`,
      '', 'Signed: _________________________   Date: _________________',
    ],
    data_protection: () => [
      COMPANY, '', 'DATA PROTECTION — ACKNOWLEDGEMENT', '',
      `I, ${name}, agree to handle personal and company data in accordance with data protection requirements.`,
      '', 'Signed: _________________________   Date: _________________',
    ],
    conflict_of_interest: () => [
      COMPANY, '', 'CONFLICT OF INTEREST DECLARATION', '',
      `I, ${name}, declare that I have read the conflict of interest policy and disclosed relevant interests.`,
      '', 'Signed: _________________________   Date: _________________',
    ],
    nda: () => [
      COMPANY, '', 'NON-DISCLOSURE AGREEMENT', '',
      `I, ${name}, agree not to disclose confidential information belonging to ${COMPANY} during or after employment.`,
      '', 'Signed: _________________________   Date: _________________',
    ],
    bonus_approval: () => [
      COMPANY, '', `Date: ${date}`, '', staffBlock(staff), '',
      'RE: BONUS APPROVAL', '',
      'Dear ' + name.split(' ')[0] + ',', '',
      `You have been approved for a ${extra.bonusType || 'performance'} bonus of ${extra.bonusAmount || 'as per payroll'}.`,
      extra.payPeriod ? `Pay period: ${extra.payPeriod}.` : '',
      '', 'Yours faithfully,', 'Human Resources (HQ)',
    ].filter(Boolean),
  };

  const fn = templates[kind];
  if (fn) return fn().join('\n');
  return templates.employment().join('\n');
}

export { COMPANY };
