/**
 * AI Intelligence Router module entry point.
 *
 * @module server/aiIntelligenceRouter
 */

export { registerAiIntelligenceRouterRoutes } from './routes/aiRouterRoutes.js';
export {
  routeQuery,
  analyzeQuery,
  executeRoute,
  getRouterAnalyticsSummary,
} from './services/aiRouterService.js';
export {
  detectIntent,
  inferSuggestedModule,
  calculateIntentConfidence,
} from './services/intentClassifierService.js';
export {
  buildRoutePlan,
  buildSearchPayload,
  buildFallbackRoutePlan,
} from './services/routingEngineService.js';
export {
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  computeSearchConfidence,
  computeCombinedConfidence,
  resolveResponseMode,
  trimResultsForMode,
  buildRoutingExplanation,
} from './services/confidenceService.js';
export {
  formatResultsAsDraft,
  synthesizeAnswer,
  synthesizeConversationReply,
} from './services/llmSynthesizerService.js';
export {
  ensureRouterAnalyticsTables,
  newRouterLogId,
  insertRouterQueryLog,
  getRouterAnalytics,
} from './repository/routerAnalyticsRepository.js';
export * as aiRouterController from './controllers/aiRouterController.js';
