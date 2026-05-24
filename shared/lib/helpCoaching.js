/**
 * Step-by-step coaching mode for Runa.
 */
import { selectRelevantSteps } from './helpSynthesize.js';
import { normalizeHelpQueryText } from './helpTypoTolerance.js';

const COACHING_START_RE =
  /\b(walk me through|step by step|guide me through|coaching mode|help me create|help me with)\b/i;
const COACHING_NEXT_RE =
  /^(next|continue|go on|what next|what now|proceed)\b|^(step\s+\d+)\b|^\d+\s*[\.)]/i;
const COACHING_STUCK_RE =
  /\b(stuck|can't|cannot|confused|where is|where do i|which button|which tab|why can't)\b/i;
const COACHING_EXIT_RE = /^(stop|exit|cancel coaching|done)\b/i;

export function isCoachingMessage(message, history = []) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  if (!q) return false;
  if (COACHING_EXIT_RE.test(q)) return false;
  if (COACHING_START_RE.test(q)) return true;
  if (COACHING_NEXT_RE.test(q)) return true;
  if (COACHING_STUCK_RE.test(q)) return true;
  const priorCoach = (history || []).some(
    (m) => m?.role === 'assistant' && /step \d+ of/i.test(String(m.content || ''))
  );
  return priorCoach && q.length < 80;
}

export function parseCoachingStepRequest(message) {
  const q = String(message || '').trim();
  const m = q.match(/step\s+(\d+)/i) || q.match(/^(\d+)\s*[\.)]/);
  if (m) return Math.max(0, Number(m[1]) - 1);
  if (COACHING_NEXT_RE.test(normalizeHelpQueryText(q))) return 'next';
  if (COACHING_STUCK_RE.test(q)) return 'stuck';
  return null;
}

export function buildCoachingReply(opts) {
  const articles = Array.isArray(opts.articles) ? opts.articles.filter(Boolean) : [];
  const article = articles[0];
  if (!article) {
    return {
      content: 'Tell me which workflow to coach you through (e.g. quotation, receipt, refund, PO).',
      coaching: { active: false, stepIndex: 0, totalSteps: 0, articleId: null },
    };
  }

  const steps =
    Array.isArray(opts.totalSteps) && opts.totalSteps.length
      ? opts.totalSteps
      : selectRelevantSteps(article, opts.message, 8);

  let stepIndex = Number(opts.stepIndex) || 0;
  const req = parseCoachingStepRequest(opts.message);

  if (req === 'next') stepIndex = Math.min(steps.length - 1, stepIndex + 1);
  else if (typeof req === 'number') stepIndex = Math.min(steps.length - 1, Math.max(0, req));
  else if (COACHING_START_RE.test(String(opts.message || ''))) stepIndex = 0;

  const step = steps[stepIndex];
  const lines = [
    `**Coaching — ${article.title.replace(/^How to /i, '')}**`,
    '',
    `**Step ${stepIndex + 1} of ${steps.length}:**`,
    step || '(no step)',
  ];

  if (parseCoachingStepRequest(opts.message) === 'stuck') {
    lines.push('', '_Complete this step in the app, then say **next**._');
  } else if (stepIndex < steps.length - 1) {
    lines.push('', 'Say **next** when you are ready for the following step.');
  } else {
    lines.push('', 'That is the last step. Say **stop** to exit coaching mode.');
  }

  return {
    content: lines.join('\n'),
    coaching: {
      active: true,
      stepIndex,
      totalSteps: steps.length,
      articleId: article.id,
      steps,
    },
  };
}
