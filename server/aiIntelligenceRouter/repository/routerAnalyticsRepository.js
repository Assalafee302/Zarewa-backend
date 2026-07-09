/**
 * AI Intelligence Router — query analytics persistence.
 *
 * @module server/aiIntelligenceRouter/repository/routerAnalyticsRepository
 */

/**
 * @param {import('better-sqlite3').Database} db
 */
export function ensureRouterAnalyticsTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_router_query_log (
      id TEXT PRIMARY KEY,
      occurred_at_iso TEXT NOT NULL,
      user_id TEXT,
      query_text TEXT NOT NULL,
      intent TEXT NOT NULL,
      route_used TEXT NOT NULL,
      mode TEXT NOT NULL,
      confidence REAL,
      intent_confidence REAL,
      search_confidence REAL,
      result_count INTEGER NOT NULL DEFAULT 0,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      module TEXT,
      response_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_router_log_time ON ai_router_query_log(occurred_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_router_log_intent ON ai_router_query_log(intent, occurred_at_iso DESC);
  `);
}

/**
 * @returns {string}
 */
export function newRouterLogId() {
  return `AIR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 */
export function insertRouterQueryLog(db, row) {
  ensureRouterAnalyticsTables(db);
  db.prepare(
    `INSERT INTO ai_router_query_log (
      id, occurred_at_iso, user_id, query_text, intent, route_used, mode,
      confidence, intent_confidence, search_confidence, result_count,
      fallback_used, module, response_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id || newRouterLogId(),
    row.occurredAt || new Date().toISOString(),
    row.userId || null,
    String(row.queryText || '').slice(0, 2000),
    String(row.intent || 'UNKNOWN'),
    String(row.routeUsed || 'unknown'),
    String(row.mode || 'fallback'),
    row.confidence ?? null,
    row.intentConfidence ?? null,
    row.searchConfidence ?? null,
    Number(row.resultCount) || 0,
    row.fallbackUsed ? 1 : 0,
    row.module || null,
    row.responseMs ?? null
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} [days]
 */
export function getRouterAnalytics(db, days = 30) {
  ensureRouterAnalyticsTables(db);
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();

  const total = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM ai_router_query_log WHERE occurred_at_iso >= ?`).get(since)?.c
  ) || 0;

  const intentRows = db
    .prepare(
      `SELECT intent, COUNT(*) AS c FROM ai_router_query_log
       WHERE occurred_at_iso >= ? GROUP BY intent ORDER BY c DESC`
    )
    .all(since);

  const moduleRows = db
    .prepare(
      `SELECT module, COUNT(*) AS c FROM ai_router_query_log
       WHERE occurred_at_iso >= ? AND module IS NOT NULL
       GROUP BY module ORDER BY c DESC LIMIT 10`
    )
    .all(since);

  const agg = db
    .prepare(
      `SELECT
         AVG(confidence) AS avgConfidence,
         SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) AS fallbackCount,
         AVG(response_ms) AS avgResponseMs
       FROM ai_router_query_log WHERE occurred_at_iso >= ?`
    )
    .get(since);

  const fallbackRate = total ? (Number(agg?.fallbackCount) || 0) / total : 0;

  return {
    days,
    totalQueries: total,
    intentDistribution: intentRows.map((r) => ({
      intent: String(r.intent),
      count: Number(r.c) || 0,
    })),
    mostUsedModules: moduleRows.map((r) => ({
      module: String(r.module),
      count: Number(r.c) || 0,
    })),
    averageConfidence: Number(agg?.avgConfidence) || 0,
    fallbackRate,
    averageResponseMs: Math.round(Number(agg?.avgResponseMs) || 0),
  };
}
