import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL_FAQ_COUNT,
  OPERATIONAL_FAQ_TARGET,
  buildOperationalHelpArticles,
} from './helpOperationalCatalog.js';
import { matchHelpArticle, HELP_ARTICLE_COUNT } from './helpKnowledge.js';

describe('helpOperationalCatalog', () => {
  it('builds exactly 1000 operational FAQ articles', () => {
    const articles = buildOperationalHelpArticles();
    expect(articles).toHaveLength(OPERATIONAL_FAQ_TARGET);
    expect(OPERATIONAL_FAQ_COUNT).toBe(1000);
    expect(HELP_ARTICLE_COUNT).toBeGreaterThan(1000);
  });

  it('each article has guide-only answer and steps', () => {
    const sample = buildOperationalHelpArticles().slice(0, 20);
    for (const a of sample) {
      expect(a.id).toMatch(/^op-/);
      expect(a.steps.length).toBeGreaterThan(0);
      expect(a.answer).toMatch(/Zare explains|you perform/i);
    }
  });

  it('matches HR employee register phrasing', () => {
    const m = matchHelpArticle('how do i register a new employee in HR');
    expect(m).not.toBeNull();
    expect(m.article.id).toMatch(/^op-hr-|register-staff/);
  });

  it('matches treasury payout phrasing', () => {
    const m = matchHelpArticle('steps to record treasury payout for approved request');
    expect(m).not.toBeNull();
    expect(m.article.answer).toMatch(/payout|treasury/i);
  });
});
