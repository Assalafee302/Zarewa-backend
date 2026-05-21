import {
  HELP_ARTICLES,
  formatHelpArticleReply,
  helpArticleLinks,
  matchHelpArticle,
} from '../shared/lib/helpKnowledge.js';
import { readAiAssistConfig, sanitizeClientMessages, normalizeCompletionContent, chatCompletionsUrl } from './aiAssist.js';

const HELP_KB_EXCERPT_MAX = 14000;

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

  const match = matchHelpArticle(message);
  if (match && match.score >= 4) {
    return {
      content: formatHelpArticleReply(match.article),
      source: 'kb',
      links: helpArticleLinks(match.article),
    };
  }

  const cfg = readAiAssistConfig();
  if (!cfg.enabled) {
    return {
      content: [
        "I couldn't find a close match in the built-in help guides.",
        '',
        'Try one of the quick questions, or rephrase with words like **receipt**, **quotation**, **refund**, **cutting list**, or **period locked**.',
        '',
        'Full department guides are in **Settings** on this app.',
      ].join('\n'),
      source: 'fallback',
      links: [{ label: 'Settings & guides', to: '/settings' }],
    };
  }

  const sanitized = sanitizeClientMessages(opts.messages);
  const history =
    sanitized.length > 0
      ? sanitized
      : [{ role: 'user', content: message }];

  const pathname = String(opts.pathname || '').trim().slice(0, 200);
  const who = String(opts.userDisplay || '').trim().slice(0, 120);

  const system = [
    'You are the Zarewa Help Assistant — a friendly procedural guide for staff using the Zarewa web app.',
    'Answer ONLY with steps and navigation inside Zarewa. You cannot click buttons or change data.',
    'Prefer the knowledge base below over general assumptions. If unsure, say what to check in the app and suggest Settings → workspace guide.',
    'Keep answers concise: short intro, numbered steps, and mention relevant menu paths (Sales, Finance, Operations, etc.).',
    'Never invent module names or URLs that are not in the knowledge base unless they are standard paths like /sales, /accounts, /settings.',
    'For money, tax, or legal decisions, remind the user to confirm with Finance or management.',
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
      messages: [{ role: 'system', content: system }, ...history.slice(-12)],
      max_tokens: 900,
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
    const err = new Error('Empty response from AI provider.');
    err.code = 'HELP_EMPTY';
    throw err;
  }

  return { content: String(content), source: 'ai', links: [] };
}
