/**
 * Additive write-response deltas so the SPA can merge the changed row without
 * waiting for a full domain snapshot. Peers still invalidate via workspace.data.
 */

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown[] | undefined>} bags
 */
export function withWriteDelta(payload, bags) {
  if (!payload || typeof payload !== 'object') return payload;
  /** @type {Record<string, unknown[]>} */
  const delta = {};
  for (const [key, rows] of Object.entries(bags || {})) {
    if (!Array.isArray(rows) || !rows.length) continue;
    delta[key] = rows.filter(Boolean);
  }
  if (!Object.keys(delta).length) return payload;
  return { ...payload, delta };
}
