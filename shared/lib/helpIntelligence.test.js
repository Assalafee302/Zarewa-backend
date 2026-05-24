import { describe, expect, it } from 'vitest';
import { classifyAgentRoute } from './helpAgentIntent.js';
import { isCoachingMessage, buildCoachingReply } from './helpCoaching.js';
import { rankRunaRecommendations } from './helpRecommendEngine.js';
import { HELP_ARTICLES } from './helpKnowledge.js';

describe('helpAgentIntent extended', () => {
  it('routes coaching', () => {
    expect(classifyAgentRoute('Walk me through creating a quotation')).toBe('coaching');
  });

  it('routes clearance', () => {
    expect(classifyAgentRoute('Why cant I see finance data')).toBe('clearance');
  });

  it('routes troubleshoot without how-to', () => {
    expect(classifyAgentRoute('Receipt posting failed')).toBe('troubleshoot');
  });

  it('routes hybrid for fix+stock', () => {
    expect(classifyAgentRoute('How do I fix inventory when stock shows wrong?')).toBe('hybrid');
  });
});

describe('helpCoaching', () => {
  it('detects next step', () => {
    expect(isCoachingMessage('next', [{ role: 'assistant', content: 'Step 1 of 3' }])).toBe(true);
  });

  it('builds step reply', () => {
    const article = HELP_ARTICLES.find((a) => a.id === 'record-receipt');
    const reply = buildCoachingReply({ message: 'step by step receipt', articles: [article] });
    expect(reply.content).toMatch(/step 1 of/i);
    expect(reply.coaching.active).toBe(true);
  });
});

describe('helpRecommendEngine', () => {
  it('ranks page prompts', () => {
    const recs = rankRunaRecommendations({ pathname: '/sales', learnedBoosts: {} });
    expect(recs.length).toBeGreaterThan(0);
  });
});
