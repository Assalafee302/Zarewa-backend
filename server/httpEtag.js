import crypto from 'node:crypto';

/**
 * Weak ETag for JSON API payloads (matches dashboard summary pattern).
 * @param {unknown} payload
 */
export function jsonWeakEtag(payload) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 32);
  return `W/"${hash}"`;
}

/**
 * @param {import('express').Request} req
 * @param {string} etag
 */
export function ifNoneMatchHit(req, etag) {
  const client = String(req.headers['if-none-match'] || '').trim();
  return client !== '' && client === etag;
}

/**
 * @param {import('express').Response} res
 * @param {string} etag
 */
export function setWeakEtag(res, etag) {
  res.setHeader('ETag', etag);
}
