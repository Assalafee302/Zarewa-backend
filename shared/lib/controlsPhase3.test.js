import { describe, expect, it } from 'vitest';
import {
  balanceDueAfterProduction,
  coilNetKg,
  coilReceiptCost,
  grnWeightVariance,
  isEditAuditAction,
  lockedPeriodChange,
  poLinePurchaseUnit,
  productionGatePaid,
  receiptLinesRepeatingAdvance,
  receiptPaidByName,
  SPOOL_KG,
  spoolKgAtReceipt,
} from './controlsPhase3.js';
import { SPOOL_KG as REGISTER_SPOOL_KG } from './coilRegisterCore.js';

// TM-KD-26-1499: LE-KD-26-1154 (QT-KD-26-0907) took ₦2,811,440 in three lines; the ₦1.5m line was the 25 Jun advance.
const tm1499 = {
  quotationRef: 'QT-KD-26-0907',
  receipts: [{ id: 'RC-1', ledgerEntryId: 'LE-KD-26-1154', quotationRef: 'QT-KD-26-0907', amountNgn: 2811440, status: 'Posted' }],
  treasuryMovements: [
    { id: 'TM-KD-26-1499', type: 'RECEIPT_IN', sourceId: 'LE-KD-26-1154', amountNgn: 1500000 },
    { id: 'TM-KD-26-1500', type: 'RECEIPT_IN', sourceId: 'LE-KD-26-1154', amountNgn: 1282980 },
    { id: 'TM-KD-26-1501', type: 'RECEIPT_IN', sourceId: 'LE-KD-26-1154', amountNgn: 129980 },
  ],
};

describe('1. production gate paid basis', () => {
  it('receipts + advance applied, before any reversal', () => {
    const r = productionGatePaid({
      ...tm1499,
      ledgerEntries: [{ type: 'ADVANCE_APPLIED', quotationRef: 'QT-KD-26-0907', amountNgn: 100000 }],
    });
    expect(r).toEqual({ receiptsNgn: 2811440, creditAppliedNgn: 100000, reversalsNgn: 0, paidNgn: 2911440 });
  });

  it('subtracts a treasury reversal of one receipt line (TM-1499 reversed in Phase 2)', () => {
    const r = productionGatePaid({
      ...tm1499,
      treasuryMovements: [
        ...tm1499.treasuryMovements,
        { id: 'TM-REV', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -1500000, reversesMovementId: 'TM-KD-26-1499' },
      ],
    });
    expect(r.reversalsNgn).toBe(1500000);
    expect(r.paidNgn).toBe(1311440);
  });

  it('a fully reversed receipt does not count (and is not subtracted twice)', () => {
    const r = productionGatePaid({
      ...tm1499,
      receipts: [{ ...tm1499.receipts[0], status: 'Reversed' }],
      treasuryMovements: [
        ...tm1499.treasuryMovements,
        { id: 'TM-REV', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -2811440, reversesMovementId: 'TM-KD-26-1499' },
      ],
    });
    expect(r.paidNgn).toBe(0);
  });

  it('balance due after production lists produced jobs under 100% paid with the amount owed', () => {
    const { rows, totalOwedNgn } = balanceDueAfterProduction({
      jobs: [
        { jobID: 'PRO-1', quotationRef: 'QT-1', status: 'Completed', completedAtISO: '2026-09-10T10:00:00' },
        { jobID: 'PRO-2', quotationRef: 'QT-1', status: 'Completed', completedAtISO: '2026-09-05T10:00:00' },
        { jobID: 'PRO-3', quotationRef: 'QT-2', status: 'Completed', completedAtISO: '2026-09-11' },
        { jobID: 'PRO-4', quotationRef: 'QT-3', status: 'Running' },
      ],
      quotations: [
        { id: 'QT-1', customerName: 'Mal Sani', totalNgn: 1000000 },
        { id: 'QT-2', customerName: 'Paid up', totalNgn: 500000 },
        { id: 'QT-3', customerName: 'Not produced', totalNgn: 400000 },
      ],
      paidByQuotation: { 'QT-1': 700000, 'QT-2': 500000, 'QT-3': 0 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      quotationRef: 'QT-1',
      jobIDs: ['PRO-1', 'PRO-2'],
      firstCompletedISO: '2026-09-05',
      owedNgn: 300000,
      paidPct: 70,
    });
    expect(totalOwedNgn).toBe(300000);
  });
});

describe('2. receipts', () => {
  it('flags a treasury line that repeats an unapplied ADVANCE_IN', () => {
    const hits = receiptLinesRepeatingAdvance({
      lines: [{ amountNgn: 1500000 }, { amountNgn: 1282980 }],
      advanceMovements: [{ id: 'TM-KD-26-1147', amountNgn: 1500000, postedAtISO: '2026-06-25T12:00:00Z' }],
      advanceBalanceNgn: 1500000,
    });
    expect(hits).toEqual([{ lineIndex: 0, amountNgn: 1500000, movementId: 'TM-KD-26-1147', postedAtISO: '2026-06-25' }]);
  });

  it('no flag once the advance is used up', () => {
    expect(
      receiptLinesRepeatingAdvance({
        lines: [{ amountNgn: 1500000 }],
        advanceMovements: [{ id: 'TM-KD-26-1147', amountNgn: 1500000 }],
        advanceBalanceNgn: 0,
      })
    ).toEqual([]);
  });

  it('Paid by defaults to the customer name', () => {
    expect(receiptPaidByName({}, 'Mal Sani')).toBe('Mal Sani');
    expect(receiptPaidByName({ paidByName: ' Musa Bello ' }, 'Mal Sani')).toBe('Musa Bello');
  });
});

describe('3–5. coil receiving', () => {
  it('weighed kg more than 2% off the PO warns', () => {
    expect(grnWeightVariance({ weighedKg: 1015, expectedKg: 1000 })).toEqual({ variancePct: 1.5, warn: false });
    expect(grnWeightVariance({ weighedKg: 965, expectedKg: 1000 })).toEqual({ variancePct: -3.5, warn: true });
  });

  it('metre line: cost per kg = metres × price per metre ÷ weighed kg (not weighed kg × metre price)', () => {
    const c = coilReceiptCost({ unit: 'metre', weighedKg: 380, metres: 300, pricePerMetreNgn: 12000 });
    expect(c).toEqual({ landedCostNgn: 3600000, unitCostNgnPerKg: 9474 });
    const old = 380 * 12000;
    expect(old / c.landedCostNgn).toBeCloseTo(1.27, 2);
  });

  it('kg line: weighed kg × price per kg', () => {
    expect(coilReceiptCost({ unit: 'kg', weighedKg: 1000, pricePerKgNgn: 1738 })).toEqual({
      landedCostNgn: 1738000,
      unitCostNgnPerKg: 1738,
    });
  });

  it('explicit PO unit wins; legacy lines use the Phase 1 rule', () => {
    expect(poLinePurchaseUnit({ purchase_unit: 'metre', product_id: 'COIL-ALU' })).toBe('metre');
    expect(poLinePurchaseUnit({ product_id: 'COIL-ALU', product_name: 'Aluminium', unit_price_per_kg_ngn: 12000, qty_ordered: 300 })).toBe('metre');
    expect(poLinePurchaseUnit({ product_id: 'PRD-102', product_name: 'Aluzinc', unit_price_per_kg_ngn: 1738 })).toBe('kg');
  });

  it('spool: Aluzinc/PPGI 65, aluminium by kg 45, by metre 0; same constants as the material register', () => {
    expect(SPOOL_KG).toEqual(REGISTER_SPOOL_KG);
    expect(spoolKgAtReceipt({ materialTypeName: 'PPGI', productID: 'PRD-102' })).toBe(65);
    expect(spoolKgAtReceipt({ materialTypeName: 'Aluminium', purchaseUnit: 'kg' })).toBe(45);
    expect(spoolKgAtReceipt({ materialTypeName: 'Aluminium', purchaseUnit: 'metre' })).toBe(0);
    expect(coilNetKg(1000, 65)).toBe(935);
    expect(coilNetKg(30, 45)).toBe(0);
  });
});

describe('6. locked-period change flag', () => {
  it('flags an edit to a record dated in a locked month', () => {
    expect(
      lockedPeriodChange({ action: 'production.completion_coil_correct', recordDateISO: '2026-09-12', lockedPeriodKeys: ['2026-09'] })
    ).toEqual({ flag: 'Locked-period change', periodKey: '2026-09', recordDateISO: '2026-09-12' });
  });

  it('does not flag open months or new postings', () => {
    expect(lockedPeriodChange({ action: 'coil_lot.update', recordDateISO: '2026-10-02', lockedPeriodKeys: ['2026-09'] })).toBeNull();
    expect(lockedPeriodChange({ action: 'ledger.receipt', recordDateISO: '2026-09-12', lockedPeriodKeys: ['2026-09'] })).toBeNull();
    expect(isEditAuditAction('credit_exception.requested')).toBe(false);
    expect(isEditAuditAction('expense.reclassify_category_post_pay')).toBe(true);
  });
});
