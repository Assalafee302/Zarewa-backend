/**
 * Month-end coil stock report — pure (server + client mirror).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/monthEndStockReportCore.js
 *
 * Input: one "stock at a date" block of the coil register (`buildCoilRegister(...).stock.closing` or `.opening`):
 * per coil the weighed gross kg, the spool by the owner's rule (Aluzinc 65 kg, aluminium bought by kg 45 kg,
 * aluminium bought by the metre 0; a coil lighter than its spool is nil net) and its unit cost.
 * Output: per coil Gross | Spool | Net | Rate | Value, subtotals by material and gauge, grand total.
 * Value is always net kg × rate (owner, 15 Oct 2026), so the books' stock convention is unchanged.
 */

export const MONTH_END_STOCK_NOTE = 'Gross = weighed coil incl. spool; Net = gross − spool; value at net.';

const MATERIAL_LABEL = { aluminium: 'Aluminium', aluzinc: 'Aluzinc' };
const MATERIAL_ORDER = ['aluminium', 'aluzinc'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(num(n) * 100) / 100;

/** Gauge label → sortable number ("0.45mm" → 0.45); blank gauges sort last. */
function gaugeSortKey(label) {
  const m = String(label || '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
}

function emptyTotals() {
  return { coilCount: 0, grossKg: 0, spoolKg: 0, netKg: 0, valueNgn: 0 };
}
function addTo(t, r) {
  t.coilCount += 1;
  t.grossKg = round2(t.grossKg + r.grossKg);
  t.spoolKg = round2(t.spoolKg + r.spoolKg);
  t.netKg = round2(t.netKg + r.netKg);
  t.valueNgn += r.valueNgn;
}

/**
 * @param {{ asAtISO: string, rows: Array<{ coilNo: string, family: string, gaugeLabel?: string, colour?: string,
 *   kgGross: number, spoolKg: number, kgNet: number, unitCostNgnPerKg: number, costSource?: string,
 *   boughtBy?: string, poID?: string, receivedISO?: string }> }} stockAt
 */
export function buildMonthEndStockReport(stockAt) {
  const asAtISO = String(stockAt?.asAtISO || '');
  const rows = (stockAt?.rows || []).map((r) => {
    const grossKg = round2(r.kgGross);
    // Never negative: the register already caps spool at gross (lighter than spool = nil net).
    const spoolKg = round2(Math.min(grossKg, Math.max(0, num(r.spoolKg))));
    const netKg = round2(Math.max(0, grossKg - spoolKg));
    const rateNgnPerKg = round2(r.unitCostNgnPerKg);
    return {
      coilNo: r.coilNo,
      family: r.family,
      material: MATERIAL_LABEL[r.family] || r.family || 'Other',
      gauge: String(r.gaugeLabel || '').trim(),
      colour: String(r.colour || '').trim(),
      grossKg,
      spoolKg,
      netKg,
      rateNgnPerKg,
      valueNgn: Math.round(netKg * rateNgnPerKg),
      boughtBy: r.boughtBy || '',
      costSource: r.costSource || '',
      poID: r.poID || '',
      receivedISO: r.receivedISO || '',
      noRate: !(rateNgnPerKg > 0),
    };
  });

  const families = [...new Set(rows.map((r) => r.family))].sort(
    (a, b) => (MATERIAL_ORDER.indexOf(a) + 1 || 99) - (MATERIAL_ORDER.indexOf(b) + 1 || 99) || String(a).localeCompare(String(b))
  );
  const grandTotal = emptyTotals();
  const materials = families.map((family) => {
    const ofFamily = rows.filter((r) => r.family === family);
    const gaugeLabels = [...new Set(ofFamily.map((r) => r.gauge))].sort(
      (a, b) => gaugeSortKey(a) - gaugeSortKey(b) || a.localeCompare(b)
    );
    const subtotal = emptyTotals();
    const gauges = gaugeLabels.map((gauge) => {
      const gaugeRows = ofFamily
        .filter((r) => r.gauge === gauge)
        .sort((a, b) => a.coilNo.localeCompare(b.coilNo, undefined, { numeric: true }));
      const t = emptyTotals();
      for (const r of gaugeRows) {
        addTo(t, r);
        addTo(subtotal, r);
        addTo(grandTotal, r);
      }
      return { gauge: gauge || '(no gauge)', rows: gaugeRows, subtotal: t };
    });
    return { family, material: MATERIAL_LABEL[family] || family || 'Other', gauges, subtotal };
  });

  return {
    asAtISO,
    note: MONTH_END_STOCK_NOTE,
    materials,
    grandTotal,
    coilsWithoutRate: rows.filter((r) => r.noRate).map((r) => r.coilNo),
  };
}

/** Flat rows for Excel / PDF tables: coil lines, a subtotal after each gauge and material, then the grand total. */
export function monthEndStockReportTableRows(report) {
  const out = [];
  const totalRow = (kind, label, t) => ({
    kind,
    coilNo: label,
    material: '',
    gauge: '',
    colour: '',
    grossKg: t.grossKg,
    spoolKg: t.spoolKg,
    netKg: t.netKg,
    rateNgnPerKg: t.netKg > 0 ? round2(t.valueNgn / t.netKg) : null,
    valueNgn: t.valueNgn,
    coilCount: t.coilCount,
  });
  for (const m of report?.materials || []) {
    for (const g of m.gauges) {
      for (const r of g.rows) out.push({ kind: 'coil', ...r });
      out.push(totalRow('gauge', `${m.material} ${g.gauge} subtotal (${g.subtotal.coilCount} coils)`, g.subtotal));
    }
    out.push(totalRow('material', `${m.material} total (${m.subtotal.coilCount} coils)`, m.subtotal));
  }
  if (report) out.push(totalRow('grand', `Grand total (${report.grandTotal.coilCount} coils)`, report.grandTotal));
  return out;
}
