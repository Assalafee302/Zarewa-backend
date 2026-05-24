import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_ARTICLE_HINTS,
  buildBehaviorCoachingNotes,
  classifyHelpReadingPace,
  promptForArticleId,
} from './helpBehaviorLearn.js';

describe('helpBehaviorLearn', () => {
  it('classifies reading pace', () => {
    expect(classifyHelpReadingPace(5000)).toBe('fast');
    expect(classifyHelpReadingPace(20000)).toBe('normal');
    expect(classifyHelpReadingPace(60000)).toBe('deep');
  });

  it('builds coaching notes for low helpful rate', () => {
    const notes = buildBehaviorCoachingNotes({ helpfulRate: 0.2, pace: 'normal' });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatch(/not helpful/i);
  });

  it('maps audit actions to articles', () => {
    expect(AUDIT_ACTION_ARTICLE_HINTS['refund.create']).toBe('refund-headroom-categories');
  });

  it('builds prompts from article ids', () => {
    const p = promptForArticleId('record-receipt');
    expect(p).not.toBeNull();
    expect(p.query).toMatch(/receipt/i);
  });
});
