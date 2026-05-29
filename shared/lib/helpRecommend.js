import { ensureHelpArticles, quickQuestionsForPath } from './helpKnowledge.js';

/**
 * @param {typeof HELP_QUICK_QUESTIONS[number][]} base
 * @param {typeof HELP_QUICK_QUESTIONS[number][]} rolePrompts
 * @param {Record<string, number>} learnedBoosts
 * @param {string} pathname
 */
export function mergePersonalizedPrompts(base, rolePrompts, learnedBoosts, pathname) {
  /** @type {Map<string, { label: string; query: string; score: number }>} */
  const merged = new Map();

  const add = (item, score) => {
    const label = String(item?.label || '').trim();
    const query = String(item?.query || '').trim();
    if (!label || !query) return;
    const prev = merged.get(label);
    if (!prev || score > prev.score) merged.set(label, { label, query, score });
  };

  for (const p of base || quickQuestionsForPath(pathname)) add(p, 10);
  for (const p of rolePrompts || []) add(p, 12);

  const boostedArticles = Object.entries(learnedBoosts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  for (const [articleId, boost] of boostedArticles) {
    const article = ensureHelpArticles().find((a) => a.id === articleId);
    if (!article) continue;
    add({ label: article.title.slice(0, 42), query: `Explain: ${article.title}` }, 8 + boost);
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ label, query }) => ({ label, query }));
}

/**
 * Surface proactive hints from bootstrap snapshot metrics (no external AI).
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @param {string} [pathname]
 * @returns {{ id: string; title: string; query: string; reason: string }[]}
 */
export function buildHelpCoachingHints(snapshot, pathname) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  /** @type {{ id: string; title: string; query: string; reason: string; weight: number }[]} */
  const hints = [];

  const pushHint = (articleId, reason, weight) => {
    const article = ensureHelpArticles().find((a) => a.id === articleId);
    if (!article) return;
    hints.push({
      id: articleId,
      title: article.title,
      query: `Help me with: ${article.title}`,
      reason,
      weight,
    });
  };

  const attn = snapshot.operationsInventoryAttention;
  if (attn && typeof attn === 'object') {
    const stuck = Number(attn.stuckProductionAttentionDistinctJobCount) || 0;
    if (stuck > 0) {
      pushHint('production-job-workflow', `${stuck} production job(s) flagged in Operations attention`, 11);
    }
    const inTransit = Number(attn.crossModule?.openInTransitLoadCount) || 0;
    if (inTransit > 0) {
      pushHint('procurement-full-workflow', `${inTransit} in-transit load(s) open`, 10);
    }
    const partialPo = Number(attn.crossModule?.partialPurchaseOrderCount) || 0;
    if (partialPo > 0) {
      pushHint('procurement-po', `${partialPo} partial PO(s) awaiting GRN or receipt`, 9);
    }
  }

  const metrics = snapshot.productionMetrics;
  if (metrics && typeof metrics === 'object') {
    const pending = Number(metrics.byStatus?.pending || metrics.byStatus?.Pending || 0);
    const running = Number(metrics.byStatus?.running || metrics.byStatus?.Running || 0);
    if (pending + running > 0) {
      pushHint('production-job-workflow', `${pending + running} production job(s) in queue`, 9);
    }
  }

  const refunds = Array.isArray(snapshot.refunds) ? snapshot.refunds : [];
  const openRefunds = refunds.filter((r) =>
    /pending|submitted|approved/i.test(String(r?.status || ''))
  ).length;
  if (openRefunds > 0) {
    pushHint('refund-approval-workflow', `${openRefunds} open refund(s)`, 8);
  }

  const p = String(pathname || '');
  if (p.startsWith('/sales') && openRefunds === 0) {
    pushHint('quote-to-cash-workflow', 'You are on Sales — review the full quote-to-cash path', 4);
  }

  const seen = new Set();
  return hints
    .sort((a, b) => b.weight - a.weight)
    .filter((h) => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    })
    .slice(0, 4)
    .map(({ id, title, query, reason }) => ({ id, title, query, reason }));
}
