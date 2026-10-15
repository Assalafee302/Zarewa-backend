import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCoilRegister } from './coilRegisterCore.js';
import { MONTH_END_STOCK_NOTE, buildMonthEndStockReport, monthEndStockReportTableRows } from './monthEndStockReportCore.js';

const kd = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/kd-2026-09/materialRegisterSource.json', import.meta.url), 'utf8')
);
const reg = buildCoilRegister(kd);
const aug31 = buildMonthEndStockReport(reg.stock.opening);
const coils = (rep) => rep.materials.flatMap((m) => m.gauges.flatMap((g) => g.rows));

describe('month-end coil stock report — Kaduna 31 Aug 2026 (fixture)', () => {
  it('has the owner 31 Aug figures: 64 coils, 59,613 kg gross, 3,456 kg spool, 56,157 kg net', () => {
    expect(aug31.asAtISO).toBe('2026-08-31');
    expect(aug31.grandTotal).toMatchObject({ coilCount: 64, grossKg: 59_613, spoolKg: 3_456, netKg: 56_157 });
    expect(aug31.note).toBe(MONTH_END_STOCK_NOTE);
    expect(MONTH_END_STOCK_NOTE).toBe('Gross = weighed coil incl. spool; Net = gross − spool; value at net.');
  });

  it('values every coil at net kg × rate, never gross', () => {
    for (const r of coils(aug31)) {
      expect(r.valueNgn).toBe(Math.round(r.netKg * r.rateNgnPerKg));
      expect(r.netKg).toBe(Math.round((r.grossKg - r.spoolKg) * 100) / 100);
    }
    // Same as the approved register's net value (gross value − spool value), within ₦1 rounding per coil.
    const regNet = reg.stock.opening.totals.valueNetNgn;
    expect(Math.abs(aug31.grandTotal.valueNgn - regNet)).toBeLessThanOrEqual(aug31.grandTotal.coilCount);
    expect(aug31.grandTotal.valueNgn).toBeLessThan(reg.stock.opening.totals.valueGrossNgn);
  });

  it('applies the spool rule: Aluzinc 65 kg, aluminium by kg 45 kg, aluminium by metre 0', () => {
    for (const r of coils(aug31)) {
      const expected = r.family === 'aluzinc' ? 65 : r.boughtBy === 'metre' ? 0 : 45;
      expect(r.spoolKg).toBe(Math.min(expected, r.grossKg));
    }
    const alu = coils(aug31).filter((r) => r.family === 'aluminium');
    expect(alu.filter((r) => r.spoolKg > 0).map((r) => r.coilNo).sort()).toEqual(['CL-26-2075', 'CL-26-2083', 'CL-KD-APR-1918']);
  });

  it('subtotals by gauge and material add up to the grand total', () => {
    const sum = (list, k) => Math.round(list.reduce((s, t) => s + t[k], 0) * 100) / 100;
    for (const m of aug31.materials) {
      expect(sum(m.gauges.map((g) => g.subtotal), 'netKg')).toBe(m.subtotal.netKg);
      expect(m.gauges.reduce((s, g) => s + g.subtotal.valueNgn, 0)).toBe(m.subtotal.valueNgn);
    }
    expect(aug31.materials.reduce((s, m) => s + m.subtotal.valueNgn, 0)).toBe(aug31.grandTotal.valueNgn);
    expect(sum(aug31.materials.map((m) => m.subtotal), 'grossKg')).toBe(aug31.grandTotal.grossKg);
    expect(aug31.materials.map((m) => m.material)).toEqual(['Aluminium', 'Aluzinc']);
  });

  it('table rows: coils, a subtotal after each gauge and material, grand total last', () => {
    const t = monthEndStockReportTableRows(aug31);
    expect(t.filter((r) => r.kind === 'coil')).toHaveLength(64);
    expect(t.at(-1)).toMatchObject({ kind: 'grand', grossKg: 59_613, spoolKg: 3_456, netKg: 56_157 });
    expect(t.filter((r) => r.kind === 'material')).toHaveLength(2);
  });
});

describe('month-end coil stock report — rules on small inputs', () => {
  it('a coil lighter than its spool is nil net and nil value, never negative', () => {
    const rep = buildMonthEndStockReport({
      asAtISO: '2026-08-31',
      rows: [
        { coilNo: 'A', family: 'aluzinc', gaugeLabel: '0.40mm', kgGross: 40, spoolKg: 40, kgNet: 0, unitCostNgnPerKg: 2000 },
        { coilNo: 'B', family: 'aluzinc', gaugeLabel: '0.40mm', kgGross: 30, spoolKg: 65, kgNet: -35, unitCostNgnPerKg: 2000 },
      ],
    });
    const [a, b] = rep.materials[0].gauges[0].rows;
    expect(a).toMatchObject({ grossKg: 40, spoolKg: 40, netKg: 0, valueNgn: 0 });
    expect(b).toMatchObject({ grossKg: 30, spoolKg: 30, netKg: 0, valueNgn: 0 });
  });

  it('sorts gauges numerically and lists coils without a rate', () => {
    const rep = buildMonthEndStockReport({
      asAtISO: '2026-08-31',
      rows: [
        { coilNo: 'X2', family: 'aluminium', gaugeLabel: '0.55mm', kgGross: 1000, spoolKg: 45, unitCostNgnPerKg: 0 },
        { coilNo: 'X1', family: 'aluminium', gaugeLabel: '0.45mm', kgGross: 1000, spoolKg: 0, unitCostNgnPerKg: 6000 },
      ],
    });
    expect(rep.materials[0].gauges.map((g) => g.gauge)).toEqual(['0.45mm', '0.55mm']);
    expect(rep.coilsWithoutRate).toEqual(['X2']);
    expect(rep.grandTotal.valueNgn).toBe(6_000_000);
  });
});
