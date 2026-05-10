import { describe, expect, it } from 'vitest';
import {
  averageOfThreeConversions,
  gaugeHistoryAvgConversionKgPerMByGauge,
  purchaseAvgConversionKgPerMByGauge,
  suggestedPricePerMeterNgn,
  theoreticalStandardKgPerM,
} from './materialPricingOps.js';

/** Minimal db stub: only what purchase/history hint queries need. */
function mockDbForConversionHints({ purchaseRows = [], historyRows = [] }) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.includes('FROM coil_lots') && s.includes('supplier_conversion_kg_per_m')) {
        return {
          all: (productId) => purchaseRows.filter((r) => r.product_id === productId),
        };
      }
      if (s.includes('production_conversion_checks') && s.includes('INNER JOIN coil_lots')) {
        return {
          all: (productId) => historyRows.filter((r) => r.product_id === productId),
        };
      }
      return { all: () => [], get: () => null };
    },
  };
}

describe('materialPricingOps', () => {
  it('averages only positive finite inputs', () => {
    expect(averageOfThreeConversions(1, 2, 3)).toBe(2);
    expect(averageOfThreeConversions(1, null, 3)).toBe(2);
    expect(averageOfThreeConversions(null, null, null)).toBe(null);
  });

  it('suggested = conv * cost/kg + overhead + profit', () => {
    expect(suggestedPricePerMeterNgn(2, 500, 100, 50)).toBe(1150);
    expect(suggestedPricePerMeterNgn(null, 500, 0, 0)).toBe(null);
  });

  it('theoretical strip mass for alu gauge', () => {
    const v = theoreticalStandardKgPerM('alu', 0.45);
    expect(v).toBeGreaterThan(1.4);
    expect(v).toBeLessThan(1.6);
  });

  it('purchaseAvgConversionKgPerMByGauge averages supplier kg/m by standard gauge', () => {
    const db = mockDbForConversionHints({
      purchaseRows: [
        { product_id: 'COIL-ALU', gauge_label: '0.45mm', supplier_conversion_kg_per_m: 1.4 },
        { product_id: 'COIL-ALU', gauge_label: '0.45 mm', supplier_conversion_kg_per_m: 1.6 },
      ],
    });
    const p = purchaseAvgConversionKgPerMByGauge(db, 'COIL-ALU');
    expect(p['0.45']).toBeCloseTo(1.5, 5);
  });

  it('gaugeHistoryAvgConversionKgPerMByGauge averages posted actual kg/m for product coils', () => {
    const db = mockDbForConversionHints({
      historyRows: [
        { product_id: 'COIL-ALU', gauge_label: '0.45mm', actual_conversion_kg_per_m: 1.48 },
        { product_id: 'COIL-ALU', gauge_label: '0.45mm', actual_conversion_kg_per_m: 1.52 },
      ],
    });
    const h = gaugeHistoryAvgConversionKgPerMByGauge(db, 'COIL-ALU');
    expect(h['0.45']).toBeCloseTo(1.5, 5);
  });
});
