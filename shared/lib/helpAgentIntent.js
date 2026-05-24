/**
 * Agent intent routing — procedural help vs live ERP data vs hybrid.
 */
import { normalizeHelpQueryText } from './helpTypoTolerance.js';

/** @typedef {'guide' | 'erp_data' | 'hybrid' | 'chitchat' | 'meta'} AgentRoute */

const META_RE =
  /\b(how smart|how intelligent|what are you|who are you|what can you do|are you (an )?ai|are you (a )?bot|are you real|do you learn|can you think|your capabilities|what do you know)\b/i;
const ERP_DATA_RE =
  /\b(how many|what is|what's|show me|current|count|total|balance|stock|inventory|level|open|pending|status of|list my|my recent|do we have|available)\b/i;
const GUIDE_RE =
  /\b(how do i|how to|steps|workflow|walk me through|where do i|help me|guide|procedure|mistake|fix|error|blocked|locked)\b/i;
const CHITCHAT_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|bye)\b/i;

/**
 * @param {string} message
 * @param {Array<{ role?: string; content?: string }>} [history]
 * @returns {AgentRoute}
 */
export function classifyAgentRoute(message, history = []) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  if (!q) return 'guide';
  if (META_RE.test(q)) return 'meta';
  if (CHITCHAT_RE.test(q) && q.length < 50) return 'chitchat';

  const erp = ERP_DATA_RE.test(q);
  const guide = GUIDE_RE.test(q);

  if (erp && guide) return 'hybrid';
  if (erp) return 'erp_data';
  if (guide) return 'guide';

  // Short data-ish questions without "how to"
  if (ERP_DATA_RE.test(q) || /\b(qt-|rcp-|rf-|po-|product\s+[a-z0-9])/i.test(q)) {
    return 'erp_data';
  }

  return 'guide';
}

/**
 * @param {AgentRoute} route
 */
export function routeLabel(route) {
  switch (route) {
    case 'erp_data':
      return 'Live ERP data';
    case 'hybrid':
      return 'Guide + ERP data';
    case 'chitchat':
      return 'Conversation';
    case 'meta':
      return 'About the assistant';
    default:
      return 'Workflow guide';
  }
}
