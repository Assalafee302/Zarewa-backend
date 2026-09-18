import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  floorPricePerMeterForGaugeDesignAsOf,
  listPriceListItemsAsOf,
  normalizePricingAsAtIso,
  quotationPricingAsAtIso,
  resolvePriceListItemFloorNgnAsOf,
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

  it('listPriceListItemsAsOf filters by branch and keeps global rows', () => {
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso)
       VALUES ('PL-KD', '0.30mm', 'iv', 5000, 0, 'BR-KD', '2024-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso)
       VALUES ('PL-YL', '0.30mm', 'iv', 5100, 0, 'BR-YL', '2024-01-01')`
    ).run();
    const kd = listPriceListItemsAsOf(db, '2024-06-01', { branchId: 'BR-KD' });
    expect(kd.some((x) => x.id === 'PL-KD')).toBe(true);
    expect(kd.some((x) => x.id === 'PL-YL')).toBe(false);
    // Global (null branch) rows still apply when the branch has no override.
    expect(kd.some((x) => x.gaugeKey === '0.24mm')).toBe(true);
    const all = listPriceListItemsAsOf(db, '2024-06-01', { branchId: 'ALL' });
    expect(all.some((x) => x.id === 'PL-YL')).toBe(true);
  });

  it('listPriceListItemsAsOf hides global when branch publish exists for same product', () => {
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso, material_type_key)
       VALUES ('PL-GL-LS', '0.28mm', 'longspan', 4000, 0, NULL, '2024-01-01', 'alu')`
    ).run();
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso, material_type_key)
       VALUES ('PL-MPS-YL', '0.28mm', 'longspan', 4550, 0, 'BR-YL', '2024-06-01', 'alu')`
    ).run();
    const yl = listPriceListItemsAsOf(db, '2024-08-01', { branchId: 'BR-YL' });
    const longspan = yl.filter((x) => x.designKey === 'longspan' && String(x.gaugeKey).includes('0.28'));
    expect(longspan).toHaveLength(1);
    expect(longspan[0].id).toBe('PL-MPS-YL');
    expect(longspan[0].unitPricePerMeterNgn).toBe(4550);
    expect(longspan[0].gaugeDisplayKey).toBe('0.35mm');
  });

  it('resolvePriceListItemFloorNgnAsOf prefers branch publish over richer global', () => {
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso, material_type_key, colour_key, profile_key)
       VALUES ('PL-GL-RICH', '0.28mm', 'longspan', 3900, 0, NULL, '2024-01-01', 'alu', 'red', 'longspan')`
    ).run();
    db.prepare(
      `INSERT INTO price_list_items (id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, branch_id, effective_from_iso, material_type_key)
       VALUES ('PL-MPS-YL2', '0.28mm', 'longspan', 4600, 0, 'BR-YL', '2024-06-01', 'alu')`
    ).run();
    const hit = resolvePriceListItemFloorNgnAsOf(
      db,
      {
        gaugeLabel: '0.35mm',
        designLabel: 'longspan',
        materialTypeName: 'alu',
        branchId: 'BR-YL',
      },
      '2024-08-01'
    );
    expect(hit?.unitPricePerMeterNgn).toBe(4600);
    expect(hit?.id).toBe('PL-MPS-YL2');
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

  it('substitution includes quoted-above-floor margin (not floor-to-floor only)', () => {
    // Quoted gauge has its own workbook floor below the customer selling ₦/m.
    // Credit must use blended selling − coil floor, not quoted-floor − coil-floor.
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-028', 'alu', '0.28', 'BR-KD', 'iv', 4500, 500, '2024-06-01')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (
        'EV-028', 'MPS-028', 'alu', '0.28', 'BR-KD', 'iv',
        ?, '2024-03-01T10:00:00.000Z', NULL, 'upsert'
      )`
    ).run(
      JSON.stringify({
        before: null,
        after: { minimumPricePerMeterNgn: 4500, commissionNgnPerM: 500 },
      })
    );
    const linesSub = JSON.stringify({
      materialGauge: '0.28mm',
      materialDesign: 'IV',
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000, gauge: '0.28mm', design: 'IV' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id)
       VALUES ('QT-ABOVE-FLOOR-SUB', 'CUS-001', 'Test', '2024-06-01', 50000, 50000, 'Paid', 'Finished', ?, 'BR-KD')`
    ).run(linesSub);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-ABOVE', 'Longspan', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso)
       VALUES ('JOB-ABOVE', 'QT-ABOVE-FLOOR-SUB', 'FG-ABOVE', 'Longspan', 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour)
       VALUES ('CL-ABOVE', 'FG-ABOVE', 1000, 1000, 1000, 'Available', '0.24mm', 'IV')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso)
       VALUES ('PJC-ABOVE', 'JOB-ABOVE', 1, 'CL-ABOVE', '0.24mm', 100, 0, 100, 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();

    const prev = previewRefundRequest(db, { quotationRef: 'QT-ABOVE-FLOOR-SUB' });
    expect(prev.ok).toBe(true);
    const sub = prev.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeDefined();
    // Floor-to-floor would be (4500 − 2000) × 10 = 25_000; must also refund ₦500/m above floor.
    expect(sub.amountNgn).toBe(30_000);
    const bd = prev.preview.substitutionPerMeterBreakdown[0];
    expect(bd.creditBasis).toBe('blended_to_coil_floor');
    expect(bd.quotedFloorPricePerMeterNgn).toBe(4500);
    expect(bd.quotedPricePerMeterNgn).toBe(5000);
    expect(bd.deltaPerMeterNgn).toBe(3000);
  });

  it('substitution credits only the thinner-gauge metres when one job has mixed coils', () => {
    // Quoted 0.24 — first coil matches (no credit); second coil 0.22 must still credit.
    // Clear as-of history so current workbook floors are used for both gauges.
    db.prepare(`DELETE FROM material_pricing_sheet_events`).run();
    db.prepare(
      `UPDATE material_pricing_sheet_rows
       SET minimum_price_per_m_ngn = 4800, commission_ngn_per_m = 0, updated_at_iso = '2026-01-01'
       WHERE material_key = 'alu' AND gauge_mm = '0.24' AND branch_id = 'BR-KD' AND design_key = 'iv'`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-MIX-022', 'alu', '0.22', 'BR-KD', 'iv', 4500, 0, '2026-01-01')`
    ).run();
    const linesMix = JSON.stringify({
      materialGauge: '0.24mm',
      materialDesign: 'IV',
      products: [{ name: 'Roofing Sheet', qty: 575.3, unitPrice: 4800, gauge: '0.24mm', design: 'IV' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id)
       VALUES ('QT-MIX-SUB', 'CUS-001', 'Test', '2026-07-16', 2811440, 2912960, 'Paid', 'Finished', ?, 'BR-KD')`
    ).run(linesMix);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-MIX', 'Longspan', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso)
       VALUES ('JOB-MIX', 'QT-MIX-SUB', 'FG-MIX', 'Longspan', 575.3, 'Completed', '2026-07-16T10:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour)
       VALUES
         ('CL-MIX-024', 'FG-MIX', 1000, 1000, 1000, 'Available', '0.24mm', 'IV'),
         ('CL-MIX-022', 'FG-MIX', 1000, 1000, 1000, 'Available', '0.22mm', 'IV')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (
        id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg,
        meters_produced, allocation_status, allocated_at_iso
      ) VALUES
        ('PJC-MIX-024', 'JOB-MIX', 1, 'CL-MIX-024', '0.24mm', 646, 61, 585, 259.5, 'Completed', '2026-07-16T10:00:00Z'),
        ('PJC-MIX-022', 'JOB-MIX', 2, 'CL-MIX-022', '0.22mm', 1347, 700, 647, 315.8, 'Completed', '2026-07-16T11:00:00Z')`
    ).run();

    const prev = previewRefundRequest(db, { quotationRef: 'QT-MIX-SUB' });
    expect(prev.ok).toBe(true);
    const sub = prev.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeDefined();
    // Only 0.22 slice: (4800 − 4500) × 315.8 m
    expect(sub.amountNgn).toBe(Math.round(300 * 315.8));
    const bd = prev.preview.substitutionPerMeterBreakdown;
    expect(bd).toHaveLength(1);
    expect(bd[0].coilGaugeFromAllocations).toBe('0.22mm');
    expect(bd[0].meters).toBe(315.8);
    expect(bd[0].deltaPerMeterNgn).toBe(300);
  });

  it('auto-suggests quoted ₦/m minus workbook floor on same-gauge produced metres (sold at list)', () => {
    const linesSame = JSON.stringify({
      materialGauge: '0.24mm',
      materialDesign: 'IV',
      products: [
        {
          name: 'Roofing Sheet',
          qty: 10,
          unitPrice: 5000,
          gauge: '0.24mm',
          design: 'IV',
          recommendedPricePerMeter: 5000,
          floorPricePerMeter: 5000,
        },
      ],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO customers (customer_id, name) VALUES ('CUS-FLOOR-DELTA', 'Floor delta')`
    ).run();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id)
       VALUES ('QT-SAME-FLOOR-DELTA', 'CUS-FLOOR-DELTA', 'Floor delta', '2024-06-01', 50000, 50000, 'Paid', 'Finished', ?, 'BR-KD')`
    ).run(linesSame);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-SAME-FLOOR', 'CUS-FLOOR-DELTA', 'Floor delta', 'QT-SAME-FLOOR-DELTA', 50000, 'Cleared', '2024-06-01')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-SAME-FLOOR', 'Longspan', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso)
       VALUES ('JOB-SAME-FLOOR', 'QT-SAME-FLOOR-DELTA', 'FG-SAME-FLOOR', 'Longspan', 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour)
       VALUES ('CL-SAME-FLOOR', 'FG-SAME-FLOOR', 1000, 1000, 1000, 'Available', '0.24mm', 'IV')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg, meters_produced, allocation_status, allocated_at_iso)
       VALUES ('PJC-SAME-FLOOR', 'JOB-SAME-FLOOR', 1, 'CL-SAME-FLOOR', '0.24mm', 100, 0, 100, 10, 'Completed', '2024-06-02T10:00:00Z')`
    ).run();

    const prev = previewRefundRequest(db, { quotationRef: 'QT-SAME-FLOOR-DELTA' });
    expect(prev.ok).toBe(true);
    const sub = prev.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeUndefined();
    const floorDelta = prev.preview.suggestedLines.find((l) => l.category === 'Customer commission');
    expect(floorDelta).toBeDefined();
    // 5000 quoted list − 2000 workbook floor (Jun 2024) × 10 m. Old formula (list − quoted) was ₦0.
    expect(floorDelta.amountNgn).toBe(30_000);
  });
});
