/**
 * Agent intent routing — procedural help, live ERP data, coaching, troubleshooting, etc.
 */
import { normalizeHelpQueryText } from './helpTypoTolerance.js';
import { HELP_BOT_NAME } from './helpBotBrand.js';
import { isCoachingMessage } from './helpCoachingDetect.js';
import { classifyZareIntent, zareIntentToAgentRoute } from './helpZareIntent.js';

/** @typedef {'guide' | 'erp_data' | 'hybrid' | 'chitchat' | 'meta' | 'troubleshoot' | 'clearance' | 'analytics' | 'coaching'} AgentRoute */

const META_RE =
  /\b(how smart|how intelligent|what are you|who are you|what can you do|are you (an )?ai|are you (a )?bot|are you real|do you learn|can you think|your capabilities|what do you know|who is (runa|zare)|what is (runa|zare))\b/i;
const ERP_DATA_RE =
  /\b(how many|what is|what's|show me|current|count|total|balance|stock|inventory|level|open|pending|status of|list my|my recent|do we have|available)\b/i;
const GUIDE_RE =
  /\b(how do i|how to|steps|workflow|walk me through|where do i|help me|guide|procedure)\b/i;
const TROUBLE_RE =
  /\b(error|failed|failure|blocked|locked|not working|why can't|why cant|mistake|wrong|fix|pending forever|stuck)\b/i;
const CLEARANCE_RE =
  /\b(clearance|permission|access denied|not allowed|restricted|why can'?t i see|my role|can i see)\b/i;
const ANALYTICS_RE =
  /\b(summary|overview|trend|compare|report|breakdown|analytics|how much total)\b/i;
const CHITCHAT_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|bye|salam)\b/i;
const FOLLOW_UP_RE =
  /\b(what next|what now|step\s+\d|next step|explain more|tell me more|why is it|show me where|where is)\b/i;

/**
 * @param {string} message
 * @param {Array<{ role?: string; content?: string }>} [history]
 * @returns {AgentRoute}
 */
export function classifyAgentRoute(message, history = [], pageContext = null) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  if (!q) return 'guide';

  const zareIntent = classifyZareIntent(message, history, pageContext);
  const zareRoute = zareIntentToAgentRoute(zareIntent);
  if (zareRoute !== 'guide' || pageContext?.mode === 'transaction_help') {
    if (zareRoute === 'meta') return 'meta';
    if (zareRoute !== 'guide') return zareRoute;
    if (pageContext?.mode === 'transaction_help') return 'troubleshoot';
  }

  if (META_RE.test(q)) return 'meta';
  if (CHITCHAT_RE.test(q) && q.length < 50) return 'chitchat';
  if (isCoachingMessage(q, history) || /\b(step by step|coaching mode)\b/i.test(q)) return 'coaching';
  if (CLEARANCE_RE.test(q)) return 'clearance';
  if (FOLLOW_UP_RE.test(q) && (history || []).filter((m) => m?.role === 'user').length >= 1) {
    return 'guide';
  }

  const erp = ERP_DATA_RE.test(q);
  const guide = GUIDE_RE.test(q);
  const analytics = ANALYTICS_RE.test(q);

  if (analytics && erp) return 'analytics';
  if (erp && guide) return 'hybrid';
  if (erp) return 'erp_data';
  if (guide) return 'guide';
  if (TROUBLE_RE.test(q)) return 'troubleshoot';
  if (analytics) return 'analytics';

  if (/\b(qt-|rcp-|rf-|po-|product\s+[a-z0-9])/i.test(q)) return 'erp_data';

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
    case 'analytics':
      return 'ERP summary';
    case 'troubleshoot':
      return 'Troubleshooting';
    case 'clearance':
      return 'Clearance';
    case 'coaching':
      return 'Coaching mode';
    case 'chitchat':
      return 'Conversation';
    case 'meta':
      return `About ${HELP_BOT_NAME}`;
    default:
      return 'Workflow guide';
  }
}
