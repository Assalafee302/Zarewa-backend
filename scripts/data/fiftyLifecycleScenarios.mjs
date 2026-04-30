/**
 * 50 deterministic “live-style” scenarios for end-to-end API stress / UAT.
 * Each row drives one full run: procurement → customer → quote → pay → cutting → production → finance.
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
];

/** @typedef {'single' | 'dual' | 'extreme'} CoilMode */

/** @param {number} n 0..49 */
export function buildScenario(n) {
  const slug = `S${String(n).padStart(2, '0')}`;
  /** @type {CoilMode} */
  let coilMode = 'single';
  if (n % 7 === 0) coilMode = 'dual';
  else if (n % 11 === 0 || n % 13 === 0) coilMode = 'extreme';

  const sheets = 2 + (n % 6);
  const lengthM = 4 + (n % 10) * 0.5;
  let payFraction = n % 5 === 0 ? 0.55 : n % 9 === 0 ? 0.8 : 1;
  const doRefund = n % 8 === 0;
  if (doRefund) payFraction = 1;
  const doRefundRejectOnly = n % 23 === 0 && !doRefund;
  if (doRefundRejectOnly) payFraction = 1;
  const poSupplierPay = n % 6 === 0;
  const day = 1 + (n % 27);
  /** Multiple rows on the cutting list (different lengths, same total meters when possible). */
  const multiLengthCut = n % 3 === 0;
  /** Drive conversion-preview alerts: normal OK, high/low trigger manager review. */
  let conversionStress = 'normal';
  if (n % 17 === 0) conversionStress = 'high';
  else if (n % 19 === 0) conversionStress = 'low';
  /** Partial pay: post a customer advance first, then receipt for the remainder (same quotation). */
  const advanceThenReceipt = payFraction < 1 && n % 6 === 2;
  const includeAccessories = n % 4 === 0;
  const coilRequestFlow = n % 5 === 0;

  return {
    index: n,
    slug,
    label: `ST50 ${slug}: ${CUSTOMERS[n % CUSTOMERS.length]} — ${PROJECTS[n % PROJECTS.length]}`,
    customerName: `${CUSTOMERS[n % CUSTOMERS.length]} (${slug})`,
    city: CITIES[n % CITIES.length],
    project: `${PROJECTS[n % PROJECTS.length]} — ${slug}`,
    dateISO: `2026-04-${String(day).padStart(2, '0')}`,
    sheets,
    lengthM,
    unitPrice: 4500 + (n % 8) * 250,
    coilMode,
    payFraction,
    doRefund,
    doRefundRejectOnly,
    poSupplierPay,
    supplierLabel: `ST50 ${slug} Steel & Coils`,
    multiLengthCut,
    conversionStress,
    advanceThenReceipt,
    includeAccessories,
    coilRequestFlow,
  };
}

export const FIFTY_LIFECYCLE_SCENARIO_COUNT = 50;

export function allScenarios() {
  return Array.from({ length: FIFTY_LIFECYCLE_SCENARIO_COUNT }, (_, i) => buildScenario(i));
}
