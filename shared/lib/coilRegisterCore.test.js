import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCoilRegister, normaliseDateISO, spoolKgForCoil, splitSpool } from './coilRegisterCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/materialRegisterSource.json', import.meta.url), 'utf8')
);
const reg = buildCoilRegister(kd);
const near = (actual, expected, tol = 1000) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe('coil register — Kaduna Sep 2026 fixture (owner figures, coils only)', () => {
  it('31 Aug: 64 coils, 59,613 kg, ₦139,018,856 gross; spool 3,861 kg / ₦9,913,473; net ₦129,105,383', () => {
    const t = reg.stock.opening.totals;
    expect(reg.stock.opening.asAtISO).toBe('2026-08-31');
    expect(t.coilCount).toBe(64);
    expect(t.kgGross).toBe(59_613);
    expect(t.spoolKg).toBe(3_861);
    near(t.valueGrossNgn, 139_018_856);
    near(t.spoolValueNgn, 9_913_473);
    near(t.valueNetNgn, 129_105_383);
    expect(reg.stock.openingWithCorrections).toBeNull();
  });

  it('30 Sep in the ERP: 70 coils, 66,655 kg, ₦140,775,874 gross', () => {
    const t = reg.stock.closing.totals;
    expect(t.coilCount).toBe(70);
    expect(t.kgGross).toBe(66_655);
    near(t.valueGrossNgn, 140_775_874);
    expect(reg.stock.closing.rows.some((r) => r.coilNo === 'CL-26-2096')).toBe(false);
  });

  it('30 Sep with CL-26-2096 at its true receive date: 71 coils, ₦145,560,914; spool 4,295 kg / ₦10,870,225; net ₦134,690,689', () => {
    const c = reg.stock.closingWithCorrections;
    expect(c.totals.coilCount).toBe(71);
    near(c.totals.valueGrossNgn, 145_560_914);
    expect(c.totals.spoolKg).toBe(4_295);
    near(c.totals.spoolValueNgn, 10_870_225);
    near(c.totals.valueNetNgn, 134_690_689);
    expect(c.rows.find((r) => r.coilNo === 'CL-26-2096')).toMatchObject({ kgGross: 2_782, valueGrossNgn: 4_785_040 });
  });

  it('September COIL_CONSUMPTION: 45,313 kg (aluminium 11,073, aluzinc 34,240); stone used 2,817 m', () => {
    expect(reg.consumption.totals).toMatchObject({ kg: 45_313, aluminiumKg: 11_073, aluzincKg: 34_240 });
    expect(reg.consumption.stoneConsumedMetres).toBe(2_817);
    expect(reg.consumption.withoutJob).toEqual([]);
    expect(reg.consumption.jobsWithoutCoilConsumption.length).toBeGreaterThan(0);
  });

  it('per PO: kg ordered vs received; September POs PO-0072…0083 received ₦121,443,840 of coil in the period', () => {
    const po78 = reg.purchaseOrders.find((p) => p.poID === 'PO-KD-26-0078');
    expect(po78.lines.map((l) => [l.kgOrdered, l.kgReceived, l.diffKg])).toEqual([
      [2750, 2782, 32],
      [2734, 2803, 69],
      [3310, 3362, 52],
    ]);
    const sepPos = reg.purchaseOrders.filter((p) => p.orderedInPeriod);
    expect(sepPos.reduce((s, p) => s + p.grnInPeriodValueNgn, 0)).toBe(121_443_840);
  });

  it('flags CL-26-2052 priced ₦11,500/kg against PO-0043 at ≈ ₦7,022/kg received', () => {
    expect(reg.exceptions.priceVsPo.find((e) => e.coilNo === 'CL-26-2052')).toMatchObject({
      poID: 'PO-KD-26-0043',
      coilUnitCostNgnPerKg: 11_500,
      poPricePerKgReceivedNgn: 7_022.54,
    });
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
  it('spool: Aluzinc incl. PPGI 65 kg, Aluminium 45 kg; a coil lighter than its spool is nil net', () => {
    expect(spoolKgForCoil({ materialTypeName: 'Aluzinc (PPGI)' })).toBe(65);
    expect(spoolKgForCoil({ materialTypeName: 'Aluminium' })).toBe(45);
    expect(splitSpool(40, 65)).toEqual({ spoolKg: 40, netKg: 0 });
    expect(splitSpool(1000, 45)).toEqual({ spoolKg: 45, netKg: 955 });
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
