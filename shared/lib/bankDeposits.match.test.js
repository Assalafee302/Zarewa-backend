import { describe, expect, it } from 'vitest';
import {
  BANK_DEPOSIT_CLOSE_DATE_DAYS,
  bankDepositCloseAmountToleranceNgn,
  isBankDepositAmountClose,
  isBankDepositDateClose,
  scoreBankDepositMatch,
} from './bankDeposits.js';

describe('bank deposit close match suggestions', () => {
  it('uses ₦100 floor or 1% for close-amount tolerance', () => {
    expect(bankDepositCloseAmountToleranceNgn(5_000)).toBe(100);
    expect(bankDepositCloseAmountToleranceNgn(50_000)).toBe(500);
    expect(isBankDepositAmountClose(50_000, 50_400)).toBe(true);
    expect(isBankDepositAmountClose(50_000, 50_600)).toBe(false);
  });

  it('treats dates within ±2 days as close', () => {
    expect(BANK_DEPOSIT_CLOSE_DATE_DAYS).toBe(2);
    expect(isBankDepositDateClose('2026-08-11', '2026-08-11')).toBe(true);
    expect(isBankDepositDateClose('2026-08-11', '2026-08-13')).toBe(true);
    expect(isBankDepositDateClose('2026-08-11', '2026-08-14')).toBe(false);
  });

  it('scores exact amount + close date as mergeable', () => {
    const match = scoreBankDepositMatch(
      { amountNgn: 100_000, bankDateISO: '2026-08-10', bankReference: 'TRX-1' },
      { amountNgn: 100_000, bankDateISO: '2026-08-11', bankReference: 'TRX-1' }
    );
    expect(match.amountExact).toBe(true);
    expect(match.dateExact).toBe(false);
    expect(match.dateClose).toBe(true);
    expect(match.canMergeDuplicate).toBe(true);
    expect(match.matchHints).toEqual(expect.arrayContaining(['exact amount', 'close date', 'exact reference']));
    expect(match.score).toBeGreaterThanOrEqual(100 + 40 + 8);
  });

  it('scores close amount as suggestion-only (not mergeable)', () => {
    const match = scoreBankDepositMatch(
      { amountNgn: 100_000, bankDateISO: '2026-08-11', bankReference: '' },
      { amountNgn: 100_050, bankDateISO: '2026-08-11', bankReference: '' }
    );
    expect(match.amountExact).toBe(false);
    expect(match.amountClose).toBe(true);
    expect(match.dateExact).toBe(true);
    expect(match.canMergeDuplicate).toBe(false);
    expect(match.matchHints).toEqual(expect.arrayContaining(['close amount', 'exact date']));
  });

  it('does not double-count exact amount as close amount score', () => {
    const exact = scoreBankDepositMatch(
      { amountNgn: 10_000, bankDateISO: '2026-08-11' },
      { amountNgn: 10_000, bankDateISO: '2026-08-11' }
    );
    expect(exact.score).toBe(40 + 20);
  });
});
