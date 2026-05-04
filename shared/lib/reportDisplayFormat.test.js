import { describe, expect, it } from 'vitest';
import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';

describe('displayDocNumber', () => {
  it('strips QT- prefix', () => {
    expect(displayDocNumber('QT-2026-001')).toBe('2026-001');
  });
  it('strips CL- prefix', () => {
    expect(displayDocNumber('CL-2026-1592')).toBe('2026-1592');
  });
  it('returns tail for PO-', () => {
    expect(displayDocNumber('PO-2026-014')).toBe('2026-014');
  });
  it('leaves unknown format', () => {
    expect(displayDocNumber('2026-001')).toBe('2026-001');
  });
});

describe('displayCoilNumber', () => {
  it('uses same rules as doc number', () => {
    expect(displayCoilNumber('GRN-99')).toBe('99');
  });
});
