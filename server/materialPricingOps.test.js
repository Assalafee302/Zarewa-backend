import { describe, expect, it } from 'vitest';
import {
  averageOfThreeConversions,
  gaugeHistoryAvgConversionKgPerMByGauge,
  purchaseAvgConversionKgPerMByGauge,
  purchaseConversionMetaByGauge,
  resolveCoilConversionsForAllGauges,
  resolveCoilConversionsForGauge,
  suggestedPricePerMeterNgn,
  theoreticalStandardKgPerM,
  usedConfidenceFromMeta,
} from './materialPricingOps.js';
import { catalogStandardKgPerM } from './materialPricingConversionResolve.js';

/** Minimal db stub: only what purchase/history hint queries need. */
function mockDbForConversionHints({ purchaseRows = [], historyRows = [], catalogRows = [] }) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.startsWith('PRAGMA table_info')) {
        return { all: () => [{ name: 'branch_id' }] };
      }
      if (s.includes('FROM procurement_catalog')) {
        return {
          all: (...args) => {
            const productId = args[0];
            let rows = catalogRows.filter((r) => r.product_id === productId);
            // Legacy single-gauge filter (TRIM match) if still present in SQL.
            if (args.length >= 2 && s.includes('TRIM(gauge)')) {
              const gauge = args[1];
              rows = rows.filter((r) => String(r.gauge).trim() === String(gauge).trim());
            }
            return rows;
          },
        };
      }
      if (s.includes('FROM coil_lots') && s.includes('supplier_conversion_kg_per_m')) {
        return {
          all: (...args) => {
            const productId = args[0];
            let rows = purchaseRows.filter((r) => r.product_id === productId);
            if (s.includes('branch_id = ?')) {
              const bid = args[args.length - 1];
              rows = rows.filter((r) => String(r.branch_id || '') === String(bid));
            }
            return rows;
          },
        };
      }
      if (s.includes('production_conversion_checks') && s.includes('INNER JOIN coil_lots')) {
        return {
          all: (...args) => {
            const productId = args[0];
            let rows = historyRows.filter((r) => r.product_id === productId);
            if (s.includes('cl.branch_id = ?')) {
              const bid = args[args.length - 1];
              rows = rows.filter((r) => String(r.branch_id || '') === String(bid));
            }
            return rows;
          },
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

  it('purchaseConversionMetaByGauge returns n and prefers median when n>=5', () => {
    const db = mockDbForConversionHints({
      purchaseRows: [
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 1.0, received_at_iso: '2026-01-01' },
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 1.1, received_at_iso: '2026-01-02' },
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 1.2, received_at_iso: '2026-01-03' },
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 1.3, received_at_iso: '2026-01-04' },
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 9.0, received_at_iso: '2026-01-05' },
      ],
    });
    const meta = purchaseConversionMetaByGauge(db, 'COIL-ALU');
    expect(meta['0.45'].n).toBe(5);
    expect(meta['0.45'].avg).toBeCloseTo(1.2, 5);
    expect(meta['0.45'].lastAtIso).toBe('2026-01-05');
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

  it('Std prefers catalog over theory', () => {
    const theory = theoreticalStandardKgPerM('alu', 0.45);
    const db = mockDbForConversionHints({
      catalogRows: [{ product_id: 'COIL-ALU', gauge: '0.45', conversion_kg_per_m: 9.99 }],
    });
    expect(catalogStandardKgPerM(db, 'COIL-ALU', '0.45')).toBeCloseTo(9.99, 5);
    const r = resolveCoilConversionsForGauge(db, 'alu', '0.45');
    expect(r.stdSource).toBe('catalog');
    expect(r.std).toBeCloseTo(9.99, 2);
    expect(r.std).not.toBeCloseTo(theory, 2);
  });

  it('batch resolve matches single-gauge resolve for catalog preference', () => {
    const db = mockDbForConversionHints({
      catalogRows: [
        { product_id: 'COIL-ALU', gauge: '0.45', conversion_kg_per_m: 9.99 },
        { product_id: 'COIL-ALU', gauge: '0.50', conversion_kg_per_m: 8.5 },
        { product_id: 'COIL-ALU', gauge: ' 0.45 ', conversion_kg_per_m: 9.97 },
      ],
      purchaseRows: [
        { product_id: 'COIL-ALU', gauge_label: '0.45', supplier_conversion_kg_per_m: 1.4 },
      ],
    });
    const single = resolveCoilConversionsForGauge(db, 'alu', '0.45');
    const batch = resolveCoilConversionsForAllGauges(db, 'alu', { gauges: ['0.45', '0.50'] });
    expect(batch['0.45'].stdSource).toBe('catalog');
    expect(batch['0.45'].std).toBeCloseTo(single.std, 5);
    expect(batch['0.45'].ref).toBeCloseTo(single.ref, 5);
    expect(batch['0.45'].usedSuggested).toBeCloseTo(single.usedSuggested, 5);
    expect(batch['0.50'].stdSource).toBe('catalog');
    expect(batch['0.50'].std).toBeCloseTo(8.5, 2);
  });

  it('usedConfidenceFromMeta ranks sample depth', () => {
    expect(usedConfidenceFromMeta({ n: 5 }, { n: 5 }, 1)).toBe('high');
    expect(usedConfidenceFromMeta({ n: 3 }, { n: 0 }, 1)).toBe('medium');
    expect(usedConfidenceFromMeta({ n: 1 }, { n: 0 }, 1)).toBe('low');
    expect(usedConfidenceFromMeta({ n: 0 }, { n: 0 }, null)).toBe('none');
  });
});
