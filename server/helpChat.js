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

const HELP_KB_EXCERPT_MAX = 18000;

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
 * @param {string} pathname
 * @returns {{ content: string; source: 'kb'; links: import('../shared/lib/helpKnowledge.js').HelpLink[] } | null}
 */
function resolveKnowledgeBaseAnswer(message, messages, pathname) {
  const searchText = buildHelpSearchText(message, messages);
  const matches = matchHelpArticles(searchText, { limit: 3, minScore: 4, pathname });
  if (!matches.length) return null;

  const complex = isComplexHelpQuery(message);
  const top = matches[0];
  const second = matches[1];

  if (matches.length >= 2 && second && second.score >= top.score - 3 && (complex || top.score < 10)) {
    const articles = matches.slice(0, 2).map((m) => m.article);
    return {
      content: formatHelpArticlesReply(articles),
      source: 'kb',
      links: mergeHelpLinks(articles),
    };
  }

  if (top.score >= 6 || (!complex && top.score >= 4)) {
    return {
      content: formatHelpArticleReply(top.article),
      source: 'kb',
      links: mergeHelpLinks([top.article]),
    };
  }

  return null;
}

/**
 * @param {{ message: string, messages?: unknown[], pathname?: string, userDisplay?: string }} opts
 * @returns {Promise<{ content: string; source: 'kb' | 'ai' | 'fallback'; links?: import('../shared/lib/helpKnowledge.js').HelpLink[] }>}
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
  const complex = isComplexHelpQuery(message);
  const searchText = buildHelpSearchText(message, history);
  const ranked = matchHelpArticles(searchText, { limit: 1, minScore: 4, pathname });
  const topScore = ranked[0]?.score ?? 0;
  const kbAnswer = resolveKnowledgeBaseAnswer(message, history, pathname);

  if (kbAnswer && (topScore >= 7 || !complex)) {
    return kbAnswer;
  }

  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    if (kbAnswer) return kbAnswer;
    return {
      content: [
        "I couldn't find a close match in the built-in help guides.",
        '',
        'Try one of the workflow quick prompts, or rephrase with words like **receipt**, **quotation**, **PO**, **production job**, **refund**, or **reconciliation**.',
        '',
        'Full department guides are in **Settings** on this app.',
      ].join('\n'),
      source: 'fallback',
      links: [{ label: 'Settings & guides', to: '/settings' }],
    };
  }

  const who = String(opts.userDisplay || '').trim().slice(0, 120);
  const related = matchHelpArticles(searchText, { limit: 3, minScore: 3, pathname })
    .map((m) => m.article.title)
    .join('; ');

  const system = [
    'You are the Zarewa Help Assistant — a friendly procedural guide for staff using the Zarewa web app.',
    'Answer ONLY with steps and navigation inside Zarewa. You cannot click buttons or change data.',
    'For multi-step or cross-department questions, break the answer into numbered phases (Sales → Operations → Finance, etc.).',
    'Prefer the knowledge base below over general assumptions. If unsure, say what to check in the app and suggest Settings → workspace guide.',
    'Keep answers practical: short intro, numbered steps, menu paths (Sales, Finance, Operations, Procurement, Manager).',
    'Never invent module names or URLs that are not in the knowledge base unless they are standard paths like /sales, /accounts, /settings.',
    'For money, tax, or legal decisions, remind the user to confirm with Finance or management.',
    related ? `Possibly related guides for this question: ${related}.` : '',
    who ? `Signed-in user label: ${who}.` : '',
    pathname ? `User is currently on path: ${pathname}.` : '',
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
    if (kbAnswer) return kbAnswer;
    const msg =
      (json && json.error && (json.error.message || json.error)) ||
      (raw ? raw.slice(0, 240) : '') ||
      `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.code = 'HELP_UPSTREAM';
    throw err;
  }

  const content = normalizeCompletionContent(json?.choices?.[0]?.message);
  if (!String(content).trim()) {
    if (kbAnswer) return kbAnswer;
    const err = new Error('Empty response from AI provider.');
    err.code = 'HELP_EMPTY';
    throw err;
  }

  const fallbackLinks =
    kbAnswer?.links?.length > 0
      ? kbAnswer.links
      : mergeHelpLinks(
          matchHelpArticles(searchText, { limit: 2, minScore: 5, pathname }).map((m) => m.article)
        );

  return { content: String(content), source: 'ai', links: fallbackLinks };
}
