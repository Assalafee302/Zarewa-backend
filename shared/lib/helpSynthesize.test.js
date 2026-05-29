import { describe, expect, it } from 'vitest';
import {
  buildHelpAiSystemPrompt,
  detectHelpIntent,
  selectRelevantSteps,
  synthesizeHelpReply,
} from './helpSynthesize.js';
import { ensureHelpArticles } from './helpKnowledge.js';

describe('helpSynthesize', () => {
  it('detects greetings', () => {
    expect(detectHelpIntent('Hello')).toBe('greeting');
    expect(detectHelpIntent('How do I add a receipt?')).toBe('workflow');
  });

  it('does not treat a new staff question after hi as follow_up', () => {
    const prior = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    expect(detectHelpIntent('how can i register new staff', prior)).toBe('workflow');
  });

  it('answers register staff from knowledge', () => {
    const article = ensureHelpArticles().find((a) => a.id === 'register-staff-user');
    const reply = synthesizeHelpReply({
      message: 'how can i register new staff',
      articles: [article],
      pathname: '/settings',
    });
    expect(reply).toMatch(/team\s*&\s*access|team access/i);
    expect(reply).not.toMatch(/receipt|record a payment/i);
  });

  it('synthesizes a concise workflow answer', () => {
    const article = ensureHelpArticles().find((a) => a.id === 'record-receipt');
    const reply = synthesizeHelpReply({
      message: 'How do I record customer payment?',
      articles: [article],
      pathname: '/sales',
    });
    expect(reply).toMatch(/receipt|payment/i);
    expect(reply).toMatch(/\*\*In Zarewa, you do this:\*\*/);
    expect(reply.length).toBeLessThan(1200);
  });

  it('selects relevant steps only', () => {
    const article = ensureHelpArticles().find((a) => a.id === 'record-receipt');
    const steps = selectRelevantSteps(article, 'Payments tab quotation', 3);
    expect(steps.length).toBeLessThanOrEqual(3);
  });

  it('builds AI system prompt with retrieved context', () => {
    const article = ensureHelpArticles().find((a) => a.id === 'record-receipt');
    const prompt = buildHelpAiSystemPrompt({
      retrievedContext: `### ${article.title}\n${article.answer}`,
      pathname: '/sales',
      pace: 'fast',
    });
    expect(prompt).toMatch(/RAG/);
    expect(prompt).toMatch(/brief/i);
  });
});
