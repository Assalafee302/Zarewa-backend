/**
 * Format business intelligence packs for Zare conversational replies.
 */
import { businessIntelligenceHeadlines } from './businessIntelligence.js';

/**
 * @param {import('./businessIntelligence.js').buildBusinessIntelligencePack extends (...args: any[]) => infer R ? R : never} pack
 * @returns {string}
 */
export function formatBusinessAnalysisReply(pack) {
  if (!pack?.ok) {
    return 'I could not load business analytics for your branch scope. Open **Business intelligence** from the sidebar or ask an admin to confirm report permissions.';
  }

  const lines = businessIntelligenceHeadlines(pack);
  const s = pack.sales;
  const p = pack.predictive;
  const inv = pack.inventory;

  const sections = [
    `**Business analysis** (${pack.periodLabel})`,
    '',
    '**Sales**',
    `- Produced revenue: ₦${(s.producedRevenueNgn || 0).toLocaleString('en-NG')}`,
    `- Quoted in period: ₦${(s.quotedNgn || 0).toLocaleString('en-NG')}`,
    `- Collected (receipts): ₦${(s.collectedNgn || 0).toLocaleString('en-NG')}`,
  ];

  if (s.mixRows?.length) {
    sections.push('- Metal family mix (produced revenue share):');
    for (const row of s.mixRows.filter((r) => r.revenueNgn > 0)) {
      const label =
        row.family === 'aluminium' ? 'Aluminium' : row.family === 'aluzinc' ? 'Aluzinc' : 'Other';
      sections.push(`  · ${label}: ${row.sharePct}% (₦${row.revenueNgn.toLocaleString('en-NG')})`);
    }
  }

  const topPay = s.topCustomers?.[0];
  if (topPay?.netCollectedNgn > 0) {
    sections.push(
      `- Top payer (net receipts − refunds): ${topPay.customerName} — ₦${topPay.netCollectedNgn.toLocaleString('en-NG')}`
    );
  }

  for (const famKey of ['aluminium', 'aluzinc']) {
    const perf = s.materialPerformance?.[famKey];
    const best = perf?.topCombinations?.[0];
    if (best?.revenueNgn > 0) {
      sections.push(
        `- Best ${perf.label} combo: ${best.gauge} · ${best.colour} · ${best.profile} — ₦${best.revenueNgn.toLocaleString('en-NG')}`
      );
    }
  }

  const buyAlu = pack.inventory?.skuIntelligence?.aluminium?.buyNext?.[0];
  if (buyAlu) {
    sections.push(`- Buy next (alu): ${buyAlu.gauge} · ${buyAlu.colour} — ${buyAlu.reason}`);
  }
  const slow = pack.inventory?.skuIntelligence?.aluminium?.reduceStock?.[0];
  if (slow) {
    sections.push(
      `- Slow stock (alu): ${slow.gauge} · ${slow.colour} — ₦${slow.valuationNgn.toLocaleString('en-NG')} tied up`
    );
  }

  const sup = pack.procurement?.supplierFocus?.[0];
  if (sup) {
    sections.push(
      `- Supplier focus: ${sup.supplierName} (₦${sup.spendNgn.toLocaleString('en-NG')} spend, ₦${sup.openNgn.toLocaleString('en-NG')} open PO)`
    );
  }

  sections.push('', '**Coil inventory (aluminium & aluzinc)**');
  for (const fam of inv?.families || []) {
    sections.push(
      `- ${fam.label}: ${fam.kgOnHand.toLocaleString()} kg · ${fam.weeksCover ?? '—'} wk cover · incoming PO ${fam.incomingKg.toLocaleString()} kg`
    );
  }

  sections.push('', '**Cash & outlook**');
  sections.push(`- Cleared cash (book): ₦${(p.clearedCashNgn || 0).toLocaleString('en-NG')}`);
  sections.push(
    `- Avg monthly net (4 mo): ₦${(p.avgMonthlyNetNgn || 0).toLocaleString('en-NG')}`
  );
  const h30 = p.cashHorizons?.find((x) => x.days === 30);
  const h90 = p.cashHorizons?.find((x) => x.days === 90);
  if (h30) {
    sections.push(`- 30-day projected balance: ₦${h30.projectedBalanceNgn.toLocaleString('en-NG')} (${h30.stress})`);
  }
  if (h90) {
    sections.push(`- 90-day projected balance: ₦${h90.projectedBalanceNgn.toLocaleString('en-NG')} (${h90.stress})`);
  }
  if (p.grossMarginPct != null) {
    sections.push(`- Estimated gross margin (period): ${p.grossMarginPct}%`);
  }
  if (p.salesMomentumPct != null) {
    sections.push(`- Sales momentum vs prior quarter: ${p.salesMomentumPct >= 0 ? '+' : ''}${p.salesMomentumPct}%`);
  }

  if (p.alerts?.length) {
    sections.push('', '**Priority signals**');
    for (const a of p.alerts.slice(0, 5)) {
      sections.push(`- [${a.severity}] ${a.message}${a.metric ? ` (${a.metric})` : ''}`);
    }
  }

  sections.push('', '**Suggested actions**');
  const suggestions = buildActionSuggestions(pack);
  for (const sug of suggestions.slice(0, 4)) {
    sections.push(`- ${sug}`);
  }

  sections.push('', '_Open **Business intelligence** for charts and drill-down._');

  if (lines.length) {
    sections.push('', '**Quick summary**', ...lines.map((l, i) => `${i + 1}. ${l}`));
  }

  return sections.join('\n');
}

/**
 * @param {ReturnType<typeof import('./businessIntelligence.js').buildBusinessIntelligencePack>} pack
 * @returns {string[]}
 */
export function buildActionSuggestions(pack) {
  /** @type {string[]} */
  const out = [];
  const p = pack.predictive;
  const s = pack.sales;

  if (s.outstandingReceivablesNgn > 0) {
    out.push('Review receivables aging and chase quotes with balance due.');
  }
  for (const fam of pack.inventory?.families || []) {
    if (fam.risk === 'critical') {
      out.push(`Raise a coil PO for ${fam.label} — cover is under 2 weeks.`);
    } else if (fam.risk === 'watch' && fam.incomingKg <= 0) {
      out.push(`Plan ${fam.label} procurement — no open PO kg detected.`);
    }
  }
  if (p.cashHorizons?.some((h) => h.stress === 'deficit' || h.stress === 'tight')) {
    out.push('Align payment requests and supplier runs with the 30–90 day cash outlook.');
  }
  if (p.salesMomentumPct != null && p.salesMomentumPct < 0) {
    out.push('Compare branch quotation pipeline vs production completions to find bottlenecks.');
  }
  if (!out.length) {
    out.push('Maintain current mix — metrics are within normal bands for this period.');
  }
  return out;
}
