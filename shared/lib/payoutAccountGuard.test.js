import { describe, expect, it } from 'vitest';
import {
  payoutAccountBlock,
  payoutAccountIsMissing,
  payoutAccountProblem,
  refundPayeesStillOwed,
} from './payoutAccountGuard.js';

describe('payout account guard (A1)', () => {
  it('accepts a bank plus a 10-digit account, with or without spaces', () => {
    expect(payoutAccountProblem({ bankName: 'Moniepoint', accountNo: '6012345678' })).toBe('');
    expect(payoutAccountProblem({ bankName: 'GTBank', accountNo: '012 345 6789' })).toBe('');
    expect(payoutAccountProblem({ bankName: 'GTBank', accountNo: '012-345-6789' })).toBe('');
  });

  it('treats "", "—", "000" and anything not 10 digits as missing', () => {
    for (const accountNo of ['', '—', '-', '000', '0000000000', '12345', '081401716740', '08140171674', 'ACCT 123', 'N/A']) {
      expect(payoutAccountIsMissing({ bankName: 'Moniepoint', accountNo })).toBe(true);
    }
  });

  it('needs a bank name as well as the number', () => {
    expect(payoutAccountProblem({ bankName: '', accountNo: '6012345678' })).toMatch(/bank/i);
    expect(payoutAccountProblem({ bankName: '—', accountNo: '6012345678' })).toMatch(/bank/i);
    expect(payoutAccountProblem({})).toMatch(/bank or account/i);
  });

  it('names the account that failed', () => {
    expect(payoutAccountProblem({ bankName: 'Opay', accountNo: '08140171674' })).toMatch(/"08140171674"/);
  });

  it('blocks with a code when any payee is missing an account', () => {
    expect(payoutAccountBlock([{ label: 'Musa', bankName: 'GTBank', accountNo: '0123456789' }])).toBeNull();
    const block = payoutAccountBlock([
      { label: 'Musa', bankName: 'GTBank', accountNo: '0123456789' },
      { label: 'Ali (staff)', bankName: '', accountNo: '000' },
    ]);
    expect(block?.code).toBe('PAYOUT_ACCOUNT_MISSING');
    expect(block?.payees).toHaveLength(1);
    expect(block?.error).toMatch(/Ali \(staff\)/);
  });
});

describe('refundPayeesStillOwed', () => {
  const targets = [
    { partyKind: 'associated_staff', partyName: 'Driver', amountNgn: 4000 },
    { partyKind: 'customer', partyName: 'Customer', amountNgn: 10000 },
  ];

  it('allocates paid cash to the customer first', () => {
    expect(refundPayeesStillOwed(targets, 0).map((t) => t.owedNgn)).toEqual([10000, 4000]);
    expect(refundPayeesStillOwed(targets, 10000).map((t) => [t.partyName, t.owedNgn])).toEqual([['Driver', 4000]]);
    expect(refundPayeesStillOwed(targets, 12000).map((t) => t.owedNgn)).toEqual([2000]);
    expect(refundPayeesStillOwed(targets, 14000)).toEqual([]);
  });

  it('skips cancelled and zero payees', () => {
    expect(
      refundPayeesStillOwed([
        { partyKind: 'customer', amountNgn: 0 },
        { partyKind: 'associated_staff', amountNgn: 500, payoutCancelled: true },
      ])
    ).toEqual([]);
  });
});
