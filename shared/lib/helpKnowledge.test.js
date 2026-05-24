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

  it('matches refund headroom questions', () => {
    const m = matchHelpArticle('Refund categories exceed quotation headroom cap');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('refund-headroom-categories');
  });

  it('matches overpayment credit', () => {
    const m = matchHelpArticle('Customer overpaid on quotation auto apply credit');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('overpayment-quotation-credit');
  });

  it('matches stone flatsheet topic', () => {
    const m = matchHelpArticle('Stone coated flatsheet m2 refund');
    expect(m).not.toBeNull();
    expect(m.article.id).toBe('stone-flatsheet-quotations');
  });
});
