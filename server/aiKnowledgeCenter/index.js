/**
 * AI Knowledge Center module entry point.
 *
 * @module server/aiKnowledgeCenter
 */

export { registerAiKnowledgeCenterRoutes } from './routes/knowledgeRoutes.js';
export { initKnowledgeCenter, createKnowledge, listKnowledge } from './services/knowledgeService.js';
export { searchKnowledge } from './services/knowledgeSearchService.js';
export { getKnowledgeCenterStats } from './services/knowledgeStatsService.js';
export {
  generateEmbedding,
  batchGenerateEmbeddings,
  readEmbeddingModelConfig,
} from './services/embeddingService.js';
export {
  indexKnowledgeRecord,
  reindexAllKnowledge,
  scheduleIndexKnowledgeRecord,
} from './services/embeddingIndexerService.js';
