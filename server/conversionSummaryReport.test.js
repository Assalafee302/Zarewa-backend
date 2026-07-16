import { describe, expect, it } from 'vitest';
import {
  buildConversionSummaryReport,
  conversionSummaryExcelRows,
} from './conversionSummaryReport.js';

/** Minimal db stub for conversion summary. */
function mockDb({ purchaseRows = [], historyRows = [], catalogRows = [], pricingRows = [] } = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return {
          get: (name) => {
            if (name === 'material_pricing_sheet_rows' || s.includes("name='material_pricing_sheet_rows'")) {
              return pricingRows.length || s.includes('?') ? { '1': 1 } : { '1': 1 };
            }
            return { '1': 1 };
          },
        };
      }
      if (s.startsWith('PRAGMA table_info')) {
        return { all: () => [{ name: 'branch_id' }] };
      }
      if (s.includes('FROM procurement_catalog')) {
        return {
          all: (...args) => catalogRows.filter((r) => r.product_id === args[0]),
        };
      }
      if (s.includes('FROM coil_lots') && s.includes('supplier_conversion_kg_per_m')) {
        return {
          all: (...args) => {
            let rows = purchaseRows.filter((r) => r.product_id === args[0]);
            const hasSince = s.includes('SUBSTR(received_at_iso, 1, 10) >= ?');
            const hasUntil = s.includes('SUBSTR(received_at_iso, 1, 10) <= ?');
            let i = 1;
            if (hasSince) {
              const since = args[i++];
              rows = rows.filter((r) => String(r.received_at_iso || '').slice(0, 10) >= since);
            }
            if (hasUntil) {
              const until = args[i++];
              rows = rows.filter((r) => String(r.received_at_iso || '').slice(0, 10) <= until);
            }
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
            let rows = historyRows.filter((r) => r.product_id === args[0]);
            const hasSince = s.includes('SUBSTR(c.checked_at_iso, 1, 10) >= ?');
            const hasUntil = s.includes('SUBSTR(c.checked_at_iso, 1, 10) <= ?');
            let i = 1;
            if (hasSince) {
              const since = args[i++];
              rows = rows.filter((r) => String(r.checked_at_iso || '').slice(0, 10) >= since);
            }
            if (hasUntil) {
              const until = args[i++];
              rows = rows.filter((r) => String(r.checked_at_iso || '').slice(0, 10) <= until);
            }
            if (s.includes('cl.branch_id = ?')) {
              const bid = args[args.length - 1];
              rows = rows.filter((r) => String(r.branch_id || '') === String(bid));
            }
            return rows;
          },
        };
      }
      if (s.includes('FROM material_pricing_sheet_rows')) {
        return {
          all: (...args) =>
            pricingRows.filter(
              (r) => r.material_key === args[0] && r.branch_id === args[1] && !String(r.design_key || '').trim()
            ),
        };
      }
      return { all: () => [], get: () => null };
    },
  };
}

describe('buildConversionSummaryReport', () => {
  it('builds material×gauge rows with period-scoped purchase/history and margin', () => {
    const db = mockDb({
      catalogRows: [{ product_id: 'COIL-ALU', gauge: '0.40', conversion_kg_per_m: 1.3 }],
      purchaseRows: [
        {
          product_id: 'COIL-ALU',
          gauge_label: '0.40',
          supplier_conversion_kg_per_m: 1.4,
          received_at_iso: '2026-07-05',
          branch_id: 'BR1',
        },
        {
          product_id: 'COIL-ALU',
          gauge_label: '0.40',
          supplier_conversion_kg_per_m: 1.6,
          received_at_iso: '2026-06-01',
          branch_id: 'BR1',
        },
      ],
      historyRows: [
        {
          product_id: 'COIL-ALU',
          gauge_label: '0.40',
          actual_conversion_kg_per_m: 1.5,
          checked_at_iso: '2026-07-08',
          branch_id: 'BR1',
        },
      ],
      pricingRows: [{ material_key: 'alu', gauge_mm: '0.40', branch_id: 'BR1', design_key: '', profit_ngn_per_m: 75 }],
    });

    const report = buildConversionSummaryReport(db, {
      startDate: '2026-07-01',
      endDate: '2026-07-15',
      branchId: 'BR1',
    });

    const row = report.rows.find((r) => r.materialKey === 'alu' && r.gauge === '0.40');
    expect(row).toBeTruthy();
    expect(row.standardConversion).toBe(1.3);
    expect(row.averagePurchaseConversion).toBe(1.4);
    expect(row.historyConversion).toBe(1.5);
    expect(row.averageOfThreeConversions).toBeCloseTo(1.4, 5);
    expect(row.marginNgnPerM).toBe(75);
    expect(row.purchaseSampleCount).toBe(1);
    expect(row.historySampleCount).toBe(1);

    const excel = conversionSummaryExcelRows(report);
    expect(excel[0]).toHaveProperty('Material');
    expect(excel[0]).toHaveProperty('Average of the 3 conversions');
    expect(excel[0]).toHaveProperty('Margin');
  });
});
