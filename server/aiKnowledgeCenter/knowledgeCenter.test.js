import { describe, it, expect } from 'vitest';
import {
  validateCreateKnowledge,
  validateSearchKnowledge,
  validateUpdateKnowledge,
} from './validators/knowledgeValidator.js';
import { buildBodyText, mapRowToKnowledgeRecord } from './models/knowledgeRecordModel.js';
import { isKnownKnowledgeType, listKnowledgeTypeIds } from '../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { cosineSimilarity, normalizeSemanticScore, hashEmbeddingContent } from './services/embeddingService.js';
import { mergeHybridResults, HYBRID_KEYWORD_WEIGHT, HYBRID_SEMANTIC_WEIGHT } from './services/hybridSearchService.js';

describe('knowledgeValidator', () => {
  it('validateCreateKnowledge requires type and title', () => {
    expect(validateCreateKnowledge({}).ok).toBe(false);
    const ok = validateCreateKnowledge({
      knowledgeType: 'sop_article',
      title: 'Record a receipt',
      module: 'sales',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.knowledgeType).toBe('sop_article');
      expect(ok.value.module).toBe('sales');
    }
  });

  it('validateUpdateKnowledge rejects empty patch', () => {
    expect(validateUpdateKnowledge({}).ok).toBe(false);
    const ok = validateUpdateKnowledge({ title: 'Updated title' });
    expect(ok.ok).toBe(true);
  });

  it('validateSearchKnowledge requires query', () => {
    expect(validateSearchKnowledge({}).ok).toBe(false);
    const ok = validateSearchKnowledge({ query: 'receipt', mode: 'semantic' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.mode).toBe('semantic');
  });
});

describe('knowledgeRecordModel', () => {
  it('buildBodyText extracts content fields', () => {
    const text = buildBodyText({
      title: 'Receipt guide',
      keywords: ['receipt', 'payment'],
      content: { answer: 'Record against quotation', steps: ['Open Sales', 'Payments tab'] },
    });
    expect(text).toContain('Receipt guide');
    expect(text).toContain('Payments tab');
  });

  it('mapRowToKnowledgeRecord maps database row', () => {
    const record = mapRowToKnowledgeRecord({
      id: 'AKC-1',
      knowledge_type: 'sop_article',
      title: 'Test',
      category: 'general',
      tags_json: '["sales"]',
      module: 'sales',
      keywords_json: '["receipt"]',
      content_json: '{"answer":"hi"}',
      body_text: 'Test hi',
      created_by_user_id: 'u1',
      created_by_name: 'Admin',
      created_at_iso: '2026-01-01',
      updated_at_iso: '2026-01-02',
      version: 2,
      status: 'active',
      metadata_json: '{}',
    });
    expect(record?.id).toBe('AKC-1');
    expect(record?.tags).toEqual(['sales']);
    expect(record?.version).toBe(2);
  });
});

describe('knowledgeTypes', () => {
  it('lists all required knowledge types', () => {
    const ids = listKnowledgeTypeIds();
    expect(ids).toContain('sop_article');
    expect(ids).toContain('ai_model_config');
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(isKnownKnowledgeType('sop_article')).toBe(true);
    expect(isKnownKnowledgeType('unknown_type')).toBe(false);
  });
});

describe('embeddingService', () => {
  it('cosineSimilarity returns 1 for identical vectors', () => {
    const v = [0.1, 0.2, 0.3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('hashEmbeddingContent is stable', () => {
    const a = hashEmbeddingContent('receipt guide');
    const b = hashEmbeddingContent('receipt guide');
    expect(a).toBe(b);
    expect(a).not.toBe(hashEmbeddingContent('other'));
  });
});

describe('hybridSearchService', () => {
  it('mergeHybridResults weights keyword and semantic scores', () => {
    const keywordRecords = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
    const semanticHits = [
      { record: { id: 'b', title: 'B' }, semanticScore: 0.9 },
      { record: { id: 'c', title: 'C' }, semanticScore: 0.95 },
    ];
    const merged = mergeHybridResults({ keywordRecords, semanticHits, topN: 10 });
    expect(merged.length).toBe(3);
    const b = merged.find((m) => m.record.id === 'b');
    expect(b).toBeTruthy();
    expect(b.score).toBeCloseTo(
      HYBRID_KEYWORD_WEIGHT * b.keywordScore + HYBRID_SEMANTIC_WEIGHT * b.semanticScore,
      5
    );
    expect(merged[0].record.id).toBe('b');
  });

  it('normalizeSemanticScore maps [-1,1] to [0,1]', () => {
    expect(normalizeSemanticScore(1)).toBe(1);
    expect(normalizeSemanticScore(-1)).toBe(0);
    expect(normalizeSemanticScore(0)).toBe(0.5);
  });
});
