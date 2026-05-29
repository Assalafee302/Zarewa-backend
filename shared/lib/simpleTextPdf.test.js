import { describe, expect, it } from 'vitest';
import { buildSimpleTextPdf } from './simpleTextPdf.js';

describe('buildSimpleTextPdf', () => {
  it('returns a valid PDF header and EOF', () => {
    const pdf = buildSimpleTextPdf([{ lines: ['Hello payslip', 'Line two'] }]);
    const text = Buffer.from(pdf).toString('utf8');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.includes('%%EOF')).toBe(true);
    expect(text.includes('Hello payslip')).toBe(true);
  });

  it('supports multiple pages', () => {
    const pdf = buildSimpleTextPdf([{ lines: ['Page A'] }, { lines: ['Page B'] }]);
    const text = Buffer.from(pdf).toString('utf8');
    expect(text.includes('/Count 2')).toBe(true);
  });
});
