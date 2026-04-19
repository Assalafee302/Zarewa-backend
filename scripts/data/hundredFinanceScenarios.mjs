/**
 * 100 deterministic “live-style” finance scenarios for stress / perf.
 * Each scenario is intended to exercise receipts, advances, refunds, transfers,
 * expenses, payment requests, and payables using realistic-ish variation.
 */
 
const CITIES = [
  'Kano',
  'Kaduna',
  'Jos',
  'Abuja',
  'Lagos',
  'Sokoto',
  'Maiduguri',
  'Zaria',
  'Minna',
  'Ilorin',
  'Aba',
  'Onitsha',
  'Port Harcourt',
  'Enugu',
  'Benin',
];
 
const CUSTOMERS = [
  'Alh. Ibrahim Roofing Ltd',
  'Blessed Heights Developers',
  'Jide Akintola Trading',
  'M & K Sheet Metal Ltd',
  'Auwal Yards Procurement',
  'Sokoto Royal Builders',
  'Kano Industrial Estates',
  'Zaria Longspan Depot',
  'Plateau Roofing Co-op',
  'Kaduna Estates Ventures',
  'Lagos Sheet & Coil Hub',
  'Maiduguri Rebuild Project',
  'Abuja Green Roofs',
  'Minna Civic Contracts',
  'Ilorin Wholesale Roofing',
  'Tal’udu GRA Roofing',
  'BUK Staff Housing Phase II',
  'Kano Sabon Gari Market',
  'Jos Terminus Contractors',
  'Nasarawa Farms Ltd',
  'Aba Industrial Traders',
  'Onitsha Mega Dealers',
  'PH Coastal Warehousing',
  'Enugu BuildRight Ventures',
  'Benin City Roofing Mart',
];
 
const PROJECTS = [
  'Warehouse longspan package',
  'School block Phase A',
  'Estate perimeter shops',
  'Factory roof retrofit',
  'Cold-room annex',
  'Mosque dome & gutters',
  'Hospital ward extension',
  'Shopping plaza canopy',
  'Mini-grid site sheds',
  'Grain store weatherproofing',
  'Market stalls expansion',
  'Truck park roofing',
  'Church hall roofing',
  'Site office container cover',
  'Logistics bay canopy',
];
 
/** Must match `shared/expenseCategories.js` — API rejects free-text categories. */
const EXPENSE_CATS = [
  'Operational — rent & utilities',
  'Maintenance — plant & equipment',
  'Logistics & haulage',
  'Marketing & business development',
  'COGS — consumables & supplies',
  'Other — misc operating',
  'Bank & finance charges',
];
 
/** @param {number} n 0..99 */
export function buildScenario(n) {
  const slug = `F${String(n).padStart(3, '0')}`;
  const day = 1 + (n % 27);
  const dateISO = `2026-04-${String(day).padStart(2, '0')}`;
 
  // Amounts are kept moderate by default; the runner can scale them via env.
  const invoiceNgn = 220_000 + (n % 17) * 25_000 + (n % 7) * 3_500;
  const doAdvance = n % 4 === 0;
  const doRefund = n % 9 === 0;
  const doTransfer = n % 5 === 0;
  const doExpenseAndRequest = n % 2 === 0;
  const doPayable = n % 6 === 0;
 
  // Ensure refund only makes sense when we actually paid (full or near-full).
  const receiptFraction = doRefund ? 1 : n % 10 === 0 ? 0.65 : n % 7 === 0 ? 0.85 : 1;
  const receiptNgn = Math.round(invoiceNgn * receiptFraction);
  const advanceNgn = doAdvance ? Math.max(25_000, Math.round(invoiceNgn * 0.18)) : 0;
  const refundNgn = doRefund ? Math.max(10_000, Math.round(invoiceNgn * 0.12)) : 0;
 
  const expenseNgn = 8_000 + (n % 41) * 350;
 
  return {
    index: n,
    slug,
    label: `FIN100 ${slug}: ${CUSTOMERS[n % CUSTOMERS.length]} — ${PROJECTS[n % PROJECTS.length]}`,
    customerName: `${CUSTOMERS[n % CUSTOMERS.length]} (${slug})`,
    city: CITIES[n % CITIES.length],
    project: `${PROJECTS[n % PROJECTS.length]} — ${slug}`,
    dateISO,
 
    invoiceNgn,
    receiptNgn,
    receiptMethod: n % 3 === 0 ? 'Transfer' : n % 3 === 1 ? 'POS' : 'Cash',
    doAdvance,
    advanceNgn,
    advanceMethod: n % 2 === 0 ? 'Transfer' : 'Cash',
 
    doRefund,
    refundNgn,
 
    doTransfer,
 
    doExpenseAndRequest,
    expenseNgn,
    expenseCategory: EXPENSE_CATS[n % EXPENSE_CATS.length],
 
    doPayable,
    payableNgn: doPayable ? 95_000 + (n % 29) * 2_500 : 0,
  };
}
 
export const FINANCE_SCENARIO_COUNT = 100;
 
export function allFinanceScenarios() {
  return Array.from({ length: FINANCE_SCENARIO_COUNT }, (_, i) => buildScenario(i));
}

