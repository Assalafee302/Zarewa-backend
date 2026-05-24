import { describe, expect, it } from 'vitest';
import { matchHelpArticle } from './helpKnowledge.js';
import { fuzzyWordsSimilar, normalizeHelpQueryText } from './helpTypoTolerance.js';

describe('helpTypoTolerance', () => {
  it('normalizes common typos', () => {
    expect(normalizeHelpQueryText('how add reciept')).toMatch(/receipt/);
  });

  it('fuzzy matches receipt', () => {
    expect(fuzzyWordsSimilar('reciept', 'receipt')).toBe(true);
  });

  it('matches misspelled receipt question', () => {
    const m = matchHelpArticle('How do I add a reciept for customer paymnt?');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('record-receipt');
  });

  it('matches misspelled refund question', () => {
    const m = matchHelpArticle('refnd headroom on qoutation');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('refund-headroom-categories');
  });
});
