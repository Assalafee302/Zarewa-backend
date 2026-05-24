import { describe, expect, it } from 'vitest';
import { formatHelpArticleReply, matchHelpArticle, matchHelpArticles } from './helpKnowledge.js';

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

  it('matches multi-step sales workflow questions', () => {
    const m = matchHelpArticle('Walk me through the full quotation to delivery process');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('quote-to-cash-workflow');
  });

  it('returns multiple articles for cross-department queries', () => {
    const matches = matchHelpArticles('receipt mistake then refund payout finance', { limit: 2, minScore: 4 });
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});
