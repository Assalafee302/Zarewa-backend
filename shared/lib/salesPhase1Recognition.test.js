import { describe, expect, it } from 'vitest';
import {
  buildPayeeRecovery,
  buildSalesPhase1Report,
  classifyPhase1Refund,
  goodsRevenueForCompletedJob,
  selectReceiptsToMarkReversed,
} from './salesPhase1Recognition.js';

function quote(partial) {
  return {
    id: 'QT-1',
    customerId: 'CUS-1',
    customerName: 'Ada',
    status: 'Pending',
    branchId: 'BR-KD',
    lines: { products: [], accessories: [], services: [] },
    ...partial,
  };
}

function job(partial) {
  return {
    jobId: 'JOB-1',
    quotationRef: 'QT-1',
    customerId: 'CUS-1',
    customerName: 'Ada',
    status: 'Completed',
    completedAtISO: '2026-09-10',
    actualMeters: 10,
    actualRoofM: 0,
    actualFlatsheetM: 10,
    actualCladdingM: 0,
    cuttingListId: 'CL-1',
    ...partial,
  };
}

const period = { startDate: '2026-09-01', endDate: '2026-09-30', openingAsAt: '2026-08-31', closingAsAt: '2026-09-30' };

describe('Qs Isa overpayment', () => {
  it('classifies the Crock refund as an advance return and drops a void service quote', () => {
    expect(classifyPhase1Refund('RF-KD-26-9655', ['Additional services'], new Set(), new Set(['RF-KD-26-9655']))).toBe('ADVANCE_RETURN');
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-KD-26-1643',
          customerId: 'CUS-KD-26-0510',
          customerName: 'Qs Isa',
          status: 'Void',
          lines: { products: [], accessories: [], services: [{ name: 'Commission', qty: '1', unitPrice: '5380867' }] },
        }),
      ],
      cuttingLists: [{ id: 'CL-1', quotationRef: 'QT-KD-26-1643', status: 'Finished' }],
      receipts: [
        { id: 'LE-KD-26-1836', customerId: 'CUS-KD-26-0510', customerName: 'Qs Isa', quotationRef: 'QT-KD-26-1643', dateISO: '2026-09-09', amountNgn: 5380867, status: 'Cleared' },
      ],
      treasuryMovements: [
        { id: 'TM-IN', sourceId: 'LE-KD-26-1836', type: 'RECEIPT_IN', amountNgn: 5380867, postedAtISO: '2026-09-09' },
      ],
      refundMovements: [
        { id: 'TM-A', sourceId: 'RF-KD-26-9655', refundId: 'RF-KD-26-9655', type: 'REFUND_PAYOUT', amountNgn: -5245510, postedAtISO: '2026-09-24', customerId: 'CUS-KD-26-0510', customerName: 'Qs Isa', quotationRef: 'QT-KD-26-1643' },
        { id: 'TM-B', sourceId: 'RF-KD-26-9655', refundId: 'RF-KD-26-9655', type: 'REFUND_PAYOUT', amountNgn: -135357, postedAtISO: '2026-09-24', customerId: 'CUS-KD-26-0510', customerName: 'Qs Isa', quotationRef: 'QT-KD-26-1643' },
      ],
      advanceReturnRefunds: [{ refundId: 'RF-KD-26-9655' }],
    });
    expect(report.revenue.totalNgn).toBe(0);
    expect(report.cash.totalNgn).toBe(5380867);
    expect(report.refunds.totalNgn).toBe(5380867);
    expect(report.bridge.differenceNgn).toBe(0);
    const isa = report.closing.customers.find((row) => row.customerId === 'CUS-KD-26-0510');
    expect(isa.positionNgn).toBe(0);
    expect(report.refunds.review.september.rows.find((row) => row.refundId === 'RF-KD-26-9655').refundClass).toBe('ADVANCE_RETURN');
  });
});

describe('goodsRevenueForCompletedJob', () => {
  it('prices coil metres at the quote unit price, including an offcut or stain quote', () => {
    const book = {
      price: { stone: 0, roofing: 4500, flatsheet: 0, cladding: 0 },
      fallback: 4500,
      method: 'quote_unit_price',
    };
    const priced = goodsRevenueForCompletedJob(
      { actualMeters: 8, actualRoofM: 0, actualFlatsheetM: 8, actualCladdingM: 0 },
      book,
      null
    );
    expect(priced.revenueNgn).toBe(36000);
    expect(priced.unitPriceNgn).toBe(4500);
  });

  it('prices a stone hybrid at the stone price and the flatsheet price', () => {
    const book = {
      price: { stone: 8000, roofing: 0, flatsheet: 3000, cladding: 0 },
      fallback: 0,
      method: 'weighted_metre_prices',
    };
    const priced = goodsRevenueForCompletedJob(
      { actualMeters: 4, actualRoofM: 10, actualFlatsheetM: 4, actualCladdingM: 0 },
      book,
      null
    );
    expect(priced.revenueNgn).toBe(10 * 8000 + 4 * 3000);
    expect(priced.method).toBe('split_output');
  });

  it('uses the cutting-list mix when one job carries two metre prices', () => {
    const book = {
      price: { stone: 0, roofing: 5000, flatsheet: 3000, cladding: 0 },
      fallback: 4000,
      method: 'weighted_metre_prices',
    };
    const priced = goodsRevenueForCompletedJob(
      { actualMeters: 20, actualRoofM: 0, actualFlatsheetM: 20, actualCladdingM: 0 },
      book,
      { roof: 15, flat: 5, stone: 0, clad: 0 }
    );
    expect(priced.revenueNgn).toBe(15 * 5000 + 5 * 3000);
    expect(priced.method).toBe('cutting_list_mix');
  });
});

describe('buildSalesPhase1Report', () => {
  it('recognises goods, accessories on the first job, and services on delivery, and the bridge balances', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          lines: {
            products: [
              { name: 'Roofing Sheet', lineKind: 'roofing', qty: '10', unitPrice: '4000' },
              { name: 'Ridge Cap', lineKind: 'ridge', qty: '2', unitPrice: '1500' },
            ],
            accessories: [{ name: 'Nails', qty: '1', unitPrice: '2000' }],
            services: [{ name: 'Installation', qty: '1', unitPrice: '8000' }],
          },
        }),
      ],
      jobs: [
        job({ jobId: 'JOB-1', actualMeters: 10, actualFlatsheetM: 10, completedAtISO: '2026-09-10' }),
        job({ jobId: 'JOB-2', actualMeters: 4, actualFlatsheetM: 4, completedAtISO: '2026-09-20', cuttingListId: 'CL-2' }),
      ],
      cuttingLists: [
        { id: 'CL-1', quotationRef: 'QT-1', status: 'Finished' },
        { id: 'CL-2', quotationRef: 'QT-1', status: 'Finished' },
      ],
      deliveries: [{ quotationRef: 'QT-1', deliveredDateISO: '2026-09-18', status: 'Delivered' }],
      receipts: [
        {
          id: 'LE-1',
          ledgerEntryId: 'LE-1',
          customerId: 'CUS-1',
          customerName: 'Ada',
          quotationRef: 'QT-1',
          dateISO: '2026-09-05',
          amountNgn: 70000,
          status: 'Cleared',
          bankConfirmedAtISO: '2026-09-06',
          bankReceivedAmountNgn: 70000,
        },
      ],
      treasuryMovements: [
        { id: 'TM-1', sourceId: 'LE-1', type: 'RECEIPT_IN', amountNgn: 70000, postedAtISO: '2026-09-05' },
      ],
      refundMovements: [],
      creditApplications: [],
    });

    expect(report.revenue.goodsNgn).toBe(10 * 4000);
    expect(report.revenue.accessoryNgn).toBe(5000);
    expect(report.revenue.serviceNgn).toBe(8000);
    expect(report.revenue.totalNgn).toBe(40000 + 5000 + 8000);
    expect(report.revenue.byQuote[0].jobs).toHaveLength(1);
    expect(report.revenue.overQuote.quotes).toEqual([
      expect.objectContaining({ quotationRef: 'QT-1', quotedMetres: 10, completedMetres: 14, excessMetres: 4, excessValueNgn: 16000 }),
    ]);
    expect(report.cash.totalNgn).toBe(70000);
    expect(report.closing.advancesNgn).toBe(70000 - 53000);
    expect(report.closing.debtorsNgn).toBe(0);
    expect(report.bridge.balances).toBe(true);
    expect(report.bridge.differenceNgn).toBe(0);
    expect(report.unrecognised.count).toBe(0);
  });

  it('excludes void quotes and does not use the receipt as revenue', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-VOID',
          status: 'Void',
          lines: { products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '9000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
      ],
      jobs: [job({ quotationRef: 'QT-VOID', actualMeters: 10, actualFlatsheetM: 10 })],
      cuttingLists: [],
      deliveries: [],
      receipts: [
        {
          id: 'LE-V',
          customerId: 'CUS-1',
          customerName: 'Ada',
          quotationRef: 'QT-VOID',
          dateISO: '2026-09-02',
          amountNgn: 90000,
          status: 'Cleared',
          bankConfirmedAtISO: '2026-09-02',
        },
      ],
      treasuryMovements: [{ id: 'TM-V', sourceId: 'LE-V', type: 'RECEIPT_IN', amountNgn: 90000, postedAtISO: '2026-09-02' }],
    });
    expect(report.revenue.totalNgn).toBe(0);
    expect(report.cash.totalNgn).toBe(90000);
    expect(report.closing.advancesNgn).toBe(90000);
    expect(report.bridge.balances).toBe(true);
  });

  it('drops suspended, reversed, and fully reversed treasury receipts, and keeps the open part of a partial reversal', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [],
      jobs: [],
      receipts: [
        { id: 'LE-S', customerId: 'C1', customerName: 'Sus', quotationRef: 'QT-S', dateISO: '2026-09-02', amountNgn: 20000, status: 'Suspended — awaiting check' },
        { id: 'LE-R', customerId: 'C2', customerName: 'Rev', quotationRef: 'QT-R', dateISO: '2026-09-03', amountNgn: 1000, status: 'Reversed', bankConfirmedAtISO: '2026-09-03' },
        { id: 'LE-F', customerId: 'C3', customerName: 'Ahmad jj', quotationRef: 'QT-F', dateISO: '2026-09-11', amountNgn: 232620, status: 'Cleared', bankConfirmedAtISO: '2026-09-11', bankReceivedAmountNgn: 232620 },
        { id: 'LE-P', customerId: 'C3', customerName: 'Ahmad jj', quotationRef: 'QT-P', dateISO: '2026-09-17', amountNgn: 175610, status: 'Cleared', bankConfirmedAtISO: '2026-09-17', bankReceivedAmountNgn: 170610 },
      ],
      treasuryMovements: [
        { id: 'TM-F', sourceId: 'LE-F', type: 'RECEIPT_IN', amountNgn: 232620, postedAtISO: '2026-09-11' },
        { id: 'TM-FR', sourceId: 'LE-F', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -232620, postedAtISO: '2026-09-15', reversesMovementId: 'TM-F' },
        { id: 'TM-P1', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 170610, postedAtISO: '2026-09-11' },
        { id: 'TM-P2', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 5000, postedAtISO: '2026-09-17' },
        { id: 'TM-PR', sourceId: 'LE-P', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -5000, postedAtISO: '2026-09-17', reversesMovementId: 'TM-P2' },
      ],
    });
    expect(report.cash.totalNgn).toBe(170610);
    expect(report.cash.rows.map((row) => row.receiptId)).toEqual(['LE-P']);
    const reasons = report.cash.exclusions.map((row) => `${row.receiptId}:${row.reason}`);
    expect(reasons).toContain('LE-S:suspended');
    expect(reasons).toContain('LE-R:reversed');
    expect(reasons).toContain('LE-F:treasury_reversed');
    expect(reasons).toContain('LE-P:partial_treasury_reversal');
  });

  it('lists services and accessory-only quotes that have never been recognised', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-ACC',
          lines: {
            products: [],
            accessories: [{ name: 'Screw', qty: '4', unitPrice: '500' }],
            services: [{ name: 'Transport', qty: '1', unitPrice: '15000' }],
          },
        }),
      ],
      jobs: [],
      cuttingLists: [{ id: 'CL-A', quotationRef: 'QT-ACC', status: 'Waiting' }],
      deliveries: [],
      receipts: [],
    });
    expect(report.revenue.totalNgn).toBe(0);
    expect(report.unrecognised.rows).toEqual([
      expect.objectContaining({ quotationRef: 'QT-ACC', accessoryNgn: 2000, serviceNgn: 15000, bucket: 'no_completed_job' }),
    ]);
    expect(report.unrecognised.noCompletedJob.totalNgn).toBe(17000);
  });

  it('recognises an accessory-only quote when its cutting list is Finished', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-ACC',
          lines: { products: [], accessories: [{ name: 'Screw', qty: '2', unitPrice: '500' }], services: [] },
        }),
      ],
      jobs: [job({ quotationRef: 'QT-ACC', jobId: 'JOB-A', actualMeters: 0, actualFlatsheetM: 0, completedAtISO: '2026-09-12' })],
      cuttingLists: [{ id: 'CL-1', quotationRef: 'QT-ACC', status: 'Finished' }],
      deliveries: [],
      receipts: [],
    });
    expect(report.revenue.accessoryNgn).toBe(1000);
    expect(report.revenue.byQuote[0].totalNgn).toBe(1000);
    expect(report.unrecognised.count).toBe(0);
  });

  it('caps a plain coil against every quoted metre line, including a sheet row saved without a name', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          lines: {
            products: [
              { name: '', qty: '10', unitPrice: '4000', gauge: '0.22mm' },
              { name: 'Flat sheet', qty: '2', unitPrice: '3000', lineKind: 'roofing' },
            ],
            accessories: [],
            services: [],
          },
        }),
      ],
      jobs: [
        job({
          actualMeters: 15,
          actualRoofM: 0,
          actualFlatsheetM: 15,
          cuttingMix: { roof: 0, flat: 15, stone: 0, clad: 0 },
        }),
      ],
      cuttingLists: [],
      deliveries: [],
      receipts: [],
    });
    expect(report.revenue.overQuote.quotes[0]).toEqual(
      expect.objectContaining({ quotedMetres: 12, completedMetres: 15, excessMetres: 3, excessValueNgn: 3 * 3833 })
    );
    expect(report.revenue.goodsNgn).toBe(12 * 3833);
  });

  it('keeps an August bank line in August even when the confirmation tick is in September', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [quote({ id: 'QT-LATE', lines: { products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] } })],
      jobs: [],
      receipts: [
        {
          id: 'LE-EARLY',
          customerId: 'CUS-1',
          customerName: 'Ada',
          quotationRef: 'QT-LATE',
          dateISO: '2026-08-28',
          amountNgn: 1314100,
          status: 'Cleared',
          bankConfirmedAtISO: '2026-09-01',
        },
      ],
      treasuryMovements: [{ id: 'TM-E', sourceId: 'LE-EARLY', type: 'RECEIPT_IN', amountNgn: 1314100, postedAtISO: '2026-08-28' }],
    });
    expect(report.opening.advancesNgn).toBe(1314100);
    expect(report.cash.totalNgn).toBe(0);
    expect(report.closing.advancesNgn).toBe(1314100);
    expect(report.bridge.differenceNgn).toBe(0);
    expect(report.bridge.balances).toBe(true);
  });

  it('counts a September bank line when the confirmation tick is in October', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [],
      jobs: [],
      receipts: [
        {
          id: 'LE-LATE',
          customerId: 'C1',
          customerName: 'Ramaran',
          quotationRef: 'QT-R',
          dateISO: '2026-09-14',
          amountNgn: 3601220,
          status: 'Cleared',
          bankConfirmedAtISO: '2026-10-02',
        },
      ],
      treasuryMovements: [{ id: 'TM-L', sourceId: 'LE-LATE', type: 'RECEIPT_IN', amountNgn: 3601220, postedAtISO: '2026-09-14' }],
    });
    expect(report.cash.totalNgn).toBe(3601220);
    expect(report.cash.rows[0].bankValueDateISO).toBe('2026-09-14');
    expect(report.cash.inBankNotTicked.totalNgn).toBe(3601220);
    expect(report.closing.advancesNgn).toBe(3601220);
    expect(report.bridge.differenceNgn).toBe(0);
  });

  it('splits closing debtors into unpaid goods, excess refunds, and late ticks', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-A',
          customerId: 'A',
          customerName: 'Unpaid',
          lines: { products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-B',
          customerId: 'B',
          customerName: 'Refunded',
          lines: { products: [{ name: 'Roofing Sheet', qty: '6', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
      ],
      jobs: [
        job({ jobId: 'JA', quotationRef: 'QT-A', customerId: 'A', customerName: 'Unpaid', actualMeters: 10, actualFlatsheetM: 10 }),
        job({ jobId: 'JB', quotationRef: 'QT-B', customerId: 'B', customerName: 'Refunded', actualMeters: 6, actualFlatsheetM: 6 }),
      ],
      receipts: [
        { id: 'LE-A', customerId: 'A', customerName: 'Unpaid', quotationRef: 'QT-A', dateISO: '2026-09-02', amountNgn: 4000, status: 'Cleared', bankConfirmedAtISO: '2026-09-02' },
        { id: 'LE-B', customerId: 'B', customerName: 'Refunded', quotationRef: 'QT-B', dateISO: '2026-09-02', amountNgn: 10000, status: 'Cleared', bankConfirmedAtISO: '2026-09-02' },
        { id: 'LE-C', customerId: 'C', customerName: 'Late', quotationRef: 'QT-C', dateISO: '2026-09-14', amountNgn: 3000, status: 'Cleared', bankConfirmedAtISO: '2026-10-02' },
      ],
      treasuryMovements: [
        { id: 'TM-A', sourceId: 'LE-A', type: 'RECEIPT_IN', amountNgn: 4000, postedAtISO: '2026-09-02' },
        { id: 'TM-B', sourceId: 'LE-B', type: 'RECEIPT_IN', amountNgn: 10000, postedAtISO: '2026-09-02' },
        { id: 'TM-C', sourceId: 'LE-C', type: 'RECEIPT_IN', amountNgn: 3000, postedAtISO: '2026-09-14' },
      ],
      refundMovements: [
        {
          id: 'TM-RF',
          sourceId: 'RF-1',
          refundId: 'RF-1',
          type: 'REFUND_PAYOUT',
          amountNgn: -5000,
          postedAtISO: '2026-09-20',
          customerId: 'B',
          customerName: 'Refunded',
          quotationRef: 'QT-B',
        },
      ],
      refunds: [
        {
          refundId: 'RF-1',
          reasonCategory: '["Substitution difference"]',
          reason: 'Unproduced meterage on the quote',
          calculationText: '{"unitPrice":1000,"label":"Roofing Sheet"}',
          payeeName: 'Staff One',
          payeeBankName: 'Taj',
          payeeAccountNo: '000',
          split_distributions_json: [
            { amountNgn: 4000, payoutAccount: { partyName: 'Staff One', payeeBankName: 'Taj', payeeAccountNo: '1' } },
            { name: 'Staff Two', bankName: 'Moniepoint', amountNgn: 1000 },
          ],
        },
      ],
    });
    const buckets = report.closing.debtors.buckets;
    expect(buckets.unpaidGoods.totalNgn).toBe(6000);
    expect(buckets.refundExceedsOverpayment.totalNgn).toBe(1000);
    const refund = buckets.refundExceedsOverpayment.customers[0].refunds[0];
    expect(refund.refundId).toBe('RF-1');
    expect(refund.candidateSalesReduction).toBe(true);
    expect(refund.salesReductionMarkers).toEqual(['Substitution difference', 'Unproduced meterage']);
    expect(refund.staffSplits.map((row) => row.name)).toEqual(['Staff One', 'Staff Two']);
    expect(buckets.timing.totalNgn).toBe(3000);
    expect(report.bridge.differenceNgn).toBe(0);
  });

  it('splits unrecognised services into finished-job, no-job, and no-cutting-list quotes', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-A',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '1000', lineKind: 'roofing' }],
            accessories: [],
            services: [{ name: 'Installation', qty: '1', unitPrice: '4000' }],
          },
        }),
        quote({
          id: 'QT-B',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '1000', lineKind: 'roofing' }],
            accessories: [{ name: 'Nails', qty: '1', unitPrice: '900' }],
            services: [],
          },
        }),
        quote({
          id: 'QT-C',
          lines: { products: [], accessories: [{ name: 'Screw', qty: '2', unitPrice: '500' }], services: [] },
        }),
      ],
      jobs: [job({ quotationRef: 'QT-A', actualMeters: 5, actualFlatsheetM: 5, completedAtISO: '2026-09-04' })],
      cuttingLists: [{ id: 'CL-A', quotationRef: 'QT-A', status: 'In production' }],
      deliveries: [],
      receipts: [],
    });
    expect(report.unrecognised.completedButListOpen.totalNgn).toBe(4000);
    expect(report.unrecognised.completedButListOpen.rows.map((row) => row.quotationRef)).toEqual(['QT-A']);
    expect(report.unrecognised.noCompletedJob.totalNgn).toBe(900);
    expect(report.unrecognised.noCuttingList.totalNgn).toBe(1000);
    expect(report.unrecognised.totalNgn).toBe(5900);
  });

  it('shows the quote when an earlier receipt is reversed in the period', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [quote()],
      jobs: [],
      receipts: [
        {
          id: 'LE-OLD',
          customerId: 'CUS-1',
          customerName: 'Ada',
          quotationRef: 'QT-1',
          dateISO: '2026-08-20',
          amountNgn: 40000,
          status: 'Cleared',
          bankConfirmedAtISO: '2026-08-21',
        },
      ],
      treasuryMovements: [
        { id: 'TM-OLD', sourceId: 'LE-OLD', type: 'RECEIPT_IN', amountNgn: 40000, postedAtISO: '2026-08-20' },
        { id: 'TM-REV', sourceId: 'LE-OLD', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -40000, postedAtISO: '2026-09-15', reversesMovementId: 'TM-OLD' },
      ],
    });
    expect(report.opening.advancesNgn).toBe(40000);
    expect(report.cash.totalNgn).toBe(0);
    expect(report.closing.netNgn).toBe(0);
    expect(report.bridge.balances).toBe(false);
    expect(report.bridge.differenceNgn).toBe(-40000);
    expect(report.bridge.causingQuotes[0].quotationRef).toBe('QT-1');
  });
});

describe('round 5 review classes', () => {
  it('puts a refund-driven balance in refund excess and keeps a price reduction out of revenue until accepted', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-S',
          customerId: 'CUS-S',
          customerName: 'Salisu',
          branchId: 'BR-YL',
          lines: { products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-P',
          customerId: 'CUS-P',
          customerName: 'Price',
          branchId: 'BR-KD',
          lines: { products: [{ name: 'Roofing Sheet', qty: '8', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
      ],
      jobs: [
        job({ jobId: 'JS', quotationRef: 'QT-S', customerId: 'CUS-S', customerName: 'Salisu', actualMeters: 10, actualFlatsheetM: 10 }),
        job({ jobId: 'JP', quotationRef: 'QT-P', customerId: 'CUS-P', customerName: 'Price', actualMeters: 8, actualFlatsheetM: 8 }),
      ],
      receipts: [
        { id: 'LE-S', customerId: 'CUS-S', customerName: 'Salisu', quotationRef: 'QT-S', branchId: 'BR-YL', dateISO: '2026-09-02', amountNgn: 10000, status: 'Cleared', bankConfirmedAtISO: '2026-09-02' },
        { id: 'LE-P', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD', dateISO: '2026-09-03', amountNgn: 8000, status: 'Cleared', bankConfirmedAtISO: '2026-09-03' },
        { id: 'LE-PT', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD', dateISO: '2026-09-04', amountNgn: 500, status: 'Cleared', bankConfirmedAtISO: '2026-09-04' },
      ],
      treasuryMovements: [
        { id: 'TM-S', sourceId: 'LE-S', type: 'RECEIPT_IN', amountNgn: 9999, postedAtISO: '2026-09-02' },
        { id: 'TM-P', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 8000, postedAtISO: '2026-09-03' },
        { id: 'TM-PT', sourceId: 'LE-PT', type: 'RECEIPT_IN', amountNgn: 500, postedAtISO: '2026-09-04' },
      ],
      refundMovements: [
        { id: 'TM-RS', sourceId: 'RF-S', refundId: 'RF-S', type: 'REFUND_PAYOUT', amountNgn: -200, postedAtISO: '2026-09-12', customerId: 'CUS-S', customerName: 'Salisu', quotationRef: 'QT-S', branchId: 'BR-KD' },
        { id: 'TM-RP', sourceId: 'RF-P', refundId: 'RF-P', type: 'REFUND_PAYOUT', amountNgn: -300, postedAtISO: '2026-09-15', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD' },
        { id: 'TM-RPT', sourceId: 'RF-PT', refundId: 'RF-PT', type: 'REFUND_PAYOUT', amountNgn: -500, postedAtISO: '2026-09-20', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD' },
      ],
      refunds: [
        { refundId: 'RF-S', reasonCategory: 'Unproduced meterage', reason: 'Unproduced meterage' },
        { refundId: 'RF-P', reasonCategory: 'Substitution difference', reason: 'Substitution difference' },
        { refundId: 'RF-PT', reasonCategory: 'Additional services', reason: 'Additional services' },
      ],
      passThroughRefunds: [{ refundId: 'RF-PT', receiptId: 'LE-PT' }],
    });
    expect(report.bridge.differenceNgn).toBe(0);
    expect(report.scope.branchScope).toBe('ALL');
    const salisuDebt = report.closing.debtors.composition.customerDebtors.customers.find((row) => row.customerName === 'Salisu');
    const salisuExcess = report.closing.debtors.composition.refundExcess.customers.find((row) => row.customerName === 'Salisu');
    expect(salisuDebt.owedNgn).toBe(1);
    expect(salisuExcess.owedNgn).toBe(200);
    expect(report.closing.debtors.composition.roundingWriteOff.customers.map((row) => row.customerName)).toContain('Salisu');
    expect(report.refunds.review.september.advanceReturnNgn).toBe(200);
    expect(report.refunds.review.september.priceReductionNgn).toBe(300);
    expect(report.branchBridge.refundBranchMismatches).toEqual([
      expect.objectContaining({ refundId: 'RF-S', revenueBranchId: 'BR-YL', refundBranchId: 'BR-KD' }),
    ]);
    expect(report.branchBridge.totals.differenceNgn).toBe(0);
    expect(report.acceptancePreview.revenueNgn).toBe(report.revenue.totalNgn - 300);
    expect(report.acceptancePreview.cashNgn).toBe(report.cash.totalNgn - 500);
    expect(report.acceptancePreview.refundsNgn).toBe(report.refunds.totalNgn - 500);
    expect(report.acceptancePreview.bridge.differenceNgn).toBe(0);
    expect(report.acceptancePreview.bridge.balances).toBe(true);
  });
});

describe('selectReceiptsToMarkReversed', () => {
  it('marks a cleared receipt whose treasury is fully reversed and leaves a partial reversal cleared', () => {
    const picked = selectReceiptsToMarkReversed(
      [
        { id: 'LE-F', status: 'Cleared', quotationRef: 'QT-F', customerName: 'Ahmad jj', amountNgn: 232620 },
        { id: 'LE-P', status: 'Cleared', quotationRef: 'QT-P', customerName: 'Ahmad jj', amountNgn: 175610 },
        { id: 'LE-S', status: 'Suspended - investigation', quotationRef: 'QT-S', amountNgn: 1000000 },
      ],
      [
        { id: 'TM-F', sourceId: 'LE-F', type: 'RECEIPT_IN', amountNgn: 232620 },
        { id: 'TM-FR', sourceId: 'LE-F', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -232620, reversesMovementId: 'TM-F' },
        { id: 'TM-P1', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 170610 },
        { id: 'TM-P2', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 5000 },
        { id: 'TM-PR', sourceId: 'LE-P', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -5000, reversesMovementId: 'TM-P2' },
        { id: 'TM-S', sourceId: 'LE-S', type: 'RECEIPT_IN', amountNgn: 1000000 },
        { id: 'TM-SR', sourceId: 'LE-S', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -1000000, reversesMovementId: 'TM-S' },
      ]
    );
    expect(picked.map((row) => row.id)).toEqual(['LE-F']);
  });

  it('does not mark a receipt whose funding is a live bank deposit', () => {
    const picked = selectReceiptsToMarkReversed(
      [{ id: 'LE-D', status: 'Cleared', amountNgn: 2069860 }],
      [
        { id: 'TM-D', sourceId: 'LE-D', type: 'RECEIPT_IN', amountNgn: 2069860 },
        { id: 'TM-DR', sourceId: 'LE-D', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -2069860, reversesMovementId: 'TM-D' },
      ],
      [{ receiptId: 'LE-D', amountNgn: 1998860, bankDateISO: '2026-07-30', depositId: 'BD-1', depositStatus: 'PARTIAL' }]
    );
    expect(picked).toEqual([]);
  });
});

describe('round 4 settlements', () => {
  it('settles an advance-funded quote, a deposit-funded receipt, and a staff credit without breaking the bridge', () => {
    const report = buildSalesPhase1Report({
      ...period,
      quotations: [
        quote({
          id: 'QT-ADV',
          customerId: 'CUS-T',
          customerName: 'Tahir',
          lines: { products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-DEP',
          customerId: 'CUS-A',
          customerName: 'Abbas',
          lines: { products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-STF',
          customerId: 'CUS-S',
          customerName: 'Staff Buyer',
          lines: { products: [{ name: 'Roofing Sheet', qty: '4', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
      ],
      jobs: [
        job({ jobId: 'J-ADV', quotationRef: 'QT-ADV', customerId: 'CUS-T', customerName: 'Tahir', completedAtISO: '2026-07-11', actualMeters: 10, actualFlatsheetM: 10 }),
        job({ jobId: 'J-DEP', quotationRef: 'QT-DEP', customerId: 'CUS-A', customerName: 'Abbas', completedAtISO: '2026-08-12', actualMeters: 5, actualFlatsheetM: 5 }),
        job({ jobId: 'J-STF', quotationRef: 'QT-STF', customerId: 'CUS-S', customerName: 'Staff Buyer', completedAtISO: '2026-06-19', actualMeters: 4, actualFlatsheetM: 4 }),
      ],
      receipts: [
        {
          id: 'LE-DEP',
          customerId: 'CUS-A',
          customerName: 'Abbas',
          quotationRef: 'QT-DEP',
          dateISO: '2026-08-11',
          amountNgn: 5000,
          status: 'Cleared',
        },
        { id: 'LE-OPEN', customerId: 'CUS-K', customerName: 'Kept', quotationRef: 'QT-K', dateISO: '2026-09-02', amountNgn: 1000, status: 'Cleared' },
        { id: 'LE-REV', customerId: 'CUS-H', customerName: 'Ahmad', quotationRef: 'QT-H', dateISO: '2026-09-17', amountNgn: 5000, status: 'Cleared' },
        { id: 'LE-SUS', customerId: 'CUS-M', customerName: 'Mrido', quotationRef: 'QT-M', dateISO: '2026-09-02', amountNgn: 20000, status: 'Suspended — No bank receipt' },
        { id: 'LE-ZERO', customerId: 'CUS-Z', customerName: 'Zero', quotationRef: 'QT-Z', dateISO: '2026-09-17', amountNgn: 0, status: 'Cleared' },
      ],
      treasuryMovements: [
        { id: 'TM-DEP', sourceId: 'LE-DEP', type: 'RECEIPT_IN', amountNgn: 5000, postedAtISO: '2026-07-30' },
        { id: 'TM-DEPR', sourceId: 'LE-DEP', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -5000, reversesMovementId: 'TM-DEP', postedAtISO: '2026-07-30' },
        { id: 'TM-OPEN', sourceId: 'LE-OPEN', type: 'RECEIPT_IN', amountNgn: 1000, postedAtISO: '2026-09-02', treasuryAccountId: 4 },
        { id: 'TM-REV', sourceId: 'LE-REV', type: 'RECEIPT_IN', amountNgn: 5000, postedAtISO: '2026-09-17', treasuryAccountId: 4 },
        { id: 'TM-REVR', sourceId: 'LE-REV', type: 'RECEIPT_REVERSAL_OUT', amountNgn: -5000, reversesMovementId: 'TM-REV', postedAtISO: '2026-09-17' },
        { id: 'TM-SUS', sourceId: 'LE-SUS', type: 'RECEIPT_IN', amountNgn: 20000, postedAtISO: '2026-09-02', treasuryAccountId: 4 },
        { id: 'TM-ZERO', sourceId: 'LE-ZERO', type: 'RECEIPT_IN', amountNgn: 0, postedAtISO: '2026-09-17', treasuryAccountId: 4 },
      ],
      depositAllocations: [
        { receiptId: 'LE-DEP', depositId: 'BD-1', amountNgn: 5000, bankDateISO: '2026-07-30', depositStatus: 'PARTIAL' },
      ],
      advanceMovements: [
        { id: 'TM-ADV', sourceId: 'LE-ADV', type: 'ADVANCE_IN', amountNgn: 12000, postedAtISO: '2026-05-24', customerId: 'CUS-T', customerName: 'Tahir' },
        { id: 'TM-SEPT', sourceId: 'LE-SEPT', type: 'ADVANCE_IN', amountNgn: 3000, postedAtISO: '2026-09-19', customerId: 'CUS-R', customerName: 'Ramaran' },
      ],
      staffPurchaseCredits: [
        { customerId: 'CUS-S', customerName: 'Staff Buyer', quotationRef: 'QT-STF', amountNgn: 5000, dateISO: '2026-06-19', obligationId: 'OBL-1' },
      ],
      tieOutReceiptIns: [
        { id: 'TM-OPEN', sourceId: 'LE-OPEN', type: 'RECEIPT_IN', amountNgn: 1000, postedAtISO: '2026-09-02', treasuryAccountId: 4, counterpartyName: 'Kept' },
        { id: 'TM-REV', sourceId: 'LE-REV', type: 'RECEIPT_IN', amountNgn: 5000, postedAtISO: '2026-09-17', treasuryAccountId: 4, counterpartyName: 'Ahmad' },
        { id: 'TM-SUS', sourceId: 'LE-SUS', type: 'RECEIPT_IN', amountNgn: 20000, postedAtISO: '2026-09-02', treasuryAccountId: 4 },
        { id: 'TM-ORP', sourceId: 'LE-ORP', type: 'RECEIPT_IN', amountNgn: 7520, postedAtISO: '2026-09-12', treasuryAccountId: 4, counterpartyName: 'Hannatu' },
        { id: 'TM-ZERO', sourceId: 'LE-ZERO', type: 'RECEIPT_IN', amountNgn: 0, postedAtISO: '2026-09-17', treasuryAccountId: 4, note: 'Zeroed — covered by overpay/refund fund' },
      ],
      tieOutReversals: [
        { id: 'TM-REVR', reversesMovementId: 'TM-REV', amountNgn: -5000, postedAtISO: '2026-09-17', note: 'Partial line reversed', treasuryAccountId: 4 },
      ],
      refundMovements: [
        { id: 'TM-RF', sourceId: 'RF-1', refundId: 'RF-1', type: 'REFUND_PAYOUT', amountNgn: -800, postedAtISO: '2026-09-20', customerId: 'CUS-T', customerName: 'Tahir', quotationRef: 'QT-ADV' },
        { id: 'TM-PT', sourceId: 'RF-PT', refundId: 'RF-PT', type: 'REFUND_PAYOUT', amountNgn: -1000, postedAtISO: '2026-09-24', customerId: 'CUS-K', customerName: 'Kept', quotationRef: 'QT-K' },
      ],
      refunds: [
        { refundId: 'RF-1', customerId: 'CUS-T', customerName: 'Tahir', quotationRef: 'QT-ADV', reasonCategory: 'Unproduced meterage', reason: 'Unproduced meterage', payeeName: 'Payee' },
        { refundId: 'RF-PT', customerId: 'CUS-K', customerName: 'Kept', quotationRef: 'QT-K', reasonCategory: 'Additional services', reason: 'Additional services', payeeName: 'Payee' },
      ],
      passThroughRefunds: [{ refundId: 'RF-PT', receiptId: 'LE-OPEN' }],
    });

    expect(report.bridge.differenceNgn).toBe(0);
    expect(report.bridge.balances).toBe(true);
    expect(report.cash.totalNgn).toBe(4000);
    const names = report.closing.debtors.composition.customerDebtors.customers.map((row) => row.customerName);
    expect(names).not.toContain('Tahir');
    expect(names).not.toContain('Abbas');
    expect(names).not.toContain('Staff Buyer');
    expect(report.closing.debtors.composition.staffReceivables.totalNgn).toBe(4000);
    expect(report.closing.debtors.composition.staffReceivables.rows[0].obligationId).toBe('OBL-1');
    const gap = report.moniepointCashCheck;
    expect(gap.treasuryReceiptInNgn).toBe(33520);
    expect(gap.inReportNgn).toBe(1000);
    expect(gap.excluded.map((row) => row.reason).sort()).toEqual(['no_sales_receipt', 'reversed', 'suspended', 'zero']);
    const pass = report.refunds.review.september.rows.find((row) => row.refundId === 'RF-PT');
    const price = report.refunds.review.september.rows.find((row) => row.refundId === 'RF-1');
    expect(pass.refundClass).toBe('PASS_THROUGH');
    expect(pass.linkedReceiptId).toBe('LE-OPEN');
    expect(price.refundClass).toBe('ADVANCE_RETURN');
    expect(report.refunds.review.september.advanceReturnNgn).toBe(800);
    expect(report.acceptancePreview.bridge.balances).toBe(true);
    expect(report.refunds.review.applied).toBe(false);
    expect(report.refunds.totalNgn).toBe(1800);
  });
});

describe('round 6 posted adjustments', () => {
  it('posts a price-reduction credit note and a rounding discount, and holds a refund-without-cash debtor', () => {
    const base = {
      ...period,
      quotations: [
        quote({
          id: 'QT-P',
          customerId: 'CUS-P',
          customerName: 'Price',
          branchId: 'BR-KD',
          lines: { products: [{ name: 'Roofing Sheet', qty: '8', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-Y',
          customerId: 'CUS-Y',
          customerName: 'Yusuf',
          branchId: 'BR-KD',
          lines: { products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
        quote({
          id: 'QT-R',
          customerId: 'CUS-R',
          customerName: 'Round',
          branchId: 'BR-YL',
          lines: { products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '1000', lineKind: 'roofing' }], accessories: [], services: [] },
        }),
      ],
      jobs: [
        job({ jobId: 'JP', quotationRef: 'QT-P', customerId: 'CUS-P', customerName: 'Price', actualMeters: 8, actualFlatsheetM: 8 }),
        job({ jobId: 'JY', quotationRef: 'QT-Y', customerId: 'CUS-Y', customerName: 'Yusuf', actualMeters: 10, actualFlatsheetM: 10 }),
        job({ jobId: 'JR', quotationRef: 'QT-R', customerId: 'CUS-R', customerName: 'Round', actualMeters: 5, actualFlatsheetM: 5 }),
      ],
      receipts: [
        { id: 'LE-P', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD', dateISO: '2026-09-03', amountNgn: 8000, status: 'Cleared' },
        { id: 'LE-R', customerId: 'CUS-R', customerName: 'Round', quotationRef: 'QT-R', branchId: 'BR-YL', dateISO: '2026-09-04', amountNgn: 4999, status: 'Cleared' },
      ],
      treasuryMovements: [
        { id: 'TM-P', sourceId: 'LE-P', type: 'RECEIPT_IN', amountNgn: 8000, postedAtISO: '2026-09-03' },
        { id: 'TM-R', sourceId: 'LE-R', type: 'RECEIPT_IN', amountNgn: 4999, postedAtISO: '2026-09-04' },
      ],
      refundMovements: [
        { id: 'TM-RP', sourceId: 'RF-P', refundId: 'RF-P', type: 'REFUND_PAYOUT', amountNgn: -300, postedAtISO: '2026-09-15', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD' },
        { id: 'TM-RY', sourceId: 'RF-Y', refundId: 'RF-Y', type: 'REFUND_PAYOUT', amountNgn: -400, postedAtISO: '2026-09-20', customerId: 'CUS-Y', customerName: 'Yusuf', quotationRef: 'QT-Y', branchId: 'BR-KD' },
      ],
      refunds: [
        { refundId: 'RF-P', reasonCategory: 'Substitution difference', reason: 'Substitution difference' },
        { refundId: 'RF-Y', reasonCategory: 'Overpayment', reason: 'Overpayment' },
      ],
      postedAdjustments: [
        { kind: 'CREDIT_NOTE', entityId: 'RF-P', customerId: 'CUS-P', customerName: 'Price', quotationRef: 'QT-P', branchId: 'BR-KD', amountNgn: 300, dateISO: '2026-09-15' },
        { kind: 'DISCOUNT_ALLOWED', entityId: 'CUS-R', customerId: 'CUS-R', customerName: 'Round', quotationRef: 'QT-R', branchId: 'BR-YL', amountNgn: 1, dateISO: '2026-09-30' },
        { kind: 'DEBTOR_HOLD', entityId: 'CUS-Y', customerId: 'CUS-Y' },
        { kind: 'REFUND_FLAG', entityId: 'RF-Y', customerId: 'CUS-Y', note: 'refund without confirmed cash' },
        { kind: 'ADVANCE_RETURN_ACCEPTED', entityId: 'RF-NONE' },
      ],
    };
    const report = buildSalesPhase1Report(base);
    expect(report.revenue.creditNotesNgn).toBe(300);
    expect(report.revenue.discountAllowedNgn).toBe(1);
    expect(report.revenue.totalNgn).toBe(8000 + 10000 + 5000 - 300 - 1);
    expect(report.bridge.differenceNgn).toBe(0);
    expect(report.branchBridge.totals.differenceNgn).toBe(0);
    const yusuf = report.closing.debtors.composition.customerDebtors.customers.find((row) => row.customerId === 'CUS-Y');
    expect(yusuf.owedNgn).toBe(10400);
    expect(report.closing.debtors.composition.refundExcess.customers.find((row) => row.customerId === 'CUS-Y')).toBeUndefined();
    expect(report.closing.debtors.composition.customerDebtors.customers.find((row) => row.customerId === 'CUS-R')).toBeUndefined();
    expect(report.posted.passThrough).toBe('held');
    expect(report.posted.septemberLocked).toBe(false);
    const price = report.closing.customers.find((row) => row.customerId === 'CUS-P');
    expect(price.positionNgn).toBe(0);
  });

  it('moves refund excess onto the statement account, and a staff payee onto a staff line', () => {
    const recovery = buildPayeeRecovery({
      excessCustomers: [{ customerId: 'CUS-1', customerName: 'Ada', owedNgn: 1000 }],
      refundCustomers: [{
        customerId: 'CUS-1',
        refunds: [
          { refundId: 'RF-1', paidNgn: 600, payeeName: 'Khalid', payeeAccountNo: '87654', payeeBankName: 'opay' },
          { refundId: 'RF-2', paidNgn: 400, payeeName: 'Mohammed Ibrahim Bakari', payeeAccountNo: '3064987728', payeeBankName: 'First Bank' },
        ],
      }],
      staffPayees: [{ name: 'Muhammad Ibrahim Bakari · ZAPKD012 (Staff)', accountNo: '' }],
      statementBeneficiaries: [{ refundId: 'RF-1', accountNo: '8012345678', name: 'Adamu Bello', bankName: 'OPay' }],
    });
    expect(recovery.totalNgn).toBe(1000);
    expect(recovery.staffNgn).toBe(400);
    expect(recovery.staffRows[0].accountNo).toBe('3064987728');
    expect(recovery.groups[0].accountNo).toBe('8012345678');
    expect(recovery.groups[0].accountSource).toBe('statement');
    expect(recovery.groups[0].payeeName).toBe('Adamu Bello');
    expect(recovery.unresolvedNgn).toBe(0);
  });
});
