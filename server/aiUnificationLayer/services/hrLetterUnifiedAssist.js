/**
 * HR letter assist via unified AI layer (suggestion-only).
 *
 * @module server/aiUnificationLayer/services/hrLetterUnifiedAssist
 */

import { analyzeQuery } from '../../aiIntelligenceRouter/services/aiRouterService.js';
import { isUnifiedAiEnabled } from '../config/unifiedAiConfig.js';
import { logUnified } from '../utils/unifiedAiLogger.js';
import { UNIFIED_AI_ORIGINS } from '../../../shared/lib/aiUnification/unifiedResponseTypes.js';

const LETTER_KIND_BY_TONE = [
  { pattern: /\b(disciplinary|warning|misconduct|termination|dismissal)\b/i, kind: 'dismissal', tone: 'disciplinary' },
  { pattern: /\b(warning|verbal warning|written warning)\b/i, kind: 'probation_extension', tone: 'warning' },
  { pattern: /\b(appointment|promotion|confirm)\b/i, kind: 'appointment', tone: 'formal' },
  { pattern: /\b(leave|vacation|annual leave)\b/i, kind: 'leave_approval', tone: 'formal' },
  { pattern: /\b(reject|decline|cannot approve)\b/i, kind: 'leave_rejection', tone: 'formal' },
  { pattern: /\b(salary|increment|bonus)\b/i, kind: 'salary_increment', tone: 'formal' },
  { pattern: /\b(transfer|relocate|reassign)\b/i, kind: 'transfer_inter_branch', tone: 'formal' },
  { pattern: /\b(experience|certificate|service)\b/i, kind: 'certificate_of_service', tone: 'formal' },
  { pattern: /\b(confidential|nda|non-disclosure)\b/i, kind: 'nda', tone: 'formal' },
];

const STRUCTURE_TIPS = [
  'Use formal salutation and closing (Yours faithfully).',
  'Include effective date and employee identifiers.',
  'State purpose in the opening paragraph.',
  'Avoid informal language in official letters.',
];

/**
 * @param {object} body
 */
export function suggestHrLetterAssist(body = {}) {
  const purpose = String(body.purpose || body.description || body.draftText || '').trim();
  const letterKind = String(body.letterKind || '').trim().toLowerCase();
  const draftText = String(body.draftText || body.body || '').trim();
  const combined = `${purpose}\n${draftText}`.trim();

  const suggestions = [];
  let suggestedKind = letterKind || null;
  let suggestedTone = 'formal';

  for (const rule of LETTER_KIND_BY_TONE) {
    if (rule.pattern.test(combined)) {
      if (!suggestedKind) suggestedKind = rule.kind;
      suggestedTone = rule.tone;
      break;
    }
  }

  if (suggestedKind) {
    suggestions.push(`Suggested template: ${suggestedKind.replace(/_/g, ' ')}`);
  }
  suggestions.push(`Suggested tone: ${suggestedTone}`);

  if (draftText.length > 0 && draftText.length < 80) {
    suggestions.push('Draft is short — add context, dates, and specific terms.');
  }
  if (draftText && /\b(hey|hi there|thanks!)\b/i.test(draftText)) {
    suggestions.push('Consider more formal language for official HR correspondence.');
  }

  const grammarTips = [];
  if (draftText && !/\b(Dear|TO WHOM IT MAY CONCERN)\b/i.test(draftText)) {
    grammarTips.push('Add a formal opening (Dear [Name] or TO WHOM IT MAY CONCERN).');
  }
  if (draftText && !/\b(Yours faithfully|Yours sincerely)\b/i.test(draftText)) {
    grammarTips.push('Add a formal closing (Yours faithfully).');
  }

  return {
    ok: true,
    aiSuggestionOnly: true,
    suggestedLetterKind: suggestedKind,
    suggestedTone,
    suggestedTemplate: suggestedKind,
    structureTips: STRUCTURE_TIPS.slice(0, 3),
    grammarTips,
    unifiedSuggestions: [...suggestions, ...grammarTips],
    unifiedAi: {
      enabled: true,
      mode: 'suggest',
      source: 'rules',
    },
  };
}

/**
 * Enrich with router analysis when unified mode is on.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 */
export async function enrichHrLetterAssist(db, user, body = {}) {
  const base = suggestHrLetterAssist(body);
  if (!isUnifiedAiEnabled()) return base;

  const text = [body.purpose, body.draftText, body.body, body.description].filter(Boolean).join('\n');
  if (!text.trim()) return base;

  try {
    const analysis = analyzeQuery(text, { module: 'hr', role: user?.roleKey });
    const suggestions = [...(base.unifiedSuggestions || [])];
    if (analysis.suggestedModule === 'hr') {
      suggestions.push('HR module context detected — use official letter workflow.');
    }
    if (analysis.intent) {
      suggestions.push(`Query intent: ${analysis.intent}`);
    }

    logUnified('hr_letter_assist', {
      moduleOrigin: UNIFIED_AI_ORIGINS.LETTER,
      suggestedKind: base.suggestedLetterKind,
      intent: analysis.intent,
    });

    return {
      ...base,
      unifiedSuggestions: suggestions,
      unifiedAi: {
        ...base.unifiedAi,
        source: 'router',
        intent: analysis.intent,
        confidence: analysis.intentConfidence,
      },
    };
  } catch (e) {
    logUnified('hr_letter_assist_error', { error: String(e?.message || e) });
    return base;
  }
}
