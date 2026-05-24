/**
 * Knowledge gap detection and suggested article drafts (admin review only).
 */
import { fingerprintHelpQuery } from './helpSelfTrain.js';
import { HELP_ARTICLES } from './helpKnowledge.js';

function hasGapTable(db) {
  try {
    return db.prepare(`PRAGMA table_info(help_knowledge_gaps)`).all().length > 0;
  } catch {
    return false;
  }
}

export function recordKnowledgeGap(db, opts) {
  if (!db || !hasGapTable(db)) return;
  const text = String(opts.queryText || '').trim().slice(0, 500);
  if (!text) return;
  const fp = fingerprintHelpQuery(text);
  const branchId = opts.branchId ? String(opts.branchId) : null;
  const at = new Date().toISOString();

  const existing = db
    .prepare(
      `SELECT id FROM help_knowledge_gaps
       WHERE query_fingerprint = ? AND IFNULL(branch_id,'') = IFNULL(?, '')`
    )
    .get(fp, branchId);

  if (existing) {
    db.prepare(
      `UPDATE help_knowledge_gaps SET
         hit_count = hit_count + 1,
         not_helpful_count = not_helpful_count + ?,
         query_text = ?,
         last_at_iso = ?
       WHERE id = ?`
    ).run(opts.notHelpful ? 1 : 0, text, at, existing.id);
    return;
  }

  const id = `gap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO help_knowledge_gaps (
      id, query_fingerprint, query_text, hit_count, not_helpful_count, branch_id, last_at_iso, status
    ) VALUES (?, ?, ?, 1, ?, ?, ?, 'open')`
  ).run(id, fp, text, opts.notHelpful ? 1 : 0, branchId, at);
}

export function aggregateKnowledgeGaps(db, opts = {}) {
  if (!db) return [];
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (opts.days ?? 30));

  try {
    let sql = `
      SELECT query_text, COUNT(*) AS c,
             SUM(CASE WHEN feedback = 'not_helpful' THEN 1 ELSE 0 END) AS not_helpful,
             branch_id
      FROM help_query_log
      WHERE occurred_at_iso >= ?
        AND (source = 'fallback' OR top_score < 4 OR feedback = 'not_helpful')
    `;
    const args = [since.toISOString()];
    if (opts.branchId) {
      sql += ` AND branch_id = ?`;
      args.push(String(opts.branchId));
    }
    sql += ` GROUP BY LOWER(TRIM(query_text)), branch_id ORDER BY c DESC LIMIT ?`;
    args.push(Math.min(50, opts.limit ?? 25));
    const rows = db.prepare(sql).all(...args);

    for (const row of rows) {
      recordKnowledgeGap(db, {
        queryText: row.query_text,
        branchId: row.branch_id,
        notHelpful: Number(row.not_helpful) > 0,
      });
    }

    if (!hasGapTable(db)) return rows;

    return db
      .prepare(
        `SELECT query_text, hit_count, not_helpful_count, branch_id, last_at_iso, status
         FROM help_knowledge_gaps WHERE status = 'open'
         ORDER BY hit_count DESC, not_helpful_count DESC LIMIT ?`
      )
      .all(Math.min(50, opts.limit ?? 25));
  } catch {
    return [];
  }
}

export function buildSuggestedArticleDrafts(db, opts = {}) {
  if (!db) return [];
  try {
    if (!db.prepare(`PRAGMA table_info(help_suggested_articles)`).all().length) return [];
  } catch {
    return [];
  }

  const gaps = aggregateKnowledgeGaps(db, { limit: opts.limit ?? 10 });
  const out = [];
  for (const g of gaps.slice(0, 5)) {
    const q = String(g.query_text || '').trim();
    if (!q) continue;
    const title = `How to: ${q.slice(0, 60)}`;
    const draft = {
      title,
      keywords: q.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 8),
      answer: `Draft — staff asked: "${q}". Add authoritative Zarewa steps here.`,
      steps: ['Confirm the screen/module.', 'Document the procedure.', 'Add screen links.'],
      links: [],
    };
    const id = `suggest-${fingerprintHelpQuery(q)}`;
    if (!db.prepare(`SELECT id FROM help_suggested_articles WHERE id = ?`).get(id)) {
      db.prepare(
        `INSERT INTO help_suggested_articles (id, title, draft_json, reason, branch_id, hit_count, status, created_at_iso)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        id,
        title,
        JSON.stringify(draft),
        `Repeated question (${g.hit_count || 1} hits)`,
        g.branch_id || null,
        Number(g.hit_count) || 1,
        new Date().toISOString()
      );
    }
    out.push({ id, title, hitCount: g.hit_count, status: 'pending' });
  }
  return out;
}

export function listLowHelpfulnessArticles(db, opts = {}) {
  if (!db) return [];
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (opts.days ?? 60));
  try {
    const rows = db
      .prepare(
        `SELECT matched_article_ids_json AS ids,
                SUM(CASE WHEN feedback = 'helpful' THEN 1 ELSE 0 END) AS helpful,
                SUM(CASE WHEN feedback = 'not_helpful' THEN 1 ELSE 0 END) AS bad
         FROM help_query_log
         WHERE occurred_at_iso >= ? AND feedback IS NOT NULL
         GROUP BY matched_article_ids_json
         HAVING bad > helpful
         ORDER BY bad DESC LIMIT 15`
      )
      .all(since.toISOString());
    return rows.flatMap((r) => {
      let ids = [];
      try {
        ids = JSON.parse(String(r.ids || '[]'));
      } catch {
        ids = [];
      }
      return ids.map((id) => ({
        articleId: id,
        title: HELP_ARTICLES.find((a) => a.id === id)?.title || id,
        notHelpful: Number(r.bad),
        helpful: Number(r.helpful),
      }));
    });
  } catch {
    return [];
  }
}
