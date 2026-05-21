import { describe, expect, it } from 'vitest';
import { formatHelpArticleReply, matchHelpArticle } from './helpKnowledge.js';

describe('helpKnowledge', () => {
  it('matches receipt questions', () => {
    const m = matchHelpArticle('How can I add a receipt for a customer payment?');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('record-receipt');
    expect(formatHelpArticleReply(m.article)).toContain('payment');
  });

  it('matches mistake correction', () => {
    const m = matchHelpArticle('I made a mistake on the wrong amount receipt');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('receipt-mistake');
  });

  it('returns null for unrelated noise', () => {
    expect(matchHelpArticle('hello')).toBeNull();
  });
});
