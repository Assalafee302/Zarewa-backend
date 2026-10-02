/**
 * AI Knowledge Center module entry point.
 *
 * @module server/aiKnowledgeCenter
 */

export { registerAiKnowledgeCenterRoutes } from './routes/knowledgeRoutes.js';
export {
  initKnowledgeCenter,
  createKnowledge,
  updateKnowledge,
  archiveKnowledge,
  getKnowledgeById,
  listKnowledge,
  getKnowledgeVersions,
  getKnowledgeByCategory,
  getKnowledgeByModule,
  getKnowledgeByTags,
} from './services/knowledgeService.js';
export {
  searchKnowledge,
  runSemanticSearch,
  runKeywordSearch,
} from './services/knowledgeSearchService.js';
export {
  HYBRID_KEYWORD_WEIGHT,
  HYBRID_SEMANTIC_WEIGHT,
  HYBRID_DEFAULT_TOP_N,
  buildKeywordScoreMap,
  buildSemanticScoreMap,
  mergeHybridResults,
} from './services/hybridSearchService.js';
export { getKnowledgeCenterStats } from './services/knowledgeStatsService.js';
export {
  generateEmbedding,
  batchGenerateEmbeddings,
  readEmbeddingModelConfig,
  hashEmbeddingContent,
} from './services/embeddingService.js';
export {
  indexKnowledgeRecord,
  updateEmbedding,
  reindexAllKnowledge,
  scheduleIndexKnowledgeRecord,
  indexableTextFromRecord,
} from './services/embeddingIndexerService.js';
export {
  validateCreateKnowledge,
  validateUpdateKnowledge,
  validateSearchKnowledge,
  validateListQuery,
} from './validators/knowledgeValidator.js';
export {
  parseJsonStringArray,
  parseJsonObject,
  mapRowToKnowledgeRecord,
  buildBodyText,
  newKnowledgeRecordId,
  newKnowledgeVersionId,
} from './models/knowledgeRecordModel.js';
export {
  cosineSimilarity,
  normalizeSemanticScore,
} from './utils/vectorMath.js';
export {
  ensureAiKnowledgeCenterTables,
  findKnowledgeRecordById,
  listKnowledgeRecords,
  insertKnowledgeRecord,
  updateKnowledgeRecord,
  archiveKnowledgeRecord,
  listKnowledgeVersions,
  ensureEmbeddingPlaceholder,
  markEmbeddingStale,
  aggregateKnowledgeStats,
  keywordSearchRecords,
} from './repository/knowledgeRepository.js';
export {
  getEmbeddingRow,
  saveReadyEmbedding,
  markEmbeddingFailed,
  listSearchableEmbeddings,
  listRecordIdsNeedingIndex,
  countEmbeddingsByStatus,
} from './repository/embeddingRepository.js';
export * as knowledgeController from './controllers/knowledgeController.js';
