/**
 * Ranked recommendations for Zare's "Try asking" area.
 */
import { HELP_ARTICLES, quickQuestionsForPath } from './helpKnowledge.js';
import { mergePersonalizedPrompts, buildHelpCoachingHints } from './helpRecommend.js';
import { buildTransactionCoachingHints } from './helpUserActivity.js';
import { readHelpMemory } from './helpMemory.js';
import { userMaySeeArticle } from './helpDesignLimits.js';

/**
 * @param {{
 *   pathname?: string;
 *   roleKey?: string;
 *   branchId?: string;
 *   learnedBoosts?: Record<string, number>;
 *   memoryBoosts?: Record<string, number>;
 *   transactionProfile?: object;
 *   snapshot?: object;
 *   branchMemory?: object;
 *   workflowEvents?: { signalKey?: string; articleId?: string; weight?: number }[];
 *   prompts?: { label: string; query: string }[];
 *   user?: { permissions?: string[]; roleKey?: string };
 * }} ctx
 */
export function rankZareRecommendations(ctx = {}) {
  const user = ctx.user;
  /** @type {Map<string, { id: string; title: string; query: string; reason?: string; score: number }>} */
  const ranked = new Map();
  const pathname = String(ctx.pathname || '/');

  const add = (id, title, query, score, reason, articleId) => {
    if (articleId && user && !userMaySeeArticle(articleId, user)) return;
    const key = String(id || title);
    const prev = ranked.get(key);
    if (!prev || score > prev.score) {
      ranked.set(key, { id: key, title, query, reason, score });
    }
  };

  for (const p of ctx.prompts ||
    mergePersonalizedPrompts(quickQuestionsForPath(pathname), [], ctx.learnedBoosts || {}, pathname)) {
    add(`prompt-${p.label}`, p.label, p.query, 10, 'Suggested for this page');
  }

  for (const h of buildHelpCoachingHints(ctx.snapshot, pathname)) {
    add(h.id, h.title, h.query, 11, h.reason);
  }

  for (const h of buildTransactionCoachingHints(ctx.transactionProfile)) {
    add(h.id, h.title, h.query, 9 + (h.weight || 0) / 3, h.reason);
  }

  for (const ev of ctx.workflowEvents || []) {
    if (!ev.articleId) continue;
    const article = HELP_ARTICLES.find((a) => a.id === ev.articleId);
    if (!article) continue;
    add(
      `wf-${ev.signalKey}`,
      article.title,
      `Help me with: ${article.title}`,
      8 + (Number(ev.weight) || 1) * 2,
      ev.signalKey?.replace(/_/g, ' '),
      ev.articleId
    );
  }

  const branchMem = ctx.branchMemory || {};
  for (const [articleId, weight] of Object.entries(branchMem.articleBoosts || {})) {
    const article = HELP_ARTICLES.find((a) => a.id === articleId);
    if (!article) continue;
    add(
      `branch-${articleId}`,
      article.title,
      `Explain: ${article.title}`,
      7 + Number(weight),
      'Common in your branch',
      articleId
    );
  }

  for (const [articleId, boost] of Object.entries(ctx.memoryBoosts || {})) {
    const article = HELP_ARTICLES.find((a) => a.id === articleId);
    if (!article) continue;
    add(
      `mem-${articleId}`,
      article.title,
      `More on: ${article.title}`,
      6 + Number(boost),
      'You ask about this often',
      articleId
    );
  }

  return [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

/** @deprecated Use rankZareRecommendations */
export const rankRunaRecommendations = rankZareRecommendations;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function loadBranchWorkflowHints(db, branchId) {
  if (!db || !branchId) return [];
  try {
    if (!db.prepare(`PRAGMA table_info(help_workflow_events)`).all().length) return [];
    const rows = db
      .prepare(
        `SELECT signal_key AS signalKey, payload_json AS payloadJson, weight
         FROM help_workflow_events
         WHERE branch_id = ? OR branch_id IS NULL
         ORDER BY occurred_at_iso DESC
         LIMIT 20`
      )
      .all(String(branchId));
    return rows.map((r) => {
      let articleId = null;
      try {
        articleId = JSON.parse(String(r.payloadJson || '{}')).articleId;
      } catch {
        articleId = null;
      }
      return { signalKey: r.signalKey, articleId, weight: r.weight };
    });
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function loadBranchMemoryPatterns(db, branchId) {
  return readHelpMemory(db, 'branch', branchId, 'workflow_patterns') || {};
}
