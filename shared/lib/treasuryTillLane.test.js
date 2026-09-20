import { describe, expect, it } from 'vitest';
import {
  TILL_LANE,
  composeTreasuryTillTruth,
  treasuryPayoutAvailableNgn,
  treasuryTillLane,
} from './treasuryTillLane.js';

describe('treasuryTillLane', () => {
  it('classifies Cash, POS type, POS-named bank, and bank', () => {
    expect(treasuryTillLane({ type: 'Cash', name: 'Till' })).toBe(TILL_LANE.CASH);
    expect(treasuryTillLane({ type: 'POS', name: 'Yola POS' })).toBe(TILL_LANE.POS);
    expect(treasuryTillLane({ type: 'Bank', name: 'Yola POS', bankName: 'POS' })).toBe(TILL_LANE.POS);
    expect(treasuryTillLane({ type: 'Bank', name: 'GTBank Main', bankName: 'Guaranty Trust Bank' })).toBe(
      TILL_LANE.BANK
    );
  });

  it('uses live balance as payout available (not opening + movements)', () => {
    expect(treasuryPayoutAvailableNgn({ balance: 12_500.4, openingBalanceNgn: 1 })).toBe(12500);
  });
});

describe('composeTreasuryTillTruth', () => {
  it('sums three lanes from live balances and keeps last movement', () => {
    const truth = composeTreasuryTillTruth({
      accounts: [
        { id: 1, name: 'Cash Office', type: 'Cash', balance: 450000 },
        { id: 2, name: 'Yola POS', type: 'Bank', bankName: 'POS', balance: 3000000 },
        { id: 3, name: 'GTBank', type: 'Bank', bankName: 'GTB', balance: 8_000_000 },
      ],
      lastByAccountId: {
        2: { postedAtISO: '2026-09-20T10:00:00', amountNgn: -5000 },
        3: { postedAtISO: '2026-09-21T08:00:00', amountNgn: 20000 },
      },
      unclearedCount: 2,
      unclearedNgn: 120000,
    });
    expect(truth.cashNgn).toBe(450000);
    expect(truth.posNgn).toBe(3000000);
    expect(truth.bankNgn).toBe(8000000);
    expect(truth.totalNgn).toBe(11450000);
    expect(truth.lastMovement.pos.lastAmountNgn).toBe(-5000);
    expect(truth.lastMovement.bank.lastPostedAtISO).toMatch(/^2026-09-21/);
    expect(truth.unclearedCount).toBe(2);
    expect(truth.unclearedNgn).toBe(120000);
  });
});
