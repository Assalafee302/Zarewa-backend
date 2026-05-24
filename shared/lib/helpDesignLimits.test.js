import { describe, expect, it } from 'vitest';
import {
  RUNA_DESIGN_LIMITS,
  assertDraftStatusTransition,
  assertPracticalLearningAllowed,
  assertValidDraftStatus,
  filterArticleBoostMap,
  filterTransactionProfileForUser,
  sanitizeHelpMemoryPayload,
  userMaySeeArticle,
} from './helpDesignLimits.js';

describe('helpDesignLimits', () => {
  it('documents the four design limits', () => {
    expect(RUNA_DESIGN_LIMITS.noErpMutations).toBe(true);
    expect(RUNA_DESIGN_LIMITS.noAutoPublishArticles).toBe(true);
    expect(RUNA_DESIGN_LIMITS.noNeuralTraining).toBe(true);
    expect(RUNA_DESIGN_LIMITS.rbacOnMemory).toBe(true);
  });

  it('blocks neural training operations', () => {
    expect(() => assertPracticalLearningAllowed('trainNeuralModel')).toThrow(/neural models/i);
    expect(() => assertPracticalLearningAllowed('retrainFromFeedback')).not.toThrow();
  });

  it('only allows pending auto-created drafts', () => {
    expect(assertValidDraftStatus('pending', { autoCreate: true })).toBe('pending');
    expect(() => assertValidDraftStatus('approved', { autoCreate: true })).toThrow(/pending/i);
  });

  it('allows admin review transitions only', () => {
    expect(assertDraftStatusTransition('pending', 'approved')).toBe('approved');
    expect(() => assertDraftStatusTransition('approved', 'pending')).toThrow();
  });

  it('sanitizes forbidden memory keys', () => {
    const clean = sanitizeHelpMemoryPayload({
      articleHits: { 'record-receipt': 2 },
      note: 'secret customer note',
      entity_id: 'LE-123',
    });
    expect(clean.articleHits).toEqual({ 'record-receipt': 2 });
    expect(clean.note).toBeUndefined();
    expect(clean.entity_id).toBeUndefined();
  });

  it('filters article boosts by clearance', () => {
    const user = { permissions: ['sales.view'] };
    const boosts = filterArticleBoostMap(
      { 'record-receipt': 5, 'quote-to-cash-workflow': 3 },
      user
    );
    expect(boosts['quote-to-cash-workflow']).toBe(3);
    expect(boosts['record-receipt']).toBeUndefined();
  });

  it('redacts transaction errors without finance clearance', () => {
    const user = { permissions: ['sales.view'] };
    const profile = filterTransactionProfileForUser(
      {
        suggestedGuides: [{ articleId: 'record-receipt', title: 'Receipt', reason: 'x', weight: 1 }],
        recentErrors: [{ action: 'ledger.post', note: 'Bank mismatch LE-99', at: '2026-01-01' }],
      },
      user
    );
    expect(profile.suggestedGuides).toHaveLength(0);
    expect(profile.recentErrors[0].note).toMatch(/clearance/i);
  });

  it('allows finance guides when user has finance clearance', () => {
    const user = { permissions: ['finance.view'] };
    expect(userMaySeeArticle('record-receipt', user)).toBe(true);
  });
});
