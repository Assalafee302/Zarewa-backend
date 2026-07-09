/**
 * Unified AI orchestration layer — Phase 4 integration module.
 *
 * @module server/aiUnificationLayer
 */

export { registerUnifiedAiRoutes } from './routes/unifiedAiRoutes.js';
export {
  unifiedQuery,
  runUnifiedHelpChat,
  formatUnifiedQueryHttpResponse,
  isUnifiedAiEnabled,
  helpResultToUnifiedResponse,
} from './services/aiOrchestratorService.js';
export { enrichMemoAssist } from './services/memoUnifiedAssist.js';
export { enrichExpenseSuggest } from './services/expenseUnifiedAssist.js';
export { enrichHrLetterAssist, suggestHrLetterAssist } from './services/hrLetterUnifiedAssist.js';
export { readUnifiedAiConfig } from './config/unifiedAiConfig.js';
