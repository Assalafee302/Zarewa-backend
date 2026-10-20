import { describe, expect, it } from 'vitest';
import {
  cashOfficePayoutProblem,
  payoutAccountBlock,
  payoutAccountDigits,
  payoutRouteBlock,
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
    for (const accountNo of ['', '—', '-', '000', '0000000000', '12345', '081401716740', '18140171674', '00000000000', 'ACCT 123', 'N/A']) {
      expect(payoutAccountIsMissing({ bankName: 'Moniepoint', accountNo })).toBe(true);
    }
  });

  it('needs a bank name as well as the number', () => {
    expect(payoutAccountProblem({ bankName: '', accountNo: '6012345678' })).toMatch(/bank/i);
    expect(payoutAccountProblem({ bankName: '—', accountNo: '6012345678' })).toMatch(/bank/i);
    expect(payoutAccountProblem({})).toMatch(/bank or account/i);
  });

  it('names the account that failed', () => {
    expect(payoutAccountProblem({ bankName: 'Opay', accountNo: '18140171674' })).toMatch(/"18140171674"/);
  });

  it('D1: accepts an 11-digit wallet number starting with 0 and stores the 10 digits', () => {
    expect(payoutAccountProblem({ bankName: 'Opay', accountNo: '08140171674' })).toBe('');
    expect(payoutAccountDigits('0814 017 1674')).toBe('8140171674');
    expect(payoutAccountDigits('0123456789')).toBe('0123456789');
    expect(payoutAccountDigits('18140171674')).toBe('');
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

describe('D2: Cash Office payouts', () => {
  const missing = [{ label: 'Ibro', bankName: '', accountNo: '' }];
  const cash = { recipientName: 'Ibro Mechanic', voucherReference: 'CV-0412' };

  it('bank / POS payouts need the payee account; Cash Office payouts need name + voucher', () => {
    expect(payoutRouteBlock({ accountTypes: ['Bank'], payees: missing })?.code).toBe('PAYOUT_ACCOUNT_MISSING');
    expect(payoutRouteBlock({ accountTypes: ['POS'], payees: missing })?.code).toBe('PAYOUT_ACCOUNT_MISSING');
    expect(payoutRouteBlock({ accountTypes: ['Cash'], payees: missing, cash })).toBeNull();
    expect(payoutRouteBlock({ accountTypes: ['Cash'], payees: missing, cash: {} })?.code).toBe('CASH_OFFICE_VOUCHER_REQUIRED');
  });

  it('a split payout needs both; no lines (wallet release) counts as bank', () => {
    expect(payoutRouteBlock({ accountTypes: ['Cash', 'Bank'], payees: missing, cash })?.code).toBe('PAYOUT_ACCOUNT_MISSING');
    expect(payoutRouteBlock({ accountTypes: [], payees: missing })?.code).toBe('PAYOUT_ACCOUNT_MISSING');
  });

  it('names what is missing', () => {
    expect(cashOfficePayoutProblem({ recipientName: 'Ibro' })).toMatch(/voucher/);
    expect(cashOfficePayoutProblem({ voucherReference: 'CV-1' })).toMatch(/name/);
  });
});
