/**
 * Rule-based memo writing assistant — works without AI key.
 */
import {
  MANAGER_REPLY_TEMPLATES,
  SMART_MEMO_TYPES,
  buildSmartMemoChecklist,
  buildSmartMemoSuggestions,
  detectSmartMemoType,
  improveMemoRuleBased,
} from './smartMemoComposer.js';

const FORMAL_OPENERS = ['Dear Team,', 'Please be advised that', 'This memo serves to'];
const SHORTER_MAX = 480;

/**
 * @param {string} body
 */
function makeShorter(body) {
  const text = String(body || '').trim();
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.slice(0, Math.max(2, Math.ceil(sentences.length * 0.6)));
  let out = kept.join(' ');
  if (out.length > SHORTER_MAX) out = `${out.slice(0, SHORTER_MAX).trim()}…`;
  return out;
}

/**
 * @param {string} body
 */
function makeFormal(body) {
  const text = String(body || '').trim();
  if (!text) return `${FORMAL_OPENERS[0]}\n\nPlease review and advise.`;
  const cleaned = text.replace(/\b(hey|hi|pls|plz|u)\b/gi, (m) => {
    const map = { hey: 'Dear Team', hi: 'Dear Team', pls: 'please', plz: 'please', u: 'you' };
    return map[m.toLowerCase()] || m;
  });
  if (!FORMAL_OPENERS.some((o) => cleaned.startsWith(o))) {
    return `${FORMAL_OPENERS[1]} ${cleaned}`;
  }
  return cleaned;
}

/**
 * @param {string} body
 */
function fixGrammar(body) {
  let t = String(body || '').trim();
  if (!t) return t;
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\bi\b/g, 'I');
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/**
 * @param {object} input
 */
export function runMemoAssist(input = {}) {
  const action = String(input.action || 'classify').trim().toLowerCase();
  const subject = String(input.subject || '');
  const body = String(input.body || '');
  const memoType = input.memoType || detectSmartMemoType(subject, body);
  const suggestions = buildSmartMemoSuggestions({
    subject,
    body,
    memoType,
    guidedFields: input.guidedFields || {},
    attachmentCount: Number(input.attachmentCount) || 0,
  });
  const checklist = buildSmartMemoChecklist(
    memoType,
    input.guidedFields || {},
    Number(input.attachmentCount) || 0
  );
  const meta = SMART_MEMO_TYPES[memoType] || SMART_MEMO_TYPES.general_internal;

  /** @type {Record<string, unknown>} */
  const base = {
    memoType,
    responsibleOffice: suggestions.responsibleOfficeKey,
    priority: suggestions.priority,
    filingCategory: suggestions.filingCategory,
    expenseCategory: suggestions.expenseCategory,
    requiredDetails: checklist.items.filter((i) => i.required).map((i) => i.label),
    missingDetails: checklist.missingRequired.map((m) => m.label),
    suggestedAttachments: suggestions.suggestedAttachments,
    nextActions: [meta.nextAction],
    warnings: checklist.warning ? [checklist.warning] : [],
    confidence: memoType === 'general_internal' ? 0.55 : 0.82,
  };

  if (action === 'classify' || action === 'checklist' || action === 'suggest_route') {
    return { ...base, suggestedSubject: subject, improvedBody: body };
  }

  if (action === 'suggest_expense_category') {
    return {
      ...base,
      expenseCategory: suggestions.expenseCategory,
      suggestedSubject: subject,
      improvedBody: body,
    };
  }

  if (action === 'suggest_filing_category') {
    return {
      ...base,
      filingCategory: suggestions.filingCategory,
      suggestedSubject: subject,
      improvedBody: body,
    };
  }

  if (action === 'manager_reply') {
    const tpl = MANAGER_REPLY_TEMPLATES.find((t) => t.id === input.templateId) || MANAGER_REPLY_TEMPLATES[0];
    return {
      ...base,
      suggestedSubject: subject,
      improvedBody: tpl.body,
      nextActions: ['Send reply in thread'],
      confidence: 0.9,
    };
  }

  let improved = { subject, body };
  if (action === 'improve' || action === 'make_formal') {
    improved = improveMemoRuleBased(subject, body, memoType);
    if (action === 'make_formal') improved.body = makeFormal(improved.body);
  } else if (action === 'make_shorter') {
    improved = { subject, body: makeShorter(body) };
  } else if (action === 'fix_grammar') {
    improved = { subject: fixGrammar(subject), body: fixGrammar(body) };
  } else {
    improved = improveMemoRuleBased(subject, body, memoType);
  }

  return {
    ...base,
    suggestedSubject: improved.subject,
    improvedBody: improved.body,
  };
}
