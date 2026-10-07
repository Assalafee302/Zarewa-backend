import { describe, expect, it } from 'vitest';
import {
  buildMonthEndDataPack,
  coilValueAtDate,
  rollCountBackToDate,
} from './monthEndDataPack.js';

describe('month-end data pack', () => {
  it('puts the total at the sum of the lines', () => {
    const pack = buildMonthEndDataPack({
      month: '2026-09',
      branchId: 'BR-KD',
      coils: [
        {
          coilNo: 'CL-1',
          material: 'Aluzinc',
          family: 'aluzinc',
          gauge: '0.24',
          colour: 'IV',
          stockForm: 'coil',
          openingKg: 1000,
          closingKg: 400,
          poRateNgn: 1000,
        },
      ],
      bookPrices: { aluminium: 500, aluzinc: 800 },
      expenses: [
        { date: '2026-09-12', ref: 'EXP-KD-26-0362', name: '2nd advance for transformer', category: 'Maintenance', description: 'transformer', amountNgn: 2_000_000 },
        { date: '2026-09-24', ref: 'EXP-KD-26-0353', name: 'fork lift', category: 'Office expenses', description: 'fork lift', amountNgn: 257_000 },
        { date: '2026-09-07', ref: 'EXP-KD-26-0401', name: 'Qs isa refund', category: 'Outside corrugation', description: 'Qs isa refund', amountNgn: 418_000 },
        { date: '2026-09-04', ref: 'EXP-KD-26-0298', name: 'Gm Iou', category: 'Welfare', description: 'Gm Iou', amountNgn: 30_000 },
        { date: '2026-09-02', ref: 'EXP-1', name: 'diesel', category: 'Fuel & lubricant', description: 'diesel', amountNgn: 80_000 },
      ],
      sales: [{ date: '2026-09-15', quotationRef: 'QT-1', customerName: 'Amina', amountNgn: 100_000 }],
      priceReductions: [{ date: '2026-09-20', ref: 'RF-1', name: 'Amina', amountNgn: 5_000 }],
      advanceReturns: [{ date: '2026-09-20', ref: 'RF-2', name: 'Bala', amountNgn: 9_000 }],
    });
    expect(pack.ok).toBe(true);
    expect(pack.preparedAccounts).toBe(false);
    expect(pack.allTotalsMatchLines).toBe(true);
    for (const schedule of pack.schedules) {
      const sum = schedule.lines.reduce((s, line) => s + line.amountNgn, 0);
      expect(schedule.totalNgn).toBe(sum);
    }
    const close = pack.schedules.find((s) => s.id === 'coil-closing');
    expect(close.lines[0].netKg).toBe(340);
    expect(close.lines[0].spoolKg).toBe(60);
    expect(close.totalNgn).toBe(340_000);
    expect(close.lines[0].bookValueNgn).toBe(272_000);
    const factory = pack.schedules.find((s) => s.id === 'factory-overhead');
    expect(factory.lines.map((line) => line.ref).sort()).toEqual(['EXP-1', 'EXP-KD-26-0353']);
    const assets = pack.schedules.find((s) => s.id === 'asset-additions');
    expect(assets.totalNgn).toBe(2_000_000);
    const reclass = pack.schedules.find((s) => s.id === 'reclassify');
    expect(reclass.totalNgn).toBe(448_000);
    expect(pack.schedules.find((s) => s.id === 'refund-book').totalNgn).toBe(5_000);
    expect(pack.schedules.find((s) => s.id === 'advance-returns').totalNgn).toBe(9_000);
    expect(pack.schedules.find((s) => s.id === 'overpayment-refunds').totalNgn).toBe(0);
    expect(pack.schedules.find((s) => s.id === 'asset-additions').lines.map((line) => line.ref)).toEqual(['EXP-KD-26-0362']);
  });

  it('keeps interest, accessory cost, a prepaid supplier, and statement kobo', () => {
    const pack = buildMonthEndDataPack({
      month: '2026-09',
      branchId: 'BR-KD',
      expenses: [
        { date: '2026-09-07', ref: 'EXP-KD-26-0414', name: 'Interest to Oga Ali', category: 'Others', description: 'Interest to Oga Ali', amountNgn: 20_000 },
        { date: '2026-09-03', ref: 'EXP-KD-26-0407', name: 'Bank charges', category: 'Bank charges', description: 'Bank charges', amountNgn: 4_000 },
        { date: '2026-09-12', ref: 'EXP-KD-26-0376', name: 'Repair Of fork lift', category: 'Maintenance', description: 'Repair Of fork lift', amountNgn: 2_000 },
      ],
      accessories: [{ ref: 'ACC-1', name: 'Metro tile', qty: 10 }],
      accessoryCosts: { 'ACC-1': 500 },
      supplierBalances: [
        { date: '2026-09-30', ref: 'PO-KD-26-0085', name: 'Banbo Bintuan Lin', amountNgn: -13_050_000, paidNgn: 13_050_000, receivedNgn: 0, paidOn: '2026-09-15', promisedDelivery: '2026-09-17', daysOutstanding: 15 },
        { date: '2026-09-30', ref: 'PO-2', name: 'Other', amountNgn: 1_000, paidNgn: 0, receivedNgn: 1_000 },
      ],
      treasury: [
        { id: 4, name: 'Zarewa Aluminum & Plastics Ltd', bank: 'Moniepoint', type: 'bank', balanceNgn: 3_010_915 },
        { id: 'jaiz', name: 'Jaiz Bank', bank: 'Jaiz Bank', type: 'bank', balanceNgn: 278_000 },
      ],
      bankStatements: { 4: 3_411_799.04, jaiz: 278_000 },
      periodLocked: true,
      bookPrices: { aluminium: 1, aluzinc: 1 },
      counts: [{ coilNo: 'none', countDate: '2026-10-07', countedKg: 0 }],
      cashCountNgn: 0,
    });
    expect(pack.schedules.find((s) => s.id === 'admin-interest').totalNgn).toBe(20_000);
    expect(pack.schedules.find((s) => s.id === 'admin-bank-charges').totalNgn).toBe(4_000);
    expect(pack.schedules.find((s) => s.id === 'factory-overhead').lines.map((line) => line.ref)).toEqual(['EXP-KD-26-0376']);
    expect(pack.schedules.find((s) => s.id === 'accessories-stock').totalNgn).toBe(5_000);
    expect(pack.schedules.find((s) => s.id === 'suppliers-advance').lines[0].ref).toBe('PO-KD-26-0085');
    expect(pack.schedules.find((s) => s.id === 'suppliers-advance').lines[0].daysOutstanding).toBe(15);
    expect(pack.schedules.find((s) => s.id === 'suppliers-advance').lines[0].promisedDelivery).toBe('2026-09-17');
    expect(pack.schedules.find((s) => s.id === 'suppliers-advance').totalNgn).toBe(13_050_000);
    expect(pack.schedules.find((s) => s.id === 'suppliers-owe').totalNgn).toBe(1_000);
    const moniepoint = pack.schedules.find((s) => s.id === 'banks').lines.find((line) => line.ref === '4');
    expect(moniepoint.amountNgn).toBe(3_411_799.04);
    expect(moniepoint.erpBalanceNgn).toBe(3_010_915);
    expect(moniepoint.statementNgn).toBe(3_411_799.04);
    expect(moniepoint.differenceNgn).toBe(400_884.04);
    expect(pack.allTotalsMatchLines).toBe(true);
  });

  it('rolls a later count back to month end', () => {
    expect(
      rollCountBackToDate(500, '2026-10-07', '2026-09-30', [
        { date: '2026-10-02', receivedKg: 100, usedKg: 0 },
        { date: '2026-10-05', receivedKg: 0, usedKg: 40 },
      ])
    ).toBe(440);
    const valued = coilValueAtDate(
      { family: 'aluminium', stockForm: 'coil', poRateNgn: 2000 },
      35,
      {}
    );
    expect(valued.netKg).toBe(0);
  });
});
