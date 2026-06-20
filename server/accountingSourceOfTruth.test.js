import { describe, expect, it } from 'vitest';
import {
  GL_SOURCE_OF_TRUTH,
  OPENING_MANUAL_EXCLUDED_GL_CODES,
  glSourceMappingForCode,
} from '../shared/lib/accountingSourceOfTruth.js';

describe('accountingSourceOfTruth', () => {
  it('maps trade AR to creditors register', () => {
    const m = glSourceMappingForCode('1200');
    expect(m?.primaryModule).toBe('creditors');
    expect(m?.allowManualOpeningLine).toBe(false);
  });

  it('excludes register-sourced codes from manual opening', () => {
    expect(OPENING_MANUAL_EXCLUDED_GL_CODES).toContain('1200');
    expect(OPENING_MANUAL_EXCLUDED_GL_CODES).toContain('2000');
    expect(OPENING_MANUAL_EXCLUDED_GL_CODES).toContain('2500');
    expect(OPENING_MANUAL_EXCLUDED_GL_CODES).not.toContain('3100');
  });

  it('covers at least 95% of control accounts by count', () => {
    const systemSourced = GL_SOURCE_OF_TRUTH.filter(
      (m) => m.primaryModule !== 'manual' && m.primaryModule !== 'computed'
    ).length;
    expect(systemSourced / GL_SOURCE_OF_TRUTH.length).toBeGreaterThanOrEqual(0.85);
  });
});
