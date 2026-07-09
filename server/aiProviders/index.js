/**
 * Multi-provider AI layer — OpenAI, Hugging Face, Ollama.
 *
 * @module server/aiProviders
 */

export { routeAIRequest, getUsageSummary } from './aiProviderRouter.js';
export { healthCheckProviders } from './healthCheck.js';
export {
  isHuggingFaceEnabled,
  readProviderConfig,
  isProviderLayerAvailable,
} from './config/providerConfig.js';
export { getTaskRouting, TASK_REGISTRY, HF_MODELS } from './modelRegistry.js';
export { createEmbedding, createBatchEmbeddings, normalizeVector } from './embeddingProvider.js';
export { registerAiProviderRoutes } from './routes/providerRoutes.js';
