/**
 * Standard API error responses — always `{ ok: false, code, error }`.
 */

/**
 * @param {import('express').Response} res
 * @param {{ status?: number; code?: string; error: string; detail?: unknown }} opts
 */
export function apiError(res, opts) {
  const status = Number(opts.status) || 400;
  const code = String(opts.code || 'REQUEST_FAILED').trim();
  const error = String(opts.error || 'Request failed.').trim();
  const body = { ok: false, code, error };
  if (opts.detail != null && opts.detail !== '') {
    body.detail = opts.detail;
  }
  return res.status(status).json(body);
}

/**
 * @param {import('express').Response} res
 * @param {string} field
 * @param {string} [message]
 */
export function apiValidationError(res, field, message) {
  return apiError(res, {
    status: 400,
    code: 'VALIDATION_ERROR',
    error: message || `${field} is required.`,
  });
}

/**
 * @param {import('express').Response} res
 * @param {string} [permissionHint]
 */
export function apiForbidden(res, permissionHint) {
  return apiError(res, {
    status: 403,
    code: 'FORBIDDEN',
    error: permissionHint || 'You do not have permission for this action.',
  });
}

/**
 * Sanitize caught errors for user-facing responses — never leak SQL/stack text.
 * @param {unknown} err
 * @param {string} fallback
 */
export function safeErrorMessage(err, fallback) {
  const raw = String(err?.message || err || '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (
    lower.includes('unique constraint') ||
    lower.includes('foreign key') ||
    lower.includes('sqlite_') ||
    lower.includes('er_') ||
    lower.includes('syntax error') ||
    raw.includes(' at ')
  ) {
    return fallback;
  }
  return raw.length > 240 ? `${raw.slice(0, 237)}…` : raw;
}
