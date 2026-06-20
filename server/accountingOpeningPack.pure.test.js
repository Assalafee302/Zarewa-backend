import { describe, expect, it } from 'vitest';
import { buildProposedJournalLines } from './accountingOpeningPackOps.js';

function mockSource({ code, side, amount, label = 'Test' }) {
  return {
    glAccountCode: code,
    side,
    amountNgn: amount,
    label,
    status: 'ok',
  };
}

describe('accountingOpeningPack (pure)', () => {
  it('buildProposedJournalLines adds 3900 credit plug when debits exceed credits', () => {
    const lines = buildProposedJournalLines(
      [mockSource({ code: '1200', side: 'debit', amount: 1_000_000 }), mockSource({ code: '2000', side: 'credit', amount: 400_000 })],
      0
    );
    const debits = lines.reduce((s, l) => s + (l.debitNgn || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.creditNgn || 0), 0);
    expect(debits).toBe(credits);
    expect(lines.some((l) => l.accountCode === '3900' && l.creditNgn === 600_000)).toBe(true);
  });

  it('buildProposedJournalLines adds 3900 debit plug when credits exceed debits', () => {
    const lines = buildProposedJournalLines(
      [mockSource({ code: '1001', side: 'debit', amount: 100_000 }), mockSource({ code: '2000', side: 'credit', amount: 500_000 })],
      0
    );
    const debits = lines.reduce((s, l) => s + (l.debitNgn || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.creditNgn || 0), 0);
    expect(debits).toBe(credits);
    expect(lines.some((l) => l.accountCode === '3900' && l.debitNgn === 400_000)).toBe(true);
  });

  it('buildProposedJournalLines includes owner capital on 3100', () => {
    const lines = buildProposedJournalLines(
      [mockSource({ code: '1200', side: 'debit', amount: 500_000 }), mockSource({ code: '2000', side: 'credit', amount: 200_000 })],
      150_000
    );
    expect(lines.some((l) => l.accountCode === '3100' && l.creditNgn === 150_000)).toBe(true);
    const debits = lines.reduce((s, l) => s + (l.debitNgn || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.creditNgn || 0), 0);
    expect(debits).toBe(credits);
  });

  it('buildProposedJournalLines splits payroll liabilities across 2200/2300/2400', () => {
    const lines = buildProposedJournalLines(
      [
        mockSource({ code: '1200', side: 'debit', amount: 1_000_000 }),
        mockSource({ code: '2200', side: 'credit', amount: 600_000, label: 'Net payroll' }),
        mockSource({ code: '2300', side: 'credit', amount: 200_000, label: 'PAYE' }),
        mockSource({ code: '2400', side: 'credit', amount: 100_000, label: 'Pension' }),
      ],
      0
    );
    expect(lines.some((l) => l.accountCode === '2200' && l.creditNgn === 600_000)).toBe(true);
    expect(lines.some((l) => l.accountCode === '2300' && l.creditNgn === 200_000)).toBe(true);
    expect(lines.some((l) => l.accountCode === '2400' && l.creditNgn === 100_000)).toBe(true);
    const debits = lines.reduce((s, l) => s + (l.debitNgn || 0), 0);
    const credits = lines.reduce((s, l) => s + (l.creditNgn || 0), 0);
    expect(debits).toBe(credits);
  });

  it('buildProposedJournalLines skips zero amounts', () => {
    const lines = buildProposedJournalLines([mockSource({ code: '1200', side: 'debit', amount: 0 })], 0);
    expect(lines).toHaveLength(0);
  });
});
