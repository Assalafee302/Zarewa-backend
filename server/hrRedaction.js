/**
 * Redact HR payloads for API, bootstrap, search, and AI context.
 * @module server/hrRedaction
 */

import {
  hrUserHas,
  userCanViewOrgSensitiveHr,
  userCanViewStaffCompensation,
} from './hrPermissions.js';

const STAFF_SENSITIVE_KEYS = [
  'baseSalaryNgn',
  'housingAllowanceNgn',
  'transportAllowanceNgn',
  'payeTaxPercent',
  'pensionPercentOverride',
  'taxId',
  'pensionRsaPin',
  'bankName',
  'bankAccountName',
  'bankAccountNo',
  'bankCode',
  'bonusAccrualNote',
  'welfareNotes',
  'trainingSummary',
];

const IDENTITY_KEYS = ['ninNumber', 'bvnNumber'];

const PAYROLL_LINE_SENSITIVE = [
  'grossNgn',
  'bonusNgn',
  'attendanceDeductionNgn',
  'otherDeductionNgn',
  'taxNgn',
  'pensionNgn',
  'netNgn',
];

function scrubProfileExtra(extra, ctx) {
  if (!extra || typeof extra !== 'object') return extra;
  const pe = { ...extra };
  delete pe.salaryHistory;
  delete pe.compensationNotes;
  if (ctx.isSelf || !ctx.canViewHrNotes) {
    delete pe.hrNotes;
  }
  if (!ctx.canViewDiscipline) {
    delete pe.disciplinaryEvents;
  }
  return pe;
}

/**
 * @param {object | null | undefined} row
 * @param {{ canViewSensitive?: boolean; maskBank?: boolean; isSelf?: boolean; canViewIdentity?: boolean; canViewHrNotes?: boolean; canViewDiscipline?: boolean }} ctx
 */
export function redactStaffProfile(row, ctx = {}) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (ctx.canViewSensitive) {
    if (ctx.maskBank) {
      if (out.bankAccountNo) out.bankAccountNo = maskAccount(out.bankAccountNo);
      if (out.bankAccountNoMasked) out.bankAccountNoMasked = maskAccount(out.bankAccountNoMasked);
    }
    if ('profileExtra' in out && out.profileExtra) {
      out.profileExtra = scrubProfileExtra(out.profileExtra, ctx);
    }
    return out;
  }
  for (const k of STAFF_SENSITIVE_KEYS) {
    if (k in out) out[k] = null;
  }
  if (!ctx.canViewIdentity) {
    for (const k of IDENTITY_KEYS) {
      if (k in out) out[k] = null;
    }
  }
  if (row.bankAccountNoMasked) {
    out.bankAccountNoMasked = maskAccount(row.bankAccountNoMasked);
  }
  if ('profileExtra' in out && out.profileExtra && typeof out.profileExtra === 'object') {
    out.profileExtra = scrubProfileExtra(out.profileExtra, ctx);
  }
  out.compensationRedacted = true;
  return out;
}

/**
 * @param {object} req
 * @param {{ subjectUserId?: string; sensitiveUnlocked?: boolean }} [opts]
 */
export function hrRedactionContextFromReq(req, opts = {}) {
  const user = req?.user;
  const viewerId = String(user?.id || '').trim();
  const sub = String(opts.subjectUserId || req?.params?.userId || '').trim();
  const isSelf = Boolean(sub && viewerId && sub === viewerId);
  const canViewSensitive = userCanViewStaffCompensation(user, sub, {
    sensitiveUnlocked: Boolean(opts.sensitiveUnlocked ?? req?.hrSensitiveUnlocked),
  });
  const canViewIdentity =
    isSelf || userCanViewOrgSensitiveHr(user) || hrUserHas(user, 'hr.staff.manage');
  const canViewHrNotes = userCanViewOrgSensitiveHr(user) || hrUserHas(user, 'hr.staff.manage');
  const canViewDiscipline =
    isSelf ||
    hrUserHas(user, 'hr.discipline.manage') ||
    hrUserHas(user, 'hr.staff.manage') ||
    userCanViewOrgSensitiveHr(user);

  return {
    canViewSensitive,
    maskBank: !userCanViewOrgSensitiveHr(user),
    isSelf,
    canViewIdentity,
    canViewHrNotes,
    canViewDiscipline,
  };
}

function maskAccount(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

/**
 * @param {object[]} list
 * @param {object} ctx
 */
export function redactStaffList(list, ctx) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => redactStaffProfile(r, ctx));
}

/**
 * @param {object | null | undefined} line
 * @param {{ canViewSensitive?: boolean }} ctx
 */
export function redactPayrollLine(line, ctx = {}) {
  if (!line || ctx.canViewSensitive) return line;
  const out = { ...line };
  for (const k of PAYROLL_LINE_SENSITIVE) {
    if (k in out) out[k] = null;
  }
  out.amountsRedacted = true;
  return out;
}

/**
 * @param {object | null | undefined} reqRow
 * @param {{ canViewSensitive?: boolean; isOwner?: boolean }} ctx
 */
export function redactHrRequest(reqRow, ctx = {}) {
  if (!reqRow || typeof reqRow !== 'object') return reqRow;
  const out = { ...reqRow };
  if (ctx.canViewSensitive || ctx.isOwner) {
    if (String(out.kind) === 'loan' && !ctx.canViewSensitive && ctx.isOwner) {
      const p = out.payload && typeof out.payload === 'object' ? { ...out.payload } : {};
      if (p.amountNgn != null) p.amountNgn = null;
      out.payload = p;
      out.loanAmountRedacted = true;
    }
    return out;
  }
  if (out.payload && typeof out.payload === 'object') {
    const p = { ...out.payload };
    delete p.amountNgn;
    delete p.deductionPerMonthNgn;
    delete p.principalOutstandingNgn;
    delete p.financePaymentRequestId;
    out.payload = p;
  }
  return out;
}

/**
 * @param {object} row
 */
export function redactStaffForAi(row) {
  return redactStaffProfile(row, { canViewSensitive: false, canViewIdentity: false });
}
