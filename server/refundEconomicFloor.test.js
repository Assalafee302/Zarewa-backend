import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildRefundEconomicFloorSummary,
  insertRefundRequest,
} from './controlOps.js';
import { REFUND_TEST_PAYEE } from './refundTestPayee.js';
import { quotationPricingAsAtIso } from './pricingAsOf.js';

/**
 * Lightweight mock for economic-floor summary paths that only need coil metres + optional gauge.
 */
function mockFloorDb({ coilMetersByJob = {}, coilGaugeByJob = {} } = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          const jobId = String(args[0] ?? '').trim();
          if (s.includes('FROM production_job_coils') && s.includes('SUM')) {
            return { s: Number(coilMetersByJob[jobId]) || 0 };
          }
          if (s.includes('FROM production_job_coils') && s.includes('gauge')) {
            const g = coilGaugeByJob[jobId];
            return g ? { g } : undefined;
          }
          if (s.includes('FROM products WHERE product_id')) return undefined;
          if (s.includes('FROM coil_lots') || s.includes('colour')) return undefined;
          return undefined;
        },
        all(...args) {
          const jobId = String(args[0] ?? '').trim();
          if (s.includes('FROM production_job_coils') && s.includes('gauge')) {
            const g = coilGaugeByJob[jobId];
            return g ? [{ g }] : [];
          }
          return [];
        },
      };
    },
  };
}

describe('buildRefundEconomicFloorSummary (unit)', () => {
  it('marks incomplete when ppm missing and nulls maxDefensible (no inflate)', () => {
    const db = mockFloorDb({
      coilMetersByJob: { 'JOB-INC': 8 },
      coilGaugeByJob: {},
    });
    const quote = { lines_json: JSON.stringify({ products: [{ name: 'R', qty: 10, unitPrice: 5000 }] }), branch_id: 'BR-KD' };
    const jobs = [{ job_id: 'JOB-INC', status: 'Completed', actual_meters: 8 }];
    const summary = buildRefundEconomicFloorSummary(db, quote, jobs, {
      cashInNgn: 50_000,
      priorRefundedNgn: 0,
    });
    expect(summary.incompleteFloorPricing).toBe(true);
    expect(summary.maxDefensibleRefundNgn).toBeNull();
    expect(summary.producedOutputMeters).toBe(8);
    // Missing ppm must not treat metres as free cash (would be 50_000 if inflated).
    expect(summary.floorDeliveredValueNgn).toBe(0);
  });

  it('computes finite maxDefensible when override ppm resolves all jobs', () => {
    const db = mockFloorDb({
      coilMetersByJob: { 'JOB-OK': 10 },
      coilGaugeByJob: { 'JOB-OK': '0.24mm' },
    });
    const quote = { lines_json: JSON.stringify({ products: [{ name: 'R', qty: 20, unitPrice: 5000 }] }), branch_id: 'BR-KD' };
    const jobs = [{ job_id: 'JOB-OK', status: 'Completed', actual_meters: 10 }];
    const summary = buildRefundEconomicFloorSummary(db, quote, jobs, {
      cashInNgn: 100_000,
      priorRefundedNgn: 0,
      substitutePricePerMeterNgn: 4000,
    });
    expect(summary.incompleteFloorPricing).toBe(false);
    expect(summary.maxDefensibleRefundNgn).toBe(60_000);
    expect(summary.floorDeliveredValueNgn).toBe(40_000);
    expect(summary.ppmSourceByJob['JOB-OK']).toBe('override');
  });

  it('values produced at quoted selling ₦/m when MD below-floor exception is on file', () => {
    const db = mockFloorDb({
      coilMetersByJob: { 'JOB-MD': 10 },
      coilGaugeByJob: { 'JOB-MD': '0.24mm' },
    });
    const quote = {
      lines_json: JSON.stringify({ products: [{ name: 'Roofing Sheet', qty: 20, unitPrice: 3500 }] }),
      branch_id: 'BR-KD',
      md_price_exception_approved_at_iso: '2026-04-01T10:00:00Z',
    };
    const jobs = [{ job_id: 'JOB-MD', status: 'Completed', actual_meters: 10 }];
    const summary = buildRefundEconomicFloorSummary(db, quote, jobs, {
      cashInNgn: 100_000,
      priorRefundedNgn: 0,
      substitutePricePerMeterNgn: 4000,
    });
    expect(summary.honouredMdPriceException).toBe(true);
    expect(summary.floorDeliveredValueNgn).toBe(35_000);
    expect(summary.maxDefensibleRefundNgn).toBe(65_000);
    expect(summary.ppmSourceByJob['JOB-MD']).toBe('md_approved_quoted_selling');
  });
});

describe('insertRefundRequest economic floor (integration)', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    const linesJson = JSON.stringify({
      materialGauge: '0.28mm',
      materialDesign: 'IV',
      products: [{ name: 'Roofing', qty: 20, unitPrice: 5000, gauge: '0.28mm', design: 'IV' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-FLOOR', 'Floor Customer', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
       VALUES ('QT-FLOOR-001', 'CUS-FLOOR', 'Floor Customer', 100000, 100000, 'Finished', ?, '2026-04-01', 'BR-KD')`
    ).run(linesJson);
    // Cash-in for refunds comes from cleared receipts, not paid_ngn alone.
    db.prepare(
      `INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, finance_reconciliation_saved_at_iso
      ) VALUES ('RCT-FLOOR-1', 'CUS-FLOOR', 'Floor Customer', 'QT-FLOOR-001', 100000, 'Confirmed', '2026-04-01', '2026-04-01T12:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-FLOOR', 'Longspan', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-FLOOR', 'alu', '0.24', 'BR-KD', 'iv', 4000, 0, '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso, branch_id
      ) VALUES ('JOB-FLOOR-1', 'QT-FLOOR-001', 'FG-FLOOR', 'Longspan', 10, 'Completed', '2026-04-01T10:00:00Z', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (
        coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour
      ) VALUES ('CL-FLOOR-1', 'FG-FLOOR', 1000, 1000, 1000, 'Available', '0.24mm', 'IV')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (
        id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg,
        meters_produced, allocation_status, allocated_at_iso
      ) VALUES (
        'PJC-FLOOR-1', 'JOB-FLOOR-1', 1, 'CL-FLOOR-1', '0.24mm',
        100, 0, 100, 10, 'Completed', '2026-04-01T10:00:00Z'
      )`
    ).run();

    const linesInc = JSON.stringify({
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id)
       VALUES ('QT-FLOOR-INC', 'CUS-FLOOR', 'Floor Customer', 50000, 50000, 'Finished', ?, '2026-04-01', 'BR-KD')`
    ).run(linesInc);
    db.prepare(
      `INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, finance_reconciliation_saved_at_iso
      ) VALUES ('RCT-FLOOR-INC', 'CUS-FLOOR', 'Floor Customer', 'QT-FLOOR-INC', 50000, 'Confirmed', '2026-04-01', '2026-04-01T12:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, quotation_ref, product_name, actual_meters, status, created_at_iso, branch_id
      ) VALUES ('JOB-FLOOR-INC', 'QT-FLOOR-INC', 'Unknown FG', 8, 'Completed', '2026-04-01T10:00:00Z', 'BR-KD')`
    ).run();
  }, 180_000);

  afterAll(() => {
    db?.close();
  });

  const salesActor = {
    id: 'sales1',
    displayName: 'Sales Floor',
    roleKey: 'sales_staff',
    permissions: ['refunds.request'],
  };

  it('rejects when amount exceeds maxDefensible', () => {
    const quote = db.prepare(`SELECT * FROM quotations WHERE id = ?`).get('QT-FLOOR-001');
    const jobs = db.prepare(`SELECT * FROM production_jobs WHERE quotation_ref = ?`).all('QT-FLOOR-001');
    const floor = buildRefundEconomicFloorSummary(db, quote, jobs, {
      cashInNgn: 100_000,
      priorRefundedNgn: 0,
      pricingAsAtIso: quotationPricingAsAtIso(quote),
    });
    expect(floor.incompleteFloorPricing).toBe(false);
    expect(floor.maxDefensibleRefundNgn).toBe(60_000);

    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-FLOOR',
        customer: 'Floor Customer',
        quotationRef: 'QT-FLOOR-001',
        reasonCategory: 'Other',
        reason: 'Too large vs economic floor',
        amountNgn: 70_000,
        calculationLines: [{ label: 'Other', amountNgn: 70_000, category: 'Other' }],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_EXCEEDS_ECONOMIC_FLOOR');
    expect(r.maxDefensibleRefundNgn).toBe(60_000);
  });

  it('rejects create when incompleteFloorPricing', () => {
    const r = insertRefundRequest(
      db,
      {
        customerID: 'CUS-FLOOR',
        customer: 'Floor Customer',
        quotationRef: 'QT-FLOOR-INC',
        reasonCategory: 'Other',
        reason: 'Incomplete floor pricing',
        amountNgn: 5_000,
        calculationLines: [{ label: 'Other', amountNgn: 5_000, category: 'Other' }],
        ...REFUND_TEST_PAYEE,
      },
      salesActor,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_INCOMPLETE_FLOOR_PRICING');
  });
});
