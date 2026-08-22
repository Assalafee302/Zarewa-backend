import { describe, expect, it } from 'vitest';
import {
  buildMaintenanceInsightsPack,
  buildMaintenanceMachineInsights,
  buildMaintenanceVendorCostComparison,
} from './maintenanceInsightsOps.js';

function mockDb({ machines = [], costRows = [], flagRows = [], downtimeRows = [], links = [], assets = {}, vendorLines = [] }) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        all: () => {
          if (s.includes('FROM machines WHERE')) return machines;
          if (s.includes('GROUP BY wo.machine_id')) return costRows;
          if (s.includes('MAX(replacement_required)')) return flagRows;
          if (s.includes('production_jobs')) throw new Error('no production_jobs');
          if (s.includes('downtime_hours, opened_at_iso')) return downtimeRows;
          if (s.includes('FROM machine_asset_links')) return links;
          if (s.includes('FROM maintenance_cost_lines cl') && s.includes('wo.vendor_id')) return vendorLines;
          return [];
        },
        get: (id) => assets[String(id)] || null,
      };
    },
  };
}

const pressAsset = {
  id: 'a1',
  name: 'Press asset',
  category: 'machinery',
  branch_id: 'kaduna',
  cost_ngn: 10_000_000,
  salvage_ngn: 0,
  useful_life_months: 120,
  depreciation_method: 'straight_line',
  acquisition_date_iso: '2024-01-01',
  status: 'active',
};

describe('maintenanceInsightsOps', () => {
  it('flags watch from lifetime cost vs asset purchase cost', () => {
    const db = mockDb({
      machines: [
        {
          id: 'm1',
          name: 'Press',
          machine_code: 'MC-1',
          branch_id: 'kaduna',
          status: 'active',
        },
      ],
      costRows: [{ machine_id: 'm1', lifetime_ngn: 4_000_000, line_count: 1 }],
      links: [{ machine_id: 'm1', asset_id: 'a1', relation_kind: 'primary' }],
      assets: { a1: pressAsset },
    });
    const rows = buildMaintenanceMachineInsights(db, { branchId: 'kaduna', viewAll: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].lifetimeMaintenanceNgn).toBe(4_000_000);
    expect(rows[0].flag).toBe('watch');
    expect(rows[0].signal).toBe('watch');
  });

  it('ignores cost lines without payment/expense source', () => {
    const db = mockDb({
      machines: [{ id: 'm1', name: 'Press', machine_code: 'MC-1', branch_id: 'kaduna', status: 'active' }],
    });
    const rows = buildMaintenanceMachineInsights(db, { viewAll: true });
    expect(rows[0].lifetimeMaintenanceNgn).toBe(0);
    expect(rows[0].flag).toBe('ok');
  });

  it('rolls up attributed spend by vendor', () => {
    const db = mockDb({
      vendorLines: [
        {
          vendor_id: 'v1',
          vendor_name: 'Acme Fix',
          work_order_id: 'wo1',
          machine_id: 'm1',
          amount_ngn: 250000,
          posted_at_iso: '2026-07-01T00:00:00.000Z',
          opened_at_iso: '2026-06-01T00:00:00.000Z',
          vendor_table_name: 'Acme Fix',
          specialty: 'electrical',
          phone: '0800',
        },
      ],
    });
    const vendors = buildMaintenanceVendorCostComparison(db, { viewAll: true });
    expect(vendors).toHaveLength(1);
    expect(vendors[0].totalNgn).toBe(250_000);
    expect(vendors[0].jobCount).toBe(1);
    expect(vendors[0].avgCostPerJobNgn).toBe(250_000);
    expect(vendors[0].specialty).toBe('electrical');
    expect(vendors[0].name).toBe('Acme Fix');
  });

  it('returns ok pack with machines and vendors arrays', () => {
    const db = mockDb({});
    const pack = buildMaintenanceInsightsPack(db, { viewAll: true });
    expect(pack.ok).toBe(true);
    expect(Array.isArray(pack.machines)).toBe(true);
    expect(Array.isArray(pack.vendors)).toBe(true);
    expect(pack.summary).toBeTruthy();
  });
});
