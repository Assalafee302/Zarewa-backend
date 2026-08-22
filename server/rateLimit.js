/**
 * Shared sliding-window rate limiting for public and authenticated routes.
 */

/**
 * @param {import('express').Request} req
 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return String(req.socket?.remoteAddress || '0').slice(0, 64);
}

/**
 * Sliding window rate limit.
 * @param {Map<string, { count: number; resetAt: number }>} buckets
 * @returns {boolean} true if allowed
 */
export function allowRateLimit(buckets, key, maxEvents, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
  }
  b.count += 1;
  buckets.set(key, b);
  return b.count <= maxEvents;
}

/**
 * True when the key is already at/over the limit (does not increment).
 * Use before expensive work (e.g. bcrypt), then call allowRateLimit only on failure.
 */
export function isRateLimited(buckets, key, maxEvents, _windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) return false;
  return b.count >= maxEvents;
}

export const skipAuthedRateLimit =
  process.env.VITEST === 'true' ||
  process.env.NODE_ENV === 'test' ||
  process.env.ZAREWA_TEST_SKIP_RATE_LIMIT === '1';
