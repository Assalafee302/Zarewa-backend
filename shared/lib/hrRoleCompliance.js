/**
 * Role-requirement compliance (qualification vs designation min, tenure vs max).
 * Distinct from handbook acknowledgement, profile completeness, and overdue review badges.
 * Always render `label` (or `shortLabel` plus the "Role compliance" prefix) — never colour alone.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/hrRoleCompliance.js
 */

export const HR_STAFF_BANDS = ['director', 'manager', 'senior_staff', 'junior_staff', 'entry_staff'];

export const HR_ROLE_COMPLIANCE_STATUS = {
  ok: 'ok',
  needs_attention: 'needs_attention',
};

export const HR_ROLE_COMPLIANCE_META = {
  ok: {
    value: 'ok',
    label: 'Role compliance: ok',
    shortLabel: 'Ok',
    tone: 'green',
  },
  needs_attention: {
    value: 'needs_attention',
    label: 'Role compliance: needs attention',
    shortLabel: 'Needs attention',
    tone: 'amber',
  },
};

export function hrRoleComplianceMeta(status) {
  const key = String(status || '').trim() || HR_ROLE_COMPLIANCE_STATUS.ok;
  return (
    HR_ROLE_COMPLIANCE_META[key] || {
      value: key,
      label: `Role compliance: ${key}`,
      shortLabel: key,
      tone: 'amber',
    }
  );
}

function asRank(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function yearsBetweenIsoAndNow(startIso, nowMs) {
  const start = Date.parse(String(startIso || '').slice(0, 10));
  if (!Number.isFinite(start)) return null;
  return (nowMs - start) / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Pure compute — does not write the database.
 * Missing held rank (when a minimum is set) or missing role start (when a max tenure is set)
 * is needs_attention, not ok.
 */
export function computeRoleCompliance(input = {}, nowMs = Date.now()) {
  const title = String(input.designationTitle || input.title || 'this role').trim() || 'this role';
  const minRank = asRank(input.minQualificationRank);
  const heldRank = asRank(input.qualificationRank);
  const maxTenure = asRank(input.maxTenureYears);
  const reasons = [];

  if (minRank != null && minRank > 0) {
    if (heldRank == null) {
      reasons.push(`Qualification not recorded; ${title} requires minimum rank ${minRank}.`);
    } else if (heldRank < minRank) {
      reasons.push(`Held qualification rank ${heldRank} is below minimum rank ${minRank} for ${title}.`);
    }
  }

  if (maxTenure != null && maxTenure > 0) {
    const yearsInRole = yearsBetweenIsoAndNow(input.roleStartedAtIso, nowMs);
    if (yearsInRole == null) {
      reasons.push(`Role start date missing; cannot check maximum tenure of ${maxTenure} years for ${title}.`);
    } else if (yearsInRole > maxTenure) {
      const shown = Math.floor(yearsInRole * 10) / 10;
      reasons.push(`In this role for ${shown} years; maximum tenure is ${maxTenure} years for ${title}.`);
    }
  }

  if (!reasons.length) {
    return { status: HR_ROLE_COMPLIANCE_STATUS.ok, reason: null };
  }
  return { status: HR_ROLE_COMPLIANCE_STATUS.needs_attention, reason: reasons.join(' ') };
}
