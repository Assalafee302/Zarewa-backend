import { describe, expect, it } from 'vitest';
import {
  LETTER_STATUSES,
  SENSITIVE_LETTER_KINDS,
  letterRequiresMdApproval,
} from './hrLetterWorkflowOps.js';

describe('hrLetterWorkflowOps', () => {
  it('defines full letter lifecycle statuses', () => {
    expect(LETTER_STATUSES).toContain('draft');
    expect(LETTER_STATUSES).toContain('submitted');
    expect(LETTER_STATUSES).toContain('approved');
    expect(LETTER_STATUSES).toContain('issued');
    expect(LETTER_STATUSES).toContain('rejected');
  });

  it('classifies sensitive letter kinds', () => {
    expect(SENSITIVE_LETTER_KINDS.has('termination')).toBe(true);
    expect(SENSITIVE_LETTER_KINDS.has('salary_increment')).toBe(true);
    expect(SENSITIVE_LETTER_KINDS.has('introduction')).toBe(false);
  });

  it('requires MD approval for sensitive kinds only', () => {
    expect(letterRequiresMdApproval('dismissal')).toBe(true);
    expect(letterRequiresMdApproval('leave_approval')).toBe(false);
  });
});
