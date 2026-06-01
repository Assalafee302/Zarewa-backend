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
});
