import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCoilRegister,
  normaliseDateISO,
  purchaseUnitForLine,
  spoolKgForCoil,
  splitSpool,
} from './coilRegisterCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/materialRegisterSource.json', import.meta.url), 'utf8')
);
const reg = buildCoilRegister(kd);
const near = (actual, expected, tol = 1000) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe('coil register — Kaduna Sep 2026 fixture (owner figures, coils only)', () => {
  it('31 Aug: 64 coils, 59,613 kg; spool 3,456 kg / ₦6,768,333 (metre-bought aluminium carries no spool)', () => {
    const t = reg.stock.opening.totals;
    expect(reg.stock.opening.asAtISO).toBe('2026-08-31');
    expect(t.coilCount).toBe(64);
    expect(t.kgGross).toBe(59_613);
    expect(t.spoolKg).toBe(3_456);
    near(t.spoolValueNgn, 6_768_333);
    // Gross = ERP ₦139,018,856 less CL-26-2052 re-costed at ₦7,022.5/kg (₦2,806,000 → ₦1,713,500).
    near(t.valueGrossNgn, 137_926_356);
    expect(reg.stock.openingWithCorrections).toBeNull();
  });

  it('30 Sep in the ERP: 70 coils, 66,655 kg', () => {
    const t = reg.stock.closing.totals;
    expect(t.coilCount).toBe(70);
    expect(t.kgGross).toBe(66_655);
    near(t.valueGrossNgn, 139_776_974);
    expect(reg.stock.closing.rows.some((r) => r.coilNo === 'CL-26-2096')).toBe(false);
  });

  it('30 Sep with CL-26-2096 at its true receive date: 71 coils; spool 3,845 kg / ₦7,432,585', () => {
    const c = reg.stock.closingWithCorrections;
    expect(c.totals.coilCount).toBe(71);
    expect(c.totals.spoolKg).toBe(3_845);
    near(c.totals.spoolValueNgn, 7_432_585);
    near(c.totals.valueGrossNgn, 144_562_014);
    expect(c.rows.find((r) => r.coilNo === 'CL-26-2096')).toMatchObject({ kgGross: 2_782, valueGrossNgn: 4_785_040 });
  });

  it('only per-kg aluminium coils carry a spool: CL-26-2083, 2075, 2100, 2082, CL-KD-APR-1918', () => {
    const withSpool = (st) => st.rows.filter((r) => r.family === 'aluminium' && r.spoolKg > 0).map((r) => r.coilNo).sort();
    expect(withSpool(reg.stock.opening)).toEqual(['CL-26-2075', 'CL-26-2083', 'CL-KD-APR-1918']);
    expect(withSpool(reg.stock.closingWithCorrections)).toEqual(['CL-26-2082', 'CL-26-2100', 'CL-KD-APR-1918']);
  });

  it('values CL-26-2052 (bought by metre) at line amount ÷ kg received: 244 kg × ₦7,022.5 ≈ ₦1,713,490 (ERP ₦2,806,000)', () => {
    const row = reg.stock.opening.rows.find((r) => r.coilNo === 'CL-26-2052');
    expect(row).toMatchObject({ boughtBy: 'metre', spoolKg: 0, erpUnitCostNgnPerKg: 11_500 });
    near(row.unitCostNgnPerKg, 7_022.5, 1);
    near(244 * row.unitCostNgnPerKg, 1_713_490, 20);
  });

  it('September COIL_CONSUMPTION: 45,313 kg (aluminium 11,073, aluzinc 34,240); stone used 2,817 m', () => {
    expect(reg.consumption.totals).toMatchObject({ kg: 45_313, aluminiumKg: 11_073, aluzincKg: 34_240 });
    expect(reg.consumption.stoneConsumedMetres).toBe(2_817);
    expect(reg.consumption.withoutJob).toEqual([]);
    expect(reg.consumption.jobsWithoutCoilConsumption.length).toBeGreaterThan(0);
  });

  it('per PO: kg ordered vs received; September POs PO-0072…0083 received ₦121,541,640 of coil in the period', () => {
    const po78 = reg.purchaseOrders.find((p) => p.poID === 'PO-KD-26-0078');
    expect(po78.lines.map((l) => [l.kgOrdered, l.kgReceived, l.diffKg])).toEqual([
      [2750, 2782, 32],
      [2734, 2803, 69],
      [3310, 3362, 52],
    ]);
    const sepPos = reg.purchaseOrders.filter((p) => p.orderedInPeriod);
    // ₦121,443,840 at ERP cost + ₦97,800: metre-bought CL-26-2205 and CL-26-2089 now at amount paid ÷ kg received.
    expect(sepPos.reduce((s, p) => s + p.grnInPeriodValueNgn, 0)).toBe(121_541_640);
  });

  it('lists coils whose ERP cost/kg differs from line amount ÷ kg received (CL-26-2052: ₦11,500 vs ₦7,022.54)', () => {
    expect(reg.exceptions.costVsPurchase.find((e) => e.coilNo === 'CL-26-2052')).toMatchObject({
      poID: 'PO-KD-26-0043',
      boughtBy: 'metre',
      erpUnitCostNgnPerKg: 11_500,
      costPerKgReceivedNgn: 7_022.54,
      erpValueNgn: 2_806_000,
      valueAtCostPerKgNgn: 1_713_500,
    });
  });

  it('lists PO lines where received kg = ordered kg exactly as "not weighed?"', () => {
    expect(reg.exceptions.notWeighed.map((e) => e.poID)).toEqual([
      'PO-KD-26-0073',
      'PO-KD-26-0074',
      'PO-KD-26-0077',
      'PO-KD-26-0079',
    ]);
  });

  it('flags CL-26-2096 booked 12 Oct but received 12 Sep, and CL-26-2082 received 31 Aug with its GRN dated 1 Sep', () => {
    expect(reg.exceptions.bookedLate.find((e) => e.coilNo === 'CL-26-2096')).toMatchObject({
      poID: 'PO-KD-26-0078',
      bookedISO: '2026-10-12',
      correctedReceivedISO: '2026-09-12',
    });
    expect(reg.exceptions.grnDateMismatch.find((e) => e.coilNo === 'CL-26-2082')).toMatchObject({
      coilReceivedISO: '2026-08-31',
      grnMovementISO: '2026-09-01',
    });
  });

  it('values opening coils with no unit cost at their opening batch price, and lists them', () => {
    expect(reg.exceptions.noUnitCost.map((e) => e.coilNo).sort()).toEqual([
      'CL-KD-APR-1755',
      'CL-KD-APR-1962',
      'CL-KD-APR-1989',
      'CL-KD-APR-2002',
    ]);
    expect(reg.exceptions.noUnitCost.every((e) => e.unitCostNgnPerKg === 1_738)).toBe(true);
  });
});

describe('coil register rules (synthetic)', () => {
  it('spool: Aluzinc incl. PPGI 65 kg, Aluminium by kg 45 kg, Aluminium by metre 0; lighter than spool is nil net', () => {
    expect(spoolKgForCoil({ materialTypeName: 'Aluzinc (PPGI)' })).toBe(65);
    expect(spoolKgForCoil({ materialTypeName: 'Aluminium' }, 'kg')).toBe(45);
    expect(spoolKgForCoil({ materialTypeName: 'Aluminium' }, 'metre')).toBe(0);
    expect(spoolKgForCoil({ materialTypeName: 'Aluzinc' }, 'metre')).toBe(65);
    expect(splitSpool(40, 65)).toEqual({ spoolKg: 40, netKg: 0 });
    expect(splitSpool(1000, 45)).toEqual({ spoolKg: 45, netKg: 955 });
  });

  it('detects aluminium bought by the metre: coil_meter, metres offered = qty ordered, or price ≥ ₦9,000', () => {
    const al = { productID: 'COIL-ALU', productName: 'Aluminium coil (kg)' };
    expect(purchaseUnitForLine({ ...al, lineType: 'coil_meter', qtyOrdered: 85.4, unitPricePerKgNgn: 6500 }).unit).toBe('metre');
    expect(purchaseUnitForLine({ ...al, lineType: '', qtyOrdered: 149, metersOffered: 149, unitPricePerKgNgn: 11500 }).unit).toBe('metre');
    expect(purchaseUnitForLine({ ...al, lineType: 'coil_kg', qtyOrdered: 72, metersOffered: 0, unitPricePerKgNgn: 10900 }).unit).toBe('metre');
    expect(purchaseUnitForLine({ ...al, lineType: 'coil_kg', qtyOrdered: 2146, metersOffered: 1390, unitPricePerKgNgn: 6700 }).unit).toBe('kg');
    expect(purchaseUnitForLine({ productID: 'PRD-102', productName: 'Aluzinc coil (kg)', qtyOrdered: 26, metersOffered: 26, unitPricePerKgNgn: 11700 }).unit).toBe('kg');
  });

  it('reads ISO dates, M/D/YY opening dates and Excel serials', () => {
    expect(normaliseDateISO('2026-09-15T12:00:00')).toBe('2026-09-15');
    expect(normaliseDateISO('4/30/26')).toBe('2026-04-30');
    expect(normaliseDateISO(46143)).toBe('2026-05-01');
  });

  it('rolls back by movement date and keeps stock-check corrections as true', () => {
    const r = buildCoilRegister({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      coilLots: [{ coilNo: 'C1', materialTypeName: 'Aluzinc', currentWeightKg: 500, receivedAtISO: '2026-08-01', unitCostNgnPerKg: 2000 }],
      stockMovements: [
        { type: 'COIL_CONSUMPTION', ref: 'J1', detail: 'C1 consumed', qty: -300, dateISO: '2026-09-10' },
        { type: 'COIL_SCRAP', ref: 'C1', detail: 'stock check', qty: -100, dateISO: '2026-10-05' },
      ],
      stockCheckCorrectionsFromISO: '2026-10-01',
    });
    expect(r.stock.opening.totals.kgGross).toBe(800);
    expect(r.stock.closing.totals.kgGross).toBe(500);
    expect(r.consumption.withoutJob).toHaveLength(1);
  });
});
