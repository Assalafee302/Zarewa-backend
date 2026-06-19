import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  floorPricePerMeterForGaugeDesignAsOf,
  listPriceListItemsAsOf,
  normalizePricingAsAtIso,
  quotationPricingAsAtIso,
  resolveWorkbookRowStateAsOf,
  selectPriceListRowsAsOf,
  workbookFloorPerMeterAsOf,
} from './pricingAsOf.js';
import { previewRefundRequest } from './controlOps.js';

describe('pricingAsOf', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso)
       VALUES ('PL-OLD', '0.24mm', 'longspan', 3800, 0, NULL, '2024-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso)
       VALUES ('PL-NEW', '0.24mm', 'longspan', 4200, 0, NULL, '2025-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-1', 'alu', '0.24', 'BR-KD', 'iv', 2200, 800, '2025-06-01')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (
        'EV-1', 'MPS-1', 'alu', '0.24', 'BR-KD', 'iv',
        ?, '2024-03-01T10:00:00.000Z', NULL, 'upsert'
      )`
    ).run(
      JSON.stringify({
        before: null,
        after: { minimumPricePerMeterNgn: 2000, commissionNgnPerM: 700 },
      })
    );
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (
        'EV-2', 'MPS-1', 'alu', '0.24', 'BR-KD', 'iv',
        ?, '2025-06-01T10:00:00.000Z', NULL, 'upsert'
      )`
    ).run(
      JSON.stringify({
        before: { minimumPricePerMeterNgn: 2000, commissionNgnPerM: 700 },
        after: { minimumPricePerMeterNgn: 2200, commissionNgnPerM: 800 },
      })
    );
  });

  afterEach(() => {
    db?.close();
  });

  it('normalizePricingAsAtIso defaults to today when invalid', () => {
    const t = normalizePricingAsAtIso('');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(t)).toBe(true);
    expect(normalizePricingAsAtIso('2024-06-15')).toBe('2024-06-15');
  });

  it('quotationPricingAsAtIso prefers date_iso', () => {
    expect(quotationPricingAsAtIso({ date_iso: '2024-03-10' })).toBe('2024-03-10');
  });

  it('selectPriceListRowsAsOf picks row effective on date', () => {
    const rows = db.prepare(`SELECT * FROM price_list_items`).all();
    const mar2024 = selectPriceListRowsAsOf(rows, '2024-06-01');
    expect(mar2024).toHaveLength(1);
    expect(mar2024[0].id).toBe('PL-OLD');
    const jan2025 = selectPriceListRowsAsOf(rows, '2025-06-01');
    expect(jan2025[0].id).toBe('PL-NEW');
  });

  it('floorPricePerMeterForGaugeDesignAsOf returns period price', () => {
    expect(floorPricePerMeterForGaugeDesignAsOf(db, '0.24mm', 'longspan', null, '2024-06-01')).toBe(3800);
    expect(floorPricePerMeterForGaugeDesignAsOf(db, '0.24mm', 'longspan', null, '2025-06-01')).toBe(4200);
  });

  it('listPriceListItemsAsOf dedupes for print/export', () => {
    const items = listPriceListItemsAsOf(db, '2024-06-01');
    expect(items.some((x) => x.gaugeKey === '0.24mm' && x.unitPricePerMeterNgn === 3800)).toBe(true);
    expect(items.some((x) => x.unitPricePerMeterNgn === 4200)).toBe(false);
  });

  it('workbookFloorPerMeterAsOf uses event history', () => {
    expect(workbookFloorPerMeterAsOf(db, 'alu', '0.24', 'iv', 'BR-KD', '2024-06-01')).toBe(2000);
    expect(workbookFloorPerMeterAsOf(db, 'alu', '0.24', 'iv', 'BR-KD', '2025-06-01')).toBe(2200);
  });

  it('resolveWorkbookRowStateAsOf returns before state when row did not exist yet', () => {
    const early = resolveWorkbookRowStateAsOf(db, 'alu', '0.24', 'BR-KD', 'iv', '2024-01-01');
    expect(early).toBeNull();
  });

  it('substitution refund uses quotation-date workbook floor not today', () => {
    const linesSub = JSON.stringify({
      materialGauge: '0.28mm',
      materialDesign: 'IV',
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000, gauge: '0.28mm', design: 'IV' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id)
       VALUES ('QT-HIST-SUB', 'CUS-001', 'Test', '2024-06-01', 50000, 50000, 'Paid', 'Finished', ?, 'BR-KD')`
    ).run(linesSub);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-HIST', 'Longspan', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso)
       VALUES ('JOB-HIST', 'QT-HIST-SUB', 'FG-HIST', 'Longspan', 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour)
       VALUES ('CL-HIST', 'FG-HIST', 1000, 1000, 1000, 'Available', '0.24mm', 'IV')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso)
       VALUES ('PJC-HIST', 'JOB-HIST', 1, 'CL-HIST', '0.24mm', 100, 0, 100, 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();

    const prev = previewRefundRequest(db, { quotationRef: 'QT-HIST-SUB' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.pricingAsAtIso).toBe('2024-06-01');
    const sub = prev.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeDefined();
    // 5000 quoted − 2000 floor (Jun 2024 event) × 10 m
    expect(sub.amountNgn).toBe(30_000);
    expect(prev.preview.substitutionPerMeterBreakdown[0].producedListPricePerMeterNgn).toBe(2000);
  });
});
