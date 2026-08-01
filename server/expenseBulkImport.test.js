import { describe, expect, it } from 'vitest';
import { normalizeExpenseImportRows, parseExpenseImportDate } from './expenseBulkImport.js';

describe('expenseBulkImport dates', () => {
  it('never defaults blank dates to today', () => {
    expect(parseExpenseImportDate('')).toBe('');
    expect(parseExpenseImportDate(null)).toBe('');
    expect(parseExpenseImportDate(undefined)).toBe('');
  });

  it('keeps explicit calendar dates stable', () => {
    expect(parseExpenseImportDate('2026-07-15')).toBe('2026-07-15');
    expect(parseExpenseImportDate('15/07/2026')).toBe('2026-07-15');
    expect(parseExpenseImportDate('15-07-2026')).toBe('2026-07-15');
  });

  it('strips sample and legacy expense ids so they do not block re-import', () => {
    const rows = normalizeExpenseImportRows([
      {
        date: '2026-07-01',
        amountNgn: 1000,
        category: 'Fuel & lubricant',
        treasuryAccountId: 1,
        expenseID: 'EXP-IMPORT-SAMPLE-1',
      },
      {
        date: '15/07/2026',
        amountNgn: 2000,
        category: 'Maintenance',
        treasuryAccountId: 2,
        expenseID: 'EXP-LEGACY-BR-KD-9',
      },
      {
        date: '2026-07-03',
        amountNgn: 3000,
        category: 'Office expenses',
        treasuryAccountId: 3,
        expenseID: 'EXP-KEEP-ME',
      },
    ]);
    expect(rows[0].expenseID).toBe('');
    expect(rows[1].expenseID).toBe('');
    expect(rows[1].date).toBe('2026-07-15');
    expect(rows[2].expenseID).toBe('EXP-KEEP-ME');
  });
});
