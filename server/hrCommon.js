/**
 * Primitives every HR module needs: timestamps, record ids, and JSON column
 * parsing. Each of these used to be hand-copied into ~20 files, which is how
 * three different `safeJsonParse` behaviours ended up in the module.
 *
 * @module server/hrCommon
 */

import crypto from 'node:crypto';

/** Current instant as an ISO-8601 UTC string — the storage format for every HR `*_iso` column. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * UTC calendar date `days` away from now, matching `nowIso().slice(0, 10)`.
 * @param {number} days
 */
export function isoDateShift(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Opaque record id, e.g. `HRAUD-9f2c…`.
 * @param {string} prefix
 * @param {number} [bytes] random bytes of entropy
 */
export function newId(prefix, bytes = 8) {
  return `${prefix}-${crypto.randomBytes(bytes).toString('hex')}`;
}

/**
 * Time-ordered id for tables whose rows are read back in creation order.
 * @param {string} prefix
 */
export function newTimeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Parse a JSON column that must hold an object — anything else yields `fallback`.
 * Use for `*_json` columns read as `{...}` maps.
 * @template T
 * @param {unknown} raw
 * @param {T} fallback
 * @returns {object|T}
 */
export function parseJsonObject(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON column that may legitimately hold an array or scalar.
 * @template T
 * @param {unknown} raw
 * @param {T} fallback
 */
export function parseJsonValue(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON column that must hold an array — anything else yields `[]`.
 * @param {unknown} raw
 * @returns {unknown[]}
 */
export function parseJsonArray(raw) {
  const v = parseJsonValue(raw, null);
  return Array.isArray(v) ? v : [];
}

/**
 * Whole days from `fromIso` to `toIso`; `0` when either side is unparseable.
 * @param {unknown} fromIso
 * @param {unknown} toIso
 */
export function diffDays(fromIso, toIso) {
  const a = Date.parse(String(fromIso || '').slice(0, 10));
  const b = Date.parse(String(toIso || '').slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}
