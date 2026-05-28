/**
 * Permission-safe daily briefing lines for Zare (counts and categories only).
 */

/**
 * @param {Record<string, unknown>|null|undefined} snapshot
 * @param {string} [roleKey]
 * @returns {string[]}
 */
export function buildZareDailyBriefing(snapshot, roleKey = '') {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const role = String(roleKey || '').toLowerCase();
  const lines = [];

  const items = Array.isArray(snapshot.unifiedWorkItems) ? snapshot.unifiedWorkItems : [];
  const needsAction = items.filter((i) => i?.requiresApproval || i?.requiresResponse || i?.status === 'pending');
  const overdue = items.filter((i) => i?.slaState === 'overdue' || i?.isOverdue);
  const unfiled = items.filter((i) => i?.filingStatus === 'unfiled' || i?.unfiled);

  if (needsAction.length) {
    lines.push(`${needsAction.length} item${needsAction.length === 1 ? '' : 's'} require your action.`);
  }
  if (overdue.length) {
    lines.push(`${overdue.length} overdue item${overdue.length === 1 ? '' : 's'} need attention.`);
  }
  if (unfiled.length) {
    lines.push(`${unfiled.length} memo${unfiled.length === 1 ? '' : 's'} remain unfiled.`);
  }

  const attn = snapshot.operationsInventoryAttention;
  if (attn && typeof attn === 'object') {
    const stuck = Number(attn.stuckProductionAttentionDistinctJobCount) || 0;
    if (stuck > 0) lines.push(`${stuck} production job${stuck === 1 ? '' : 's'} may be delayed.`);
    const inTransit = Number(attn.crossModule?.openInTransitLoadCount) || 0;
    if (inTransit > 0) lines.push(`${inTransit} in-transit load${inTransit === 1 ? '' : 's'} open.`);
  }

  const metrics = snapshot.productionMetrics;
  if (metrics?.byStatus) {
    const pending = Number(metrics.byStatus.pending || metrics.byStatus.Pending || 0);
    if (pending > 0 && (role.includes('operation') || role.includes('manager'))) {
      lines.push(`${pending} production job${pending === 1 ? '' : 's'} pending start.`);
    }
  }

  if (role.includes('finance') || role.includes('manager') || role === 'admin' || role === 'md') {
    const financeItems = needsAction.filter((i) => {
      const t = String(i?.documentType || i?.category || '').toLowerCase();
      return t.includes('payment') || t.includes('expense') || t.includes('receipt') || t.includes('refund');
    });
    if (financeItems.length >= 3) {
      lines.push(`${financeItems.length} finance/payment items in your queue.`);
    }
  }

  if (role.includes('procurement')) {
    const poItems = needsAction.filter((i) => String(i?.documentType || '').toLowerCase().includes('procurement'));
    if (poItems.length) lines.push(`${poItems.length} procurement item${poItems.length === 1 ? '' : 's'} awaiting action.`);
  }

  const office = snapshot.officeSummary;
  if (office && Number(office.unreadApprox) > 0) {
    lines.push(`${office.unreadApprox} memo${office.unreadApprox === 1 ? '' : 's'} need replies.`);
  }

  return lines.slice(0, 6);
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
export function formatZareBriefingReply(lines) {
  if (!lines.length) return '';
  const body = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return `**Today's briefing** (permission-safe counts only):\n\n${body}\n\nAsk me about any line for next steps.`;
}
