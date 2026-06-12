/**
 * Policy text shown to staff before acknowledgement (keep in sync with frontend copy).
 * @type {Record<string, { summary: string; body: string }>}
 */
export const HR_POLICY_CONTENT = {
  employee_handbook: {
    summary: 'Core employment terms, benefits, and workplace expectations.',
    body: `You acknowledge that you have read and understood the Zarewa employee handbook. This includes your duties, reporting lines, leave rules, disciplinary process, and company values. You agree to follow handbook policies for the duration of your employment.`,
  },
  it_security: {
    summary: 'Protect company systems, passwords, and customer data.',
    body: `You will keep login credentials confidential, use company systems only for authorised work, report suspected breaches promptly, and not install unapproved software on company devices.`,
  },
  attendance_policy: {
    summary: 'Working hours, punctuality, and attendance recording.',
    body: `You agree to observe scheduled working hours, report absences through the proper channels, and understand that daily attendance is recorded by your branch manager for payroll purposes.`,
  },
  eeo_policy: {
    summary: 'Equal opportunity and non-discrimination.',
    body: `Zarewa provides equal employment opportunity regardless of gender, religion, ethnicity, or disability. Harassment and discrimination are not tolerated.`,
  },
  confidentiality_pledge: {
    summary: 'Protect company, customer, and employee information.',
    body: `You will not disclose confidential information about Zarewa, its customers, suppliers, or colleagues to unauthorised persons during or after employment.`,
  },
  code_of_conduct: {
    summary: 'Professional behaviour and integrity standards.',
    body: `You will act honestly, avoid conflicts of interest, treat colleagues and customers respectfully, and follow lawful instructions from management.`,
  },
  anti_harassment: {
    summary: 'Zero tolerance for harassment or bullying.',
    body: `You understand how to report harassment, that retaliation is prohibited, and that the company will investigate reports fairly.`,
  },
  data_protection: {
    summary: 'Personal data handling and privacy.',
    body: `You will handle personal data lawfully, access only what you need for your role, and report data incidents to HR or IT immediately.`,
  },
  conflict_of_interest: {
    summary: 'Declare outside interests that may affect your role.',
    body: `You will disclose any personal, financial, or family interest that could conflict with your duties and follow HR guidance on mitigation.`,
  },
};

/** Plain-text guarantor form template for download. */
export const HR_GUARANTOR_FORM_TEMPLATE = `ZAREWA ALUMINIUM & PLASTICS LTD
STAFF LOAN GUARANTOR FORM

I, ________________________________________________ (full name),
of ________________________________________________ (address),
Phone: ____________________  NIN: ____________________

hereby guarantee repayment of any staff loan granted to:

Employee name: _______________________________________
Employee no.: ________________________________________
Branch/Dept: _________________________________________

Loan amount (₦): _____________________________________
Repayment period: __________ months

I understand that if the employee defaults, the company may seek recovery
from me as guarantor, subject to company loan policy and applicable law.

Guarantor signature: _____________________  Date: __________

Witness name: _________________________  Signature: __________

FOR HR USE ONLY
Verified by: _________________  Date: _________________
`;
