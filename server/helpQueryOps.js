import {
  ensureHelpArticles,
  HELP_ARTICLE_COUNT,
  quickQuestionsForPath,
  buildHelpSearchText,
  matchHelpArticles,
} from '../shared/lib/helpKnowledge.js';
import {
  buildBehaviorCoachingNotes,
  classifyHelpReadingPace,
  promptForArticleId,
} from '../shared/lib/helpBehaviorLearn.js';
import {
  buildTransactionActivitySummary,
  buildTransactionCoachingHints,
  guideForErrorNote,
  guideForTransactionAction,
} from '../shared/lib/helpUserActivity.js';
import { buildHelpCoachingHints, mergePersonalizedPrompts } from '../shared/lib/helpRecommend.js';
import { computeQueryLearnedBoosts, trainHelpFromFeedback } from '../shared/lib/helpSelfTrain.js';
import {
  rankZareRecommendations,
  loadBranchWorkflowHints,
  loadBranchMemoryPatterns,
} from '../shared/lib/helpRecommendEngine.js';
import { buildZareDailyBriefing } from '../shared/lib/helpZareBriefing.js';
import { branchMemoryArticleBoosts, memoryArticleBoosts } from '../shared/lib/helpMemory.js';
import { filterPersonalizationForUser } from '../shared/lib/helpDesignLimits.js';
import { recordKnowledgeGap } from '../shared/lib/helpGapAnalysis.js';
import { readAiAssistConfig } from './aiAssist.js';

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

function hasAuditLogTable(db) {
  try {
    return db.prepare(`PRAGMA table_info(audit_log)`).all().length > 0;
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
 *   responseMs?: number;
 *   clientDraftMs?: number;
 *   sessionTurn?: number;
 * }} row
 * @returns {string | null}
 */
export function insertHelpQueryLog(db, row) {
  if (!hasHelpQueryLogTable(db)) return null;
  const id = `hq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO help_query_log (
      id, occurred_at_iso, user_id, branch_id, role_key, pathname, query_text,
      matched_article_ids_json, source, top_score, response_chars,
      response_ms, client_draft_ms, session_turn
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    Math.max(0, Math.round(Number(row.responseChars) || 0)),
    Math.max(0, Math.round(Number(row.responseMs) || 0)),
    Math.max(0, Math.round(Number(row.clientDraftMs) || 0)),
    Math.max(0, Math.round(Number(row.sessionTurn) || 0))
  );
  return id;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   logId: string;
 *   userId?: string | null;
 *   feedback?: 'helpful' | 'not_helpful' | null;
 *   readMs?: number;
 *   followUp?: boolean;
 *   linkClicked?: boolean;
 * }} opts
 */
export function recordHelpQuerySignal(db, opts) {
  if (!hasHelpQueryLogTable(db)) return false;
  const logId = String(opts?.logId || '').trim();
  if (!logId) return false;

  const row = db
    .prepare(
      `SELECT id, user_id, feedback, query_text, matched_article_ids_json, branch_id
       FROM help_query_log WHERE id = ?`
    )
    .get(logId);
  if (!row) return false;
  if (opts.userId && row.user_id && String(row.user_id) !== String(opts.userId)) return false;

  const sets = [];
  const args = [];
  if (opts.feedback === 'helpful' || opts.feedback === 'not_helpful') {
    sets.push('feedback = ?');
    args.push(opts.feedback);
  }
  if (Number(opts.readMs) > 0) {
    sets.push('read_ms = ?');
    args.push(Math.min(600_000, Math.round(Number(opts.readMs))));
  }
  if (opts.followUp) {
    sets.push('follow_up = 1');
  }
  if (opts.linkClicked) {
    sets.push('link_clicked = 1');
  }
  if (!sets.length) return false;

  db.prepare(`UPDATE help_query_log SET ${sets.join(', ')} WHERE id = ?`).run(...args, logId);

  if (opts.feedback === 'helpful' || opts.feedback === 'not_helpful') {
    let articleIds = [];
    try {
      articleIds = JSON.parse(String(row.matched_article_ids_json || '[]'));
    } catch {
      articleIds = [];
    }
    try {
      trainHelpFromFeedback(db, {
        queryText: String(row.query_text || ''),
        articleIds,
        feedback: opts.feedback,
        branchId: row.branch_id,
        userId: row.user_id,
      });
    } catch (e) {
      console.error('[zarewa] help self-train failed', e);
    }
    if (opts.feedback === 'not_helpful') {
      try {
        recordKnowledgeGap(db, {
          queryText: String(row.query_text || ''),
          branchId: row.branch_id,
          notHelpful: true,
        });
      } catch (e) {
        console.error('[zarewa] help gap record failed', e);
      }
    }
  }

  return true;
}

/**
 * @param {Record<string, number>} base
 * @param {Record<string, number>} extra
 * @returns {Record<string, number>}
 */
export function mergeLearnedBoostMaps(base, extra) {
  /** @type {Record<string, number>} */
  const out = { ...(base || {}) };
  for (const [id, weight] of Object.entries(extra || {})) {
    const key = String(id || '').trim();
    if (!key) continue;
    out[key] = Math.max(out[key] || 0, Number(weight) || 0);
  }
  return out;
}

/**
 * Aggregate successful KB matches into per-article boost weights (pattern learning).
 * Weights positive feedback higher and down-ranks articles marked not helpful.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; days?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function computeHelpLearnedBoosts(db, opts = {}) {
  if (!hasHelpQueryLogTable(db)) return {};
  const since = isoDaysAgo(opts.days ?? 90);
  const branchId = opts.branchId ? String(opts.branchId).trim() : '';
  let sql = `
    SELECT matched_article_ids_json AS ids_json,
           COUNT(*) AS hits,
           SUM(CASE WHEN feedback = 'helpful' THEN 3 WHEN feedback = 'not_helpful' THEN -2 ELSE 1 END) AS weight_sum
    FROM help_query_log
    WHERE occurred_at_iso >= ?
      AND source IN ('kb', 'api', 'ai', 'synth')
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
    const weightBase = Math.min(8, Math.log10(Number(row.hits) + 1) * 4);
    const feedbackAdj = Math.max(-3, Math.min(4, (Number(row.weight_sum) || 0) / Math.max(1, Number(row.hits))));
    const weight = Math.max(0.5, weightBase + feedbackAdj);
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key) continue;
      boosts[key] = Math.max(boosts[key] || 0, weight);
    }
  }
  return boosts;
}

/**
 * Per-user article boosts from their own help history and reactions.
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string | null; days?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function computeUserLearnedBoosts(db, opts = {}) {
  if (!hasHelpQueryLogTable(db)) return {};
  const userId = String(opts.userId || '').trim();
  if (!userId) return {};
  const since = isoDaysAgo(opts.days ?? 60);
  const rows = db.prepare(
    `SELECT matched_article_ids_json AS ids_json, feedback, follow_up, read_ms, top_score
     FROM help_query_log
     WHERE user_id = ? AND occurred_at_iso >= ?
     ORDER BY occurred_at_iso DESC
     LIMIT 120`
  ).all(userId, since);

  /** @type {Record<string, number>} */
  const boosts = {};
  for (const row of rows) {
    let ids = [];
    try {
      ids = JSON.parse(String(row.ids_json || '[]'));
    } catch {
      ids = [];
    }
    let weight = 2;
    if (row.feedback === 'helpful') weight += 4;
    if (row.feedback === 'not_helpful') weight -= 3;
    if (Number(row.follow_up) > 0) weight -= 1;
    if (Number(row.top_score) >= 8) weight += 1;
    const readMs = Number(row.read_ms) || 0;
    if (readMs > 45000) weight += 0.5;
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key) continue;
      boosts[key] = (boosts[key] || 0) + Math.max(0.5, weight);
    }
  }
  for (const key of Object.keys(boosts)) {
    boosts[key] = Math.min(10, boosts[key]);
  }
  return boosts;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string | null; branchId?: string | null; queryText?: string; days?: number }} [opts]
 */
export function computeMergedLearnedBoosts(db, opts = {}) {
  const branch = computeHelpLearnedBoosts(db, { branchId: opts.branchId, days: opts.days ?? 90 });
  const user = computeUserLearnedBoosts(db, { userId: opts.userId, days: opts.days ?? 60 });
  const query = opts.queryText
    ? computeQueryLearnedBoosts(db, opts.queryText, { branchId: opts.branchId })
    : {};
  const memUser = opts.userId ? memoryArticleBoosts(db, String(opts.userId)) : {};
  const memBranch = opts.branchId ? branchMemoryArticleBoosts(db, String(opts.branchId)) : {};
  return mergeLearnedBoostMaps(
    mergeLearnedBoostMaps(mergeLearnedBoostMaps(branch, user), query),
    mergeLearnedBoostMaps(memUser, memBranch)
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string | null; days?: number }} [opts]
 */
export function computeUserHelpBehaviorProfile(db, opts = {}) {
  const userId = String(opts.userId || '').trim();
  if (!hasHelpQueryLogTable(db) || !userId) {
    return {
      queryCount: 0,
      helpfulRate: null,
      followUpRate: 0,
      avgReadMs: 0,
      avgResponseMs: 0,
      pace: 'normal',
      topArticleIds: [],
      behaviorNotes: [],
    };
  }
  const since = isoDaysAgo(opts.days ?? 90);
  const rows = db.prepare(
    `SELECT feedback, follow_up, read_ms, response_ms, matched_article_ids_json
     FROM help_query_log
     WHERE user_id = ? AND occurred_at_iso >= ?
     ORDER BY occurred_at_iso DESC
     LIMIT 80`
  ).all(userId, since);

  let helpful = 0;
  let notHelpful = 0;
  let followUps = 0;
  let readSum = 0;
  let readCount = 0;
  let responseSum = 0;
  let responseCount = 0;
  /** @type {Record<string, number>} */
  const articleHits = {};

  for (const row of rows) {
    if (row.feedback === 'helpful') helpful += 1;
    if (row.feedback === 'not_helpful') notHelpful += 1;
    if (Number(row.follow_up) > 0) followUps += 1;
    if (Number(row.read_ms) > 0) {
      readSum += Number(row.read_ms);
      readCount += 1;
    }
    if (Number(row.response_ms) > 0) {
      responseSum += Number(row.response_ms);
      responseCount += 1;
    }
    let ids = [];
    try {
      ids = JSON.parse(String(row.matched_article_ids_json || '[]'));
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key) continue;
      articleHits[key] = (articleHits[key] || 0) + 1;
    }
  }

  const rated = helpful + notHelpful;
  const helpfulRate = rated > 0 ? helpful / rated : null;
  const followUpRate = rows.length ? followUps / rows.length : 0;
  const avgReadMs = readCount ? readSum / readCount : 0;
  const avgResponseMs = responseCount ? responseSum / responseCount : 0;
  const pace = classifyHelpReadingPace(avgReadMs);
  const topArticleIds = Object.entries(articleHits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
  const behaviorNotes = buildBehaviorCoachingNotes({ helpfulRate, followUpRate, pace });

  return {
    queryCount: rows.length,
    helpfulRate,
    followUpRate,
    avgReadMs: Math.round(avgReadMs),
    avgResponseMs: Math.round(avgResponseMs),
    pace,
    topArticleIds,
    behaviorNotes,
  };
}

/**
 * Track normal ERP transactions & performance: quotations, payments, refunds, corrections, errors.
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string | null; branchId?: string | null; days?: number }} [opts]
 */
export function computeUserTransactionProfile(db, opts = {}) {
  const userId = String(opts.userId || '').trim();
  const branchId = String(opts.branchId || '').trim();
  const days = Math.max(7, Number(opts.days) || 14);
  const empty = {
    periodDays: days,
    totals: {
      receiptsPosted: 0,
      paymentsRecorded: 0,
      refundsRequested: 0,
      quotationsTouched: 0,
      receiptCorrections: 0,
      auditFailures: 0,
      ledgerEntries: 0,
    },
    recentActions: [],
    recentErrors: [],
    workPace: null,
    performance: { level: 'low', actionsPerDay: 0 },
    suggestedGuides: [],
    activitySummary: [],
  };
  if (!userId) return empty;

  const since = isoDaysAgo(days);
  /** @type {typeof empty.totals} */
  const totals = { ...empty.totals };
  /** @type {{ action: string; count: number }[]} */
  const recentActions = [];
  /** @type {{ action: string; note: string; at: string; entityKind?: string; entityId?: string }[]} */
  const recentErrors = [];
  /** @type {{ articleId: string; title: string; reason: string; weight: number }[]} */
  const suggestedGuides = [];

  if (hasAuditLogTable(db)) {
    const actionRows = db
      .prepare(
        `SELECT action, COUNT(*) AS c
         FROM audit_log
         WHERE actor_user_id = ? AND occurred_at_iso >= ?
         GROUP BY action
         ORDER BY c DESC
         LIMIT 20`
      )
      .all(userId, since);
    for (const row of actionRows) {
      recentActions.push({ action: String(row.action || ''), count: Number(row.c) || 0 });
    }

    const failRows = db
      .prepare(
        `SELECT action, note, occurred_at_iso, entity_kind, entity_id, status
         FROM audit_log
         WHERE actor_user_id = ? AND occurred_at_iso >= ?
           AND LOWER(COALESCE(status, 'success')) NOT IN ('success', 'ok', 'completed', 'approved')
         ORDER BY occurred_at_iso DESC
         LIMIT 10`
      )
      .all(userId, since);
    for (const row of failRows) {
      totals.auditFailures += 1;
      recentErrors.push({
        action: String(row.action || ''),
        note: String(row.note || ''),
        at: String(row.occurred_at_iso || ''),
        entityKind: row.entity_kind ? String(row.entity_kind) : undefined,
        entityId: row.entity_id ? String(row.entity_id) : undefined,
      });
    }

    const correctionRows = db
      .prepare(
        `SELECT action, COUNT(*) AS c
         FROM audit_log
         WHERE actor_user_id = ? AND occurred_at_iso >= ?
           AND (
             action LIKE '%reverse%' OR action LIKE '%correct%' OR action LIKE '%delete%'
             OR action LIKE 'receipt.%' AND action LIKE '%reset%'
           )
         GROUP BY action`
      )
      .all(userId, since);
    for (const row of correctionRows) {
      totals.receiptCorrections += Number(row.c) || 0;
    }

    for (const { action, count } of recentActions) {
      if (action.includes('quotation')) totals.quotationsTouched += count;
      const map = guideForTransactionAction(action);
      if (!map) continue;
      const article = ensureHelpArticles().find((a) => a.id === map.articleId);
      if (!article) continue;
      suggestedGuides.push({
        articleId: map.articleId,
        title: article.title,
        reason: `${count}× ${map.label} in your recent work`,
        weight: 8 + Math.min(4, count),
      });
    }
  }

  try {
    const ledgerRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ledger_entries
         WHERE created_by_user_id = ? AND at_iso >= ?`
      )
      .get(userId, since);
    totals.ledgerEntries = Number(ledgerRow?.c) || 0;

    const receiptRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ledger_entries
         WHERE created_by_user_id = ? AND at_iso >= ?
           AND UPPER(type) LIKE '%RECEIPT%'`
      )
      .get(userId, since);
    totals.receiptsPosted = Number(receiptRow?.c) || 0;

    const advanceRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ledger_entries
         WHERE created_by_user_id = ? AND at_iso >= ?
           AND UPPER(type) LIKE '%ADVANCE%'`
      )
      .get(userId, since);
    totals.paymentsRecorded = totals.receiptsPosted + (Number(advanceRow?.c) || 0);
  } catch {
    /* ledger table optional in some modes */
  }

  try {
    let refundSql = `
      SELECT COUNT(*) AS c FROM customer_refunds
      WHERE requested_by_user_id = ? AND requested_at_iso >= ?
    `;
    const refundArgs = [userId, since];
    if (branchId) {
      refundSql += ` AND branch_id = ?`;
      refundArgs.push(branchId);
    }
    const refundRow = db.prepare(refundSql).get(...refundArgs);
    totals.refundsRequested = Number(refundRow?.c) || 0;
  } catch {
    /* refunds table */
  }

  for (const err of recentErrors) {
    const fromNote = guideForErrorNote(err.note);
    if (!fromNote) continue;
    const article = ensureHelpArticles().find((a) => a.id === fromNote.articleId);
    if (!article) continue;
    suggestedGuides.push({
      articleId: fromNote.articleId,
      title: article.title,
      reason: `Error note: ${fromNote.label}`,
      weight: 11,
    });
  }

  const times = hasAuditLogTable(db)
    ? db
        .prepare(
          `SELECT occurred_at_iso FROM audit_log
           WHERE actor_user_id = ? AND occurred_at_iso >= ?
           ORDER BY occurred_at_iso ASC LIMIT 100`
        )
        .all(userId, since)
        .map((r) => Date.parse(String(r.occurred_at_iso || '')))
        .filter((t) => Number.isFinite(t))
    : [];

  /** @type {'fast' | 'normal' | 'deliberate' | null} */
  let workPace = null;
  if (times.length >= 4) {
    const gaps = [];
    for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] || 0;
    if (median < 90_000) workPace = 'fast';
    else if (median > 600_000) workPace = 'deliberate';
    else workPace = 'normal';
  }

  const totalActions = recentActions.reduce((s, r) => s + r.count, 0) + totals.ledgerEntries;
  const actionsPerDay = totalActions / days;
  /** @type {'high' | 'normal' | 'low'} */
  let level = 'low';
  if (actionsPerDay >= 3) level = 'high';
  else if (actionsPerDay >= 1) level = 'normal';

  const profile = {
    periodDays: days,
    totals,
    recentActions,
    recentErrors,
    workPace,
    performance: { level, actionsPerDay: Math.round(actionsPerDay * 10) / 10 },
    suggestedGuides: suggestedGuides.slice(0, 6),
    activitySummary: [],
  };
  profile.activitySummary = buildTransactionActivitySummary(profile);
  return profile;
}

/**
 * @deprecated alias — use computeUserTransactionProfile
 */
export function computeUserWorkPatterns(db, opts = {}) {
  const profile = computeUserTransactionProfile(db, opts);
  return {
    recentActions: profile.recentActions,
    workPace: profile.workPace,
    suggestedGuides: profile.suggestedGuides,
  };
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
       AND (source = 'fallback' OR top_score < 4 OR feedback = 'not_helpful')
     GROUP BY LOWER(TRIM(query_text))
     ORDER BY c DESC
     LIMIT ?`
  ).all(since, limit);
  return rows.map((r) => String(r.query_text || '').trim()).filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId?: string; branchId?: string; roleKey?: string; pathname?: string; user?: object }} ctx
 */
export function buildHelpPersonalization(db, ctx = {}) {
  const pathname = String(ctx.pathname || '/');
  const roleKey = String(ctx.roleKey || '').trim();
  const branchId = String(ctx.branchId || '').trim();
  const userId = String(ctx.userId || '').trim();
  const branchBoosts = computeHelpLearnedBoosts(db, { branchId });
  const userBoosts = computeUserLearnedBoosts(db, { userId });
  const learnedBoosts = mergeLearnedBoostMaps(branchBoosts, userBoosts);
  const behaviorProfile = computeUserHelpBehaviorProfile(db, { userId });
  const transactionProfile = computeUserTransactionProfile(db, { userId, branchId });

  const basePrompts = quickQuestionsForPath(pathname);
  const rolePrompts = roleQuickPrompts(roleKey);
  const workPrompts = (transactionProfile.suggestedGuides || [])
    .map((g) => promptForArticleId(g.articleId))
    .filter(Boolean);
  const historyPrompts = (behaviorProfile.topArticleIds || [])
    .map((id) => promptForArticleId(id))
    .filter(Boolean);

  const prompts = mergePersonalizedPrompts(
    basePrompts,
    [...rolePrompts, ...workPrompts, ...historyPrompts],
    learnedBoosts,
    pathname
  );
  const knowledgeGaps = listHelpKnowledgeGaps(db, { limit: 8 });

  const workPatterns = {
    recentActions: transactionProfile.recentActions,
    workPace: transactionProfile.workPace,
    suggestedGuides: transactionProfile.suggestedGuides,
  };

  const aiCfg = readAiAssistConfig();
  const raw = {
    prompts: prompts.slice(0, 8),
    learnedBoosts,
    branchLearnedBoosts: branchBoosts,
    userLearnedBoosts: userBoosts,
    knowledgeGaps,
    articleCount: HELP_ARTICLE_COUNT,
    externalAi: aiCfg.enabled,
    aiProvider: aiCfg.provider,
    chatModel: aiCfg.helpModel || aiCfg.model,
    polishModel: aiCfg.polishModel || aiCfg.model,
    learningEnabled: hasHelpQueryLogTable(db),
    behaviorLearningEnabled: hasHelpQueryLogTable(db) && Boolean(userId),
    behaviorProfile,
    workPatterns,
    transactionProfile,
    transactionCoachingHints: buildTransactionCoachingHints(transactionProfile),
    behaviorNotes: [
      ...(behaviorProfile.behaviorNotes || []),
      ...(transactionProfile.activitySummary || []),
    ].slice(0, 3),
  };
  return filterPersonalizationForUser(raw, ctx.user || { permissions: [], roleKey });
}

/**
 * Coaching hints from live workspace snapshot (performance / attention signals).
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @param {string} [pathname]
 * @param {{ workPatterns?: ReturnType<typeof computeUserWorkPatterns> }} [extra]
 */
export function buildHelpPersonalizationFromSnapshot(db, snapshot, ctx = {}, extra = {}) {
  const base = buildHelpPersonalization(db, ctx);
  const coachingHints = buildHelpCoachingHints(snapshot, ctx.pathname);
  const txnHints = (base.transactionCoachingHints || buildTransactionCoachingHints(base.transactionProfile)).map(
    (h) => ({
      id: h.id,
      title: h.title,
      query: h.query,
      reason: h.reason,
      weight: h.weight || 9,
    })
  );
  const workHints = (base.transactionProfile?.suggestedGuides || base.workPatterns?.suggestedGuides || []).map(
    (g) => ({
      id: `work-${g.articleId}`,
      title: g.title,
      query: `Help me with: ${g.title}`,
      reason: g.reason,
      weight: g.weight || 8,
    })
  );

  const merged = [...coachingHints, ...txnHints, ...workHints]
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 5)
    .map(({ id, title, query, reason }) => ({ id, title, query, reason }));

  const branchId = String(ctx.branchId || '').trim();
  const workflowEvents = branchId ? loadBranchWorkflowHints(db, branchId) : [];
  const branchMemory = branchId ? loadBranchMemoryPatterns(db, branchId) : {};
  const memoryBoosts = ctx.userId ? memoryArticleBoosts(db, String(ctx.userId)) : {};

  const dailyBriefing = buildZareDailyBriefing(snapshot, ctx.roleKey);

  const recommendations = rankZareRecommendations({
    pathname: ctx.pathname,
    roleKey: ctx.roleKey,
    branchId,
    learnedBoosts: base.learnedBoosts,
    memoryBoosts,
    transactionProfile: base.transactionProfile,
    snapshot,
    branchMemory,
    workflowEvents,
    prompts: base.prompts,
    user: ctx.user,
  });

  return filterPersonalizationForUser(
    {
      ...base,
      coachingHints: merged,
      recommendations,
      dailyBriefing,
      intelligence: {
        workflowEvents: workflowEvents.length,
        branchMemoryKeys: Object.keys(branchMemory?.articleBoosts || {}).length,
      },
    },
    ctx.user || { permissions: [], roleKey: ctx.roleKey }
  );
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
    case 'operations_officer':
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
 * @param {{ pathname?: string; branchId?: string; userId?: string; learnedBoosts?: Record<string, number> }} [opts]
 */
export function rankHelpArticlesWithLearning(db, message, messages, opts = {}) {
  const searchText = buildHelpSearchText(message, messages);
  let boosts = opts.learnedBoosts;
  if (!boosts || !Object.keys(boosts).length) {
    boosts = computeMergedLearnedBoosts(db, { branchId: opts.branchId, userId: opts.userId });
  }
  return matchHelpArticles(searchText, {
    limit: 3,
    minScore: 4,
    pathname: opts.pathname,
    learnedBoosts: boosts,
  });
}
