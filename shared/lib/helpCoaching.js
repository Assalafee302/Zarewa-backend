/**
 * Step-by-step coaching mode for Zare.
 */
import { selectRelevantSteps } from './helpSynthesize.js';
import {
  COACHING_START_RE,
  isCoachingMessage,
  parseCoachingStepRequest,
} from './helpCoachingDetect.js';

export { isCoachingMessage, parseCoachingStepRequest };

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
