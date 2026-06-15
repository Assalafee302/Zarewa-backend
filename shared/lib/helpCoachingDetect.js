/**
 * Coaching-mode detection — kept separate from helpCoaching.js so helpAgentIntent
 * does not pull helpSynthesize into the same module init graph (avoids TDZ in prod bundles).
 */
import { normalizeHelpQueryText } from './helpTypoTolerance.js';

const COACHING_START_RE =
  /\b(walk me through|step by step|guide me through|coaching mode|help me create|help me with)\b/i;
const COACHING_NEXT_RE =
  /^(next|continue|go on|what next|what now|proceed)\b|^(step\s+\d+)\b|^\d+\s*[.)]/i;
const COACHING_STUCK_RE =
  /\b(stuck|can't|cannot|confused|where is|where do i|which button|which tab|why can't)\b/i;
const COACHING_EXIT_RE = /^(stop|exit|cancel coaching|done)\b/i;

export { COACHING_START_RE, COACHING_NEXT_RE, COACHING_STUCK_RE, COACHING_EXIT_RE };

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
  const m = q.match(/step\s+(\d+)/i) || q.match(/^(\d+)\s*[.)]/);
  if (m) return Math.max(0, Number(m[1]) - 1);
  if (COACHING_NEXT_RE.test(normalizeHelpQueryText(q))) return 'next';
  if (COACHING_STUCK_RE.test(q)) return 'stuck';
  return null;
}
