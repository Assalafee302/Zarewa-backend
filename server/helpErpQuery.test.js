import { describe, it, expect } from 'vitest';
import {
  parseQuotationRefFromMessage,
  resolveQuotationIds,
  tryNativeErpTool,
} from './helpErpQuery.js';

describe('parseQuotationRefFromMessage', () => {
  it('parses what is in quotation N', () => {
    expect(parseQuotationRefFromMessage('WHAT IS IN QUOTATION 36')).toEqual({ kind: 'seq', value: '36' });
    expect(parseQuotationRefFromMessage('what is in quote 12')).toEqual({ kind: 'seq', value: '12' });
    expect(parseQuotationRefFromMessage('status of QT-KD-26-0036')).toEqual({
      kind: 'full',
      value: 'QT-KD-26-0036',
    });
  });
});

function mockQuotationDb() {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('PRAGMA table_info(quotations)')) {
        return { all: () => [{ name: 'branch_id' }] };
      }
      if (s.includes('FROM quotations WHERE id LIKE')) {
        return { all: () => [{ id: 'QT-KD-26-0036' }] };
      }
      if (s.includes('FROM quotations WHERE id = ?') && s.includes('customer_name')) {
        return {
          get: () => ({
            id: 'QT-KD-26-0036',
            customer_name: 'Acme Ltd',
            status: 'approved',
            total_ngn: 500000,
            paid_ngn: 200000,
            payment_status: 'partial',
            date_iso: '2026-05-01',
            project_name: '',
            lines_json: null,
          }),
        };
      }
      if (s.includes('FROM quotation_lines')) {
        return {
          all: () => [
            { category: 'products', name: 'Stone-coated sheet', qty: 120, unit: 'm²', line_total_ngn: 300000 },
            { category: 'accessories', name: 'Ridge cap', qty: 40, unit: 'pcs', line_total_ngn: 200000 },
          ],
        };
      }
      if (s.includes('FROM quotations WHERE id = ? LIMIT 1') && !s.includes('customer_name')) {
        return { get: (id) => (id === 'QT-KD-26-0036' ? { id: 'QT-KD-26-0036' } : undefined) };
      }
      if (s.includes('FROM branches WHERE id')) {
        return { get: () => ({ code: 'KD' }) };
      }
      return { all: () => [], get: () => undefined };
    },
  };
}

describe('resolveQuotationIds (mock db)', () => {
  it('resolves padded sequence to quotation id', () => {
    const ids = resolveQuotationIds(mockQuotationDb(), { kind: 'seq', value: '36' }, 'BR-KD');
    expect(ids).toEqual(['QT-KD-26-0036']);
  });
});

describe('tryNativeErpTool quotation lookup (mock db)', () => {
  it('returns line items without AI text-to-SQL', () => {
    const result = tryNativeErpTool(mockQuotationDb(), 'WHAT IS IN QUOTATION 36', {
      branchId: 'BR-KD',
      user: { permissions: ['sales.view', 'quotations.view'] },
    });
    expect(result?.ok).toBe(true);
    expect(result?.tool).toBe('quotation_lookup');
    expect(result?.summary).toMatch(/QT-KD-26-0036/);
    expect(result?.summary).toMatch(/Stone-coated sheet/);
    expect(result?.summary).toMatch(/Ridge cap/);
  });
});
