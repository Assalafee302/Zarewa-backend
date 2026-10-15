// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_CHARGES,
  BUCKET_PAYMENTS,
  BUCKET_RECEIPTS,
  BUCKET_REFUNDS,
  BUCKET_TRANSFERS,
  buildBankReconStatement,
  linkedMovementIds,
} from './bankReconStatementCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/bankReconSource.json', import.meta.url), 'utf8')
);

const tm = (id, date, type, amountNgn, extra = {}) => ({
  id,
  postedAtISO: `${date}T12:00:00.000Z`,
  type,
  treasuryAccountId: 1,
  amountNgn,
  sourceKind: 'LEDGER_RECEIPT',
  sourceId: `SRC-${id}`,
  ...extra,
});
const bk = (id, date, amountNgn, systemMatch, extra = {}) => ({
  id,
  bankDateISO: date,
  description: `line ${id}`,
  amountNgn,
  status: 'Matched',
  systemMatch,
  treasuryAccountId: 1,
  ...extra,
});
const acc = { id: 1, name: 'Main', bankName: 'Moniepoint', type: 'Bank', openingBalanceNgn: 1000 };

describe('linkedMovementIds', () => {
  it('reads every TM id from the match text, once', () => {
    expect(linkedMovementIds('TM-KD-26-1904 + TM-KD-26-1942 (excess → advance LE-KD-26-2126) TM-KD-26-1904')).toEqual([
      'TM-KD-26-1904',
      'TM-KD-26-1942',
    ]);
    expect(linkedMovementIds('NOT IN ERP')).toEqual([]);
  });
});

describe('bank reconciliation statement — synthetic', () => {
  const page = buildBankReconStatement({
    accounts: [acc],
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    bankOpeningByAccount: { 1: 900 },
    expenses: [{ expenseID: 'EXP-1', category: 'Bank charges' }],
    treasuryMovements: [
      tm('TM-XX-26-0001', '2026-07-30', 'RECEIPT_IN', 500), // before the period → opening
      tm('TM-XX-26-0002', '2026-08-02', 'RECEIPT_IN', 10_000),
      tm('TM-XX-26-0003', '2026-08-05', 'REFUND_PAYOUT', -2_000),
      tm('TM-XX-26-0004', '2026-08-06', 'PAYMENT_REQUEST_OUT', -3_000),
      tm('TM-XX-26-0005', '2026-08-07', 'INTERNAL_TRANSFER_OUT', -1_000),
      tm('TM-XX-26-0006', '2026-08-08', 'EXPENSE', -50, { sourceKind: 'EXPENSE', sourceId: 'EXP-1' }),
      tm('TM-XX-26-0007', '2026-08-31', 'RECEIPT_IN', 700), // on the bank in September → timing
      tm('TM-XX-26-0008', '2026-08-20', 'RECEIPT_IN', 60_000), // no bank line → unlinked
      tm('TM-XX-26-0009', '2026-08-21', 'RECEIPT_IN', 4_000, { sourceId: 'LE-9' }), // receipt …
      tm('TM-XX-26-0010', '2026-08-21', 'RECEIPT_REVERSAL_OUT', -4_000, { sourceId: 'LE-9' }), // … and its reversal
    ],
    bankLines: [
      bk('BKR-XX-26-0001', '2026-08-02', 10_000, 'TM-XX-26-0002'),
      bk('BKR-XX-26-0002', '2026-08-05', -2_020, 'TM-XX-26-0003 · net of ₦20 fee'),
      bk('BKR-XX-26-0003', '2026-08-06', -3_000, 'TM-XX-26-0004'),
      bk('BKR-XX-26-0004', '2026-08-07', -1_000, 'TM-XX-26-0005'),
      bk('BKR-XX-26-0005', '2026-08-08', -50, 'TM-XX-26-0006'),
      bk('BKR-XX-26-0006', '2026-08-22', 59_000, 'NOT IN ERP', { status: 'Review' }),
      bk('BKR-XX-26-0007', '2026-08-23', 75_000, 'NOT IN ERP'),
      bk('BKR-XX-26-0008', '2026-09-01', 700, 'TM-XX-26-0007'),
    ],
  }).pages[0];
  const bucket = (k) => page.erp.buckets.find((b) => b.key === k).amountNgn;

  it('walks ERP opening → buckets → closing', () => {
    expect(page.erp.openingNgn).toBe(1_500);
    expect(bucket(BUCKET_RECEIPTS)).toBe(70_700);
    expect(bucket(BUCKET_REFUNDS)).toBe(-2_000);
    expect(bucket(BUCKET_PAYMENTS)).toBe(-3_000);
    expect(bucket(BUCKET_TRANSFERS)).toBe(-1_000);
    expect(bucket(BUCKET_CHARGES)).toBe(-50);
    expect(page.erp.closingNgn).toBe(1_500 + 70_700 - 2_000 - 3_000 - 1_000 - 50);
  });

  it('bank closing = bank opening + lines in the period; difference = ERP closing − bank closing', () => {
    expect(page.bank.linesNetNgn).toBe(10_000 - 2_020 - 3_000 - 1_000 - 50 + 59_000 + 75_000);
    expect(page.bank.closingNgn).toBe(900 + page.bank.linesNetNgn);
    expect(page.differenceNgn).toBe(page.erp.closingNgn - page.bank.closingNgn);
    expect(page.openingDifferenceNgn).toBe(600);
  });

  it('explains the movement difference item by item, leaving ₦0', () => {
    expect(page.reconciling).toEqual({
      erpUnlinkedNgn: 60_000,
      erpTimingNgn: 700,
      bankUnlinkedNgn: 134_000,
      matchedVarianceNgn: -20,
      unexplainedNgn: 0,
    });
    expect(page.matchedVariances.map((v) => v.bankLineId)).toEqual(['BKR-XX-26-0002']);
    expect(page.erpTiming.map((t) => [t.id, t.bankLineId])).toEqual([['TM-XX-26-0007', 'BKR-XX-26-0008']]);
  });

  it('lists unlinked lines with severity and suggested matches', () => {
    const erp = Object.fromEntries(page.erpUnlinked.map((t) => [t.id, t]));
    expect(erp['TM-XX-26-0008'].severity).toBe('exception');
    expect(erp['TM-XX-26-0009'].severity).toBe('review');
    expect(erp['TM-XX-26-0009'].offsetMovementId).toBe('TM-XX-26-0010');
    const bank = Object.fromEntries(page.bankUnlinked.map((b) => [b.id, b]));
    expect(bank['BKR-XX-26-0006'].severity).toBe('review');
    expect(bank['BKR-XX-26-0007'].severity).toBe('exception');
  });

  it('suggests a same-amount line within 3 days', () => {
    const p = buildBankReconStatement({
      accounts: [acc],
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      treasuryMovements: [tm('TM-XX-26-0100', '2026-08-10', 'RECEIPT_IN', 80_000)],
      bankLines: [bk('BKR-XX-26-0100', '2026-08-12', 80_000, 'NOT IN ERP'), bk('BKR-XX-26-0101', '2026-08-20', 80_000, 'NOT IN ERP')],
    }).pages[0];
    expect(p.erpUnlinked[0].suggestedMatch).toBe('BKR-XX-26-0100');
    expect(p.bankUnlinked.find((b) => b.id === 'BKR-XX-26-0100').suggestedMatch).toBe('TM-XX-26-0100');
    expect(p.bankUnlinked.find((b) => b.id === 'BKR-XX-26-0101').suggestedMatch).toBe('');
  });

  it('without a bank opening, bank closing and difference are left empty (not guessed)', () => {
    const p = buildBankReconStatement({ accounts: [acc], startDate: '2026-08-01', endDate: '2026-08-31' }).pages[0];
    expect(p.bank.closingNgn).toBeNull();
    expect(p.differenceNgn).toBeNull();
  });

  it('cash accounts have no bank side and no unlinked lists', () => {
    const p = buildBankReconStatement({
      accounts: [{ id: 1, name: 'Cash Office', type: 'Cash' }],
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      treasuryMovements: [tm('TM-XX-26-0200', '2026-08-10', 'RECEIPT_IN', 5_000)],
    }).pages[0];
    expect(p.isCash).toBe(true);
    expect(p.erpUnlinked).toEqual([]);
    expect(p.erp.closingNgn).toBe(5_000);
  });

  it('flags a link to a movement that does not exist', () => {
    const p = buildBankReconStatement({
      accounts: [acc],
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      bankLines: [bk('BKR-XX-26-0300', '2026-08-03', 1_000, 'TM-XX-26-9999')],
    }).pages[0];
    expect(p.brokenLinks).toEqual([
      { bankLineId: 'BKR-XX-26-0300', treasuryMovementId: 'TM-XX-26-9999', dateISO: '2026-08-03', amountNgn: 1_000 },
    ]);
    expect(p.reconciling.unexplainedNgn).toBe(0);
  });
});

describe('bank reconciliation statement — Kaduna Sep 2026 fixture', () => {
  const r = buildBankReconStatement({
    ...kd,
    accounts: kd.accounts.map((a) => ({ ...a, openingBalanceNgn: 0 })),
  });
  const page = (id) => r.pages.find((p) => p.account.id === id);

  it('one page per treasury account; cash and accounts with no statement lines are marked', () => {
    expect(r.pages.map((p) => [p.account.id, p.isCash, p.hasBankStatement])).toEqual([
      [2, false, true],
      [3, true, false],
      [4, false, true],
      [10, false, false],
    ]);
  });

  it('Taj (Zaps): ERP net ₦1,281,307, bank net ₦1,548,302, every naira explained', () => {
    const p = page(2);
    expect(p.erp.netNgn).toBe(1_281_307);
    expect(p.bank.linesNetNgn).toBe(1_548_302);
    expect(p.reconciling).toEqual({
      erpUnlinkedNgn: 0,
      erpTimingNgn: 0,
      bankUnlinkedNgn: 267_000,
      matchedVarianceNgn: -5,
      unexplainedNgn: 0,
    });
    expect(p.bankUnlinked.map((b) => b.id)).toEqual(['BKR-KD-26-0062', 'BKR-KD-26-0063', 'BKR-KD-26-0083', 'BKR-KD-26-0084']);
  });

  it('Moniepoint (Zarewa): ERP net −₦5,286,229, bank net −₦4,885,220, unexplained ₦0', () => {
    const p = page(4);
    expect(p.erp.netNgn).toBe(-5_286_229);
    expect(p.bank.linesNetNgn).toBe(-4_885_220);
    expect(p.reconciling.erpUnlinkedNgn).toBe(3_660_230);
    expect(p.reconciling.bankUnlinkedNgn).toBe(4_242_224);
    expect(p.reconciling.matchedVarianceNgn).toBe(-180_985);
    expect(p.reconciling.unexplainedNgn).toBe(0);
    expect(p.erpUnlinked.find((t) => t.id === 'TM-KD-26-2489')).toMatchObject({ amountNgn: 5_000_000, severity: 'exception' });
  });

  it('ERP buckets add up to the net movement on every account', () => {
    for (const p of r.pages) {
      expect(p.erp.buckets.reduce((s, b) => s + b.amountNgn, 0)).toBe(p.erp.netNgn);
    }
  });
});
