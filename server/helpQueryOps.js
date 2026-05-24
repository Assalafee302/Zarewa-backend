import {
  HELP_ARTICLES,
  quickQuestionsForPath,
  buildHelpSearchText,
  matchHelpArticles,
} from '../shared/lib/helpKnowledge.js';
import { buildHelpCoachingHints, mergePersonalizedPrompts } from '../shared/lib/helpRecommend.js';

const LEARNED_BOOSTS_BLOB = 'help.learned_boosts.v1';

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, Number(days) || 90));
  return d.toISOString();
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function hasHelpQueryLogTable(db) {
  try {
    return db.prepare(`PRAGMA table_info(help_query_log)`).all().length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   userId?: string | null;
 *   branchId?: string | null;
 *   roleKey?: string | null;
 *   pathname?: string | null;
 *   queryText: string;
 *   matchedArticleIds?: string[];
 *   source: string;
 *   topScore?: number;
 *   responseChars?: number;
 * }} row
 */
export function insertHelpQueryLog(db, row) {
  if (!hasHelpQueryLogTable(db)) return;
  const id = `hq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO help_query_log (
      id, occurred_at_iso, user_id, branch_id, role_key, pathname, query_text,
      matched_article_ids_json, source, top_score, response_chars
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    at,
    row.userId ? String(row.userId) : null,
    row.branchId ? String(row.branchId) : null,
    row.roleKey ? String(row.roleKey) : null,
    row.pathname ? String(row.pathname).slice(0, 200) : null,
    String(row.queryText || '').slice(0, 2000),
    JSON.stringify(Array.isArray(row.matchedArticleIds) ? row.matchedArticleIds : []),
    String(row.source || 'unknown').slice(0, 32),
    Number(row.topScore) || 0,
    Math.max(0, Math.round(Number(row.responseChars) || 0))
  );
}

/**
 * Aggregate successful KB matches into per-article boost weights (pattern learning).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; days?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function computeHelpLearnedBoosts(db, opts = {}) {
  if (!hasHelpQueryLogTable(db)) return {};
  const since = isoDaysAgo(opts.days ?? 90);
  const branchId = opts.branchId ? String(opts.branchId).trim() : '';
  let sql = `
    SELECT matched_article_ids_json AS ids_json, COUNT(*) AS hits
    FROM help_query_log
    WHERE occurred_at_iso >= ?
      AND source IN ('kb', 'api')
      AND top_score >= 5
  `;
  const args = [since];
  if (branchId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  sql += ` GROUP BY matched_article_ids_json ORDER BY hits DESC LIMIT 200`;

  /** @type {Record<string, number>} */
  const boosts = {};
  const rows = db.prepare(sql).all(...args);
  for (const row of rows) {
    let ids = [];
    try {
      ids = JSON.parse(String(row.ids_json || '[]'));
    } catch {
      ids = [];
    }
    const weight = Math.min(8, Math.log10(Number(row.hits) + 1) * 4);
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key) continue;
      boosts[key] = Math.max(boosts[key] || 0, weight);
    }
  }
  return boosts;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number; days?: number }} [opts]
 * @returns {string[]}
 */
export function listHelpKnowledgeGaps(db, opts = {}) {
  if (!hasHelpQueryLogTable(db)) return [];
  const since = isoDaysAgo(opts.days ?? 30);
  const limit = Math.min(20, Math.max(5, Number(opts.limit) || 10));
  const rows = db.prepare(
    `SELECT query_text, COUNT(*) AS c
     FROM help_query_log
     WHERE occurred_at_iso >= ?
       AND (source = 'fallback' OR top_score < 4)
     GROUP BY LOWER(TRIM(query_text))
     ORDER BY c DESC
     LIMIT ?`
  ).all(since, limit);
  return rows.map((r) => String(r.query_text || '').trim()).filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string; branchId?: string; roleKey?: string; pathname?: string }} ctx
 */
export function buildHelpPersonalization(db, ctx = {}) {
  const pathname = String(ctx.pathname || '/');
  const roleKey = String(ctx.roleKey || '').trim();
  const branchId = String(ctx.branchId || '').trim();
  const learnedBoosts = computeHelpLearnedBoosts(db, { branchId });
  const basePrompts = quickQuestionsForPath(pathname);
  const rolePrompts = roleQuickPrompts(roleKey);
  const prompts = mergePersonalizedPrompts(basePrompts, rolePrompts, learnedBoosts, pathname);
  const knowledgeGaps = listHelpKnowledgeGaps(db, { limit: 8 });
  return {
    prompts: prompts.slice(0, 8),
    learnedBoosts,
    knowledgeGaps,
    articleCount: HELP_ARTICLES.length,
    learningEnabled: hasHelpQueryLogTable(db),
  };
}

/**
 * Coaching hints from live workspace snapshot (performance / attention signals).
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @param {string} [pathname]
 */
export function buildHelpPersonalizationFromSnapshot(db, snapshot, ctx = {}) {
  const base = buildHelpPersonalization(db, ctx);
  const coachingHints = buildHelpCoachingHints(snapshot, ctx.pathname);
  return { ...base, coachingHints };
}

function roleQuickPrompts(roleKey) {
  switch (String(roleKey || '').trim()) {
    case 'sales_manager':
    case 'sales':
      return [
        { label: 'Payment threshold', query: 'How much payment is needed before cutting list?' },
        { label: 'Manager clearance', query: 'Customer hold or clearance — what do I do?' },
      ];
    case 'finance_manager':
    case 'finance':
      return [
        { label: 'Reconcile receipts', query: 'How do I match bank lines to customer receipts?' },
        { label: 'Unlock period', query: 'Accounting period locked — who can open it?' },
      ];
    case 'storekeeper':
    case 'operations':
      return [
        { label: 'GRN steps', query: 'How do I complete GRN when material arrives?' },
        { label: 'Production queue', query: 'Production job from cutting list to completion' },
      ];
    case 'procurement':
      return [{ label: 'PO approval', query: 'How do I create and approve a purchase order?' }];
    case 'admin':
    case 'md':
      return [{ label: 'Edit approvals', query: 'How do second approvals work for locked edits?' }];
    default:
      return [];
  }
}

/**
 * Refresh cached learned boosts (optional periodic job).
 * @param {import('better-sqlite3').Database} db
 */
export function refreshHelpLearnedBoostsBlob(db) {
  const boosts = computeHelpLearnedBoosts(db, { days: 120 });
  db.prepare(
    `INSERT INTO app_json_blobs (key, payload_json, updated_at_iso)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at_iso = excluded.updated_at_iso`
  ).run(LEARNED_BOOSTS_BLOB, JSON.stringify(boosts), new Date().toISOString());
  return boosts;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} message
 * @param {unknown[]} messages
 * @param {{ pathname?: string; branchId?: string; learnedBoosts?: Record<string, number> }} [opts]
 */
export function rankHelpArticlesWithLearning(db, message, messages, opts = {}) {
  const searchText = buildHelpSearchText(message, messages);
  let boosts = opts.learnedBoosts;
  if (!boosts || !Object.keys(boosts).length) {
    boosts = computeHelpLearnedBoosts(db, { branchId: opts.branchId });
  }
  return matchHelpArticles(searchText, {
    limit: 3,
    minScore: 4,
    pathname: opts.pathname,
    learnedBoosts: boosts,
  });
}
