import { describe, expect, it } from 'vitest';
import { buildMaterialTransactionReport } from '../shared/lib/materialTransactionReportCore.js';

describe('buildMaterialTransactionReport', () => {
  it('groups aluminium by gauge and sorts by coil number', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'J1',
          status: 'Completed',
          completedAtISO: '2026-05-10',
          quotationRef: 'QT-1',
          customerName: 'Acme',
          productName: 'Design A',
          actualMeters: 100,
          actualWeightKg: 50,
        },
      ],
      productionJobCoils: [
        {
          jobID: 'J1',
          sequenceNo: 2,
          coilNo: 'C-002',
          gaugeLabel: '0.5mm',
          openingWeightKg: 500,
          closingWeightKg: 450,
          consumedWeightKg: 50,
          metersProduced: 100,
          actualConversionKgPerM: 0.5,
          colour: 'R',
        },
        {
          jobID: 'J1',
          sequenceNo: 1,
          coilNo: 'C-001',
          gaugeLabel: '0.5mm',
          openingWeightKg: 600,
          closingWeightKg: 550,
          consumedWeightKg: 50,
          metersProduced: 100,
          actualConversionKgPerM: 0.5,
          colour: 'B',
        },
      ],
      quotations: [
        { id: 'QT-1', customerName: 'Acme', projectName: 'Site X', totalNgn: 1_000_000, paidNgn: 800_000 },
      ],
      refunds: [],
      coilLots: [
        { coilNo: 'C-001', materialTypeName: 'Aluminium' },
        { coilNo: 'C-002', materialTypeName: 'Aluminium' },
      ],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(report.aluminium.groups).toHaveLength(1);
    expect(report.aluminium.groups[0].gaugeLabel).toBe('0.5mm');
    expect(report.aluminium.groups[0].rows.map((r) => r.coilNo)).toEqual(['C-001', 'C-002']);
    expect(report.aluminium.groups[0].rows[0].qtNoDisplay).toBe('0001');
    expect(report.aluminium.groups[0].rows[0].coilNoDisplay).toBe('0001');
    expect(report.aluminium.groups[0].rows[0].txnDateDisplay).toBe('10/05');
    expect(report.aluminium.groups[0].subtotals.totalKgUsed).toBe(100);
  });

  it('includes cancelled jobs in cancelled section', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'JX',
          status: 'Cancelled',
          completedAtISO: '2026-05-12',
          quotationRef: 'QT-9',
          customerName: 'Cancel Co',
        },
      ],
      productionJobCoils: [],
      quotations: [{ id: 'QT-9', projectName: 'P' }],
      refunds: [],
      coilLots: [],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(report.cancelled.totals.lineCount).toBeGreaterThan(0);
    expect(report.aluminium.groups).toHaveLength(0);
  });

  it('chains same-coil rows: highest before first, then after links to next before', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'J2',
          status: 'Completed',
          completedAtISO: '2026-05-05',
          quotationRef: 'QT-2',
          actualMeters: 50,
          actualWeightKg: 25,
        },
        {
          jobID: 'J1',
          status: 'Completed',
          completedAtISO: '2026-05-15',
          quotationRef: 'QT-1',
          actualMeters: 50,
          actualWeightKg: 50,
        },
      ],
      productionJobCoils: [
        {
          jobID: 'J2',
          coilNo: 'C-SAME',
          gaugeLabel: '0.5mm',
          openingWeightKg: 450,
          closingWeightKg: 375,
          consumedWeightKg: 75,
          metersProduced: 50,
        },
        {
          jobID: 'J1',
          coilNo: 'C-SAME',
          gaugeLabel: '0.5mm',
          openingWeightKg: 500,
          closingWeightKg: 450,
          consumedWeightKg: 50,
          metersProduced: 50,
        },
      ],
      quotations: [{ id: 'QT-1' }, { id: 'QT-2' }],
      refunds: [],
      coilLots: [{ coilNo: 'C-SAME', materialTypeName: 'Aluminium' }],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    const rows = report.aluminium.groups[0].rows;
    expect(rows.map((r) => r.jobId)).toEqual(['J1', 'J2']);
    expect(rows[0].beforeKg).toBe(500);
    expect(rows[0].afterKg).toBe(450);
  });

  it('flags balance gap when same coil after does not match next before', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'J1',
          status: 'Completed',
          completedAtISO: '2026-05-05',
          quotationRef: 'QT-1',
          actualMeters: 50,
          actualWeightKg: 25,
        },
        {
          jobID: 'J2',
          status: 'Completed',
          completedAtISO: '2026-05-15',
          quotationRef: 'QT-2',
          actualMeters: 50,
          actualWeightKg: 25,
        },
      ],
      productionJobCoils: [
        {
          jobID: 'J1',
          coilNo: 'C-SAME',
          gaugeLabel: '0.5mm',
          openingWeightKg: 500,
          closingWeightKg: 450,
          consumedWeightKg: 50,
          metersProduced: 50,
        },
        {
          jobID: 'J2',
          coilNo: 'C-SAME',
          gaugeLabel: '0.5mm',
          openingWeightKg: 400,
          closingWeightKg: 375,
          consumedWeightKg: 25,
          metersProduced: 50,
        },
      ],
      quotations: [
        { id: 'QT-1', customerName: 'A' },
        { id: 'QT-2', customerName: 'B' },
      ],
      refunds: [],
      coilLots: [{ coilNo: 'C-SAME', materialTypeName: 'Aluminium' }],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    const rows = report.aluminium.groups[0].rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].remark).toMatch(/New coil/);
    expect(rows[1].remark).not.toMatch(/New coil/);
    expect(rows[1].balanceBreak).toBe(true);
    expect(rows[1].balanceNote).toMatch(/Gap:/);
  });

  it('marks Finished only on the line that depletes the coil', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'J1',
          status: 'Completed',
          completedAtISO: '2026-05-08',
          quotationRef: 'QT-1',
          actualMeters: 50,
          actualWeightKg: 500,
        },
      ],
      productionJobCoils: [
        {
          jobID: 'J1',
          sequenceNo: 1,
          coilNo: 'C-END',
          gaugeLabel: '0.5mm',
          openingWeightKg: 500,
          closingWeightKg: 0.5,
          consumedWeightKg: 499.5,
          metersProduced: 50,
        },
      ],
      quotations: [{ id: 'QT-1', customerName: 'Acme' }],
      refunds: [],
      coilLots: [{ coilNo: 'C-END', materialTypeName: 'Aluminium' }],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    const row = report.aluminium.groups[0].rows[0];
    expect(row.remark).toMatch(/New coil/);
    expect(row.remark).toMatch(/Finished/);
  });

  it('lists quotations registered for production in period but not completed', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'JP',
          status: 'Planned',
          createdAtISO: '2026-05-12T10:00:00.000Z',
          quotationRef: 'QT-PEND',
          customerName: 'Pending Co',
          plannedMeters: 120,
        },
        {
          jobID: 'JD',
          status: 'Completed',
          createdAtISO: '2026-05-14T10:00:00.000Z',
          completedAtISO: '2026-05-15',
          quotationRef: 'QT-DONE',
          customerName: 'Done Co',
          actualMeters: 80,
          actualWeightKg: 40,
        },
      ],
      productionJobCoils: [],
      quotations: [
        { id: 'QT-PEND', customerName: 'Pending Co', projectName: 'Site P' },
        { id: 'QT-DONE', customerName: 'Done Co' },
      ],
      refunds: [],
      coilLots: [],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(report.listedNotProduced.rows).toHaveLength(1);
    expect(report.listedNotProduced.rows[0].qtNoDisplay).toBe('PEND');
    expect(report.listedNotProduced.rows[0].status).toBe('Planned');
  });

  it('includes summary by material and gauge with observations', () => {
    const report = buildMaterialTransactionReport({
      productionJobs: [
        {
          jobID: 'J1',
          status: 'Completed',
          completedAtISO: '2026-05-10',
          quotationRef: 'QT-1',
          actualMeters: 100,
          actualWeightKg: 50,
        },
      ],
      productionJobCoils: [
        {
          jobID: 'J1',
          coilNo: 'C-001',
          gaugeLabel: '0.5mm',
          openingWeightKg: 500,
          closingWeightKg: 450,
          consumedWeightKg: 50,
          metersProduced: 100,
        },
      ],
      quotations: [{ id: 'QT-1', customerName: 'Acme' }],
      refunds: [],
      coilLots: [{ coilNo: 'C-001', materialTypeName: 'Aluminium' }],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(report.summary.byMaterial.some((m) => m.label === 'Aluminium')).toBe(true);
    expect(report.summary.byGauge.some((g) => g.gaugeLabel === '0.5mm')).toBe(true);
    expect(report.summary.byMaterial[0].metres).toBe(100);
    expect(Array.isArray(report.summary.observations)).toBe(true);
  });
});
