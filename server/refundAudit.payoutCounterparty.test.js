/**
 * Refund audit — the treasury payout line names the person paid (pure, no DB).
 */
import { describe, it, expect } from 'vitest';
import { resolveRefundPayoutCounterparty } from './writeOps.js';
import { normalizeSwappedPayeeFields } from '../shared/lib/refundPayeeAccount.js';
import { buildTreasuryCashBook } from '../shared/lib/treasuryCashBookCore.js';

const row = { customer_name: 'Yunusa Driver', payee_name: 'Babangida' };

describe('resolveRefundPayoutCounterparty', () => {
  it('uses the payee the cashier picked in the pay dialog', () => {
    const r = resolveRefundPayoutCounterparty(
      { payeeName: 'Abdulrahman Uthman Sali', payeeBankName: 'opay', payeeAccountNo: '8031831486', payeeKind: 'customer' },
      { cashierPayoutLines: [] },
      row
    );
    expect(r).toMatchObject({ name: 'Abdulrahman Uthman Sali', accountNo: '8031831486', source: 'dialog' });
  });

  it('with nothing picked and one payee line still due, uses that line (the staff share after the customer was paid)', () => {
    const r = resolveRefundPayoutCounterparty(
      {},
      {
        cashierPayoutLines: [
          { payeeName: 'Babangida', tillDueNgn: 0, staffShare: false },
          { payeeName: 'Abdulrahman Uthman Sali', payeeBankName: 'opay', payeeAccountNo: '8031831486', tillDueNgn: 138_352, staffShare: true },
        ],
      },
      row
    );
    expect(r).toMatchObject({ name: 'Abdulrahman Uthman Sali', kind: 'staff', source: 'single_payee_line' });
  });

  it('falls back to the quotation customer when two payees are still due and none was picked', () => {
    const r = resolveRefundPayoutCounterparty(
      {},
      { cashierPayoutLines: [{ payeeName: 'Babangida', tillDueNgn: 730_000 }, { payeeName: 'Abdulrahman Uthman Sali', tillDueNgn: 138_352 }] },
      row
    );
    expect(r).toMatchObject({ name: 'Yunusa Driver', source: 'customer' });
  });
});

describe('normalizeSwappedPayeeFields — AS-001 name/account typed the wrong way round', () => {
  it('swaps a digits-only name with a letters-only account number', () => {
    expect(normalizeSwappedPayeeFields({ payeeName: '0636783237', payeeAccountNo: 'Ahmed Ibrahim' })).toEqual({
      payeeName: 'Ahmed Ibrahim',
      payeeAccountNo: '0636783237',
      swapped: true,
    });
  });
  it('leaves a normal record alone, including placeholders it cannot repair', () => {
    expect(normalizeSwappedPayeeFields({ payeeName: 'abbas gabdo', payeeAccountNo: '3051161830' })).toEqual({ payeeName: 'abbas gabdo', payeeAccountNo: '3051161830', swapped: false });
    expect(normalizeSwappedPayeeFields({ payeeName: 'Khalid', payeeAccountNo: '23456yu' }).swapped).toBe(false);
    expect(normalizeSwappedPayeeFields({ payeeName: '000', payeeAccountNo: 'OPAY' }).swapped).toBe(false);
  });
});

describe('cash book keeps the customer in the description (owner layout) and names the payee in the remark', () => {
  const movements = [
    { id: 'TM-1', postedAtISO: '2026-10-10T12:00:00.000Z', type: 'REFUND_PAYOUT', amountNgn: -730_000, treasuryAccountId: 4, sourceKind: 'REFUND', sourceId: 'RF-KD-26-9769', counterpartyName: 'Babangida' },
    { id: 'TM-2', postedAtISO: '2026-10-10T12:05:00.000Z', type: 'REFUND_PAYOUT', amountNgn: -138_352, treasuryAccountId: 4, sourceKind: 'REFUND', sourceId: 'RF-KD-26-9769', counterpartyName: 'Abdulrahman Uthman Sali' },
  ];
  const book = buildTreasuryCashBook({
    account: { id: 4, name: 'Moniepoint' },
    startDate: '2026-10-10',
    endDate: '2026-10-10',
    openingNgn: 1_000_000,
    movements,
    refunds: { 'RF-KD-26-9769': { customerName: 'Yunusa Driver', quotationRef: 'QT-KD-26-1747', staffShare: true } },
    refundPayoutLines: { 'RF-KD-26-9769': ['TM-1', 'TM-2'] },
  });
  const lines = book.days[0].lines;
  it('customer share paid to a nominee: description unchanged, remark says "paid to Babangida"', () => {
    expect(lines[0].description).toBe('Yunusa Driver refund (QT-1747) – part 1 of 2');
    expect(lines[0].remark).toBe('staff share 80%; paid to Babangida');
  });
  it('staff share: remark names the staff member', () => {
    expect(lines[1].description).toBe('Yunusa Driver refund (QT-1747) – part 2 of 2');
    expect(lines[1].remark).toBe('staff share 80%; paid to Abdulrahman Uthman Sali');
  });
  it('a staff account on file is still "via <name> account", not "paid to"', () => {
    const via = buildTreasuryCashBook({
      account: { id: 4, name: 'Moniepoint' },
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      openingNgn: 0,
      movements: [movements[1]],
      refunds: { 'RF-KD-26-9769': { customerName: 'Yunusa Driver', quotationRef: 'QT-KD-26-1747' } },
      staffAccounts: [{ name: 'Abdulrahman Uthman Sali', label: 'OM' }],
    });
    expect(via.days[0].lines[0].remark).toBe('via OM');
  });
  it('a line booked under the customer name keeps the old wording', () => {
    const same = buildTreasuryCashBook({
      account: { id: 4, name: 'Moniepoint' },
      startDate: '2026-10-10',
      endDate: '2026-10-10',
      openingNgn: 0,
      movements: [{ ...movements[0], counterpartyName: 'Yunusa Driver' }],
      refunds: { 'RF-KD-26-9769': { customerName: 'Yunusa Driver', quotationRef: 'QT-KD-26-1747' } },
    });
    expect(same.days[0].lines[0].description).toBe('Yunusa Driver refund (QT-1747)');
    expect(same.days[0].lines[0].remark).toBe('');
  });
});
