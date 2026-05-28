import { describe, expect, it } from 'vitest';
import { classifyZareIntent, zareIntentToAgentRoute } from './helpZareIntent.js';

describe('helpZareIntent', () => {
  it('detects wrong payment amount typos', () => {
    expect(classifyZareIntent('payment amount wrong')).toBe('wrong_payment_amount');
    expect(classifyZareIntent('i enter wrong money')).toBe('correction_request');
  });

  it('detects duplicate receipt', () => {
    expect(classifyZareIntent('receipt duplicate')).toBe('duplicate_receipt');
  });

  it('detects cannot approve', () => {
    expect(classifyZareIntent("why can't i approve")).toBe('cannot_approve');
  });

  it('detects memo writing', () => {
    expect(classifyZareIntent('make this memo professional')).toBe('memo_writing_help');
  });

  it('routes transaction help mode', () => {
    expect(
      classifyZareIntent('help', [], { mode: 'transaction_help', issueType: 'wrong_payment_amount' })
    ).toBe('wrong_payment_amount');
  });

  it('maps to agent routes', () => {
    expect(zareIntentToAgentRoute('cannot_approve')).toBe('clearance');
    expect(zareIntentToAgentRoute('wrong_payment_amount')).toBe('troubleshoot');
    expect(zareIntentToAgentRoute('meta_question')).toBe('meta');
  });
});
