/**
 * Customer-facing price book HTML (print). Premium column is PDF-only (3.5% + rounding).
 */

import { listPriceListItems } from './pricingOps.js';
import { listMasterData } from './masterData.js';
import { getPricingPolicyBundle } from './pricingPolicyOps.js';
import { premiumProfilePriceFromBase } from './pricingPolicyResolve.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNgn(n) {
  return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function buildCustomerPriceBookHtml(db) {
  const items = listPriceListItems(db);
  const md = listMasterData(db);
  const accessories = (md.quoteItems || []).filter((q) => String(q.itemType || '').toLowerCase() === 'accessory' && q.active !== false);
  const policy = getPricingPolicyBundle(db);

  let maxEff = '';
  for (const it of items) {
    const e = String(it.effectiveFromIso || '').trim();
    if (e && e > maxEff) maxEff = e;
  }
  const effectiveLabel = maxEff || new Date().toISOString().slice(0, 10);

  const normMt = (s) =>
    String(s ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const stoneRows = items.filter((it) => normMt(it.materialTypeKey) === 'stone-coated');
  const coilRows = items.filter((it) => normMt(it.materialTypeKey) !== 'stone-coated');

  const sortCoil = (rows) =>
    [...rows].sort((a, b) => {
      const g = String(a.gaugeKey).localeCompare(String(b.gaugeKey));
      if (g !== 0) return g;
      return String(a.designKey).localeCompare(String(b.designKey));
    });

  const isAluMt = (m) => {
    const x = normMt(m);
    return x === 'alu' || x === 'aluminium' || x === 'aluminum' || x === '';
  };
  const isAluzincMt = (m) => {
    const x = normMt(m);
    return x === 'aluzinc' || x === 'ppgi' || x.includes('aluzinc') || x.includes('zinc');
  };

  const aluCoil = sortCoil(coilRows.filter((it) => isAluMt(it.materialTypeKey)));
  const aluzincCoil = sortCoil(coilRows.filter((it) => isAluzincMt(it.materialTypeKey)));
  const otherCoil = sortCoil(
    coilRows.filter((it) => !isAluMt(it.materialTypeKey) && !isAluzincMt(it.materialTypeKey))
  );

  const coilSectionHtml = (title, rows) => {
    const body = rows
      .map((it) => {
        const base = Math.round(Number(it.unitPricePerMeterNgn) || 0);
        const prem = premiumProfilePriceFromBase(base);
        return `<tr><td>${esc(it.materialTypeKey || '—')}</td><td>${esc(it.gaugeKey)}</td><td>${esc(it.designKey)}</td><td class="num">${esc(fmtNgn(base))}</td><td class="num">${esc(fmtNgn(prem))}</td></tr>`;
      })
      .join('');
    return `
  <h2>${esc(title)}</h2>
  <table>
    <thead><tr><th>Material</th><th>Gauge</th><th>Design</th><th class="num">Base ₦/m</th><th class="num">Premium profile ₦/m</th></tr></thead>
    <tbody>${body || '<tr><td colspan="5">No rows.</td></tr>'}</tbody>
  </table>`;
  };

  const coilRowsHtml =
    coilSectionHtml('Aluminium (published floors)', aluCoil) +
    coilSectionHtml('Aluzinc / PPGI (published floors)', aluzincCoil) +
    (otherCoil.length
      ? coilSectionHtml('Other coil / sheet (published floors)', otherCoil)
      : '');

  const stoneSorted = [...stoneRows].sort((a, b) => String(a.gaugeKey).localeCompare(String(b.gaugeKey)));
  const stoneHtml = stoneSorted
    .map(
      (it) =>
        `<tr><td>${esc(it.gaugeKey)}</td><td class="num">${esc(fmtNgn(it.unitPricePerMeterNgn))}</td><td>${esc(it.notes || '')}</td></tr>`
    )
    .join('');

  const accHtml = accessories
    .map((a) => {
      const up = Math.round(Number(a.defaultUnitPriceNgn) || 0);
      return `<tr><td>${esc(a.name)}</td><td>${esc(a.unit || '')}</td><td class="num">${up > 0 ? esc(fmtNgn(up)) : '—'}</td></tr>`;
    })
    .join('');

  const ridgeRows = (policy.ridgeAddOns || [])
    .map(
      (r) =>
        `<tr><td>${esc(String(r.girthMm))}</td><td>${esc(r.materialFamily || '—')}</td><td class="num">${esc(fmtNgn(r.addOnNgn))}</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Zarewa price list — ${esc(effectiveLabel)}</title>
  <style>
    body { font-family: 'Segoe UI', system-ui, Roboto, sans-serif; color: #0f172a; margin: 24px; max-width: 1000px; }
    h1 { font-size: 1.35rem; color: #134e4a; border-bottom: 2px solid #134e4a; padding-bottom: 8px; }
    h2 { font-size: 1.05rem; margin-top: 1.75rem; color: #0f766e; page-break-after: avoid; }
    .muted { color: #64748b; font-size: 0.88rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 6px; margin-bottom: 4px; font-size: 0.88rem; }
    th, td { border: 1px solid #94a3b8; padding: 7px 9px; text-align: left; }
    th { background: #e2e8f0; font-weight: 700; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    @media print { body { margin: 12px; } h2 { break-after: avoid; } }
  </style>
</head>
<body>
  <h1>Price list (customer)</h1>
  <p class="muted">Effective ${esc(effectiveLabel)} · All roofing rates in Naira per running metre unless noted.
  Metcoppo / Steptiles column is <strong>3.5%</strong> above base (rounded: &lt; ₦5,000 → nearest ₦50; ≥ ₦5,000 → nearest ₦100).</p>

  <p class="muted">Sections follow material family (Aluminium, Aluzinc, other coil, stone-coated, accessories). Premium column = 3.5% on base + rounding rule.</p>
  ${coilRowsHtml || '<h2>Coil &amp; sheet</h2><p class="muted">No non–stone-coated price list rows yet.</p>'}

  <h2>Stone-coated (published floors)</h2>
  <table>
    <thead><tr><th>Gauge</th><th class="num">₦/m</th><th>Notes</th></tr></thead>
    <tbody>${stoneHtml || '<tr><td colspan="3">No stone-coated rows in price list.</td></tr>'}</tbody>
  </table>

  <h2>Ridge / flashing add-ons (₦ per metre, after sheet split)</h2>
  <p class="muted">Ridge floor at quote time may combine sheet floor ÷ (1200 ÷ girth mm) plus the add-on below.</p>
  <table>
    <thead><tr><th>Girth mm</th><th>Material family</th><th class="num">Add-on ₦/m</th></tr></thead>
    <tbody>${ridgeRows || '<tr><td colspan="3">No ridge add-ons configured (Settings → Pricing policy).</td></tr>'}</tbody>
  </table>

  <h2>Accessories (reference)</h2>
  <p class="muted">From setup quote items (accessory type). Confirm live prices before quoting.</p>
  <table>
    <thead><tr><th>Item</th><th>Unit</th><th class="num">Default ₦</th></tr></thead>
    <tbody>${accHtml || '<tr><td colspan="3">No accessories in master data.</td></tr>'}</tbody>
  </table>

  <h2>Notes</h2>
  <ul class="muted">
    <li>Prices subject to change; quotations subject to material availability.</li>
    <li>Below-list quotations require Managing Director price exception before production.</li>
  </ul>
</body>
</html>`;
}
