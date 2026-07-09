import { describe, expect, it } from 'vitest';
import { assessCuttingListQuotationConsumption } from '../shared/lib/cuttingListBlankConsumption.js';
import { cuttingListTotalMetresFromLines, roundCuttingListMetres2 } from '../shared/lib/refundCuttingListQuotationReconciliation.js';

/** Mirror of writeOps productionPlannedTotalsForCuttingList (non-stone). */
function plannedTotalsFromLines(lines) {
  const plannedRoofM = cuttingListTotalMetresFromLines(lines, { lineTypes: ['Roof'] });
  const plannedCladdingM = cuttingListTotalMetresFromLines(lines, { lineTypes: ['Cladding'] });
  const plannedFlatsheetM = cuttingListTotalMetresFromLines(lines, { lineTypes: ['Flatsheet'] });
  const breakdownTotalM = roundCuttingListMetres2(plannedRoofM + plannedCladdingM + plannedFlatsheetM);
  return {
    plannedMeters: breakdownTotalM,
    plannedRoofM,
    plannedCladdingM,
    plannedFlatsheetM,
  };
}

describe('production planned breakdown', () => {
  it('sums section breakdown into planned total', () => {
    const lines = [
      { lineType: 'Roof', sheets: 50, lengthM: 2, totalM: 100 },
      { lineType: 'Flatsheet', sheets: 1, lengthM: 1, totalM: 1 },
    ];
    const p = plannedTotalsFromLines(lines);
    expect(p.plannedRoofM).toBe(100);
    expect(p.plannedFlatsheetM).toBe(1);
    expect(p.plannedMeters).toBe(101);
  });

  it('refund consumption matches production total when trim blank included', () => {
    const quote = {
      products: [{ name: 'Roofing Sheet', qty: 100 }, { name: 'Ridge Cap', qty: 3, girthMm: 400 }],
    };
    const lines = [
      { lineType: 'Roof', sheets: 50, lengthM: 2, totalM: 100 },
      { lineType: 'Flatsheet', sheets: 1, lengthM: 1, totalM: 1 },
    ];
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: quote,
      cuttingListLines: lines,
    });
    const p = plannedTotalsFromLines(lines);
    expect(assessment.ok).toBe(true);
    expect(p.plannedMeters).toBe(assessment.expectedTotalM);
  });
});
