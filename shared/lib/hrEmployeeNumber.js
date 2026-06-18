/**
 * Staff employee number formatting — display IDs for ID cards, letters, and HR records.
 * Default: branch codes like ZAPKD001, ZAPYL002 (company + branch + sequence).
 * @module shared/lib/hrEmployeeNumber
 */

export const DEFAULT_COMPANY_PREFIX = 'ZAP';
export const DEFAULT_STAFF_NUMBER_PREFIX = 'ZAP';
export const DEFAULT_STAFF_NUMBER_PAD = 3;
export const DEFAULT_STAFF_STARTING_NUMBER = 6;
export const DEFAULT_RESERVED_BRANCH_CODE = 'KD';

const BRANCH_ID_CODE_FALLBACK = {
  'BR-KD': 'KD',
  'BR-YL': 'YL',
  'BR-MDG': 'MDG',
};

const EXECUTIVE_RESERVED = [
  { numericRank: 1, label: 'CEO / Chairman' },
  { numericRank: 2, label: 'Managing Director' },
  { numericRank: 3, label: 'Director 1' },
  { numericRank: 4, label: 'Director 2' },
  { numericRank: 5, label: 'Director 3' },
];

function baseStaffNumberConfig() {
  return {
    format: 'branch_prefixed',
    companyPrefix: DEFAULT_COMPANY_PREFIX,
    prefix: DEFAULT_COMPANY_PREFIX,
    padWidth: DEFAULT_STAFF_NUMBER_PAD,
    startingNumber: DEFAULT_STAFF_STARTING_NUMBER,
    reservedBranchCode: DEFAULT_RESERVED_BRANCH_CODE,
    lastAppliedAtIso: null,
  };
}

export function resolveEmployeeBranchCode(db, branchId) {
  const id = String(branchId || '').trim();
  if (!id) return DEFAULT_RESERVED_BRANCH_CODE;
  if (db) {
    try {
      const row = db.prepare(`SELECT code FROM branches WHERE id = ? LIMIT 1`).get(id);
      const code = String(row?.code || '').trim().toUpperCase();
      if (code) return code;
    } catch {
      /* table may not exist in tests */
    }
  }
  if (BRANCH_ID_CODE_FALLBACK[id]) return BRANCH_ID_CODE_FALLBACK[id];
  const m = id.match(/^BR-([A-Z0-9]+)$/i);
  return m ? m[1].toUpperCase() : DEFAULT_RESERVED_BRANCH_CODE;
}

function formatStaffEmployeeNumberRaw(cfg, numericValue, branchCode) {
  const num = Math.max(0, Math.round(Number(numericValue) || 0));
  const pad = Math.max(3, Math.min(6, Number(cfg.padWidth) || DEFAULT_STAFF_NUMBER_PAD));
  if (cfg.format === 'branch_prefixed') {
    const company = String(cfg.companyPrefix || DEFAULT_COMPANY_PREFIX).trim().toUpperCase();
    const bc = String(branchCode || cfg.reservedBranchCode || DEFAULT_RESERVED_BRANCH_CODE)
      .trim()
      .toUpperCase();
    return `${company}${bc}${String(num).padStart(pad, '0')}`;
  }
  if (cfg.format === 'prefixed') {
    const prefix = String(cfg.prefix || DEFAULT_STAFF_NUMBER_PREFIX).trim();
    return `${prefix}${String(num).padStart(pad, '0')}`;
  }
  return String(num).padStart(pad, '0');
}

export function buildDefaultReservedEntries(config) {
  const cfg = {
    ...baseStaffNumberConfig(),
    ...(config && typeof config === 'object' ? config : {}),
  };
  cfg.padWidth = Math.max(3, Math.min(6, Number(cfg.padWidth) || DEFAULT_STAFF_NUMBER_PAD));
  if (cfg.format !== 'numeric' && cfg.format !== 'prefixed') cfg.format = 'branch_prefixed';
  const reservedBranch = String(cfg.reservedBranchCode || DEFAULT_RESERVED_BRANCH_CODE).toUpperCase();
  return EXECUTIVE_RESERVED.map(({ numericRank, label }) => ({
    number: formatStaffEmployeeNumberRaw(cfg, numericRank, reservedBranch),
    label,
    numericRank,
    branchCode: reservedBranch,
  }));
}

export function getDefaultStaffNumberConfig() {
  const base = baseStaffNumberConfig();
  return {
    ...base,
    reserved: buildDefaultReservedEntries(base),
  };
}

export function normalizeStaffNumberConfig(config) {
  const defaults = getDefaultStaffNumberConfig();
  const merged = { ...defaults, ...(config && typeof config === 'object' ? config : {}) };
  merged.padWidth = Math.max(3, Math.min(6, Number(merged.padWidth) || DEFAULT_STAFF_NUMBER_PAD));
  merged.startingNumber = Math.max(
    1,
    Math.round(Number(merged.startingNumber) || DEFAULT_STAFF_STARTING_NUMBER)
  );
  if (!['numeric', 'prefixed', 'branch_prefixed'].includes(merged.format)) {
    merged.format = 'branch_prefixed';
  }
  merged.companyPrefix =
    String(merged.companyPrefix || merged.prefix || DEFAULT_COMPANY_PREFIX)
      .trim()
      .toUpperCase() || DEFAULT_COMPANY_PREFIX;
  merged.reservedBranchCode = String(merged.reservedBranchCode || DEFAULT_RESERVED_BRANCH_CODE)
    .trim()
    .toUpperCase();
  if (merged.format === 'prefixed' && !String(merged.prefix || '').trim()) {
    merged.prefix = `${DEFAULT_COMPANY_PREFIX}-`;
  }
  const reserved = Array.isArray(merged.reserved) && merged.reserved.length ? merged.reserved : defaults.reserved;
  merged.reserved = reserved.map((entry) => {
    const branchCode =
      entry?.branchCode ||
      merged.reservedBranchCode ||
      parseEmployeeNumberParts(entry?.number, merged)?.branchCode ||
      DEFAULT_RESERVED_BRANCH_CODE;
    const numericRank =
      entry?.numericRank ??
      parseEmployeeNumberParts(entry?.number, merged)?.numeric ??
      (Number(entry?.number) > 0 ? Number(entry.number) : null);
    const number =
      numericRank != null
        ? formatStaffEmployeeNumberRaw(merged, numericRank, branchCode)
        : String(entry?.number || '').trim().toUpperCase();
    return {
      ...entry,
      number,
      label: entry?.label || '',
      branchCode: String(branchCode || merged.reservedBranchCode).toUpperCase(),
      ...(numericRank != null ? { numericRank } : {}),
    };
  });
  return merged;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseDuplicateCompanyPrefix(raw, company) {
  let out = String(raw || '').trim().toUpperCase();
  const doubled = `${company}${company}`;
  while (out.startsWith(doubled)) out = out.slice(company.length);
  return out;
}

export function parseEmployeeNumberParts(employeeNo, config) {
  let raw = String(employeeNo || '').trim().toUpperCase();
  if (!raw) return null;
  const cfg =
    config?.format != null || config?.companyPrefix != null
      ? normalizeStaffNumberConfig(config)
      : normalizeStaffNumberConfig(config);

  if (cfg.format === 'branch_prefixed') {
    const company = String(cfg.companyPrefix || DEFAULT_COMPANY_PREFIX).toUpperCase();
    raw = collapseDuplicateCompanyPrefix(raw, company);

    const empLegacy = raw.match(/^EMP[-\s]?(\d+)$/i);
    if (empLegacy) {
      return { companyPrefix: company, branchCode: null, numeric: parseInt(empLegacy[1], 10) };
    }

    const companyRe = new RegExp(`^${escapeRegExp(company)}([A-Z]{2,5})(\\d+)$`, 'i');
    const m = raw.match(companyRe);
    if (m) {
      const branchCode = m[1].toUpperCase();
      const numeric = parseInt(m[2], 10);
      if (branchCode === 'EMP') {
        return { companyPrefix: company, branchCode: null, numeric };
      }
      if (branchCode !== company) {
        return { companyPrefix: company, branchCode, numeric };
      }
    }

    if (raw.startsWith(company)) {
      const afterCompany = raw.slice(company.length);
      if (/^\d+$/.test(afterCompany)) {
        return { companyPrefix: company, branchCode: null, numeric: parseInt(afterCompany, 10) };
      }
    }

    const branchOnlyRe = /^([A-Z]{2,5})(\d+)$/;
    const m2 = raw.match(branchOnlyRe);
    if (m2) {
      const branchCode = m2[1].toUpperCase();
      const numeric = parseInt(m2[2], 10);
      if (branchCode === 'EMP') {
        return { companyPrefix: company, branchCode: null, numeric };
      }
      if (branchCode !== company) {
        return { companyPrefix: company, branchCode, numeric };
      }
      return { companyPrefix: company, branchCode: null, numeric };
    }
    if (/^\d+$/.test(raw)) {
      return { companyPrefix: company, branchCode: null, numeric: parseInt(raw, 10) };
    }
    return null;
  }

  const prefix = String(cfg.prefix || '').trim();
  if (prefix && raw.startsWith(prefix.toUpperCase())) {
    const rest = raw.slice(prefix.length).replace(/^[-\s]*/, '');
    if (!/^\d+$/.test(rest)) return null;
    return { companyPrefix: prefix, branchCode: null, numeric: parseInt(rest, 10) };
  }
  if (/^\d+$/.test(raw)) {
    return { companyPrefix: null, branchCode: null, numeric: parseInt(raw, 10) };
  }
  return null;
}

export function formatStaffEmployeeNumber(config, numericValue, ctx = {}) {
  const cfg = normalizeStaffNumberConfig(config);
  const branchCode =
    ctx.branchCode ||
    (ctx.branchId ? resolveEmployeeBranchCode(ctx.db, ctx.branchId) : null) ||
    cfg.reservedBranchCode;
  return formatStaffEmployeeNumberRaw(cfg, numericValue, branchCode);
}

export function parseEmployeeNumberNumeric(employeeNo, config, ctx = {}) {
  const parts = parseEmployeeNumberParts(employeeNo, config);
  if (!parts || parts.numeric == null) return null;
  if (ctx.branchCode && parts.branchCode && parts.branchCode !== String(ctx.branchCode).toUpperCase()) {
    return null;
  }
  return parts.numeric;
}

export function expandReservedEmployeeNumbers(config) {
  const cfg = normalizeStaffNumberConfig(config);
  const out = new Set();
  for (const entry of cfg.reserved || []) {
    const raw = String(entry?.number || '').trim().toUpperCase();
    if (raw) out.add(raw);
    const branchCode = entry?.branchCode || cfg.reservedBranchCode;
    const numeric =
      entry?.numericRank ??
      parseEmployeeNumberParts(raw, cfg)?.numeric ??
      (Number(raw) > 0 ? Number(raw) : null);
    if (numeric != null) {
      out.add(formatStaffEmployeeNumberRaw(cfg, numeric, branchCode));
      out.add(String(numeric));
    }
  }
  return out;
}

export function isReservedEmployeeNumber(employeeNo, config) {
  const raw = String(employeeNo || '').trim().toUpperCase();
  if (!raw) return false;
  const cfg = normalizeStaffNumberConfig(config);
  const expanded = expandReservedEmployeeNumbers(cfg);
  if (expanded.has(raw)) return true;
  const parts = parseEmployeeNumberParts(raw, cfg);
  if (parts?.numeric == null) return false;
  return (cfg.reserved || []).some((entry) => {
    const rank =
      entry?.numericRank ??
      parseEmployeeNumberParts(entry?.number, cfg)?.numeric ??
      (Number(entry?.number) > 0 ? Number(entry.number) : null);
    const entryBranch = String(entry?.branchCode || cfg.reservedBranchCode).toUpperCase();
    const sameBranch = !parts.branchCode || parts.branchCode === entryBranch;
    return rank === parts.numeric && sameBranch;
  });
}

export function normalizeEmployeeNumberForSave(raw, config, ctx = {}) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const cfg = normalizeStaffNumberConfig(config);
  const branchCode =
    ctx.branchCode ||
    (ctx.branchId && ctx.db ? resolveEmployeeBranchCode(ctx.db, ctx.branchId) : null) ||
    cfg.reservedBranchCode;

  const parts = parseEmployeeNumberParts(trimmed, cfg);
  if (parts?.numeric != null && cfg.format === 'branch_prefixed') {
    const bc = parts.branchCode || branchCode;
    return formatStaffEmployeeNumberRaw(cfg, parts.numeric, bc);
  }
  if (parts?.numeric != null) {
    return formatStaffEmployeeNumber(cfg, parts.numeric, { branchCode, db: ctx.db });
  }
  return trimmed.toUpperCase();
}

export function findMaxAssignedEmployeeNumericForBranch(db, config, branchCode) {
  if (!db || !branchCode) return 0;
  const cfg = normalizeStaffNumberConfig(config);
  const bc = String(branchCode).toUpperCase();
  let max = 0;
  const rows =
    db
      .prepare(
        `SELECT employee_no AS employeeNo FROM hr_staff_profiles
         WHERE employee_no IS NOT NULL AND trim(employee_no) != ''`
      )
      .all() || [];
  for (const row of rows) {
    const parts = parseEmployeeNumberParts(row.employeeNo, cfg);
    if (parts?.branchCode === bc && parts.numeric != null && parts.numeric > max) max = parts.numeric;
  }
  return max;
}

export function findMaxAssignedEmployeeNumeric(db, config) {
  if (!db) return 0;
  let max = 0;
  const cfg = normalizeStaffNumberConfig(config);
  const rows =
    db
      .prepare(
        `SELECT employee_no AS employeeNo FROM hr_staff_profiles
         WHERE employee_no IS NOT NULL AND trim(employee_no) != ''`
      )
      .all() || [];
  for (const row of rows) {
    const n = parseEmployeeNumberParts(row.employeeNo, cfg)?.numeric;
    if (n != null && n > max) max = n;
  }
  return max;
}

export function findNextAssignableNumeric(db, config, ctx = {}) {
  const cfg = normalizeStaffNumberConfig(config);
  const branchCode =
    ctx.branchCode ||
    (ctx.branchId && ctx.db ? resolveEmployeeBranchCode(ctx.db, ctx.branchId) : null) ||
    cfg.reservedBranchCode;
  const takenNumerics = ctx.takenNumerics instanceof Set ? ctx.takenNumerics : new Set();

  const reservedNumerics = new Set(
    (cfg.reserved || [])
      .filter((entry) => {
        const entryBranch = String(entry?.branchCode || cfg.reservedBranchCode).toUpperCase();
        return String(branchCode).toUpperCase() === entryBranch;
      })
      .map(
        (entry) =>
          entry?.numericRank ??
          parseEmployeeNumberParts(entry?.number, cfg)?.numeric ??
          (Number(entry?.number) > 0 ? Number(entry.number) : null)
      )
      .filter((n) => n != null && n > 0)
  );

  const maxInBranch =
    cfg.format === 'branch_prefixed'
      ? findMaxAssignedEmployeeNumericForBranch(db, cfg, branchCode)
      : findMaxAssignedEmployeeNumeric(db, cfg);

  let next;
  if (cfg.format === 'branch_prefixed') {
    if (maxInBranch > 0) {
      next = maxInBranch + 1;
    } else if (String(branchCode).toUpperCase() === String(cfg.reservedBranchCode).toUpperCase()) {
      next = Math.max(cfg.startingNumber, 1);
    } else {
      next = 1;
    }
  } else {
    next = Math.max(cfg.startingNumber, maxInBranch + 1, 1);
  }
  while (reservedNumerics.has(next) || takenNumerics.has(next)) next += 1;
  return next;
}

export function createEmployeeNumberAllocator(db, config, { takenFormatted = new Set() } = {}) {
  const cfg = normalizeStaffNumberConfig(config);
  const takenByBranch = new Map();

  const getTakenNumerics = (branchCode) => {
    const bc = String(branchCode).toUpperCase();
    if (!takenByBranch.has(bc)) {
      const set = new Set();
      for (const value of takenFormatted) {
        const parts = parseEmployeeNumberParts(value, cfg);
        if (parts?.branchCode === bc && parts.numeric != null) set.add(parts.numeric);
      }
      takenByBranch.set(bc, set);
    }
    return takenByBranch.get(bc);
  };

  return {
    next(ctx = {}) {
      const branchCode =
        ctx.branchCode ||
        resolveEmployeeBranchCode(db, ctx.branchId) ||
        cfg.reservedBranchCode;
      const takenNumerics = getTakenNumerics(branchCode);
      const numeric = findNextAssignableNumeric(db, cfg, { branchCode, takenNumerics, db });
      const formatted = formatStaffEmployeeNumberRaw(cfg, numeric, branchCode);
      takenNumerics.add(numeric);
      takenFormatted.add(formatted);
      return formatted;
    },
  };
}

export function allocateNextEmployeeNumber(db, config, ctx = {}) {
  return createEmployeeNumberAllocator(db, config, {
    takenFormatted: ctx.takenFormatted instanceof Set ? ctx.takenFormatted : new Set(),
  }).next(ctx);
}

export function previewSampleEmployeeNumber(config, db, ctx = {}) {
  const cfg = normalizeStaffNumberConfig(config);
  const branchCode =
    ctx.branchCode ||
    resolveEmployeeBranchCode(db, ctx.branchId) ||
    cfg.reservedBranchCode;
  const numeric = findNextAssignableNumeric(db, cfg, { branchCode, db });
  return formatStaffEmployeeNumber(cfg, numeric, { branchCode, db });
}
