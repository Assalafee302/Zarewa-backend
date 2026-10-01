/**
 * Strict posting-date parse. Garbage strings (e.g. TM-2780 "262026-09-T12…")
 * must fail, not be saved as-is. Frontend copies via `npm run sync:shared`.
 */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export const LAGOS_TZ = 'Africa/Lagos';

export class IsoTimestampError extends Error {
  constructor(message, code = 'INVALID_DATE') {
    super(message);
    this.name = 'IsoTimestampError';
    this.code = code;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Calendar day YYYY-MM-DD in Africa/Lagos. */
export function lagosCalendarDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAGOS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function utcNoonIso(day) {
  return `${day}T12:00:00.000Z`;
}

function isRealYmd(year, month, day) {
  if (!Number.isFinite(year) || year < 1990 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, day: string, iso: string } | { ok: false, error: string, code: string }}
 */
export function parseIsoTimestamp(value) {
  if (value == null) return { ok: false, error: 'Date is required.', code: 'INVALID_DATE' };
  const s = String(value).trim();
  if (!s) return { ok: false, error: 'Date is required.', code: 'INVALID_DATE' };

  const dayOnly = DAY_RE.exec(s);
  if (dayOnly) {
    const year = Number(dayOnly[1]);
    const month = Number(dayOnly[2]);
    const day = Number(dayOnly[3]);
    if (!isRealYmd(year, month, day)) {
      return { ok: false, error: `Invalid calendar date "${s}".`, code: 'INVALID_DATE' };
    }
    const dayStr = `${year}-${pad2(month)}-${pad2(day)}`;
    return { ok: true, day: dayStr, iso: utcNoonIso(dayStr) };
  }

  if (s.includes('T')) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) {
      return { ok: false, error: `Invalid date "${s}".`, code: 'INVALID_DATE' };
    }
    const dt = new Date(t);
    if (Number.isNaN(dt.getTime())) {
      return { ok: false, error: `Invalid date "${s}".`, code: 'INVALID_DATE' };
    }
    const prefix = s.slice(0, 10);
    const dayMatch = DAY_RE.exec(prefix);
    if (dayMatch && isRealYmd(Number(dayMatch[1]), Number(dayMatch[2]), Number(dayMatch[3]))) {
      return { ok: true, day: prefix, iso: s.includes('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : dt.toISOString() };
    }
    const day = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    return { ok: true, day, iso: dt.toISOString() };
  }

  return { ok: false, error: `Invalid date "${s}".`, code: 'INVALID_DATE' };
}

export function parseIsoTimestampOrThrow(value, label = 'Date') {
  const parsed = parseIsoTimestamp(value);
  if (!parsed.ok) throw new IsoTimestampError(`${label}: ${parsed.error}`, parsed.code);
  return parsed;
}

/**
 * When the caller omitted a date, use now. Garbage is never treated as now.
 * @param {unknown} value
 */
export function normalizeIsoTimestampStrict(value, opts = {}) {
  const omitted = value == null || String(value).trim() === '';
  if (omitted) {
    if (opts.allowNow === false) {
      throw new IsoTimestampError('Date is required.', 'INVALID_DATE');
    }
    const iso = new Date().toISOString();
    const parsed = parseIsoTimestamp(iso);
    return parsed.ok ? parsed.iso : iso;
  }
  return parseIsoTimestampOrThrow(value, opts.label || 'Date').iso;
}

/**
 * Period key YYYY-MM. Accepts a period key or a posting date. Rejects TM-2780-style garbage.
 * @param {unknown} dateISO
 */
export function periodKeyFromParsedDate(dateISO, nowDay = '') {
  const raw = String(dateISO || '').trim();
  if (!raw) {
    const day = nowDay || lagosCalendarDay();
    return day.slice(0, 7);
  }
  const periodOnly = PERIOD_RE.exec(raw);
  if (periodOnly) {
    const year = Number(periodOnly[1]);
    const month = Number(periodOnly[2]);
    if (year < 1990 || year > 2100 || month < 1 || month > 12) {
      throw new IsoTimestampError(`Invalid period "${raw}".`, 'INVALID_DATE');
    }
    return `${periodOnly[1]}-${periodOnly[2]}`;
  }
  const parsed = parseIsoTimestampOrThrow(raw, 'Posting date');
  return parsed.day.slice(0, 7);
}

export const TREASURY_DATE_WINDOW_DAYS_DEFAULT = 7;

/** Types with no source document: the posting day is measured against today. */
export const TODAY_MEASURED_TREASURY_TYPES = new Set([
  'INTERNAL_TRANSFER_OUT',
  'INTERNAL_TRANSFER_IN',
  'BANK_CHARGE',
  'BANK_FEE',
  'BANK_VAT',
  'STAMP_DUTY',
  'POS_FEE',
]);

/** Whole days from `fromDay` to `toDay` (both YYYY-MM-DD); positive when toDay is later. */
export function calendarDayDiff(fromDay, toDay) {
  const a = Date.parse(`${String(fromDay).slice(0, 10)}T12:00:00.000Z`);
  const b = Date.parse(`${String(toDay).slice(0, 10)}T12:00:00.000Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * Phase 2.1 posting-date rule.
 * - Future day: Admin/MD with a reason.
 * - Transfers / bank charges: measured against today. 1..window days back needs a reason;
 *   older needs Admin/MD with a reason.
 * - Everything else: posting day more than `windowDays` from the source document date
 *   (or from today when no document date is known) needs a reason.
 *
 * @param {{
 *   day: string,
 *   todayDay?: string,
 *   type?: string,
 *   sourceDocDay?: string,
 *   isPrivileged?: boolean,
 *   reason?: string,
 *   windowDays?: number,
 * }} opts
 * @returns {{ ok: true, day: string, override: null | 'future' | 'backdate' | 'doc_gap', gapDays: number }}
 */
export function assertTreasuryPostingDate(opts) {
  const parsed = parseIsoTimestamp(String(opts.day || '').trim());
  if (!parsed.ok) throw new IsoTimestampError(parsed.error, parsed.code);
  const day = parsed.day;
  const today = String(opts.todayDay || lagosCalendarDay()).trim().slice(0, 10);
  const windowDays = Math.max(
    0,
    Math.round(Number(opts.windowDays ?? TREASURY_DATE_WINDOW_DAYS_DEFAULT) || 0)
  );
  const reason = String(opts.reason || '').trim();
  const privileged = Boolean(opts.isPrivileged);
  const type = String(opts.type || '').trim().toUpperCase();

  if (day > today) {
    if (privileged && reason) return { ok: true, day, override: 'future', gapDays: calendarDayDiff(today, day) };
    throw new IsoTimestampError(
      `Date ${day} is in the future. Use today's date, or ask an Admin/MD to post it with a reason.`,
      'FUTURE_DATE'
    );
  }

  if (TODAY_MEASURED_TREASURY_TYPES.has(type)) {
    const back = calendarDayDiff(day, today);
    if (back > windowDays) {
      if (privileged && reason) return { ok: true, day, override: 'backdate', gapDays: back };
      throw new IsoTimestampError(
        `Date ${day} is ${back} days before today. Only an Admin/MD can post more than ${windowDays} days back, with a reason.`,
        'DATE_ADMIN_REQUIRED'
      );
    }
    if (back > 0) {
      if (reason) return { ok: true, day, override: 'backdate', gapDays: back };
      throw new IsoTimestampError(
        `Date ${day} is ${back} day(s) before today. Give a reason for backdating.`,
        'DATE_REASON_REQUIRED'
      );
    }
    return { ok: true, day, override: null, gapDays: 0 };
  }

  const docParsed = opts.sourceDocDay ? parseIsoTimestamp(String(opts.sourceDocDay).trim()) : null;
  const ref = docParsed?.ok ? docParsed.day : today;
  const gap = Math.abs(calendarDayDiff(ref, day));
  if (gap > windowDays) {
    if (reason) return { ok: true, day, override: 'doc_gap', gapDays: gap };
    const against = docParsed?.ok ? `the document date ${ref}` : 'today';
    throw new IsoTimestampError(
      `Date ${day} is ${gap} days from ${against}. Give a reason for this posting date.`,
      'DATE_REASON_REQUIRED'
    );
  }
  return { ok: true, day, override: null, gapDays: gap };
}

export function isPrivilegedTreasuryActor(actor) {
  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  return rk === 'admin' || rk === 'md' || rk === 'ceo';
}
