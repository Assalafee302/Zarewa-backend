/**
 * Headline figures of the four Kaduna Sep 2026 reports, from report inputs ("fx" = { purchase, material, sales,
 * expenses } shaped like the kd-2026-09 fixtures / the live loaders). Shared by the Phase 2 dry run (fixtures)
 * and scripts/phase2-report-headlines.mjs (a database), so before/after figures are computed the same way.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const FE = path.resolve(BE, '../Zarewa-frontend-main');
const imp = (p) => import(pathToFileURL(p).href);

const { buildPurchaseReport } = await imp(path.join(BE, 'shared/lib/purchaseReportCore.js'));
const { buildCoilRegister } = await imp(path.join(BE, 'shared/lib/coilRegisterCore.js'));
const { buildSalesReport } = await imp(path.join(FE, 'src/lib/salesReportCore.js'));
const { buildExpensesReport } = await imp(path.join(FE, 'src/lib/expensesReportCore.js'));

export function headlines(fx, { withSales = true } = {}) {
  const pr = buildPurchaseReport(fx.purchase);
  const cr = buildCoilRegister(fx.material);
  const er = buildExpensesReport(fx.expenses);
  const h = {
    'Purchase: coil value at receipt': pr.aluminium.totals.totalValueNgn + pr.aluzinc.totals.totalValueNgn,
    'Purchase: aluminium kg received': pr.aluminium.totals.totalReceived,
    'Purchase: aluzinc kg received': pr.aluzinc.totals.totalReceived,
    'Purchase: supplier outstanding 30 Sep': pr.payments.totals.supplierOutstandingAtEndNgn,
    'Purchase: paid, not yet received': pr.paidNotReceived.totalGapNgn,
    'Material: coils 31 Aug': cr.stock.opening.totals.coilCount,
    'Material: kg 31 Aug': cr.stock.opening.totals.kgGross,
    'Material: gross value 31 Aug': cr.stock.opening.totals.valueGrossNgn,
    'Material: spool kg 31 Aug': cr.stock.opening.totals.spoolKg,
    'Material: net value 31 Aug': cr.stock.opening.totals.valueNetNgn,
    'Material: coils 30 Sep (ERP)': cr.stock.closing.totals.coilCount,
    'Material: kg 30 Sep (ERP)': cr.stock.closing.totals.kgGross,
    'Material: gross value 30 Sep (ERP)': cr.stock.closing.totals.valueGrossNgn,
    'Material: spool kg 30 Sep (ERP)': cr.stock.closing.totals.spoolKg,
    'Material: net value 30 Sep (ERP)': cr.stock.closing.totals.valueNetNgn,
    'Material: Sep coil consumption kg': cr.consumption.totals.kg,
    'Material: coils with ERP cost ≠ amount paid ÷ kg': cr.exceptions.costVsPurchase.length,
    'Expenses: ERP total': er.totals.amountNgn,
    'Expenses: book expense total': er.bookExpenseTotalNgn,
    'Expenses: lines to reclassify (R1–R6)': er.warningCount,
  };
  for (const c of er.bookByCategory) h[`Expenses: book ${c.category}`] = c.amountNgn;
  if (withSales) {
    const sr = buildSalesReport({ ...fx.sales, accrualTreasuryMovements: fx.sales.accrualTreasuryMovements || fx.sales.treasuryMovements });
    Object.assign(h, {
      'Sales: cash received': sr.cashReceived.totalNgn,
      'Sales: recognised sales': sr.recognised.totalNgn,
      'Sales: produced in period (group)': sr.recognised.producedNgn,
      'Sales: not produced in period (group)': sr.recognised.notProducedNgn,
      'Sales: reconciliation unexplained': sr.reconciliation.unexplainedNgn,
      'Sales: accrual goods produced': sr.accrual.producedNgn,
      'Sales: debts 30 Sep': sr.accrual.balances.closing.debtsNgn,
      'Sales: advances 30 Sep': sr.accrual.balances.closing.advancesNgn,
      'Sales: accrual bridge difference': sr.accrual.bridge.differenceNgn,
      'Sales: account-check lines': sr.paymentLineMismatchCount,
    });
  }
  return h;
}
