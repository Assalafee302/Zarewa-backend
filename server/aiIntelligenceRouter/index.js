/**
 * AI Intelligence Router module entry point.
 *
 * @module server/aiIntelligenceRouter
 */

export { registerAiIntelligenceRouterRoutes } from './routes/aiRouterRoutes.js';
export { routeQuery, analyzeQuery, executeRoute } from './services/aiRouterService.js';
export { detectIntent } from './services/intentClassifierService.js';
