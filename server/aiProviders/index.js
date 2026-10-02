/**
 * Multi-provider AI layer — OpenAI, Hugging Face, Ollama.
 *
 * @module server/aiProviders
 */

export { routeAIRequest, getUsageSummary } from './aiProviderRouter.js';
export { healthCheckProviders } from './healthCheck.js';
export {
  isHuggingFaceEnabled,
  readHuggingFaceApiKey,
  readProviderConfig,
  isProviderLayerAvailable,
} from './config/providerConfig.js';
export {
  recordProviderUsage,
  getOpenAiDailyTokenUsage,
  isOpenAiOverDailyLimit,
  buildProviderChain,
  recordTextUsage,
  _resetUsageForTests,
} from './costController.js';
export {
  getTaskRouting,
  isHuggingFacePreferredTask,
  isOpenAiOnlyTask,
  resolveModelForTask,
  TASK_REGISTRY,
  HF_MODELS,
} from './modelRegistry.js';
export { createEmbedding, createBatchEmbeddings, normalizeVector } from './embeddingProvider.js';
export { registerAiProviderRoutes } from './routes/providerRoutes.js';
export { logProvider } from './utils/providerLogger.js';
export { isOpenAiProviderAvailable } from './openaiProvider.js';
export { readHuggingFaceConfig } from './huggingfaceProvider.js';
export { isOllamaProviderAvailable } from './ollamaProvider.js';
export * as openaiProvider from './openaiProvider.js';
export * as huggingfaceProvider from './huggingfaceProvider.js';
export * as ollamaProvider from './ollamaProvider.js';
