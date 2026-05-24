import { readAiAssistConfig } from './aiAssist.js';
import { HELP_ARTICLES } from '../shared/lib/helpKnowledge.js';
import {
  aggregateKnowledgeGaps,
  buildSuggestedArticleDrafts,
  listLowHelpfulnessArticles,
  listSuggestedArticleDrafts,
} from '../shared/lib/helpGapAnalysis.js';
import { RUNA_DESIGN_LIMITS } from '../shared/lib/helpDesignLimits.js';

export function getRunaIntelligenceDashboard(db, opts = {}) {
  const days = opts.days ?? 30;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString();

  const out = {
    articleCount: HELP_ARTICLES.length,
    ai: readAiAssistConfig(),
    periodDays: days,
    designLimits: RUNA_DESIGN_LIMITS,
    queryVolume: 0,
    helpfulRate: null,
    avgResponseMs: 0,
    fallbackCount: 0,
    topQuestions: [],
    knowledgeGaps: [],
    lowHelpfulnessArticles: [],
    suggestedArticles: [],
    branchIssues: [],
  };

  if (!db) return out;

  try {
    if (!db.prepare(`PRAGMA table_info(help_query_log)`).all().length) return out;

    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN feedback = 'helpful' THEN 1 ELSE 0 END) AS helpful,
                SUM(CASE WHEN feedback = 'not_helpful' THEN 1 ELSE 0 END) AS bad,
                AVG(response_ms) AS avg_ms,
                SUM(CASE WHEN source = 'fallback' OR top_score < 4 THEN 1 ELSE 0 END) AS fallback
         FROM help_query_log WHERE occurred_at_iso >= ?`
      )
      .get(sinceIso);

    out.queryVolume = Number(stats?.total) || 0;
    const helpful = Number(stats?.helpful) || 0;
    const bad = Number(stats?.bad) || 0;
    if (helpful + bad > 0) out.helpfulRate = Math.round((helpful / (helpful + bad)) * 100) / 100;
    out.avgResponseMs = Math.round(Number(stats?.avg_ms) || 0);
    out.fallbackCount = Number(stats?.fallback) || 0;

    out.topQuestions = db
      .prepare(
        `SELECT query_text, COUNT(*) AS c FROM help_query_log
         WHERE occurred_at_iso >= ? GROUP BY LOWER(TRIM(query_text)) ORDER BY c DESC LIMIT 10`
      )
      .all(sinceIso);

    out.knowledgeGaps = aggregateKnowledgeGaps(db, { days, branchId: opts.branchId, limit: 15 });
    out.lowHelpfulnessArticles = listLowHelpfulnessArticles(db, { days: days * 2 });
    out.suggestedArticles = listSuggestedArticleDrafts(db, { status: 'pending', limit: 15 });

    out.branchIssues = db
      .prepare(
        `SELECT branch_id, COUNT(*) AS c,
                SUM(CASE WHEN feedback = 'not_helpful' THEN 1 ELSE 0 END) AS bad
         FROM help_query_log
         WHERE occurred_at_iso >= ? AND branch_id IS NOT NULL
         GROUP BY branch_id ORDER BY bad DESC, c DESC LIMIT 10`
      )
      .all(sinceIso);
  } catch (e) {
    out.error = String(e?.message || e);
  }

  return out;
}

export function logHelpAiObservation(db, obs) {
  if (!db) return;
  try {
    if (!db.prepare(`PRAGMA table_info(help_ai_observations)`).all().length) return;
  } catch {
    return;
  }
  const id = `ho-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO help_ai_observations (id, occurred_at_iso, user_id, branch_id, route, query_text, source, response_ms, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    new Date().toISOString(),
    obs.userId || null,
    obs.branchId || null,
    obs.route || null,
    String(obs.queryText || '').slice(0, 500),
    obs.source || null,
    Number(obs.responseMs) || 0,
    JSON.stringify(obs.payload || {})
  );
}
