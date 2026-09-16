import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  clearStaleMdBelowFloorReviewFlag,
  quotationPriceViolations,
} from './pricingOps.js';

describe('quotationPriceViolations freeze after floor raise', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso
      ) VALUES ('MPS-FZ', 'alu', '0.24', 'BR-KD', 'iv', 4500, 500, '2026-06-01')`
    ).run();
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (
        'EV-FZ-OLD', 'MPS-FZ', 'alu', '0.24', 'BR-KD', 'iv',
        ?, '2026-01-01T10:00:00.000Z', NULL, 'upsert'
      )`
    ).run(
      JSON.stringify({
        before: null,
        after: { minimumPricePerMeterNgn: 4000, commissionNgnPerM: 400 },
      })
    );
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (
        'EV-FZ-NEW', 'MPS-FZ', 'alu', '0.24', 'BR-KD', 'iv',
        ?, '2026-06-01T10:00:00.000Z', NULL, 'upsert'
      )`
    ).run(
      JSON.stringify({
        before: { minimumPricePerMeterNgn: 4000, commissionNgnPerM: 400 },
        after: { minimumPricePerMeterNgn: 4500, commissionNgnPerM: 500 },
      })
    );
  });

  afterEach(() => {
    db?.close();
  });

  function linesJson({ unitPrice, stampedFloor }) {
    return JSON.stringify({
      materialGauge: '0.24mm',
      materialDesign: 'IV',
      materialTypeId: '',
      products: [
        {
          name: 'Roofing Sheet',
          meters: 10,
          unitPrice,
          floorPricePerMeter: stampedFloor,
          gauge: '0.24mm',
          design: 'IV',
          materialType: 'alu',
        },
      ],
      services: [],
    });
  }

  it('honors stamped floor so a later live raise does not below-floor flag', () => {
    const row = {
      id: 'QT-FZ-1',
      branch_id: 'BR-KD',
      date_iso: '2026-03-15',
      paid_ngn: 0,
      lines_json: linesJson({ unitPrice: 4000, stampedFloor: 4000 }),
    };
    // Live workbook is 4500; stamped floor keeps this OK.
    const live = quotationPriceViolations(db, row, { pricingMode: 'current' });
    expect(live.violations.filter((v) => v.code === 'below_floor')).toHaveLength(0);

    const frozen = quotationPriceViolations(db, row);
    expect(frozen.violations.filter((v) => v.code === 'below_floor')).toHaveLength(0);
  });

  it('does not treat a list-price stamp as the floor gate', () => {
    // Older clients stamped floor+commission into floorPricePerMeter.
    const row = {
      id: 'QT-FZ-LIST',
      branch_id: 'BR-KD',
      date_iso: '2026-03-15',
      paid_ngn: 0,
      lines_json: linesJson({ unitPrice: 4000, stampedFloor: 4800 }),
    };
    const pv = quotationPriceViolations(db, row);
    expect(pv.violations.filter((v) => v.code === 'below_floor')).toHaveLength(0);
    // Gate uses workbook min (4000 on quote date), not the inflated stamp.
  });

  it('unpaid dated quote freezes to quote-date workbook floor (not live)', () => {
    const row = {
      id: 'QT-FZ-2',
      branch_id: 'BR-KD',
      date_iso: '2026-03-15',
      paid_ngn: 0,
      // No stamp — must use as-of workbook (4000 on quote date), not live 4500.
      lines_json: linesJson({ unitPrice: 4000, stampedFloor: 0 }),
    };
    const asOfQuote = quotationPriceViolations(db, row);
    expect(asOfQuote.violations.filter((v) => v.code === 'below_floor')).toHaveLength(0);

    const live = quotationPriceViolations(db, row, { pricingMode: 'current' });
    expect(live.violations.some((v) => v.code === 'below_floor')).toBe(true);
    expect(live.violations.find((v) => v.code === 'below_floor')?.floorPerMeter).toBe(4500);
  });

  it('still flags when quoted below stamped floor', () => {
    const row = {
      id: 'QT-FZ-3',
      branch_id: 'BR-KD',
      date_iso: '2026-03-15',
      paid_ngn: 50000,
      lines_json: linesJson({ unitPrice: 3800, stampedFloor: 4000 }),
    };
    const pv = quotationPriceViolations(db, row);
    expect(pv.violations.some((v) => v.code === 'below_floor')).toBe(true);
    expect(pv.violations.find((v) => v.code === 'below_floor')?.floorSource).toBe('line_stamp');
  });

  it('clears stale MD review flag when frozen check is clean', () => {
    const lines = linesJson({ unitPrice: 4000, stampedFloor: 4000 });
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-FZ', 'FZ', 'BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json, date_iso, branch_id,
        price_exception_md_review_required
      ) VALUES ('QT-FZ-CLR', 'CUS-FZ', 'FZ', 40000, 0, 'Open', ?, '2026-03-15', 'BR-KD', 1)`
    ).run(lines);
    const row = db
      .prepare(`SELECT id, lines_json, branch_id, date_iso, paid_ngn FROM quotations WHERE id = ?`)
      .get('QT-FZ-CLR');
    const r = clearStaleMdBelowFloorReviewFlag(db, row);
    expect(r.cleared).toBe(true);
    expect(r.violations).toHaveLength(0);
    const flag = db
      .prepare(`SELECT price_exception_md_review_required AS f FROM quotations WHERE id = ?`)
      .get('QT-FZ-CLR');
    expect(Number(flag.f)).toBe(0);
  });
});
