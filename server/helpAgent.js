/**
 * Help AI Agent — orchestrates RAG retrieval, ERP text-to-SQL tools, and LLM synthesis.
 *
 * [User Query] → [Agent Router] → [Semantic RAG | Text-to-SQL | Guide synth]
 *                      ↓
 *              [Synthesized Answer] ← [Frontier LLM] ← [Secure context]
 */
import { classifyAgentRoute, routeLabel } from '../shared/lib/helpAgentIntent.js';
import { classifyZareIntent } from '../shared/lib/helpZareIntent.js';
import { buildTransactionHelpReply } from '../shared/lib/helpTransactionHelp.js';
import { formatHelpErrorReply } from '../shared/lib/helpErrorExplain.js';
import { buildZareDailyBriefing, formatZareBriefingReply } from '../shared/lib/helpZareBriefing.js';
import { buildHelpSearchText, isComplexHelpQuery, matchHelpArticles, mergeHelpLinks } from '../shared/lib/helpKnowledge.js';
import {
  buildHelpAiSystemPrompt,
  detectHelpIntent,
  synthesizeHelpReply,
  synthesizeMetaReply,
} from '../shared/lib/helpSynthesize.js';
import { HELP_ARTICLES } from '../shared/lib/helpKnowledge.js';
import {
  normalizeCompletionContent,
  postChatCompletions,
  readAiAssistConfig,
  sanitizeClientMessages,
} from './aiAssist.js';
import { queryErpData, synthesizeErpAnswer } from './helpErpQuery.js';
import { computeUserHelpBehaviorProfile, computeUserTransactionProfile, insertHelpQueryLog } from './helpQueryOps.js';
import { formatRetrievedContext, indexHelpKnowledgeBaseIfStale, retrieveHelpContext } from './helpRagStore.js';
import { buildCoachingReply, isCoachingMessage } from '../shared/lib/helpCoaching.js';
import {
  readCoachingSession,
  recordUserQueryMemory,
  writeCoachingSession,
} from '../shared/lib/helpMemory.js';
import { recordKnowledgeGap } from '../shared/lib/helpGapAnalysis.js';
import { logHelpAiObservation } from './helpIntelligenceAdmin.js';
import {
  formatClearanceMessage,
  inferClearanceTopicFromMessage,
} from '../shared/lib/helpClearance.js';

function logHelpQuery(db, opts, result) {
  if (!db) return null;
  try {
    return insertHelpQueryLog(db, {
      userId: opts.userId,
      branchId: opts.branchId,
      roleKey: opts.roleKey,
      pathname: opts.pathname,
      queryText: opts.message,
      matchedArticleIds: result?.matchedArticleIds || [],
      source: result?.source || 'unknown',
      topScore: result?.topScore ?? 0,
      responseChars: String(result?.content || '').length,
      responseMs: opts.responseMs,
      clientDraftMs: opts.clientDraftMs,
      sessionTurn: opts.sessionTurn,
    });
  } catch (e) {
    console.error('[zarewa] help query log failed', e);
    return null;
  }
}

function finalize(result, logId = null) {
  return {
    content: result.content,
    source: result.source,
    links: result.links || [],
    matchedArticleIds: result.matchedArticleIds || [],
    topScore: result.topScore ?? 0,
    logId,
    agentRoute: result.agentRoute || null,
    sources: result.sources || [],
    coaching: result.coaching || null,
  };
}

function finish(db, opts, logCtx, chatStarted, result) {
  logCtx.responseMs = Date.now() - chatStarted;
  const logId = logHelpQuery(db, logCtx, result);
  if (db && opts.userId) {
    recordUserQueryMemory(db, {
      userId: opts.userId,
      queryText: opts.message,
      articleIds: result.matchedArticleIds,
      agentRoute: result.agentRoute,
    });
    logHelpAiObservation(db, {
      userId: opts.userId,
      branchId: opts.branchId,
      route: result.agentRoute,
      queryText: opts.message,
      source: result.source,
      responseMs: logCtx.responseMs,
      payload: { topScore: result.topScore, sources: result.sources?.length || 0 },
    });
  }
  if (db && (result.topScore < 4 || result.source === 'fallback')) {
    recordKnowledgeGap(db, { queryText: opts.message, branchId: opts.branchId });
  }
  return finalize(result, logId);
}

/**
 * @param {{
 *   db?: import('better-sqlite3').Database;
 *   message: string;
 *   messages?: unknown[];
 *   pathname?: string;
 *   user?: object;
 *   userDisplay?: string;
 *   userId?: string;
 *   branchId?: string;
 *   roleKey?: string;
 *   learnedBoosts?: Record<string, number>;
 *   clientDraftMs?: number;
 *   pageContext?: Record<string, unknown>;
 * }} opts
 */
export async function runHelpAgent(opts) {
  const chatStarted = Date.now();
  const message = String(opts?.message || '').trim();
  if (!message) {
    const err = new Error('Message is required.');
    err.code = 'HELP_BAD_REQUEST';
    throw err;
  }

  const db = opts.db;
  if (db) {
    indexHelpKnowledgeBaseIfStale(db).catch((e) =>
      console.warn('[zarewa] help RAG index async failed', e?.message || e)
    );
  }

  const sanitized = sanitizeClientMessages(opts.messages);
  const history = sanitized.length > 0 ? sanitized : [{ role: 'user', content: message }];
  const pathname = String(opts.pathname || '').trim().slice(0, 200);
  const pageContext = opts.pageContext && typeof opts.pageContext === 'object' ? opts.pageContext : null;
  const userId = String(opts.userId || opts.user?.id || '').trim();
  const branchId = String(opts.branchId || '').trim();
  const sessionTurn = history.filter((m) => m.role === 'user').length;
  const logCtx = {
    ...opts,
    sessionTurn,
    clientDraftMs: Math.max(0, Math.round(Number(opts.clientDraftMs) || 0)),
    responseMs: 0,
  };

  const behaviorProfile =
    db && userId ? computeUserHelpBehaviorProfile(db, { userId }) : { pace: 'normal' };
  const transactionProfile =
    db && userId ? computeUserTransactionProfile(db, { userId, branchId }) : null;

  const agentRoute = classifyAgentRoute(message, history, pageContext);
  const zareIntent = classifyZareIntent(message, history, pageContext);
  const helpIntent = detectHelpIntent(message, history);
  const cfgEarly = readAiAssistConfig();

  const txCtx = pageContext?.transaction || pageContext?.transactionContext;
  const transactionHelpIntents = new Set([
    'wrong_payment_amount',
    'wrong_customer_payment',
    'duplicate_receipt',
    'wrong_payment_method',
    'wrong_branch',
    'wrong_expense_amount',
    'wrong_vendor_or_supplier',
    'transaction_stuck',
    'transaction_problem',
    'correction_request',
    'reversal_request',
    'missing_attachment',
    'cannot_approve',
  ]);
  if (
    pageContext?.mode === 'transaction_help' ||
    txCtx ||
    transactionHelpIntents.has(zareIntent)
  ) {
    const txReply = buildTransactionHelpReply({
      message,
      history,
      pageContext,
      transactionContext: txCtx,
    });
    return finish(db, opts, logCtx, chatStarted, {
      content: txReply.content,
      source: 'transaction_help',
      links: [],
      matchedArticleIds: [],
      topScore: 0,
      agentRoute: 'troubleshoot',
      sources: [],
      coaching: txReply.correctionMemo
        ? { correctionMemo: txReply.correctionMemo, issueType: txReply.issueType }
        : null,
    });
  }

  if (zareIntent === 'error_explanation') {
    const errContent = formatHelpErrorReply(message);
    if (errContent) {
      return finish(db, opts, logCtx, chatStarted, {
        content: errContent,
        source: 'error_explain',
        links: [],
        matchedArticleIds: [],
        topScore: 0,
        agentRoute: 'troubleshoot',
      });
    }
  }

  if (zareIntent === 'daily_briefing' || zareIntent === 'branch_summary') {
    const briefingLines = buildZareDailyBriefing(
      opts.snapshot || pageContext?.briefingSnapshot || pageContext?.snapshot,
      opts.roleKey
    );
    const briefing = formatZareBriefingReply(briefingLines);
    if (briefing) {
      return finish(db, opts, logCtx, chatStarted, {
        content: briefing,
        source: 'briefing',
        links: [{ label: 'Workspace', to: '/' }],
        matchedArticleIds: [],
        topScore: 0,
        agentRoute: 'analytics',
      });
    }
  }

  if (agentRoute === 'meta' || helpIntent === 'meta') {
    return finish(db, opts, logCtx, chatStarted, {
      content: synthesizeMetaReply({
        userDisplay: opts.userDisplay,
        externalAiEnabled: cfgEarly.enabled,
      }),
      source: 'meta',
      links: [{ label: 'Settings & guides', to: '/settings' }],
      matchedArticleIds: [],
      topScore: 0,
      agentRoute: 'meta',
    });
  }

  const searchText = buildHelpSearchText(message, history);

  const retrieval =
    db && agentRoute !== 'chitchat'
      ? await retrieveHelpContext(db, searchText, {
          pathname,
          learnedBoosts: opts.learnedBoosts,
        })
      : { chunks: [], articleIds: [], mode: 'none' };

  const ragContext = formatRetrievedContext(retrieval);
  const matchedArticles = retrieval.articleIds
    .map((id) => HELP_ARTICLES.find((a) => a.id === id))
    .filter(Boolean);

  const sources = matchedArticles.slice(0, 3).map((a) => ({ id: a.id, title: a.title }));

  const topScore =
    matchHelpArticles(searchText, {
      limit: 1,
      minScore: 4,
      pathname,
      learnedBoosts: opts.learnedBoosts,
    })[0]?.score ?? 0;

  if (agentRoute === 'clearance') {
    const topicKey = inferClearanceTopicFromMessage(message) || 'manager';
    const clearanceMsg = formatClearanceMessage({
      topicKey,
      roleKey: opts.roleKey,
      mode: 'live_data',
    });
    const guideArticles =
      matchedArticles.length > 0
        ? matchedArticles
        : matchHelpArticles(searchText, { limit: 1, minScore: 3, pathname, learnedBoosts: opts.learnedBoosts }).map(
            (m) => m.article
          );
    const guide = synthesizeHelpReply({
      message,
      history,
      articles: guideArticles,
      pathname,
      userDisplay: opts.userDisplay,
      roleKey: opts.roleKey,
      user: opts.user || { permissions: opts.user?.permissions, roleKey: opts.roleKey },
      pace: behaviorProfile.pace,
      intent: helpIntent,
      transactionProfile,
      externalAiEnabled: cfgEarly.enabled,
    });
    return finish(db, opts, logCtx, chatStarted, {
      content: [clearanceMsg, '', guide].join('\n'),
      source: 'clearance',
      links: mergeHelpLinks(guideArticles.slice(0, 2)),
      matchedArticleIds: guideArticles.slice(0, 2).map((a) => a.id),
      topScore,
      agentRoute: 'clearance',
      sources,
    });
  }

  if (agentRoute === 'coaching' || isCoachingMessage(message, history)) {
    const session = db && userId ? readCoachingSession(db, userId) : null;
    const articles =
      matchedArticles.length > 0
        ? matchedArticles
        : matchHelpArticles(searchText, {
            limit: 1,
            minScore: 3,
            pathname,
            learnedBoosts: opts.learnedBoosts,
          }).map((m) => m.article);
    const coaching = buildCoachingReply({
      message,
      articles,
      stepIndex: session?.stepIndex,
      totalSteps: session?.steps,
      articleId: session?.articleId,
    });
    if (db && userId && coaching.coaching?.active) {
      writeCoachingSession(db, userId, coaching.coaching);
    }
    return finish(db, opts, logCtx, chatStarted, {
      content: coaching.content,
      source: 'coaching',
      links: mergeHelpLinks(articles.slice(0, 1)),
      matchedArticleIds: articles.slice(0, 1).map((a) => a.id),
      topScore,
      agentRoute: 'coaching',
      sources,
      coaching: coaching.coaching,
    });
  }

  /** @type {string[]} */
  const contentParts = [];
  if (
    pageContext?.surface === 'workspace_command_center' &&
    (helpIntent === 'guide' || agentRoute === 'guide' || /what should i do|next|workspace|memo/i.test(message))
  ) {
    const folder = String(pageContext.folder || 'inbox');
    const cat = String(pageContext.category || 'all');
    const ar = pageContext.counts?.actionRequired;
    contentParts.push(
      `You are on the **Workspace command center** (${folder}${cat !== 'all' ? ` · ${cat}` : ''}).` +
        (ar != null ? ` **${ar}** item(s) need action.` : '')
    );
  }
  let source = 'agent';
  let erpSummary = null;
  let erpDenied = false;

  if (agentRoute === 'erp_data' || agentRoute === 'hybrid' || agentRoute === 'analytics') {
    if (db) {
      const erp = await queryErpData(db, message, {
        user: opts.user || { id: userId, permissions: opts.user?.permissions, roleKey: opts.roleKey },
        branchId,
        userId,
      });
      if (erp?.ok) {
        erpSummary = synthesizeErpAnswer(erp, message);
        contentParts.push(erpSummary);
        source = 'agent+erp';
      } else if (erp?.code === 'CLEARANCE_DENIED') {
        erpSummary = synthesizeErpAnswer(erp, message);
        contentParts.push(erpSummary);
        erpDenied = true;
        source = 'agent+clearance';
      } else if (erp?.error) {
        erpSummary = synthesizeErpAnswer(erp, message);
        contentParts.push(erpSummary);
        source = 'agent+erp_error';
      }
    }
  }

  const wantsGuide =
    agentRoute === 'guide' ||
    agentRoute === 'hybrid' ||
    agentRoute === 'chitchat' ||
    agentRoute === 'troubleshoot' ||
    agentRoute === 'analytics' ||
    erpDenied ||
    (agentRoute === 'erp_data' && !erpSummary) ||
    !contentParts.length;

  if (wantsGuide) {
    const synth = synthesizeHelpReply({
      message,
      history,
      articles: matchedArticles.length ? matchedArticles : [],
      pathname,
      userDisplay: opts.userDisplay,
      roleKey: opts.roleKey,
      user: opts.user || { permissions: opts.user?.permissions, roleKey: opts.roleKey },
      pace: behaviorProfile.pace,
      intent: helpIntent,
      transactionProfile,
      externalAiEnabled: readAiAssistConfig().enabled,
    });
    if (contentParts.length) contentParts.push('', '---', '', synth);
    else contentParts.push(synth);
    if (source === 'agent') source = 'synth';
  }

  let content = contentParts.filter(Boolean).join('\n');

  const cfg = readAiAssistConfig();
  const complex = isComplexHelpQuery(message);
  const shouldPolish =
    cfg.enabled && (complex || agentRoute === 'hybrid' || (erpSummary && matchedArticles.length));

  if (shouldPolish) {
    const system =
      buildHelpAiSystemPrompt({
        retrievedContext: [ragContext, erpSummary ? `ERP tool result:\n${erpSummary}` : '']
          .filter(Boolean)
          .join('\n\n'),
        pathname,
        userDisplay: opts.userDisplay,
        roleKey: opts.roleKey,
        pace: behaviorProfile.pace,
      }) +
      `\nAgent route: ${routeLabel(agentRoute)}. Never invent data outside retrieved context and ERP results.`;

    const { ok, json } = await postChatCompletions(cfg, {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        ...history.slice(-12),
        {
          role: 'assistant',
          content: `Draft answer (${routeLabel(agentRoute)}):\n${content}`.slice(0, 6000),
        },
        {
          role: 'user',
          content: 'Polish this into one clear, accurate reply. Keep ERP numbers exact. Do not add fake data.',
        },
      ],
      max_tokens: 1000,
      temperature: 0.25,
    });

    if (ok) {
      const polished = normalizeCompletionContent(json?.choices?.[0]?.message);
      if (String(polished).trim()) {
        content = String(polished);
        source = erpSummary ? 'ai+erp' : 'ai';
      }
    }
  }

  return finish(db, opts, logCtx, chatStarted, {
    content,
    source,
    links: mergeHelpLinks(matchedArticles.slice(0, 2)),
    matchedArticleIds: retrieval.articleIds.slice(0, 3),
    topScore,
    agentRoute,
    sources,
  });
}

/** Back-compat entry point used by HTTP API. */
export const runHelpChat = runHelpAgent;
