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

  it('shows a company-cut payout as money out and reduces the running balance', () => {
    const db = {
      prepare: (sql) => {
        const q = String(sql);
        return {
          get: () => {
            if (q.includes('FROM treasury_accounts')) {
              return {
                id: 4,
                name: 'Keystone ops',
                type: 'Bank',
                bank_name: 'Keystone',
                acc_no: '0123',
                balance: 450_000,
                opening_balance_ngn: 500_000,
                branch_id: 'BR-KD',
              };
            }
            return { s: 0 };
          },
          all: () => {
            if (!q.includes('FROM treasury_movements tm')) return [];
            return [
              {
                id: 'TM-1',
                posted_at_iso: '2026-09-20T12:00:00.000Z',
                type: 'REFUND_COMPANY_CUT_PAYOUT',
                amount_ngn: -50_000,
                source_kind: 'REFUND_COMPANY_RETENTION',
                source_id: 'RCW-KD-26-0002',
                reference: 'RCW-KD-26-0002',
                counterparty_name: 'Mansur Lawal Matazu',
                note: 'Company cut retention RCW-KD-26-0002',
              },
            ];
          },
        };
      },
    };
    const stmt = buildTreasuryAccountStatement(db, 4, '2026-09-01', '2026-09-30');
    expect(stmt.ok).toBe(true);
    expect(stmt.lines).toHaveLength(1);
    expect(stmt.lines[0].source).toBe('Company cut');
    expect(stmt.lines[0].outNgn).toBe(50_000);
    expect(stmt.lines[0].inNgn).toBe(0);
    expect(stmt.outflowNgn).toBe(50_000);
    expect(stmt.closingBalanceNgn).toBe(450_000);
    expect(stmt.lines[0].balanceNgn).toBe(450_000);
  });
});
