/**
 * AI Automation Engine — Phase 5 structured action proposals.
 *
 * @module server/aiAutomationEngine
 */

export { registerAiAutomationRoutes } from './routes/aiProposalRoutes.js';
export {
  createActionProposal,
  approveActionProposal,
  rejectActionProposal,
  getActionProposals,
  getActionProposalById,
} from './services/aiActionProposalService.js';
export {
  routeAutomationRequest,
  shouldCreateProposal,
} from './services/aiAutomationRouterService.js';
export {
  FORBIDDEN_AUTO_ACTIONS,
  classifyProposalRisk,
  resolveRequiredApprovalLevel,
  validateProposalForCreation,
  validateProposalApproval,
  userMayApproveProposal,
} from './services/aiSafetyGuardService.js';
export {
  createMemoAutomationProposal,
  createFilingAutomationProposal,
} from './services/memoAutomationService.js';
export { createExpenseAutomationProposal } from './services/expenseAutomationService.js';
export { createHrLetterAutomationProposal } from './services/hrLetterAutomationService.js';
export { createWorkflowAutomationProposal } from './services/workflowAutomationService.js';
export {
  newProposalId,
  proposalsTableReady,
  mapProposalRow,
  insertProposal,
  getProposalById,
  listProposals,
  updateProposal,
} from './repository/proposalRepository.js';
export { isAutomationEnabled, readAutomationConfig } from './config/automationConfig.js';
export {
  processMemoAutomationHook,
  processExpenseAutomationHook,
  processHrLetterAutomationHook,
} from './bridges/automationHooks.js';
export { logAutomation } from './utils/automationLogger.js';
export * as aiProposalController from './controllers/aiProposalController.js';
