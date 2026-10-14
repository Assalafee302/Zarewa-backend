import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMaterialRegisterV2, buildMaterialTransactionReport } from './materialTransactionReportCore.js';
import { buildQuotationCoverage } from './quotationCoverageCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/materialRegisterSource.json', import.meta.url), 'utf8')
);

/** Every row carrying Paid (net) in the per-job sections, with its quotation. */
function paidRows(report, quoteOfJob) {
  const rows = [];
  for (const key of ['aluminium', 'aluzinc', 'unclassifiedCoil', 'stoneCoated']) {
    for (const g of report[key]?.groups || []) for (const r of g.rows) rows.push(r);
  }
  rows.push(...(report.offcutProduction?.rows || []));
  for (const g of report.accessories?.groups || []) for (const r of g.rows || []) rows.push(r);
  return rows.filter((r) => r.amountNetNgn != null).map((r) => ({ q: quoteOfJob.get(r.jobId), amount: r.amountNetNgn }));
}

describe('material register v2 — Kaduna Sep 2026 fixture', () => {
  const quoteOfJob = new Map(kd.productionJobs.map((j) => [j.jobID, j.quotationRef]));
  const v2 = buildMaterialRegisterV2({ ...kd, allStockMovements: kd.stockMovements });

  it('counts Paid (net) once per quotation (no quotation counted twice)', () => {
    const rows = paidRows(v2, quoteOfJob);
    const quotes = rows.map((r) => r.q);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(quotes).size).toBe(quotes.length);
  });

  it('Paid (net) = cash that stayed + credit applied − refunds paid, as at period end, in three parts', () => {
    const summary = v2.summary.paidByQuotation;
    expect(summary.length).toBeGreaterThan(0);
    for (const q of summary) expect(q.paidNetNgn).toBe(q.cashNgn + q.creditNgn - q.refundsNgn);
    expect(new Set(summary.map((q) => q.quotationRef)).size).toBe(summary.length);
    // Yusuf: both receipts reversed in treasury → no cash on QT-1594 / QT-1606.
    const yusuf = summary.filter((q) => ['QT-KD-26-1594', 'QT-KD-26-1606'].includes(q.quotationRef));
    expect(yusuf.every((q) => q.cashNgn === 0)).toBe(true);
  });

  it('lists every quotation covered above its value + own overpayment (credit applied on top of cash)', () => {
    const over = v2.summary.paidByQuotation.filter(
      (q) => q.paidNetNgn > q.quotationTotalNgn + Math.max(0, q.cashNgn - q.quotationTotalNgn)
    );
    expect(v2.summary.coverageAboveValue.map((q) => q.quotationRef).sort()).toEqual(over.map((q) => q.quotationRef).sort());
    expect(over.map((q) => q.quotationRef).sort()).toEqual(['QT-KD-26-1522', 'QT-KD-26-1544', 'QT-KD-26-1668', 'QT-KD-26-1681']);
  });

  it('flags quotations first produced in the period before they were fully covered', () => {
    expect(v2.summary.producedBeforeFullyCovered.length).toBeGreaterThan(0);
    for (const q of v2.summary.producedBeforeFullyCovered) {
      expect(q.coverageAtFirstCompletionNgn).toBeLessThan(q.quotationTotalNgn);
      expect(q.firstCompletedISO >= '2026-09-01' && q.firstCompletedISO <= '2026-09-30').toBe(true);
    }
  });

  it('carries the coil register and keeps ?legacy=1 on the old builder', () => {
    expect(v2.version).toBe(2);
    expect(v2.coilRegister.consumption.totals.kg).toBe(45_313);
    const legacy = buildMaterialTransactionReport({ ...kd });
    expect(legacy.coilRegister).toBeUndefined();
    expect(legacy.version).toBeUndefined();
  });
});

describe('quotation coverage (synthetic)', () => {
  it('adds cash that stayed and credit, takes off refunds paid, and checks coverage at first completion', () => {
    const cov = buildQuotationCoverage({
      asAtISO: '2026-09-30',
      quotations: [{ id: 'Q1', totalNgn: 1000 }],
      productionJobs: [{ jobID: 'J1', quotationRef: 'Q1', status: 'Completed', completedAtISO: '2026-09-05' }],
      ledgerEntries: [
        { id: 'LE1', type: 'RECEIPT', quotationRef: 'Q1' },
        { id: 'LE2', type: 'RECEIPT', quotationRef: 'Q1' },
        { id: 'LA', type: 'OVERPAY_APPLIED', quotationRef: 'Q1', amountNgn: 300, atISO: '2026-09-10' },
      ],
      treasuryMovements: [
        { type: 'RECEIPT_IN', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE1', amountNgn: 600, postedAtISO: '2026-09-01' },
        { type: 'RECEIPT_IN', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE2', amountNgn: 200, postedAtISO: '2026-09-02' },
        { type: 'RECEIPT_REVERSAL_OUT', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE2', amountNgn: -200, postedAtISO: '2026-09-03' },
        { type: 'REFUND_PAYOUT', sourceId: 'R1', amountNgn: -50, postedAtISO: '2026-09-20' },
        { type: 'RECEIPT_IN', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE1', amountNgn: 999, postedAtISO: '2026-10-02' },
      ],
      refunds: [{ refundID: 'R1', quotationRef: 'Q1' }],
    }).get('Q1');
    expect(cov).toMatchObject({ cashNgn: 600, creditNgn: 300, refundsNgn: 50, paidNetNgn: 850 });
    expect(cov).toMatchObject({ coverageAtFirstCompletionNgn: 600, producedBeforeFullyCovered: true, overCoveredNgn: 0 });
  });
});

describe('material register v2 rules (synthetic)', () => {
  const base = {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    refunds: [],
    coilLots: [
      { coilNo: 'CL-1', materialTypeName: 'Aluzinc', gaugeLabel: '0.24mm', currentWeightKg: 900, receivedAtISO: '2026-08-01', unitCostNgnPerKg: 1700 },
    ],
  };

  it('classifies stone-coated by the quotation material, not by which metre field is filled', () => {
    const report = buildMaterialRegisterV2({
      ...base,
      quotations: [
        { id: 'QS', stoneMeterQuote: true, paidNgn: 100 },
        { id: 'QA', stoneMeterQuote: false, paidNgn: 200 },
      ],
      productionJobs: [
        { jobID: 'JS', quotationRef: 'QS', status: 'Completed', actualMeters: 0, actualRoofM: 0, actualFlatsheetM: 12, completedAtISO: '2026-09-05' },
        { jobID: 'JA', quotationRef: 'QA', status: 'Completed', actualMeters: 30, actualWeightKg: 0, completedAtISO: '2026-09-06' },
      ],
      productionJobCoils: [],
      stockMovements: [],
      allStockMovements: [],
    });
    const stoneJobs = report.stoneCoated.groups.flatMap((g) => g.rows.map((r) => r.jobId));
    expect(stoneJobs).toEqual(['JS']);
    expect(report.offcutProduction.rows.map((r) => r.jobId)).toEqual(['JA']);
  });

  it('takes coil kg from COIL_CONSUMPTION and shows the job record kg and the difference', () => {
    const report = buildMaterialRegisterV2({
      ...base,
      quotations: [{ id: 'Q1', paidNgn: 500 }],
      productionJobs: [{ jobID: 'J1', quotationRef: 'Q1', status: 'Completed', actualMeters: 50, completedAtISO: '2026-09-05' }],
      productionJobCoils: [
        { jobID: 'J1', coilNo: 'CL-1', gaugeLabel: '0.24mm', openingWeightKg: 1000, closingWeightKg: 900, consumedWeightKg: 95, metersProduced: 50 },
      ],
      stockMovements: [],
      allStockMovements: [{ type: 'COIL_CONSUMPTION', ref: 'J1', detail: 'CL-1 consumed for 50 m on J1', qty: -100, dateISO: '2026-09-05' }],
    });
    const row = report.aluzinc.groups[0].rows[0];
    expect(row).toMatchObject({ kgUsed: 100, jobConsumedKg: 95, kgDifference: 5, kgSource: 'COIL_CONSUMPTION' });
  });

  it('gives Paid (net) once per quotation when one quotation has two jobs', () => {
    const report = buildMaterialRegisterV2({
      ...base,
      quotations: [{ id: 'Q1', paidNgn: 1000 }],
      productionJobs: [
        { jobID: 'J1', quotationRef: 'Q1', status: 'Completed', actualMeters: 10, actualWeightKg: 20, completedAtISO: '2026-09-05' },
        { jobID: 'J2', quotationRef: 'Q1', status: 'Completed', actualMeters: 10, actualWeightKg: 20, completedAtISO: '2026-09-07' },
      ],
      productionJobCoils: [],
      stockMovements: [],
      allStockMovements: [],
      ledgerEntries: [{ id: 'LE1', type: 'RECEIPT', quotationRef: 'Q1' }],
      treasuryMovements: [
        { type: 'RECEIPT_IN', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE1', amountNgn: 1000, postedAtISO: '2026-09-01' },
      ],
    });
    expect(report.offcutProduction.rows.map((r) => r.amountNetNgn)).toEqual([1000, null]);
    const legacy = buildMaterialTransactionReport({ ...base, quotations: [{ id: 'Q1', paidNgn: 1000 }], productionJobs: report.offcutProduction.rows.map((r) => ({ jobID: r.jobId, quotationRef: 'Q1', status: 'Completed', actualMeters: 10, actualWeightKg: 20, completedAtISO: '2026-09-05' })) });
    expect(legacy.offcutProduction.rows.map((r) => r.amountNetNgn)).toEqual([1000, 1000]);
  });

  it('lists coil balance gaps instead of only counting them', () => {
    const report = buildMaterialRegisterV2({
      ...base,
      quotations: [{ id: 'Q1' }, { id: 'Q2' }],
      productionJobs: [
        { jobID: 'J1', quotationRef: 'Q1', status: 'Completed', actualMeters: 10, completedAtISO: '2026-09-05' },
        { jobID: 'J2', quotationRef: 'Q2', status: 'Completed', actualMeters: 10, completedAtISO: '2026-09-06' },
      ],
      productionJobCoils: [
        { jobID: 'J1', coilNo: 'CL-1', gaugeLabel: '0.24mm', openingWeightKg: 1000, closingWeightKg: 900, consumedWeightKg: 100, metersProduced: 10 },
        { jobID: 'J2', coilNo: 'CL-1', gaugeLabel: '0.24mm', openingWeightKg: 850, closingWeightKg: 800, consumedWeightKg: 50, metersProduced: 10 },
      ],
      stockMovements: [],
      allStockMovements: [],
    });
    expect(report.summary.gapLines).toEqual([
      expect.objectContaining({ material: 'Aluzinc', coilNo: 'CL-1', jobId: 'J2' }),
    ]);
  });
});
