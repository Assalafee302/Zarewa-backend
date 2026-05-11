/**
 * Full-branch material pricing workbook print HTML (all coil/stone sections + accessories).
 */

import { listMaterialPricingSheet, suggestedPricePerMeterNgn } from './materialPricingOps.js';
import { roundPublishedPrice } from './pricingPolicyResolve.js';
import { listMasterData } from './masterData.js';
import { getPricingPolicyBundle } from './pricingPolicyOps.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtConv2(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(2);
}

function fmtNgn(n) {
  return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

/** Workbook UI rows: primary line or duplicate line (wb-*) */
function isWorkbookDesignKey(dk) {
  const s = String(dk ?? '').trim();
  // Back-compat: older clients generated `wb_...`; treat as workbook rows too.
  return s === '' || s.startsWith('wb-') || s.startsWith('wb_');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {{ branchLabel?: string }} [opts]
 */
export function buildMaterialWorkbookAllHtml(db, branchId, opts = {}) {
  const bid = String(branchId || '').trim();
  const branchLabel = String(opts.branchLabel || bid).trim() || bid;
  if (!bid) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Error</title></head><body><p>branchId is required.</p></body></html>`;
  }

  const materials = [
    { key: 'alu', title: 'Aluminium' },
    { key: 'aluzinc', title: 'Aluzinc (PPGI)' },
    { key: 'stone-coated', title: 'Stone-coated' },
  ];

  const sheets = [];
  for (const m of materials) {
    const r = listMaterialPricingSheet(db, m.key, bid);
    if (!r.ok) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Error</title></head><body><p>${esc(r.error)}</p></body></html>`;
    }
    sheets.push({ ...r, sectionTitle: m.title });
  }

  const md = listMasterData(db);
  const accessories = (md.quoteItems || []).filter(
    (q) => String(q.itemType || '').toLowerCase() === 'accessory' && q.active !== false
  );
  const policy = getPricingPolicyBundle(db);
  const lookbackDays = sheets[0]?.purchaseCostLookbackDays ?? 30;
  const printed = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

  const ridgeRows = (policy.ridgeAddOns || [])
    .map(
      (r) =>
        `<tr><td>${esc(String(r.girthMm))}</td><td>${esc(r.materialFamily || '—')}</td><td class="num">${esc(fmtNgn(r.addOnNgn))}</td></tr>`
    )
    .join('');

  const accHtml = accessories
    .map((a) => {
      const up = Math.round(Number(a.defaultUnitPriceNgn) || 0);
      return `<tr><td>${esc(a.name)}</td><td>${esc(a.unit || '')}</td><td class="num">${up > 0 ? esc(fmtNgn(up)) : '—'}</td></tr>`;
    })
    .join('');

  const coilTable = (sheet) => {
    const isStone = Boolean(sheet.isStoneCoatedWorkbook);
    const rows = sheet.rows || [];
    const workbookRows = rows
      .filter((r) => isWorkbookDesignKey(r.designKey))
      .sort((a, b) => {
        const ga = String(a.gaugeMm || '');
        const gb = String(b.gaugeMm || '');
        if (ga !== gb) return ga.localeCompare(gb);
        return String(a.designKey || '').localeCompare(String(b.designKey || ''));
      });
    const body = workbookRows
      .map((row) => {
        const g = String(row.gaugeMm || '').trim();
        const rv = sheet.resolvedByGauge?.[g] || {};
        const used = rv.used != null && Number.isFinite(Number(rv.used)) ? Number(rv.used) : null;
        const ck = row?.costPerKgNgn != null ? Number(row.costPerKgNgn) : null;
        const oh = row?.overheadNgnPerM != null ? Number(row.overheadNgnPerM) : 0;
        const pr = row?.profitNgnPerM != null ? Number(row.profitNgnPerM) : 0;
        let sug = null;
        if (!isStone && used != null && ck != null && ck >= 0) {
          sug = suggestedPricePerMeterNgn(used, ck, oh, pr);
        }
        const minimumNgn = Math.round(Number(row?.minimumPricePerMeterNgn) || 0);
        const comm = Math.max(0, Number(row?.commissionNgnPerM) || 0);
        const listP = roundPublishedPrice(minimumNgn + comm);
        const displaySug =
          sug != null && sug > 0 ? sug : isStone && minimumNgn > 0 ? minimumNgn : null;
        const sugCell =
          displaySug != null && displaySug > 0 ? esc(fmtNgn(displaySug)) : '—';
        const floorCell = minimumNgn > 0 ? esc(fmtNgn(minimumNgn)) : '—';
        const commCell = comm > 0 ? esc(fmtNgn(comm)) : '—';
        const listCell = listP > 0 ? esc(fmtNgn(listP)) : '—';
        const ckCell =
          !isStone && ck != null && Number.isFinite(ck) && ck >= 0 ? esc(fmtNgn(ck)) : '—';
        const custLab = String(row.gaugeCustomerLabel || '').trim();
        const gaugeCell = custLab
          ? `<strong>${esc(g)}</strong> mm<br/><span style="font-size:0.78rem;color:#64748b;">${esc(custLab)}</span>`
          : `<strong>${esc(g)}</strong> mm`;
        return `<tr>
  <td>${gaugeCell}</td>
  <td class="num">${esc(fmtConv2(rv.std))}</td>
  <td class="num">${esc(fmtConv2(rv.ref))}</td>
  <td class="num">${esc(fmtConv2(rv.hist))}</td>
  <td class="num">${esc(fmtConv2(used))}</td>
  <td class="num">${isStone ? '—' : ckCell}</td>
  <td class="num">${sugCell}</td>
  <td class="num">${floorCell}</td>
  <td class="num">${commCell}</td>
  <td class="num">${listCell}</td>
</tr>`;
      })
      .join('');
    return `
  <h2>${esc(sheet.sectionTitle)}</h2>
  <p class="muted">${isStone ? 'Minimum ₦/m per gauge (internal workbook).' : `Std / Ref / Hist from data; Used = saved override or average of Std–Hist. Purchase &amp; production hints: last ${lookbackDays} days.`}</p>
  <table>
    <thead>
      <tr>
        <th>Gauge</th>
        <th class="num">Std</th>
        <th class="num">Ref</th>
        <th class="num">Hist</th>
        <th class="num">Used</th>
        <th class="num">₦/kg</th>
        <th class="num">Suggested ₦/m</th>
        <th class="num">Min floor ₦/m</th>
        <th class="num">Comm ₦/m</th>
        <th class="num">List ₦/m</th>
      </tr>
    </thead>
    <tbody>${body || '<tr><td colspan="10">No workbook lines yet.</td></tr>'}</tbody>
  </table>`;
  };

  const sectionsHtml = sheets.map((s) => coilTable(s)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Zarewa — material pricing workbook (all materials)</title>
  <style>
    body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #0f172a; margin: 24px 28px; max-width: 1000px; padding-top: 52px; box-sizing: border-box; }
    h1 { font-size: 1.25rem; color: #134e4a; margin: 0 0 8px; }
    h2 { font-size: 1.05rem; color: #0f766e; margin: 1.75rem 0 6px; page-break-after: avoid; }
    .muted { color: #64748b; font-size: 0.82rem; margin: 0 0 10px; line-height: 1.45; }
    .meta { font-size: 0.82rem; color: #334155; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; margin-top: 6px; font-size: 0.82rem; }
    th, td { border: 1px solid #94a3b8; padding: 7px 9px; text-align: left; }
    th { background: #e2e8f0; font-weight: 700; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .print-preview-bar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
      padding: 10px 18px; background: #f8fafc; border-bottom: 1px solid #cbd5e1;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
    }
    .print-preview-bar strong { font-size: 0.88rem; color: #134e4a; }
    .print-preview-bar .hint { font-size: 0.78rem; color: #64748b; flex: 1 1 160px; }
    .print-preview-bar button {
      font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer;
      padding: 8px 14px; border-radius: 8px; border: 1px solid #134e4a;
      background: #134e4a; color: #fff;
    }
    .print-preview-bar button.secondary { background: #fff; color: #334155; border-color: #94a3b8; }
    .print-preview-bar button:hover { filter: brightness(1.05); }
    .print-preview-bar button.secondary:hover { background: #f1f5f9; }
    @media print {
      body { margin: 12px 16px; padding-top: 0; }
      h2 { break-after: avoid; }
      .print-preview-bar { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="print-preview-bar" role="region" aria-label="Print preview">
    <strong>Print preview</strong>
    <span class="hint">Review the report below, then use Print to open the system print dialog.</span>
    <button type="button" id="workbook-print-btn">Print…</button>
    <button type="button" id="workbook-close-btn" class="secondary">Close tab</button>
  </div>
  <h1>Material pricing workbook — all materials</h1>
  <div class="meta">
    <strong>Branch:</strong> ${esc(branchLabel)}<br/>
    <strong>Printed:</strong> ${esc(printed)}
  </div>
  <p class="muted">Internal reference: Aluminium, Aluzinc, stone-coated gauges, ridge add-ons, and accessories. Customer-facing list: Pricing policy → Customer price book.</p>
  ${sectionsHtml}

  <h2>Ridge / flashing add-ons (₦ per metre, after sheet split)</h2>
  <table>
    <thead><tr><th>Girth mm</th><th>Material family</th><th class="num">Add-on ₦/m</th></tr></thead>
    <tbody>${ridgeRows || '<tr><td colspan="3">No ridge add-ons configured.</td></tr>'}</tbody>
  </table>

  <h2>Accessories (reference)</h2>
  <p class="muted">From setup quote items (accessory type). Confirm live prices before quoting.</p>
  <table>
    <thead><tr><th>Item</th><th>Unit</th><th class="num">Default ₦</th></tr></thead>
    <tbody>${accHtml || '<tr><td colspan="3">No accessories in master data.</td></tr>'}</tbody>
  </table>
  <script>
    (function () {
      var p = document.getElementById('workbook-print-btn');
      var c = document.getElementById('workbook-close-btn');
      if (p) p.addEventListener('click', function () { try { window.print(); } catch (e) {} });
      if (c) c.addEventListener('click', function () { try { window.close(); } catch (e) {} });
    })();
  </script>
</body>
</html>`;
}
