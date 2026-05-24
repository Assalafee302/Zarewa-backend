import {
  HELP_ARTICLES,
  buildHelpSearchText,
  formatHelpArticleReply,
  formatHelpArticlesReply,
  isComplexHelpQuery,
  matchHelpArticles,
  mergeHelpLinks,
} from '../shared/lib/helpKnowledge.js';
import { readAiAssistConfig, sanitizeClientMessages, normalizeCompletionContent, chatCompletionsUrl } from './aiAssist.js';
import { insertHelpQueryLog } from './helpQueryOps.js';

const HELP_KB_EXCERPT_MAX = 22000;

function buildHelpKnowledgeExcerpt() {
  const lines = ['Zarewa procedural help articles (authoritative):'];
  for (const a of HELP_ARTICLES) {
    lines.push(`\n## ${a.title} (${a.id})`);
    lines.push(a.answer);
    if (a.steps.length) {
      lines.push('Steps:');
      a.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    if (a.links?.length) {
      lines.push(`Links: ${a.links.map((l) => `${l.label} → ${l.to}`).join('; ')}`);
    }
  }
  return lines.join('\n').slice(0, HELP_KB_EXCERPT_MAX);
}

const HELP_KB_EXCERPT = buildHelpKnowledgeExcerpt();

/**
 * @param {string} message
 * @param {unknown[]} messages
 * @param {{ pathname?: string; learnedBoosts?: Record<string, number> }} ctx
 * @returns {{ content: string; source: 'kb'; links: import('../shared/lib/helpKnowledge.js').HelpLink[]; matchedArticleIds: string[]; topScore: number } | null}
 */
function resolveKnowledgeBaseAnswer(message, messages, ctx = {}) {
  const searchText = buildHelpSearchText(message, messages);
  const matchOpts = {
    limit: 3,
    minScore: 4,
    pathname: ctx.pathname,
    learnedBoosts: ctx.learnedBoosts,
  };
  const matches = matchHelpArticles(searchText, matchOpts);
  if (!matches.length) return null;

  const complex = isComplexHelpQuery(message);
  const top = matches[0];
  const second = matches[1];
  const matchedArticleIds = matches.map((m) => m.article.id);

  if (matches.length >= 2 && second && second.score >= top.score - 3 && (complex || top.score < 10)) {
    const articles = matches.slice(0, 2).map((m) => m.article);
    return {
      content: formatHelpArticlesReply(articles),
      source: 'kb',
      links: mergeHelpLinks(articles),
      matchedArticleIds: articles.map((a) => a.id),
      topScore: top.score,
    };
  }

  if (top.score >= 6 || (!complex && top.score >= 4) || (complex && top.score >= 8)) {
    return {
      content: formatHelpArticleReply(top.article),
      source: 'kb',
      links: mergeHelpLinks([top.article]),
      matchedArticleIds: [top.article.id],
      topScore: top.score,
    };
  }

  return null;
}

/**
 * Looser KB pass when AI is off but the user asked a complex question.
 */
function resolveKnowledgeBaseAnswerLoose(message, messages, ctx = {}) {
  const searchText = buildHelpSearchText(message, messages);
  const matches = matchHelpArticles(searchText, {
    limit: 2,
    minScore: 3,
    pathname: ctx.pathname,
    learnedBoosts: ctx.learnedBoosts,
  });
  if (!matches.length) return null;
  const articles = matches.slice(0, 2).map((m) => m.article);
  return {
    content: formatHelpArticlesReply(articles),
    source: 'kb',
    links: mergeHelpLinks(articles),
    matchedArticleIds: articles.map((a) => a.id),
    topScore: matches[0].score,
  };
}

function logHelpQuery(db, opts, result) {
  if (!db) return;
  try {
    insertHelpQueryLog(db, {
      userId: opts.userId,
      branchId: opts.branchId,
      roleKey: opts.roleKey,
      pathname: opts.pathname,
      queryText: opts.message,
      matchedArticleIds: result?.matchedArticleIds || [],
      source: result?.source || 'unknown',
      topScore: result?.topScore ?? 0,
      responseChars: String(result?.content || '').length,
    });
  } catch (e) {
    console.error('[zarewa] help query log failed', e);
  }
}

function finalize(result) {
  return {
    content: result.content,
    source: result.source,
    links: result.links || [],
    matchedArticleIds: result.matchedArticleIds || [],
    topScore: result.topScore ?? 0,
  };
}

/**
 * Self-contained help assistant — built-in KB first, optional external AI, pattern learning via help_query_log.
 * @param {{
 *   db?: import('better-sqlite3').Database;
 *   message: string;
 *   messages?: unknown[];
 *   pathname?: string;
 *   userDisplay?: string;
 *   userId?: string;
 *   branchId?: string;
 *   roleKey?: string;
 *   learnedBoosts?: Record<string, number>;
 * }} opts
 */
export async function runHelpChat(opts) {
  const message = String(opts?.message || '').trim();
  if (!message) {
    const err = new Error('Message is required.');
    err.code = 'HELP_BAD_REQUEST';
    throw err;
  }

  const sanitized = sanitizeClientMessages(opts.messages);
  const history =
    sanitized.length > 0
      ? sanitized
      : [{ role: 'user', content: message }];

  const pathname = String(opts.pathname || '').trim().slice(0, 200);
  const ctx = { pathname, learnedBoosts: opts.learnedBoosts };
  const complex = isComplexHelpQuery(message);
  const searchText = buildHelpSearchText(message, history);
  const ranked = matchHelpArticles(searchText, { limit: 1, minScore: 4, pathname, learnedBoosts: ctx.learnedBoosts });
  const topScore = ranked[0]?.score ?? 0;
  let kbAnswer = resolveKnowledgeBaseAnswer(message, history, ctx);

  if (kbAnswer && (topScore >= 7 || !complex || topScore >= 8)) {
    const out = finalize(kbAnswer);
    logHelpQuery(opts.db, opts, out);
    return out;
  }

  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    if (!kbAnswer) kbAnswer = resolveKnowledgeBaseAnswerLoose(message, history, ctx);
    if (kbAnswer) {
      const out = finalize(kbAnswer);
      logHelpQuery(opts.db, opts, out);
      return out;
    }
    const out = finalize({
      content: [
        "I couldn't find a close match in the built-in help guides.",
        '',
        'Try a workflow quick prompt, or use words like **receipt**, **quotation**, **PO**, **production**, **refund**, **offline**, or **period locked**.',
        '',
        `There are **${HELP_ARTICLES.length}** built-in guides — Settings also has department workspace guides.`,
        '',
        'This assistant learns from staff questions over time (no external AI key required).',
      ].join('\n'),
      source: 'fallback',
      links: [{ label: 'Settings & guides', to: '/settings' }],
      matchedArticleIds: [],
      topScore: 0,
    });
    logHelpQuery(opts.db, opts, out);
    return out;
  }

  const who = String(opts.userDisplay || '').trim().slice(0, 120);
  const related = matchHelpArticles(searchText, { limit: 3, minScore: 3, pathname, learnedBoosts: ctx.learnedBoosts })
    .map((m) => m.article.title)
    .join('; ');

  const system = [
    'You are the Zarewa Help Assistant — procedural guide for staff. Prefer the knowledge base below.',
    'Answer ONLY with steps inside Zarewa. Break cross-department workflows into numbered phases.',
    'Never invent URLs except standard paths (/sales, /accounts, /operations, /procurement, /settings, /manager).',
    related ? `Related guides: ${related}.` : '',
    who ? `User: ${who}.` : '',
    pathname ? `Path: ${pathname}.` : '',
    '',
    HELP_KB_EXCERPT,
  ]
    .filter(Boolean)
    .join('\n');

  const url = chatCompletionsUrl(cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...history.slice(-14)],
      max_tokens: 1200,
      temperature: 0.2,
    }),
  });

  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    if (kbAnswer) {
      const out = finalize(kbAnswer);
      logHelpQuery(opts.db, opts, out);
      return out;
    }
    const err = new Error(
      (json && json.error && (json.error.message || json.error)) ||
        (raw ? raw.slice(0, 240) : '') ||
        `HTTP ${res.status}`
    );
    err.code = 'HELP_UPSTREAM';
    throw err;
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message);
  if (!String(content).trim()) {
    if (kbAnswer) {
      const out = finalize(kbAnswer);
      logHelpQuery(opts.db, opts, out);
      return out;
    }
    const err = new Error('Empty response from AI provider.');
    err.code = 'HELP_EMPTY';
    throw err;
  }

  const relatedMatches = matchHelpArticles(searchText, {
    limit: 2,
    minScore: 5,
    pathname,
    learnedBoosts: ctx.learnedBoosts,
  }).map((m) => m.article);

  const out = finalize({
    content: String(content),
    source: 'ai',
    links: kbAnswer?.links?.length ? kbAnswer.links : mergeHelpLinks(relatedMatches),
    matchedArticleIds: relatedMatches.map((a) => a.id),
    topScore,
  });
  logHelpQuery(opts.db, opts, out);
  return out;
}
