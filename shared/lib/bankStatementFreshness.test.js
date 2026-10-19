import { describe, expect, it } from 'vitest';
import { latestStatementByAccount, statementCoveredTo, statementFreshness } from './bankStatementFreshness.js';

const now = new Date('2026-10-17T10:00:00.000Z'); // 11:00 Lagos

describe('bank statement freshness (A8)', () => {
  it('statement imported the same day as its last line runs to the import time', () => {
    expect(statementCoveredTo({ lineDays: ['2026-10-16', '2026-10-17'], importedAtISO: '2026-10-17T08:30:00.000Z' })).toEqual({
      statementToISO: '2026-10-17T08:30:00.000Z',
      hasTime: true,
    });
  });

  it('an older statement runs to its last day, with no clock', () => {
    expect(statementCoveredTo({ lineDays: ['2026-10-14', '2026-10-15'], importedAtISO: '2026-10-17T08:30:00.000Z' })).toEqual({
      statementToISO: '2026-10-15',
      hasTime: false,
    });
    expect(statementCoveredTo({ statementToISO: '2026-10-16T17:45:00+01:00' })).toEqual({
      statementToISO: '2026-10-16T17:45:00+01:00',
      hasTime: true,
    });
  });

  it('labels dd/mm hh:mm in Lagos time and is red when older than today', () => {
    expect(statementFreshness({ statementToISO: '2026-10-17T08:30:00.000Z', hasTime: true }, now)).toEqual({
      label: 'Statement loaded to 17/10 09:30',
      stale: false,
      dayISO: '2026-10-17',
    });
    expect(statementFreshness({ statementToISO: '2026-10-15', hasTime: false }, now)).toMatchObject({
      label: 'Statement loaded to 15/10',
      stale: true,
    });
    expect(statementFreshness(null, now)).toMatchObject({ label: 'No statement loaded', stale: true });
  });

  it('keeps the latest point per account, imports or tagged bank lines', () => {
    const rows = latestStatementByAccount(
      [
        { treasuryAccountId: 2, statementToISO: '2026-10-16T12:00:00.000Z', hasTime: true },
        { treasuryAccountId: 2, statementToISO: '2026-10-14', hasTime: false },
      ],
      [
        { treasuryAccountId: 2, lastBankDateISO: '2026-10-15' },
        { treasuryAccountId: 3, lastBankDateISO: '2026-10-10' },
      ]
    );
    expect(rows.find((r) => r.treasuryAccountId === 2)).toMatchObject({ statementToISO: '2026-10-16T12:00:00.000Z', source: 'import' });
    expect(rows.find((r) => r.treasuryAccountId === 3)).toMatchObject({ statementToISO: '2026-10-10', source: 'lines' });
  });
});
