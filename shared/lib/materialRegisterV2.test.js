import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMaterialRegisterV2, buildMaterialTransactionReport } from './materialTransactionReportCore.js';

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
    // Open (owner decision): Paid (net) = quote paidNgn − refunds, which includes credits applied
    // (OVERPAY_APPLIED) and payments after period end, so it is not bounded by recognised sales.
  });

  it('carries the coil register and keeps ?legacy=1 on the old builder', () => {
    expect(v2.version).toBe(2);
    expect(v2.coilRegister.consumption.totals.kg).toBe(45_313);
    const legacy = buildMaterialTransactionReport({ ...kd });
    expect(legacy.coilRegister).toBeUndefined();
    expect(legacy.version).toBeUndefined();
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
