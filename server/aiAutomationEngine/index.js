/**
 * AI Automation Engine — Phase 5 structured action proposals.
 *
 * @module server/aiAutomationEngine
 */

export { registerAiAutomationRoutes } from './routes/aiProposalRoutes.js';
export { createActionProposal, approveActionProposal, rejectActionProposal } from './services/aiActionProposalService.js';
export { routeAutomationRequest, shouldCreateProposal } from './services/aiAutomationRouterService.js';
export { isAutomationEnabled, readAutomationConfig } from './config/automationConfig.js';
export {
  processMemoAutomationHook,
  processExpenseAutomationHook,
  processHrLetterAutomationHook,
} from './bridges/automationHooks.js';
