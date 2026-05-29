/**
 * Excel export for business intelligence packs (management meetings).
 */
import XLSX from 'xlsx';

/**
 * @param {ReturnType<import('../shared/lib/businessIntelligence.js').buildBusinessIntelligencePack>} pack
 * @returns {Buffer}
 */
export function buildBusinessIntelligenceXlsx(pack) {
  if (!pack?.ok) {
    throw new Error('Invalid business intelligence pack');
  }

  const wb = XLSX.utils.book_new();
  const s = pack.sales || {};
  const inv = pack.inventory || {};
  const pred = pack.predictive || {};
  const proc = pack.procurement || {};

  const summaryRows = [
    ['Zarewa Business Intelligence'],
    ['Period', pack.periodLabel || pack.periodKey],
    ['As of', pack.asOfISO],
    ['Branch scope', pack.branchScope],
    ['Generated', pack.generatedAtISO],
    ['Engine', pack.engineRev],
    [],
    ['KPI', 'Value'],
    ['Produced sales (₦)', s.producedRevenueNgn || 0],
    ['Collected receipts (₦)', s.collectedNgn || 0],
    ['Quoted (₦)', s.quotedNgn || 0],
    ['Outstanding receivables (₦)', s.outstandingReceivablesNgn || 0],
    ['Cleared cash (₦)', pred.clearedCashNgn || 0],
    ['Est. gross margin %', pred.grossMarginPct ?? ''],
    ['Total coil kg', inv.totalCoilKg || 0],
    ['Expenses (period ₦)', pack.expenseAnalysis?.periodTotalNgn || 0],
    ['30d production forecast ₦', pack.productionForecast?.horizons?.find((h) => h.days === 30)?.projectedProducedRevenueNgn || 0],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

  const prodFc = pack.productionForecast;
  if (prodFc) {
    const pfRows = [
      ['Horizon', 'Projected revenue ₦', 'Projected metres'],
      ...(prodFc.horizons || []).map((h) => [h.days, h.projectedProducedRevenueNgn, h.projectedMetres]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pfRows), 'Production forecast');
  }

  const exp = pack.expenseAnalysis;
  if (exp) {
    const expRows = [
      ['Category', 'Amount ₦', 'Share %'],
      ...(exp.topCategories || []).map((c) => [c.category, c.amountNgn, c.sharePct]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expRows), 'Expenses');
    const expTrend = [
      ['Month', 'Amount ₦'],
      ...(exp.monthlyTrend || []).map((m) => [m.key, m.amountNgn]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expTrend), 'Expense trend');
  }

  const invFc = pack.inventoryForecast;
  if (invFc?.familyForecasts?.length) {
    const invFcRows = [
      ['Family', 'Kg on hand', 'Daily kg', 'Suggested order kg', 'Stockout date'],
      ...invFc.familyForecasts.map((f) => [
        f.label,
        f.kgOnHand,
        f.dailyConsumptionKg,
        f.suggestedOrderKg,
        f.projectedStockoutISO || '',
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(invFcRows), 'Inventory forecast');
  }

  const customerRows = [
    ['Rank', 'Customer', 'Net collected ₦', 'Payments ₦', 'Refunds ₦', 'Receipts'],
    ...(s.topCustomers || []).map((c, i) => [
      i + 1,
      c.customerName,
      c.netCollectedNgn ?? 0,
      c.paymentsNgn ?? 0,
      c.refundsNgn ?? 0,
      c.receiptCount ?? 0,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(customerRows), 'Top customers');

  const materialSheet = (famKey, label) => {
    const perf = s.materialPerformance?.[famKey];
    const rows = [
      ['Gauge', 'Colour', 'Profile', 'Revenue ₦', 'COGS ₦', 'Margin ₦', 'Margin %', 'Metres', 'Kg'],
      ...(perf?.topCombinations || []).map((r) => [
        r.gauge,
        r.colour,
        r.profile,
        r.revenueNgn,
        r.cogsNgn ?? '',
        r.marginNgn ?? '',
        r.marginPct ?? '',
        r.metres,
        r.weightKg,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), label);
  };
  materialSheet('aluminium', 'Material Alu');
  materialSheet('aluzinc', 'Material Aluzinc');

  const skuSheet = (famKey, suffix) => {
    const sku = inv.skuIntelligence?.[famKey];
    const buy = [
      ['Action', 'Gauge', 'Colour', 'Kg on hand', 'Valuation ₦', 'Weeks cover', 'Reason'],
      ...(sku?.buyNext || []).map((r) => [
        'Buy',
        r.gauge,
        r.colour,
        r.kgOnHand,
        r.valuationNgn,
        r.weeksCover ?? '',
        r.reason,
      ]),
    ];
    const liq = [
      ['Action', 'Gauge', 'Colour', 'Kg on hand', 'Valuation ₦', 'Reason'],
      ...(sku?.reduceStock || []).map((r) => [
        'Liquidate',
        r.gauge,
        r.colour,
        r.kgOnHand,
        r.valuationNgn,
        r.reason,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buy), `Buy ${suffix}`);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(liq), `Liquidate ${suffix}`);
  };
  skuSheet('aluminium', 'Alu');
  skuSheet('aluzinc', 'Aluzinc');

  const supplierRows = [
    ['Supplier', 'Spend ₦ (4mo)', 'Open PO ₦', 'Coil kg on order', 'PO count'],
    ...(proc.supplierFocus || []).map((r) => [
      r.supplierName,
      r.spendNgn,
      r.openNgn,
      r.coilKgOrdered,
      r.poCount,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(supplierRows), 'Suppliers');

  const branches = pack.branchBreakdown?.byBranch || [];
  if (branches.length > 1) {
    const branchRows = [
      [
        'Branch',
        'Produced sales ₦',
        'Net collected ₦',
        'Payments ₦',
        'Refunds ₦',
        'Coil kg',
        'Coil value ₦',
        'Top material',
        'Buy SKUs',
        'Liquidate SKUs',
      ],
      ...branches.map((b) => [
        b.branchId,
        b.producedRevenueNgn,
        b.netCollectedNgn,
        b.paymentsNgn,
        b.refundsNgn,
        b.coilKgOnHand,
        b.coilValuationNgn,
        b.topMaterialLabel,
        b.buySkuCount,
        b.liquidateSkuCount,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(branchRows), 'Branches');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
