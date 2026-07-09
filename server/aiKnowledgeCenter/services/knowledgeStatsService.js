/**

 * AI Knowledge Center — dashboard statistics.

 *

 * @module server/aiKnowledgeCenter/services/knowledgeStatsService

 */



import {

  KNOWLEDGE_TYPE_REGISTRY,

  listKnowledgeTypeIds,

} from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';

import { aggregateKnowledgeStats } from '../repository/knowledgeRepository.js';

import { countEmbeddingsByStatus } from '../repository/embeddingRepository.js';

import { readEmbeddingModelConfig } from './embeddingService.js';

import { initKnowledgeCenter } from './knowledgeService.js';



/**

 * Build dashboard statistics for the admin UI.

 *

 * @param {import('better-sqlite3').Database} db

 */

export function getKnowledgeCenterStats(db) {

  initKnowledgeCenter(db);

  const agg = aggregateKnowledgeStats(db);

  const embedCounts = countEmbeddingsByStatus(db);

  const embeddingConfig = readEmbeddingModelConfig();

  const readyEmbeddings = embedCounts.ready || 0;



  /** @type {Record<string, number>} */

  const byStatKey = {};

  for (const typeId of listKnowledgeTypeIds()) {

    const meta = KNOWLEDGE_TYPE_REGISTRY[typeId];

    if (meta?.statKey) {

      byStatKey[meta.statKey] = agg.typeCounts[typeId] || 0;

    }

  }



  return {

    ok: true,

    stats: {

      totalKnowledge: agg.total,

      pendingReview: agg.pendingReview,

      archived: agg.archived,

      embeddingsReady: readyEmbeddings,

      embeddingsPending: embedCounts.pending || 0,

      embeddingsFailed: embedCounts.failed || 0,

      ...byStatKey,

      byType: agg.typeCounts,

    },

    knowledgeTypes: listKnowledgeTypeIds().map((id) => ({

      id,

      ...KNOWLEDGE_TYPE_REGISTRY[id],

    })),

    extensions: {

      semanticSearch: readyEmbeddings > 0,

      hybridSearch: true,

      embeddingsTable: 'aic_knowledge_embeddings',

      embeddingProvider: embeddingConfig.provider,

      embeddingModel: embeddingConfig.model,

      ragIntegration: 'active_phase2',

      fineTuningExport: 'planned',

      huggingFaceDatasets: 'planned',

    },

  };

}


