/**
 * Resolve org manager targets with optional branch + quarter dimensions.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/managerOrgTargets.js
 *
 * Blob shape (org.manager_targets.v1 / manager_targets):
 * {
 *   nairaTargetPerMonth, meterTargetPerMonth,  // company monthly defaults
 *   byBranch: { [branchId]: { nairaTargetPerMonth, meterTargetPerMonth } },
 *   byQuarter: { [YYYY-Qn]: { nairaTargetPerMonth, meterTargetPerMonth } },
 *   byBranchQuarter: { [`branchId:YYYY-Qn`]: { nairaTargetPerMonth, meterTargetPerMonth } }
 * }
 */

/**
 * @param {Date} [d]
 * @returns {string} e.g. 2026-Q3
 */
export function quarterKeyFromDate(d = new Date()) {
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

/**
 * Merge branch/quarter patches into the targets blob without wiping company defaults.
 * Empty branch/quarter layers are not written (would clobber a prior layer with `{}`).
 * @param {object} prev
 * @param {object} body
 */
export function mergeManagerTargetsBlob(prev, body) {
  const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
  if (Object.prototype.hasOwnProperty.call(body, 'nairaTargetPerMonth')) {
    const n = Number(body.nairaTargetPerMonth);
    if (Number.isFinite(n) && n > 0) next.nairaTargetPerMonth = n;
    else delete next.nairaTargetPerMonth;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'meterTargetPerMonth')) {
    const m = Number(body.meterTargetPerMonth);
    if (Number.isFinite(m) && m > 0) next.meterTargetPerMonth = m;
    else delete next.meterTargetPerMonth;
  }
  if (body.byBranch && typeof body.byBranch === 'object') {
    next.byBranch = { ...(next.byBranch || {}), ...body.byBranch };
  }
  if (body.byQuarter && typeof body.byQuarter === 'object') {
    next.byQuarter = { ...(next.byQuarter || {}), ...body.byQuarter };
  }
  if (body.byBranchQuarter && typeof body.byBranchQuarter === 'object') {
    next.byBranchQuarter = { ...(next.byBranchQuarter || {}), ...body.byBranchQuarter };
  }
  if (body.branchId && (body.nairaTargetPerMonth != null || body.meterTargetPerMonth != null)) {
    const bid = String(body.branchId).trim();
    const qk = String(body.quarterKey || '').trim();
    const layer = {};
    if (Number(body.nairaTargetPerMonth) > 0) layer.nairaTargetPerMonth = Number(body.nairaTargetPerMonth);
    if (Number(body.meterTargetPerMonth) > 0) layer.meterTargetPerMonth = Number(body.meterTargetPerMonth);
    if (Object.keys(layer).length) {
      if (qk) {
        next.byBranchQuarter = { ...(next.byBranchQuarter || {}), [`${bid}:${qk}`]: layer };
      } else {
        next.byBranch = { ...(next.byBranch || {}), [bid]: { ...(next.byBranch?.[bid] || {}), ...layer } };
      }
    }
  }
  return next;
}

/**
 * @param {object | null | undefined} targets
 * @param {{ branchId?: string, quarterKey?: string }} [scope]
 */
export function resolveManagerTargets(targets, scope = {}) {
  const t = targets && typeof targets === 'object' ? targets : {};
  const branchId = String(scope.branchId || '').trim();
  const quarterKey = String(scope.quarterKey || '').trim();
  const branchQuarterKey = branchId && quarterKey ? `${branchId}:${quarterKey}` : '';

  const pick = (...layers) => {
    let naira;
    let metre;
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object') continue;
      if (naira == null && Number(layer.nairaTargetPerMonth) > 0) naira = Number(layer.nairaTargetPerMonth);
      if (metre == null && Number(layer.meterTargetPerMonth) > 0) metre = Number(layer.meterTargetPerMonth);
    }
    return { nairaTargetPerMonth: naira ?? null, meterTargetPerMonth: metre ?? null };
  };

  const byBq = branchQuarterKey ? t.byBranchQuarter?.[branchQuarterKey] : null;
  const byQ = quarterKey ? t.byQuarter?.[quarterKey] : null;
  const byB = branchId ? t.byBranch?.[branchId] : null;
  const resolved = pick(byBq, byB, byQ, t);
  let source = 'company';
  if (byBq && (Number(byBq.nairaTargetPerMonth) > 0 || Number(byBq.meterTargetPerMonth) > 0)) source = 'branch_quarter';
  else if (byB && (Number(byB.nairaTargetPerMonth) > 0 || Number(byB.meterTargetPerMonth) > 0)) source = 'branch';
  else if (byQ && (Number(byQ.nairaTargetPerMonth) > 0 || Number(byQ.meterTargetPerMonth) > 0)) source = 'quarter';
  return { ...resolved, source, quarterKey: quarterKey || null, branchId: branchId || null };
}
