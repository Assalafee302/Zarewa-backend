/**
 * RAG-style help response synthesis — retrieve guides, then generate a conversational
 * answer instead of dumping raw article text (ChatGPT-style pipeline, no GPU required).
 */

import { guideClearanceFootnote } from './helpClearance.js';

/** @typedef {'greeting' | 'thanks' | 'follow_up' | 'clarify' | 'workflow' | 'meta' | 'unknown'} HelpIntent */

import { normalizeHelpQueryText } from './helpTypoTolerance.js';
const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening|greetings|howdy|salam|assalam)\b/i;
const THANKS_RE = /^(thanks|thank you|got it|perfect|great|ok thanks|cheers)\b/i;
const META_RE =
  /\b(how smart|how intelligent|what are you|who are you|what can you do|are you (an )?ai|are you (a )?bot|are you real|do you learn|can you think|your capabilities|what do you know|how do you work)\b/i;
const FOLLOW_UP_RE =
  /\b(what about|and then|tell me more|more detail|step\s+\d|next step|you said|you mentioned|also|what if|how about|continue|go on|explain that)\b/i;
const CLARIFY_RE = /\b(what do you mean|which one|where exactly|which tab|which screen|confused|don't understand)\b/i;

/**
 * @param {string} message
 * @param {Array<{ role?: string; content?: string }>} [history]
 * @returns {HelpIntent}
 */
export function detectHelpIntent(message, history = []) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  if (!q) return 'unknown';
  if (META_RE.test(q)) return 'meta';
  if (GREETING_RE.test(q) && q.length < 40) return 'greeting';
  if (THANKS_RE.test(q) && q.length < 60) return 'thanks';
  if (CLARIFY_RE.test(q)) return 'clarify';
  const userTurns = (history || []).filter((m) => m?.role === 'user').length;
  if (FOLLOW_UP_RE.test(q) || (userTurns >= 2 && q.length < 90)) return 'follow_up';
  return 'workflow';
}

/**
 * @param {string} q
 * @returns {string[]}
 */
function tokens(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * @param {import('./helpKnowledge.js').HelpArticle} article
 * @param {string} message
 * @param {number} maxSteps
 */
export function selectRelevantSteps(article, message, maxSteps = 5) {
  const msgTokens = new Set(tokens(message));
  const scored = (article.steps || []).map((step, idx) => {
    const stepTokens = tokens(step);
    let score = 0;
    for (const t of stepTokens) {
      if (msgTokens.has(t)) score += 2;
    }
    score += Math.max(0, 3 - idx * 0.3);
    return { step, score, idx };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, maxSteps).sort((a, b) => a.idx - b.idx);
  if (!picked.length) return (article.steps || []).slice(0, maxSteps);
  return picked.map((p) => p.step);
}

/**
 * @param {string} pathname
 */
function pageContextLabel(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/sales')) return 'Sales';
  if (p.startsWith('/accounts')) return 'Finance';
  if (p.startsWith('/operations')) return 'Operations';
  if (p.startsWith('/procurement')) return 'Procurement';
  if (p.startsWith('/manager')) return 'Manager';
  if (p.startsWith('/settings')) return 'Settings';
  return 'Zarewa';
}

/**
 * @param {string} answer
 * @param {number} maxSentences
 */
function summarizeAnswer(answer, maxSentences = 2) {
  const parts = String(answer || '')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  if (parts.length <= maxSentences) return parts.join(' ');
  return parts.slice(0, maxSentences).join(' ');
}

/**
 * @param {import('./helpKnowledge.js').HelpArticle} article
 * @param {string} message
 */
function directOpening(article, message) {
  const q = String(message || '').toLowerCase();
  const title = article.title.replace(/^How to /i, '').replace(/\?$/, '');
  if (/\b(mistake|wrong|fix|error|can't|cannot|blocked|locked)\b/i.test(q)) {
    return `For **${title.toLowerCase()}**, here's the practical path:`;
  }
  if (/\b(how|where|what|walk|step)\b/i.test(q)) {
    return `Here's how **${title.toLowerCase()}** works in Zarewa:`;
  }
  return summarizeAnswer(article.answer, 2);
}

/**
 * @param {{
 *   message: string;
 *   history?: Array<{ role?: string; content?: string }>;
 *   articles: import('./helpKnowledge.js').HelpArticle[];
 *   pathname?: string;
 *   userDisplay?: string;
 *   roleKey?: string;
 *   pace?: 'fast' | 'normal' | 'deep';
 *   intent?: HelpIntent;
 *   transactionProfile?: import('./helpUserActivity.js').TransactionProfile;
 *   user?: { permissions?: string[]; roleKey?: string };
 *   externalAiEnabled?: boolean;
 * }} opts
 * @returns {string}
 */
export function synthesizeMetaReply(opts = {}) {
  const name = String(opts?.userDisplay || '').trim().split(/\s+/)[0];
  const who = name ? ` ${name}` : '';
  const aiOn = Boolean(opts.externalAiEnabled);
  return [
    `Hi${who} — I'm **Zarewa Coach**, built for your ERP workflows (quotations, receipts, PO, refunds, production).`,
    '',
    'I search **44+ guides**, respect your **role clearance**, and can read **live ERP data** when your permissions allow.',
    aiOn
      ? '**AI polish is on** — answers stay grounded in Zarewa data only.'
      : '**AI polish is off** — I still answer from guides and tools without an external API key.',
    '',
    'I will not invent numbers or bypass your clearance. Ask "how do I…" for steps, or "what is…" for live data.',
  ].join('\n');
}

/**
 * @param {{
 *   message: string;
 *   history?: Array<{ role?: string; content?: string }>;
 *   articles: import('./helpKnowledge.js').HelpArticle[];
 *   pathname?: string;
 *   userDisplay?: string;
 *   roleKey?: string;
 *   pace?: 'fast' | 'normal' | 'deep';
 *   intent?: HelpIntent;
 *   transactionProfile?: import('./helpUserActivity.js').TransactionProfile;
 *   user?: { permissions?: string[]; roleKey?: string };
 * }} opts
 * @returns {string}
 */
export function synthesizeHelpReply(opts) {
  const message = String(opts?.message || '').trim();
  const history = Array.isArray(opts?.history) ? opts.history : [];
  const articles = Array.isArray(opts?.articles) ? opts.articles.filter(Boolean) : [];
  const pathname = String(opts?.pathname || '');
  const pace = opts?.pace || 'normal';
  const intent = opts?.intent || detectHelpIntent(message, history);
  const page = pageContextLabel(pathname);
  const name = String(opts?.userDisplay || '').trim().split(/\s+/)[0];

  if (intent === 'meta') {
    return synthesizeMetaReply({
      userDisplay: opts.userDisplay,
      externalAiEnabled: opts.externalAiEnabled,
    });
  }

  if (intent === 'greeting') {
    const who = name ? ` ${name}` : '';
    return `Hello${who}! What **${page}** workflow can I help with?`;
  }

  if (intent === 'thanks') {
    return name ? `You're welcome, ${name}.` : "You're welcome.";
  }

  if (!articles.length) {
    return 'I could not match that to a workflow yet. Try naming the module (**Sales**, **Finance**, **Operations**) or document (receipt, quotation, PO, refund).';
  }

  const maxSteps = pace === 'fast' ? 3 : pace === 'deep' ? 6 : 4;

  if (intent === 'clarify' && articles.length) {
    const primary = articles[0];
    const steps = selectRelevantSteps(primary, message, Math.min(maxSteps, 4));
    const lines = [`**${primary.title.replace(/^How to /i, '')}** — key steps:`];
    if (steps.length) steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('', 'Which step or screen is unclear?');
    return lines.join('\n');
  }

  if (intent === 'follow_up' || intent === 'clarify') {
    const primary = articles[0];
    const steps = selectRelevantSteps(primary, message, maxSteps + 1);
    const lines = [`Follow-up on **${primary.title.replace(/^How to /i, '')}**:`];
    if (steps.length) {
      steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    return lines.join('\n');
  }

  if (articles.length === 1) {
    const article = articles[0];
    const steps = selectRelevantSteps(article, message, maxSteps);
    const lines = [directOpening(article, message)];
    if (steps.length) {
      lines.push('', '**Do this:**');
      steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    const remaining = (article.steps || []).length - steps.length;
    if (remaining > 0 && pace === 'deep') {
      lines.push('', `_Ask "tell me more" for ${remaining} additional step(s)._`);
    }
    const clearanceNote = guideClearanceFootnote(article, opts.user || { permissions: [], roleKey: opts.roleKey });
    if (clearanceNote) lines.push('', clearanceNote);
    if (opts?.roleKey === 'finance' && article.id.includes('receipt')) {
      lines.push('', '_Finance tip: check ledger posting status before editing a receipt in Sales._');
    }
    return lines.join('\n');
  }

  const lines = [
    'This crosses a few workflows — here is the order that usually works:',
    '',
  ];
  articles.slice(0, 2).forEach((article, i) => {
    const steps = selectRelevantSteps(article, message, pace === 'fast' ? 2 : 3);
    lines.push(`**Phase ${i + 1} — ${article.title}**`);
    lines.push(summarizeAnswer(article.answer, 1));
    if (steps.length) {
      steps.forEach((s, j) => lines.push(`${j + 1}. ${s}`));
    }
    lines.push('');
  });
  lines.push('Tell me which phase to expand on.');
  return lines.join('\n');
}

/**
 * Build compact RAG context for external AI (retrieved chunks only — not full KB).
 * @param {import('./helpKnowledge.js').HelpArticle[]} articles
 * @param {string} message
 */
export function buildRetrievedContextForAi(articles, message) {
  const list = Array.isArray(articles) ? articles.slice(0, 3) : [];
  if (!list.length) return '';
  const lines = ['Retrieved Zarewa guides (authoritative — do not invent steps outside these):'];
  for (const a of list) {
    lines.push(`\n### ${a.title} (${a.id})`);
    lines.push(a.answer);
    const steps = selectRelevantSteps(a, message, 5);
    if (steps.length) {
      lines.push('Key steps:');
      steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    if (a.links?.length) {
      lines.push(`Screens: ${a.links.map((l) => l.label).join(', ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * System prompt for external AI synthesis (ChatGPT-style instruction tuning).
 * @param {{ retrievedContext: string; pathname?: string; userDisplay?: string; roleKey?: string; pace?: string }} ctx
 */
export function buildHelpAiSystemPrompt(ctx) {
  return [
    'You are the Zarewa Help Assistant — a smart, friendly procedural coach for ERP staff.',
    'Architecture: RAG — you ONLY use the retrieved guides below. Never invent modules, buttons, or URLs.',
    'Style (like ChatGPT):',
    '- Lead with a direct 1–2 sentence answer to what they asked.',
    '- Then numbered steps — only the steps relevant to their question (max 5 unless they asked for full workflow).',
    '- Use **bold** for screen names and document types.',
    '- If they are continuing a conversation, reference prior context briefly — do not repeat the whole guide.',
    '- End with one short offer: e.g. "Want me to break down phase 2?" or "Need the Finance posting rules?"',
    '- Never paste the entire knowledge base. Never say "as an AI model".',
    ctx.userDisplay ? `Staff member: ${ctx.userDisplay}.` : '',
    ctx.roleKey ? `Role: ${ctx.roleKey}.` : '',
    ctx.pathname ? `Current path: ${ctx.pathname}.` : '',
    ctx.pace === 'fast' ? 'User prefers brief answers — keep steps to 3 max.' : '',
    ctx.pace === 'deep' ? 'User reads thoroughly — you may add one extra tip or edge case.' : '',
    '',
    ctx.retrievedContext || '(No guides retrieved — say you need more detail about the workflow.)',
  ]
    .filter(Boolean)
    .join('\n');
}
