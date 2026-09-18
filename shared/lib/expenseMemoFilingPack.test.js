import { describe, expect, it } from 'vitest';
import {
  buildExpenseMemoFilingPack,
  compactLineItemsSummary,
  estimateFilingPackPages,
  filingPackToCsv,
  filingPackToPdfPages,
  groupExpenseMemosByCategory,
  parseExpenseFilingPeriod,
} from './expenseMemoFilingPack.js';

describe('parseExpenseFilingPeriod', () => {
  it('expands YYYY-MM to the calendar month', () => {
    const p = parseExpenseFilingPeriod({ month: '2026-09' });
    expect(p.ok).toBe(true);
    expect(p.startDate).toBe('2026-09-01');
    expect(p.endDate).toBe('2026-09-30');
    expect(p.label).toBe('September 2026');
  });

  it('rejects inverted date ranges', () => {
    const p = parseExpenseFilingPeriod({ startDate: '2026-09-30', endDate: '2026-09-01' });
    expect(p.ok).toBe(false);
    expect(p.code).toBe('VALIDATION_ERROR');
  });
});

describe('buildExpenseMemoFilingPack', () => {
  const period = parseExpenseFilingPeriod({ month: '2026-09' });

  it('stacks memos under category groups instead of one page each', () => {
    const pack = buildExpenseMemoFilingPack({
      period,
      branchScope: 'BR-KD',
      memos: [
        {
          expenseId: 'EXP-1',
          requestId: 'PREQ-1',
          dateISO: '2026-09-03',
          category: 'Fuel & lubricant',
          amountNgn: 75_000,
          paidAmountNgn: 75_000,
          approvalStatus: 'Paid',
          description: 'Diesel week 1',
          payeeName: 'ABC Petroleum',
          bankAccount: 'ZENITH',
          filingNo: 'FUEL-KD-26-0012',
        },
        {
          expenseId: 'EXP-2',
          requestId: 'PREQ-2',
          dateISO: '2026-09-10',
          category: 'Fuel & lubricant',
          amountNgn: 90_000,
          paidAmountNgn: 90_000,
          approvalStatus: 'Paid',
          description: 'Diesel week 2',
        },
        {
          expenseId: 'EXP-3',
          dateISO: '2026-09-12',
          category: 'Office expenses',
          amountNgn: 8_000,
          paidAmountNgn: 8_000,
          approvalStatus: 'Paid',
          description: 'A4 paper',
          paymentMethod: 'Cash',
        },
      ],
    });

    expect(pack.totals.count).toBe(3);
    expect(pack.totals.amountNgn).toBe(173_000);
    expect(pack.groups).toHaveLength(2);
    const fuel = pack.groups.find((g) => g.category === 'Fuel & lubricant');
    expect(fuel.rowCount).toBe(2);
    expect(fuel.subtotalNgn).toBe(165_000);
    expect(fuel.memos.map((m) => m.expenseId)).toEqual(['EXP-1', 'EXP-2']);
    expect(pack.printHints.pageBreakBeforeMemo).toBe(false);
    expect(pack.printHints.density).toBe('compact');
    expect(pack.printHints.filingInstruction).toContain('Accounts / Expenses / 2026-09');
  });

  it('estimates far fewer sheets once a category has many memos', () => {
    const memos = [
      ...Array.from({ length: 12 }, (_, i) => ({
        expenseId: `EXP-F-${i + 1}`,
        dateISO: `2026-09-${String(i + 1).padStart(2, '0')}`,
        category: 'Fuel & lubricant',
        amountNgn: 1000,
        approvalStatus: 'Paid',
        description: `Diesel ${i + 1}`,
      })),
      {
        expenseId: 'EXP-O-1',
        dateISO: '2026-09-12',
        category: 'Office expenses',
        amountNgn: 8000,
        approvalStatus: 'Paid',
        description: 'A4 paper',
      },
    ];
    const pack = buildExpenseMemoFilingPack({ period, memos });
    expect(pack.printHints.estimatedPagesA4).toBeLessThan(memos.length);
    expect(pack.printHints.pagesSavedVsOneMemoPerPage).toBeGreaterThan(5);
  });

  it('starts a new sheet per category only when printing the full binder', () => {
    const all = buildExpenseMemoFilingPack({
      period,
      memos: [
        { expenseId: 'A', dateISO: '2026-09-01', category: 'Fuel & lubricant', amountNgn: 1, approvalStatus: 'Paid' },
        { expenseId: 'B', dateISO: '2026-09-01', category: 'Office expenses', amountNgn: 1, approvalStatus: 'Paid' },
      ],
    });
    expect(all.printHints.pageBreakBeforeCategory).toBe(true);

    const one = buildExpenseMemoFilingPack({
      period,
      categoryFilter: 'Fuel & lubricant',
      memos: [
        { expenseId: 'A', dateISO: '2026-09-01', category: 'Fuel & lubricant', amountNgn: 1, approvalStatus: 'Paid' },
      ],
    });
    expect(one.printHints.pageBreakBeforeCategory).toBe(false);
  });

  it('keeps several memos on one PDF page', () => {
    const memos = Array.from({ length: 8 }, (_, i) => ({
      expenseId: `EXP-${i + 1}`,
      dateISO: `2026-09-${String(i + 1).padStart(2, '0')}`,
      category: 'Office expenses',
      amountNgn: 1000,
      approvalStatus: 'Paid',
      description: `Stationery ${i + 1}`,
    }));
    const pack = buildExpenseMemoFilingPack({ period, memos });
    const pages = filingPackToPdfPages(pack);
    const bodyPages = pages.slice(1);
    expect(bodyPages.length).toBe(1);
    const joined = bodyPages[0].lines.join('\n');
    expect(joined).toContain('EXP-1');
    expect(joined).toContain('EXP-8');
    expect(joined).toContain('----------------------------------------');
  });

  it('emits a CSV register for the same stacked rows', () => {
    const pack = buildExpenseMemoFilingPack({
      period,
      memos: [
        {
          expenseId: 'EXP-9',
          dateISO: '2026-09-04',
          category: 'Welfare',
          amountNgn: 2500,
          approvalStatus: 'Paid',
          description: 'Staff water',
        },
      ],
    });
    const csv = filingPackToCsv(pack);
    expect(csv).toContain('category,lane,date');
    expect(csv).toContain('Welfare');
    expect(csv).toContain('EXP-9');
  });
});

describe('compactLineItemsSummary', () => {
  it('flattens qty x amount without a nested table', () => {
    expect(
      compactLineItemsSummary([
        { description: 'Diesel', quantity: 2, unitPriceNgn: 40_000, amountNgn: 80_000 },
        { description: 'Filter', quantity: 1, unitPriceNgn: 5_000, amountNgn: 5_000 },
      ])
    ).toMatch(/Diesel x2/);
  });
});

describe('groupExpenseMemosByCategory', () => {
  it('orders production lanes before admin', () => {
    const groups = groupExpenseMemosByCategory([
      { expenseId: '1', category: 'Office expenses', dateISO: '2026-09-02', amountNgn: 1 },
      { expenseId: '2', category: 'Fuel & lubricant', dateISO: '2026-09-01', amountNgn: 1 },
    ]);
    expect(groups.map((g) => g.category)).toEqual(['Fuel & lubricant', 'Office expenses']);
  });
});

describe('estimateFilingPackPages', () => {
  it('is far smaller than one page per memo', () => {
    expect(estimateFilingPackPages(40, 4)).toBeLessThan(40);
    expect(estimateFilingPackPages(40, 4)).toBeGreaterThan(1);
  });
});
