import { describe, expect, it } from 'vitest';
import {
  REFUND_EXPENSE_BLOCK_MESSAGE,
  equipmentRepairMonthAlert,
  reviewPaymentRequestIntake,
} from './paymentRequestIntake.js';

describe('reviewPaymentRequestIntake', () => {
  it('blocks the word refund', () => {
    const r = reviewPaymentRequestIntake({
      description: 'Qs isa refund',
      expenseCategory: 'Outside corrugation',
      amountNgn: 418000,
      requestDate: '2026-09-07',
      quotationRef: 'QT-KD-26-1394',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(REFUND_EXPENSE_BLOCK_MESSAGE);
  });

  it('requires a staff name and repayment month for an IOU', () => {
    const r = reviewPaymentRequestIntake({
      description: 'IOU',
      expenseCategory: 'Office expenses',
      amountNgn: 20000,
      requestDate: '2026-09-14',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/staff name/);
    expect(r.errors.join(' ')).toMatch(/repayment month/);
  });

  it('accepts a named IOU with a repayment month', () => {
    const r = reviewPaymentRequestIntake({
      description: 'IOU',
      expenseCategory: 'IOU / staff loan',
      staffName: 'Ahmed JJ',
      repaymentMonth: '2026-11',
      amountNgn: 25000,
      requestDate: '2026-10-07',
    });
    expect(r.ok).toBe(true);
    expect(r.staffLoan).toBe(true);
  });

  it('requires a quote for bending', () => {
    const r = reviewPaymentRequestIntake({
      description: 'Bending – customer recoverable',
      expenseCategory: 'Others',
      amountNgn: 12000,
      requestDate: '2026-10-07',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/quote number/);
  });

  it('requires a reason when amount, date, and description match', () => {
    const r = reviewPaymentRequestIntake(
      {
        description: 'Drivers payment – Muhammad Yahaya',
        expenseCategory: 'Carriage inward',
        requestReference: 'PO-KD-26-0011',
        amountNgn: 15410,
        requestDate: '2026-09-12',
      },
      [{ id: 'PREQ-KD-26-0241', date: '2026-09-12', amountNgn: 15410, description: 'Drivers payment Muhammad Yahaya' }]
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason/);
    const confirmed = reviewPaymentRequestIntake(
      {
        description: 'Drivers payment – Muhammad Yahaya',
        expenseCategory: 'Carriage inward',
        requestReference: 'PO-KD-26-0011',
        amountNgn: 15410,
        requestDate: '2026-09-12',
        duplicateReason: 'Second trip, different delivery',
      },
      [{ id: 'PREQ-KD-26-0241', date: '2026-09-12', amountNgn: 15410, description: 'Drivers payment Muhammad Yahaya' }]
    );
    expect(confirmed.ok).toBe(true);
  });
});

describe('equipmentRepairMonthAlert', () => {
  it('alerts the month a forklift passes 250,000', () => {
    const quiet = equipmentRepairMonthAlert(
      [{ assetName: 'Forklift', month: '2026-09', amountNgn: 200000 }],
      { assetName: 'Forklift', month: '2026-09' }
    );
    expect(quiet.alert).toBe(false);
    const loud = equipmentRepairMonthAlert(
      [
        { assetName: 'Forklift', month: '2026-09', amountNgn: 257000 },
        { assetName: 'Forklift', month: '2026-09', amountNgn: 32000 },
      ],
      { assetName: 'Forklift', month: '2026-09' }
    );
    expect(loud.alert).toBe(true);
    expect(loud.totalNgn).toBe(289000);
  });
});
