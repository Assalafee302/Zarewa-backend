import { describe, expect, it } from 'vitest';
import { buildTreasuryAccountStatement } from './treasuryAccountStatementOps.js';

describe('buildTreasuryAccountStatement', () => {
  it('rejects a missing account or inverted dates', () => {
    const db = {
      prepare: () => ({
        get: () => null,
        all: () => [],
      }),
    };
    expect(buildTreasuryAccountStatement(db, 0, '2026-09-01', '2026-09-18').ok).toBe(false);
    const dbAcc = {
      prepare: (sql) => ({
        get: () =>
          String(sql).includes('FROM treasury_accounts')
            ? { id: 9, name: 'POS', type: 'Bank', balance: 100, opening_balance_ngn: 0, branch_id: 'BR-YL' }
            : { s: 0 },
        all: () => [],
      }),
    };
    expect(buildTreasuryAccountStatement(dbAcc, 9, '2026-09-18', '2026-09-01').error).toMatch(/From date/);
  });
});
