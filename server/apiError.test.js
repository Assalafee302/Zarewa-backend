import { describe, expect, it, vi } from 'vitest';
import { apiError, safeErrorMessage } from './apiError.js';

describe('apiError', () => {
  it('returns consistent error shape', () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    apiError(res, { status: 403, code: 'FORBIDDEN', error: 'Not allowed.' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ ok: false, code: 'FORBIDDEN', error: 'Not allowed.' });
  });

  it('safeErrorMessage hides SQL errors', () => {
    expect(safeErrorMessage(new Error('UNIQUE constraint failed'), 'Fallback')).toBe('Fallback');
    expect(safeErrorMessage(new Error('Customer name required'), 'Fallback')).toBe('Customer name required');
  });
});
