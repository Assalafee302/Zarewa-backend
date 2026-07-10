import { describe, expect, it } from 'vitest';
import { publishMaterialPricingSheet } from './materialPricingOps.js';

/**
 * Minimal stub covering publishMaterialPricingSheet + upsertPriceListItem happy path tables.
 */
function mockDbForPublish() {
  const rows = [
    {
      id: 'MPS-TEST1',
      material_key: 'alu',
      gauge_mm: '0.45',
      branch_id: 'BR-1',
      design_key: '',
      conversion_standard_kg_per_m: 1.5,
      conversion_reference_kg_per_m: 1.5,
      conversion_history_kg_per_m: 1.5,
      conversion_used_kg_per_m: 1.5,
      cost_per_kg_ngn: 1000,
      overhead_ngn_per_m: 50,
      profit_ngn_per_m: 50,
      minimum_price_per_m_ngn: 2500,
      commission_ngn_per_m: 100,
      gauge_customer_label: '',
      notes: '',
      sync_minimum_to_price_list: 1,
      sync_design_key: 'longspan',
      updated_at_iso: null,
      updated_by_user_id: null,
    },
  ];
  /** @type {object[]} */
  const priceList = [];
  /** @type {object[]} */
  const audit = [];

  return {
    priceList,
    audit,
    exec() {
      return undefined;
    },
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master') && s.includes('material_pricing_sheet_rows')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.includes('sqlite_master') && s.includes('price_list_items')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.includes('sqlite_master') && s.includes('human_id_sequences')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.includes('sqlite_master') && s.includes('audit_log')) {
        return { get: () => ({ '1': 1 }) };
      }
      if (s.includes('FROM material_pricing_sheet_rows') && s.includes('sync_minimum_to_price_list = 1')) {
        return { all: () => rows };
      }
      if (s.includes('FROM material_pricing_sheet_rows') && s.includes('id IN')) {
        return { all: () => rows };
      }
      if (s.includes('PRAGMA table_info')) {
        return {
          all: () => [
            { name: 'id' },
            { name: 'gauge_key' },
            { name: 'design_key' },
            { name: 'unit_price_per_m_ngn' },
            { name: 'branch_id' },
            { name: 'notes' },
            { name: 'material_type_key' },
            { name: 'colour_key' },
            { name: 'profile_key' },
            { name: 'effective_from_iso' },
            { name: 'sort_order' },
            { name: 'scope' },
            { name: 'last_value' },
          ],
        };
      }
      if (s.includes('human_id_sequences')) {
        return {
          get: () => ({ last_value: 1 }),
          run: () => ({ changes: 1 }),
          all: () => [],
        };
      }
      if (s.includes('FROM price_list_items')) {
        return { get: () => null, all: () => [] };
      }
      if (s.includes('INSERT INTO price_list_items') || s.includes('INSERT OR REPLACE INTO price_list_items') || s.includes('REPLACE INTO price_list_items')) {
        return {
          run: (...args) => {
            priceList.push({ args });
            return { changes: 1 };
          },
        };
      }
      if (s.includes('UPDATE price_list_items')) {
        return {
          run: (...args) => {
            priceList.push({ update: true, args });
            return { changes: 1 };
          },
        };
      }
      if (s.includes('audit_log') || s.includes('INSERT INTO audit')) {
        return {
          run: (...args) => {
            audit.push(args);
            return { changes: 1 };
          },
        };
      }
      return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
    },
  };
}

describe('publishMaterialPricingSheet', () => {
  it('publishes synced workbook rows to the price list', () => {
    const db = mockDbForPublish();
    const r = publishMaterialPricingSheet(db, { materialKey: 'alu', branchId: 'BR-1' }, { id: 'U1' });
    expect(r.ok).toBe(true);
    expect(r.published).toHaveLength(1);
    expect(r.published[0].gaugeMm).toBe('0.45');
    expect(r.published[0].designKey).toBe('longspan');
    expect(r.published[0].listNgn).toBeGreaterThan(2500);
    expect(db.priceList.length).toBeGreaterThan(0);
  });

  it('errors when no rows are marked for publish', () => {
    const db = mockDbForPublish();
    // Override select to empty
    const orig = db.prepare.bind(db);
    db.prepare = (sql) => {
      const s = String(sql);
      if (s.includes('sync_minimum_to_price_list = 1')) {
        return { all: () => [] };
      }
      return orig(sql);
    };
    const r = publishMaterialPricingSheet(db, { materialKey: 'alu', branchId: 'BR-1' }, { id: 'U1' });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/Include in publish/i);
  });
});
