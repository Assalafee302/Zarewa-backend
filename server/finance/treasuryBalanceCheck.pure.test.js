import { describe, expect, it } from 'vitest';
import { adjustTreasuryBalanceTx } from './treasuryMovementWrite.js';

/** Minimal db stub: one treasury account row whose stored balance moves on UPDATE. */
function fakeDb(balance) {
  const row = { id: 1, name: 'Zarewa Aluminum & Plastics Ltd.', balance, strict_cache_enabled: 0 };
  return {
    row,
    prepare(sql) {
      return {
        get: () => ({ ...row }),
        run: (next) => {
          if (/UPDATE treasury_accounts/.test(sql)) row.balance = next;
        },
      };
    },
  };
}

describe('adjustTreasuryBalanceTx insufficient-balance check', () => {
  it('accepts a receipt into an account whose stored balance is already negative', () => {
    const db = fakeDb(-5_000_000);
    const out = adjustTreasuryBalanceTx(db, 1, 200_000);
    expect(out.storedAfter).toBe(-4_800_000);
    expect(db.row.balance).toBe(-4_800_000);
  });

  it('still refuses an outflow that would end below zero', () => {
    const db = fakeDb(100_000);
    expect(() => adjustTreasuryBalanceTx(db, 1, -150_000)).toThrow(/Insufficient balance/);
    expect(db.row.balance).toBe(100_000);
  });

  it('refuses an outflow from an already-negative account', () => {
    const db = fakeDb(-10_000);
    expect(() => adjustTreasuryBalanceTx(db, 1, -1)).toThrow(/Insufficient balance/);
  });

  it('allows an outflow below zero when allowNegativeBalance is set', () => {
    const db = fakeDb(100_000);
    expect(adjustTreasuryBalanceTx(db, 1, -150_000, { allowNegativeBalance: true }).storedAfter).toBe(-50_000);
  });
});
