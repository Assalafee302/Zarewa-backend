/**
 * Practical learning layer — feedback weights and query→article ranking in app_json_blobs.
 * Not neural model training (see helpDesignLimits.js).
 */
import { assertPracticalLearningAllowed } from './helpDesignLimits.js';

const QUERY_WEIGHTS_BLOB = 'help.query_article_weights.v1';
const MAX_FINGERPRINTS = 400;

/**
 * @param {string} query
 * @returns {string}
 */
export function fingerprintHelpQuery(query) {
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  const unique = [...new Set(tokens)].sort();
  return unique.slice(0, 12).join('|') || 'empty';
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'what',
  'where',
  'when',
  'can',
  'you',
  'help',
  'with',
  'this',
  'that',
  'from',
  'have',
  'does',
  'about',
  'please',
  'need',
  'want',
]);

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} 0–1
 */
export function queryFingerprintSimilarity(a, b) {
  const ta = new Set(String(a || '').split('|').filter(Boolean));
  const tb = new Set(String(b || '').split('|').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  return inter / Math.max(ta.size, tb.size);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function loadQueryWeights(db) {
  try {
    const row = db.prepare(`SELECT payload_json FROM app_json_blobs WHERE key = ?`).get(QUERY_WEIGHTS_BLOB);
    if (!row?.payload_json) return { version: 1, entries: [] };
    const parsed = JSON.parse(String(row.payload_json));
    if (Array.isArray(parsed?.entries)) return parsed;
  } catch {
    /* fresh */
  }
  return { version: 1, entries: [] };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ version: number; entries: unknown[] }} data
 */
function saveQueryWeights(db, data) {
  const trimmed = {
    version: 1,
    entries: (data.entries || []).slice(-MAX_FINGERPRINTS),
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO app_json_blobs (key, payload_json, updated_at_iso)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, updated_at_iso = excluded.updated_at_iso`
  ).run(QUERY_WEIGHTS_BLOB, JSON.stringify(trimmed), new Date().toISOString());
}

/**
 * Reinforce or weaken query→article mapping from user feedback (online learning).
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   queryText: string;
 *   articleIds?: string[];
 *   feedback: 'helpful' | 'not_helpful';
 *   branchId?: string | null;
 *   userId?: string | null;
 * }} opts
 */
export function trainHelpFromFeedback(db, opts) {
  assertPracticalLearningAllowed('trainHelpFromFeedback');
  if (!db || !opts?.queryText) return;
  const fp = fingerprintHelpQuery(opts.queryText);
  if (fp === 'empty') return;
  const ids = Array.isArray(opts.articleIds) ? opts.articleIds.filter(Boolean) : [];
  if (!ids.length) return;

  const delta = opts.feedback === 'helpful' ? 3 : -2;
  const store = loadQueryWeights(db);
  /** @type {{ fingerprint: string; branchId?: string; articles: Record<string, number>; hits: number; lastAt: string } | undefined} */
  let entry = store.entries.find(
    (e) => e.fingerprint === fp && (e.branchId || '') === String(opts.branchId || '')
  );

  if (!entry) {
    entry = {
      fingerprint: fp,
      branchId: opts.branchId ? String(opts.branchId) : undefined,
      articles: {},
      hits: 0,
      lastAt: new Date().toISOString(),
    };
    store.entries.push(entry);
  }

  entry.hits = (entry.hits || 0) + 1;
  entry.lastAt = new Date().toISOString();
  for (const id of ids) {
    const key = String(id);
    entry.articles[key] = Math.max(-5, Math.min(15, (entry.articles[key] || 0) + delta));
  }

  saveQueryWeights(db, store);
}

/**
 * Aggregate self-training boosts for the current query (retrieval-time learning).
 * @param {import('better-sqlite3').Database} db
 * @param {string} queryText
 * @param {{ branchId?: string | null; minSimilarity?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function computeQueryLearnedBoosts(db, queryText, opts = {}) {
  if (!db) return {};
  const fp = fingerprintHelpQuery(queryText);
  if (fp === 'empty') return {};
  const minSim = Number(opts.minSimilarity) || 0.35;
  const branchId = String(opts.branchId || '').trim();
  const store = loadQueryWeights(db);

  /** @type {Record<string, number>} */
  const boosts = {};

  for (const entry of store.entries || []) {
    if (branchId && entry.branchId && entry.branchId !== branchId) continue;
    const sim = queryFingerprintSimilarity(fp, entry.fingerprint);
    if (sim < minSim) continue;
    const scale = sim * Math.min(2, Math.log10((entry.hits || 1) + 1));
    for (const [articleId, weight] of Object.entries(entry.articles || {})) {
      if (Number(weight) <= 0) continue;
      boosts[articleId] = Math.max(boosts[articleId] || 0, Number(weight) * scale);
    }
  }

  return boosts;
}

/**
 * Batch train from historical helpful logs (self-training without new feedback).
 * @param {import('better-sqlite3').Database} db
 * @param {{ days?: number; limit?: number }} [opts]
 */
export function retrainHelpFromQueryLog(db, opts = {}) {
  assertPracticalLearningAllowed('retrainHelpFromQueryLog');
  if (!db) return 0;
  let rows = [];
  try {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (opts.days ?? 60));
    rows = db
      .prepare(
        `SELECT query_text, matched_article_ids_json, branch_id, feedback
         FROM help_query_log
         WHERE occurred_at_iso >= ?
           AND feedback = 'helpful'
           AND source IN ('kb', 'api', 'ai', 'synth')
         ORDER BY occurred_at_iso DESC
         LIMIT ?`
      )
      .all(since.toISOString(), Math.min(500, opts.limit ?? 200));
  } catch {
    return 0;
  }

  let count = 0;
  for (const row of rows) {
    let ids = [];
    try {
      ids = JSON.parse(String(row.matched_article_ids_json || '[]'));
    } catch {
      ids = [];
    }
    if (!ids.length) continue;
    trainHelpFromFeedback(db, {
      queryText: String(row.query_text || ''),
      articleIds: ids,
      feedback: 'helpful',
      branchId: row.branch_id,
    });
    count += 1;
  }
  return count;
}
