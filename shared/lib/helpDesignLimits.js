/**
 * Runa design limits — non-negotiable safety boundaries for ERP intelligence.
 *
 * 1. No ERP mutations without user action (guide/suggest/prepare only).
 * 2. No auto-publish help articles (drafts stay pending until admin review).
 * 3. No neural model training in-app (practical learning: weights, patterns, analytics).
 * 4. RBAC on all remembered or live operational data.
 */
import {
  CLEARANCE_TOPICS,
  inferClearanceTopicFromArticle,
  userHasClearance,
} from './helpClearance.js';

/** @readonly */
export const RUNA_DESIGN_LIMITS = Object.freeze({
  noErpMutations: true,
  noAutoPublishArticles: true,
  noNeuralTraining: true,
  rbacOnMemory: true,
});

/** Auto-created drafts always start here; never merged into HELP_ARTICLES by Runa. */
export const HELP_ARTICLE_AUTO_CREATE_STATUS = 'pending';

/** Valid draft lifecycle states (no "published" — that requires a code deploy). */
export const HELP_ARTICLE_DRAFT_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

/** @type {Record<string, string[]>} */
export const HELP_ARTICLE_DRAFT_TRANSITIONS = Object.freeze({
  pending: ['approved', 'rejected'],
  approved: [],
  rejected: ['pending'],
});

export const HELP_MEMORY_ALLOWED_TOP_KEYS = new Set([
  'articleHits',
  'routes',
  'fingerprints',
  'articleBoosts',
  'stepIndex',
  'articleId',
  'steps',
  'active',
  'startedAt',
  'updatedAt',
]);

export const HELP_MEMORY_FORBIDDEN_KEYS = new Set([
  'note',
  'customer_name',
  'amount_ngn',
  'entity_id',
  'payload',
  'raw',
  'sql',
  'rows',
  'query_text',
  'password',
  'token',
]);

const FORBIDDEN_NEURAL_OPS = new Set([
  'trainNeuralModel',
  'fineTune',
  'backprop',
  'retrainEmbeddingModel',
  'updateModelWeights',
]);

/**
 * Runa learns via feedback weights, article ranking, and workflow analytics — not in-app neural training.
 * @param {string} operation
 */
export function assertPracticalLearningAllowed(operation) {
  if (FORBIDDEN_NEURAL_OPS.has(String(operation || ''))) {
    throw new Error('Runa does not train neural models inside the ERP.');
  }
}

/**
 * @param {string} status
 * @param {{ autoCreate?: boolean }} [opts]
 */
export function assertValidDraftStatus(status, opts = {}) {
  const s = String(status || '').trim();
  if (!HELP_ARTICLE_DRAFT_STATUSES.includes(s)) {
    throw new Error(`Invalid help article draft status: ${s}`);
  }
  if (opts.autoCreate && s !== HELP_ARTICLE_AUTO_CREATE_STATUS) {
    throw new Error('Runa may only auto-create help article drafts as pending.');
  }
  return s;
}

/**
 * @param {string} fromStatus
 * @param {string} toStatus
 */
export function assertDraftStatusTransition(fromStatus, toStatus) {
  const from = assertValidDraftStatus(fromStatus);
  const to = assertValidDraftStatus(toStatus);
  const allowed = HELP_ARTICLE_DRAFT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`Cannot transition help draft from ${from} to ${to}.`);
  }
  return to;
}

/**
 * Strip restricted payloads from memory writes.
 * @param {unknown} payload
 */
export function sanitizeHelpMemoryPayload(payload) {
  if (payload == null || typeof payload !== 'object') return {};
  return sanitizeHelpMemoryNode(payload, 0);
}

/**
 * @param {unknown} node
 * @param {number} depth
 */
function sanitizeHelpMemoryNode(node, depth) {
  if (depth > 4) return null;
  if (node == null) return null;
  if (typeof node === 'string') return node.slice(0, 200);
  if (typeof node === 'number' || typeof node === 'boolean') return node;
  if (Array.isArray(node)) {
    return node.slice(0, 30).map((v) => sanitizeHelpMemoryNode(v, depth + 1));
  }
  if (typeof node !== 'object') return null;

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (HELP_MEMORY_FORBIDDEN_KEYS.has(key)) continue;
    if (depth === 0 && !HELP_MEMORY_ALLOWED_TOP_KEYS.has(key) && typeof value === 'object') continue;
    out[key] = sanitizeHelpMemoryNode(value, depth + 1);
  }
  return out;
}

/**
 * @param {string} articleId
 * @param {{ permissions?: string[] } | null | undefined} user
 */
export function userMaySeeArticle(articleId, user) {
  const topicKey = inferClearanceTopicFromArticle(String(articleId || ''));
  if (!topicKey) return true;
  const topic = CLEARANCE_TOPICS[topicKey];
  if (!topic) return true;
  return userHasClearance(user, topic.permissions);
}

/**
 * @param {Record<string, number>} boosts
 * @param {{ permissions?: string[] } | null | undefined} user
 */
export function filterArticleBoostMap(boosts, user) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [id, weight] of Object.entries(boosts || {})) {
    if (userMaySeeArticle(id, user)) out[id] = Number(weight) || 0;
  }
  return out;
}

/**
 * @param {string} action
 * @returns {string | null}
 */
export function inferClearanceTopicFromAction(action) {
  const a = String(action || '').toLowerCase();
  if (/\b(refund|rf-)\b/.test(a)) return 'refunds';
  if (/\b(ledger|receipt|treasury|finance|payment|bank)\b/.test(a)) return 'finance';
  if (/\b(quotation|quote|qt-)\b/.test(a)) return 'quotations';
  if (/\b(purchase|procurement|po-|grn)\b/.test(a)) return 'procurement';
  if (/\b(inventory|stock|product|coil)\b/.test(a)) return 'inventory';
  if (/\b(payroll|salary|hr)\b/.test(a)) return 'hr';
  if (/\b(audit)\b/.test(a)) return 'audit';
  if (/\b(report|executive|management)\b/.test(a)) return 'manager';
  return null;
}

/**
 * @param {object | null | undefined} profile
 * @param {{ permissions?: string[]; roleKey?: string } | null | undefined} user
 */
export function filterTransactionProfileForUser(profile, user) {
  if (!profile) return profile;
  const suggestedGuides = (profile.suggestedGuides || []).filter((g) =>
    userMaySeeArticle(g.articleId, user)
  );
  const recentErrors = (profile.recentErrors || []).map((err) => {
    const topicKey = inferClearanceTopicFromAction(err.action);
    const topic = topicKey ? CLEARANCE_TOPICS[topicKey] : null;
    if (topic && !userHasClearance(user, topic.permissions)) {
      return {
        action: String(err.action || 'action'),
        note: 'Details require additional clearance.',
        at: err.at,
      };
    }
    return {
      action: String(err.action || ''),
      note: String(err.note || '').slice(0, 120),
      at: err.at,
    };
  });
  return {
    ...profile,
    suggestedGuides,
    recentErrors,
  };
}

/**
 * Apply RBAC to personalization payloads before sending to the client.
 * @param {Record<string, unknown>} personalization
 * @param {{ permissions?: string[]; roleKey?: string } | null | undefined} user
 */
export function filterPersonalizationForUser(personalization, user) {
  if (!personalization || typeof personalization !== 'object') return personalization;
  const txn = filterTransactionProfileForUser(
    /** @type {object} */ (personalization.transactionProfile),
    user
  );
  const learnedBoosts = filterArticleBoostMap(
    /** @type {Record<string, number>} */ (personalization.learnedBoosts),
    user
  );
  const userLearnedBoosts = filterArticleBoostMap(
    /** @type {Record<string, number>} */ (personalization.userLearnedBoosts),
    user
  );
  const branchLearnedBoosts = filterArticleBoostMap(
    /** @type {Record<string, number>} */ (personalization.branchLearnedBoosts),
    user
  );
  const recommendations = (personalization.recommendations || [])
    .filter((rec) => {
      const match = String(rec.id || '').match(/(?:mem-|branch-|work-|wf-|prompt-)/);
      if (!match) return true;
      const articleId = String(rec.id || '').replace(/^(mem-|branch-|work-|wf-)/, '');
      const article = articleId.includes('prompt-') ? null : articleId;
      if (!article || article.includes('-')) {
        const fromTitle = String(rec.title || '');
        return !fromTitle || true;
      }
      return userMaySeeArticle(article, user);
    })
    .map((rec) => {
      const id = String(rec.id || '');
      for (const prefix of ['mem-', 'branch-', 'work-', 'wf-']) {
        if (id.startsWith(prefix)) {
          const articleId = id.slice(prefix.length);
          if (!userMaySeeArticle(articleId, user)) return null;
        }
      }
      return rec;
    })
    .filter(Boolean);

  const workPatterns = personalization.workPatterns
    ? {
        .../** @type {object} */ (personalization.workPatterns),
        suggestedGuides: (/** @type {object} */ (personalization.workPatterns).suggestedGuides || []).filter(
          (g) => userMaySeeArticle(g.articleId, user)
        ),
      }
    : personalization.workPatterns;

  return {
    ...personalization,
    learnedBoosts,
    userLearnedBoosts,
    branchLearnedBoosts,
    transactionProfile: txn,
    workPatterns,
    recommendations,
    designLimits: RUNA_DESIGN_LIMITS,
  };
}
