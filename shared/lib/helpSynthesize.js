/**
 * RAG-style help response synthesis — retrieve guides, then generate a conversational
 * answer instead of dumping raw article text (ChatGPT-style pipeline, no GPU required).
 */

import { guideClearanceFootnote } from './helpClearance.js';
import { HELP_BOT_GUIDE_PRINCIPLE, HELP_BOT_NAME } from './helpBotBrand.js';
import { normalizeHelpQueryText } from './helpTypoTolerance.js';

/** @typedef {'greeting' | 'thanks' | 'follow_up' | 'clarify' | 'workflow' | 'meta' | 'unknown'} HelpIntent */
const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening|greetings|howdy|salam|assalam)\b/i;
const THANKS_RE = /^(thanks|thank you|got it|perfect|great|ok thanks|cheers)\b/i;
const META_RE =
  /\b(how smart|how intelligent|what are you|who are you|what can you do|are you (an )?ai|are you (a )?bot|are you real|do you learn|can you think|your capabilities|what do you know|how do you work)\b/i;
const FOLLOW_UP_RE =
  /\b(what about|and then|tell me more|more detail|step\s+\d|next step|you said|you mentioned|also|what if|how about|continue|go on|explain that)\b/i;
const CLARIFY_RE = /\b(what do you mean|which one|where exactly|which tab|which screen|confused|don't understand)\b/i;
/** New workflow questions — not continuations of the previous answer. */
const NEW_TOPIC_RE =
  /\b(how (can|do|to)|where (can|do|to)|what is|who can|help me|register|create|add|new|delete|remove|onboard|set up|setup)\b/i;

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
  if (FOLLOW_UP_RE.test(q)) return 'follow_up';
  const userTurns = (history || []).filter((m) => m?.role === 'user').length;
  if (userTurns >= 2 && q.length < 50 && !NEW_TOPIC_RE.test(q)) return 'follow_up';
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
    `Hi${who} — I'm **${HELP_BOT_NAME}**, your **Zarewa how-to guide** for SOPs, screen-by-screen steps, and company workflow rules.`,
    '',
    HELP_BOT_GUIDE_PRINCIPLE,
    '',
    'I can explain **why** something is blocked (permissions, period lock, missing attachment) and **who** normally handles the next step — but I never approve, post, pay, or save records for you in chat.',
    aiOn
      ? '**AI polish is on** — answers stay grounded in Zarewa guides and permission-safe data only.'
      : '**AI polish is off** — I still answer from built-in guides without an external API key.',
    '',
    'Ask things like: *How do I register staff?* · *What is the receipt workflow?* · *Why can’t I approve this?* (I’ll explain the rule, not press Approve for you.)',
    '',
    'I learn from feedback and usage patterns to surface better guides — not by retraining a model inside your ERP. RBAC always applies.',
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
    return [
      `Hello${who}! I'm **${HELP_BOT_NAME}** — here to help you use **${page}** the right way.`,
      '',
      'Ask **how do I…** for step-by-step SOPs, or **why can’t I…** when something is blocked. I guide only; you keep control of every button in Zarewa.',
    ].join('\n');
  }

  if (intent === 'thanks') {
    return name ? `You're welcome, ${name}.` : "You're welcome.";
  }

  if (!articles.length) {
    return [
      "I'm not sure which workflow you mean yet — and that's okay.",
      '',
      'Try naming the area (**Sales**, **Finance**, **Operations**, **Settings**, **HR**) or the document (**receipt**, **quotation**, **PO**, **refund**, **memo**).',
      '',
      'Example: *How do I record a receipt?* or *How do I register a new staff user?*',
    ].join('\n');
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
    const lines = [`More on **${primary.title.replace(/^How to /i, '')}**:`];
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
      lines.push('', '**In Zarewa, you do this:**');
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
    `You are ${HELP_BOT_NAME} — an expert Zarewa ERP guide. Answer at the quality of ChatGPT or Gemini: clear, accurate, and actionable.`,
    'Hard rules:',
    `- ${HELP_BOT_GUIDE_PRINCIPLE}`,
    '- NEVER say you approved, posted, paid, saved, rejected, or will perform any ERP action for the user.',
    '- NEVER tell the user you clicked a button or changed data — only explain what THEY should click.',
    '- For approval questions: explain rules, roles, and who normally approves; do not impersonate an approver.',
    'Architecture: RAG — ground every step in the retrieved guides below. Never invent modules, buttons, URLs, or document numbers.',
    'Tone: warm, clear, professional — like a helpful senior colleague who knows Zarewa inside out.',
    'Style:',
    '- Lead with a direct 1–2 sentence answer to what they asked.',
    '- Then numbered steps — only the steps relevant to their question (max 6 unless they asked for the full workflow).',
    '- Use **bold** for screen names, tabs, and document types (Receipt, Quotation, PO).',
    '- If they are continuing a conversation, reference prior context briefly — do not repeat the whole guide.',
    '- For multi-part questions, structure with short headings.',
    '- End with one short friendly offer: e.g. "Want the Finance posting steps next?" or "Should I explain who can approve this?"',
    '- Never paste the entire knowledge base. Never say "as an AI model" or "I cannot access your data".',
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
