import { describe, expect, it } from 'vitest';
import { classifyAgentRoute } from './helpAgentIntent.js';

describe('helpAgentIntent', () => {
  it('routes ERP data questions', () => {
    expect(classifyAgentRoute('What is our current inventory for Product X?')).toBe('erp_data');
  });

  it('routes guide questions', () => {
    expect(classifyAgentRoute('How do I record a receipt?')).toBe('guide');
  });

  it('routes hybrid', () => {
    expect(classifyAgentRoute('How do I fix inventory when stock shows wrong?')).toBe('hybrid');
  });

  it('routes meta questions', () => {
    expect(classifyAgentRoute('How smart are u')).toBe('meta');
  });
});
