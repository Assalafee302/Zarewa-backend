/**
 * Redact HR payloads for API, bootstrap, search, and AI context.
 * @module server/hrRedaction
 */

import { userCanViewOrgSensitiveHr, userCanViewStaffCompensation } from './hrPermissions.js';

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
  'bankAccountNoMasked',
  'bonusAccrualNote',
];

const PAYROLL_LINE_SENSITIVE = [
  'grossNgn',
  'bonusNgn',
  'attendanceDeductionNgn',
  'otherDeductionNgn',
  'taxNgn',
  'pensionNgn',
  'netNgn',
];

/**
 * @param {object | null | undefined} row
 * @param {{ canViewSensitive?: boolean; maskBank?: boolean }} ctx
 */
export function redactStaffProfile(row, ctx = {}) {
  if (!row || typeof row !== 'object') return row;
  if (ctx.canViewSensitive) {
    if (ctx.maskBank && row.bankAccountNoMasked) {
      return { ...row, bankAccountNoMasked: maskAccount(row.bankAccountNoMasked) };
    }
    return row;
  }
  const out = { ...row };
  for (const k of STAFF_SENSITIVE_KEYS) {
    if (k in out) out[k] = null;
  }
  if ('profileExtra' in out && out.profileExtra && typeof out.profileExtra === 'object') {
    const pe = { ...out.profileExtra };
    delete pe.salaryHistory;
    delete pe.compensationNotes;
    out.profileExtra = pe;
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
  const sub = String(opts.subjectUserId || req?.params?.userId || '').trim();
  const canViewSensitive = userCanViewStaffCompensation(user, sub, {
    sensitiveUnlocked: Boolean(opts.sensitiveUnlocked ?? req?.hrSensitiveUnlocked),
  });
  return {
    canViewSensitive,
    maskBank: !userCanViewOrgSensitiveHr(user),
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
  return redactStaffProfile(row, { canViewSensitive: false });
}
