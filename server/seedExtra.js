/** Extended seed rows (Node-safe). Stock levels from REFERENCE_STOCK_CALIBRATION. */

import { LAGACY_CUTTING_LIST_SEED } from './lagacyCuttingListSeed.js';

export const SUPPLIERS_SEED = [
  {
    supplierID: 'SUP-001',
    name: 'Alumaco Global',
    city: 'Kano',
    paymentTerms: 'Credit',
    qualityScore: 92,
    notes: 'Primary northern coil source — competitive on heavy gauges.',
  },
  {
    supplierID: 'SUP-002',
    name: 'Tower Aluminum',
    city: 'Lagos',
    paymentTerms: 'Advance',
    qualityScore: 88,
    notes: 'South-west logistics; strong on thin aluzinc.',
  },
  {
    supplierID: 'SUP-003',
    name: 'MetalMark West Africa',
    city: 'Abuja',
    paymentTerms: 'Credit',
    qualityScore: 85,
    notes: 'FCA Abuja — useful for mixed routes.',
  },
];

export const TRANSPORT_AGENTS_SEED = [
  { id: 'AG-001', name: 'Kano Haulage Co.', region: 'Kano / North', phone: '0801 000 0001' },
  { id: 'AG-002', name: 'Lagos Freight Ltd.', region: 'Lagos / South-West', phone: '0802 000 0002' },
  { id: 'AG-003', name: 'Abuja Linehaul', region: 'Abuja / Central', phone: '0803 000 0003' },
];

const longspanThinQty = 80060;
const aluzinc028Kg = 12792;
const heavyCoilKg = 9157;
const tappingScrewCartons = 142;

export const PRODUCTS_SEED = [
  {
    productID: 'COIL-ALU',
    name: 'Aluminium coil (kg)',
    stockLevel: heavyCoilKg,
    unit: 'kg',
    lowStockThreshold: 10000,
    reorderQty: 20000,
    dashboardAttrs: {
      gauge: 'Per PO / coil',
      colour: 'Per PO / coil (HMB, GB, TB, …)',
      materialType: 'Aluminium',
    },
  },
  {
    productID: 'PRD-102',
    name: 'Aluzinc (PPGI) coil (kg)',
    stockLevel: aluzinc028Kg,
    unit: 'kg',
    lowStockThreshold: 15000,
    reorderQty: 20000,
    dashboardAttrs: {
      gauge: 'Per PO / coil',
      colour: 'Per PO / coil',
      materialType: 'Aluzinc (PPGI)',
    },
  },
  {
    productID: 'PRD-201',
    name: 'Tapping screws (carton)',
    stockLevel: tappingScrewCartons,
    unit: 'box',
    lowStockThreshold: 200,
    reorderQty: 500,
    dashboardAttrs: { gauge: '—', colour: '—', materialType: 'Accessory (fasteners)' },
  },
  {
    productID: 'FG-101',
    name: 'Longspan thin (0.18–0.24mm, IV·GB·HMB·TB) — opening ≈ yard register',
    stockLevel: longspanThinQty,
    unit: 'm',
    lowStockThreshold: 70000,
    reorderQty: 100000,
    dashboardAttrs: {
      gauge: '0.18–0.24',
      colour: 'IV · GB · HMB · TB · PR',
      materialType: 'Longspan (finished)',
    },
  },
];

export const PURCHASE_ORDERS_SEED = [
  {
    po: {
      poID: 'PO-2026-001',
      supplierID: 'SUP-001',
      supplierName: 'Alumaco Global',
      orderDateISO: '2026-03-27',
      expectedDeliveryISO: '2026-04-02',
      status: 'In Transit',
      invoiceNo: 'INV-AG-8821',
      invoiceDateISO: '2026-03-28',
      deliveryDateISO: '',
      transportAgentId: 'AG-001',
      transportAgentName: 'Kano Haulage Co.',
      transportPaid: true,
      transportPaidAtISO: '2026-03-28T10:00:00',
      supplierPaidNgn: 5_000_000,
    },
    lines: [
      {
        lineKey: 'L0-COIL-ALU',
        productID: 'COIL-ALU',
        productName: 'Aluminium coil (kg)',
        color: 'IV',
        gauge: '0.24',
        metersOffered: 1208,
        conversionKgPerM: 2.65,
        unitPricePerKgNgn: 1850,
        qtyOrdered: 4000,
        unitPriceNgn: 1850,
        qtyReceived: 0,
      },
    ],
  },
  {
    po: {
      poID: 'PO-2026-002',
      supplierID: 'SUP-002',
      supplierName: 'Tower Aluminum',
      orderDateISO: '2026-03-26',
      expectedDeliveryISO: '2026-03-29',
      status: 'On loading',
      invoiceNo: '',
      invoiceDateISO: '',
      deliveryDateISO: '',
      transportAgentId: 'AG-002',
      transportAgentName: 'Lagos Freight Ltd.',
      transportPaid: false,
      transportPaidAtISO: '',
      supplierPaidNgn: 2_000_000,
    },
    lines: [
      {
        lineKey: 'L0-PRD-102',
        productID: 'PRD-102',
        productName: 'Aluzinc (PPGI) coil (kg)',
        color: 'GB',
        gauge: '0.28',
        metersOffered: 1550,
        conversionKgPerM: 2.65,
        unitPricePerKgNgn: 2100,
        qtyOrdered: 2500,
        unitPriceNgn: 2100,
        qtyReceived: 0,
      },
    ],
  },
  {
    po: {
      poID: 'PO-2026-003',
      supplierID: 'SUP-003',
      supplierName: 'MetalMark West Africa',
      orderDateISO: '2026-03-22',
      expectedDeliveryISO: '2026-03-28',
      status: 'Approved',
      invoiceNo: 'INV-MM-2201',
      invoiceDateISO: '2026-03-23',
      deliveryDateISO: '',
      transportAgentId: '',
      transportAgentName: '',
      transportPaid: false,
      transportPaidAtISO: '',
      supplierPaidNgn: 1_000_000,
    },
    lines: [
      {
        lineKey: 'L0-MM-102',
        productID: 'PRD-102',
        productName: 'Aluzinc (PPGI) coil (kg)',
        color: 'TB',
        gauge: '0.28',
        metersOffered: 800,
        conversionKgPerM: 2.65,
        unitPricePerKgNgn: 2050,
        qtyOrdered: 1800,
        unitPriceNgn: 2050,
        qtyReceived: 0,
      },
    ],
  },
];

export const DELIVERIES_SEED = [
  {
    id: 'DN-2026-008',
    quotationRef: 'QT-2026-001',
    customer: 'Alhaji Musa',
    destination: 'Kano — Site B (Zaria Rd)',
    method: 'Company truck',
    status: 'In transit',
    trackingNo: 'ZW-TRK-8821',
    shipDate: '29 Mar 2026',
    eta: '30 Mar 2026',
  },
  {
    id: 'DN-2026-007',
    quotationRef: 'QT-2026-002',
    customer: 'Grace Emmanuel',
    destination: 'Jos — Liberty Quarters',
    method: 'Third-party haulage',
    status: 'Scheduled',
    trackingNo: '—',
    shipDate: '31 Mar 2026',
    eta: '2 Apr 2026',
  },
  {
    id: 'DN-2026-004',
    quotationRef: 'QT-2026-000',
    customer: 'Zaidu Roofing Ltd',
    destination: 'Sokoto — Central depot',
    method: 'Customer pickup',
    status: 'Delivered',
    trackingNo: 'PICKUP-ZW-04',
    shipDate: '22 Mar 2026',
    eta: '22 Mar 2026',
  },
];

export const SALES_RECEIPTS_SEED = [
  {
    id: 'RC-2026-014',
    customerID: 'CUS-001',
    customer: 'Alhaji Musa',
    quotationRef: 'QT-2026-001',
    date: '28 Mar',
    dateISO: '2026-03-28',
    amount: '₦400,000',
    amountNgn: 400000,
    method: 'Bank Transfer',
    status: 'Posted',
    handledBy: 'Cashier — Hauwa',
  },
  {
    id: 'RC-2026-1849',
    customerID: 'CUS-NDA',
    customer: 'NDA',
    quotationRef: 'QT-2026-027',
    date: '11 Aug',
    dateISO: '2026-08-11',
    amount: '₦31,202,000',
    amountNgn: 31202000,
    method: 'TAJ Bank',
    status: 'Posted',
    handledBy: 'Cashier — Hauwa',
  },
  {
    id: 'RC-2026-013',
    customerID: 'CUS-002',
    customer: 'Grace Emmanuel',
    quotationRef: 'QT-2026-002',
    date: '27 Mar',
    dateISO: '2026-03-27',
    amount: '₦200,000',
    amountNgn: 200000,
    method: 'POS',
    status: 'Posted',
    handledBy: 'Cashier — Hauwa',
  },
  {
    id: 'RC-2026-012',
    customerID: 'CUS-004',
    customer: 'Zaidu Roofing Ltd',
    quotationRef: 'QT-2026-003',
    date: '25 Mar',
    dateISO: '2026-03-25',
    amount: '₦2,100,000',
    amountNgn: 2100000,
    method: 'Bank Transfer',
    status: 'Posted',
    handledBy: 'Cashier — Hauwa',
  },
  {
    id: 'RC-2026-010',
    customerID: 'CUS-001',
    customer: 'Alhaji Musa',
    quotationRef: 'QT-2026-005',
    date: '16 Mar',
    dateISO: '2026-03-16',
    amount: '₦320,000',
    amountNgn: 320000,
    method: 'Cash',
    status: 'Posted',
    handledBy: 'Cashier — Musa',
  },
  {
    id: 'RC-2026-008',
    customerID: 'CUS-002',
    customer: 'Grace Emmanuel',
    quotationRef: 'QT-2026-007',
    date: '11 Mar',
    dateISO: '2026-03-11',
    amount: '₦410,000',
    amountNgn: 410000,
    method: 'Bank Transfer',
    status: 'Posted',
    handledBy: 'Cashier — Hauwa',
  },
];

/** Empty so new cutting lists can be created against seeded quotations in tests and fresh DBs. */
export const CUTTING_LISTS_SEED = [LAGACY_CUTTING_LIST_SEED];

export const REFUNDS_SEED = [
  {
    refundID: 'RF-2026-001',
    customerID: 'CUS-001',
    customer: 'Alhaji Musa',
    quotationRef: 'QT-2026-001',
    cuttingListRef: 'CL-2026-005',
    product: 'Longspan roofing 0.45mm HM Blue',
    reasonCategory: 'Short supply (quoted vs cutting list)',
    reason: 'Short supply (quoted vs cutting list) — Quoted 500m; cutting list 450.5m',
    amountNgn: 75000,
    calculationLines: [
      { label: 'Metres not supplied (49.5m @ blended rate)', amountNgn: 62000 },
      { label: 'Transport allocation reversal', amountNgn: 13000 },
    ],
    calculationNotes: 'Quote assumed 500m roofline; cutting list total 450.5m after site measure.',
    status: 'Pending',
    approvalDate: '',
    managerComments: '',
    requestedBy: 'Auwal Idris',
    requestedAtISO: '2026-03-28T09:15:00.000Z',
    approvedBy: '',
    paidAtISO: '',
    paidBy: '',
  },
  {
    refundID: 'RF-2026-002',
    customerID: 'CUS-002',
    customer: 'Grace Emmanuel',
    quotationRef: 'QT-2026-002',
    cuttingListRef: '',
    product: 'Accessory pack (screws, silicone)',
    reasonCategory: 'Short supply (quoted vs cutting list)',
    reason: 'Short supply (quoted vs cutting list) — Partial delivery vs quote',
    amountNgn: 45000,
    calculationLines: [{ label: 'Undelivered accessories (per quote line)', amountNgn: 45000 }],
    calculationNotes: '',
    status: 'Approved',
    approvalDate: '2026-03-27',
    managerComments: 'Approved — pay customer; document GRN short on next stock take.',
    requestedBy: 'Mary Okafor',
    requestedAtISO: '2026-03-26T14:00:00.000Z',
    approvedBy: 'Sales Manager (demo)',
    paidAtISO: '',
    paidBy: '',
  },
];

export const TREASURY_SEED = [
  { id: 1, name: 'GTBank Main', bankName: 'Guaranty Trust Bank', balance: 14250000, type: 'Bank', accNo: '0123456789' },
  { id: 2, name: 'Zenith Production', bankName: 'Zenith Bank', balance: 5200000, type: 'Bank', accNo: '9876543210' },
  { id: 3, name: 'Cash Office (Till)', bankName: '', balance: 450000, type: 'Cash', accNo: 'N/A' },
];

export const EXPENSES_SEED = [
  {
    expenseID: 'EXP-2026-014',
    expenseType: 'Materials',
    amountNgn: 185000,
    date: '2026-03-26',
    category: 'COGS — consumables & supplies',
    paymentMethod: 'Bank Transfer',
    reference: 'INV-TXN-8821',
  },
  {
    expenseID: 'EXP-2026-013',
    expenseType: 'Utilities',
    amountNgn: 92000,
    date: '2026-03-25',
    category: 'Operational — rent & utilities',
    paymentMethod: 'Cash',
    reference: 'RCPT-441',
  },
];

export const PAYMENT_REQUESTS_SEED = [
  {
    requestID: 'PREQ-2026-003',
    expenseID: 'EXP-2026-014',
    amountRequestedNgn: 185000,
    requestDate: '2026-03-27',
    approvalStatus: 'Pending',
    description: 'Pay supplier invoice for consumables',
  },
  {
    requestID: 'PREQ-2026-002',
    expenseID: 'EXP-2026-013',
    amountRequestedNgn: 92000,
    requestDate: '2026-03-26',
    approvalStatus: 'Approved',
    description: 'Utilities settlement',
  },
];

export const ACCOUNTS_PAYABLE_SEED = [
  {
    apID: 'AP-2026-004',
    supplierName: 'Alumaco Global',
    poRef: 'PO-2026-001',
    invoiceRef: 'INV-AG-8821',
    amountNgn: 14_500_000,
    paidNgn: 5_000_000,
    dueDateISO: '2026-04-05',
  },
  {
    apID: 'AP-2026-003',
    supplierName: 'Tower Aluminum',
    poRef: 'PO-2026-002',
    invoiceRef: 'INV-TA-4410',
    amountNgn: 8_800_000,
    paidNgn: 8_800_000,
    dueDateISO: '2026-03-20',
  },
  {
    apID: 'AP-2026-002',
    supplierName: 'MetalMark West Africa',
    poRef: 'PO-2026-003',
    invoiceRef: 'INV-MM-2201',
    amountNgn: 3_250_000,
    paidNgn: 1_000_000,
    dueDateISO: '2026-03-25',
  },
];

export const BANK_RECONCILIATION_SEED = [
  {
    id: 'BR-001',
    bankDateISO: '2026-03-27',
    description: 'NIP / ZAREWA ROOFING — QT collections',
    amountNgn: 2_450_000,
    systemMatch: 'Batch receipts (Sales)',
    status: 'Matched',
  },
  {
    id: 'BR-002',
    bankDateISO: '2026-03-27',
    description: 'POS SETTLEMENT — GTB',
    amountNgn: 890_000,
    systemMatch: 'RC-2026-013',
    status: 'Matched',
  },
  {
    id: 'BR-003',
    bankDateISO: '2026-03-28',
    description: 'UBA NIP INFLOW — UNIDENTIFIED PAYER',
    amountNgn: 312_500,
    systemMatch: '',
    status: 'Review',
  },
  {
    id: 'BR-004',
    bankDateISO: '2026-03-28',
    description: 'CHARGES — GTB ACCOUNT MAINTENANCE',
    amountNgn: -2_750,
    systemMatch: '',
    status: 'Review',
  },
];

export const PROCUREMENT_CATALOG_SEED = [
  { id: 'CAT-001', color: 'IV', gauge: '0.24', productID: 'COIL-ALU', offerKg: 3200, offerMeters: 1208, conversionKgPerM: 2.65, label: 'IV 0.24 — aluminium' },
  { id: 'CAT-002', color: 'GB', gauge: '0.28', productID: 'PRD-102', offerKg: 4100, offerMeters: 1550, conversionKgPerM: 2.65, label: 'GB 0.28 — aluzinc' },
  { id: 'CAT-003', color: 'HMB', gauge: '0.22', productID: 'COIL-ALU', offerKg: 2800, offerMeters: 1186, conversionKgPerM: 2.36, label: 'HMB 0.22 — aluminium' },
  { id: 'CAT-004', color: 'TB', gauge: '0.30', productID: 'COIL-ALU', offerKg: 3600, offerMeters: 1200, conversionKgPerM: 3.0, label: 'TB 0.30 — aluminium' },
];

export const YARD_COILS_SEED = [
  { id: 'COIL-1882', colour: 'HMB', gaugeLabel: '0.24', materialType: 'Aluzinc longspan', weightKg: 3279, loc: 'Bay A' },
  { id: 'COIL-1908', colour: 'TB', gaugeLabel: '0.24', materialType: 'Aluzinc longspan', weightKg: 3428, loc: 'Bay A' },
  { id: 'COIL-1878', colour: 'GB', gaugeLabel: '0.55', materialType: 'Aluzinc longspan', weightKg: 732, loc: 'Bay B' },
  { id: 'COIL-1912', colour: 'IV', gaugeLabel: '0.20', materialType: 'Aluzinc longspan', weightKg: 2890, loc: 'Bay A' },
];

export const AVAILABLE_STOCK_SEED = [
  { id: 'COIL-1882', material: 'HM Blue', gauge: '0.24', color: 'Blue', weight: '3,279kg' },
  { id: 'COIL-1908', material: 'Traffic Black', gauge: '0.24', color: 'Black', weight: '3,428kg' },
  { id: 'COIL-1878', material: 'HM Blue', gauge: '0.55', color: 'Blue', weight: '732kg' },
];

/** CRM dashboard demo payload (stored in app_json_blobs). */
export const CUSTOMER_DASHBOARD_SEED = {
  orders: [
    {
      id: 'ORD-2026-018',
      customerID: 'CUS-001',
      date: '27 Mar 2026',
      dateISO: '2026-03-27',
      lines: [
        { product: 'Longspan 0.45mm HM Blue', qty: 180, unit: 'm' },
        { product: 'Ridge caps & screws kit', qty: 2, unit: 'set' },
      ],
      totalNgn: 890000,
      status: 'Shipped',
      quotationRef: 'QT-2026-001',
    },
    {
      id: 'ORD-2026-012',
      customerID: 'CUS-001',
      date: '16 Mar 2026',
      dateISO: '2026-03-16',
      lines: [{ product: 'Accessories & silicone', qty: 40, unit: 'unit' }],
      totalNgn: 320000,
      status: 'Delivered',
      quotationRef: 'QT-2026-005',
    },
    {
      id: 'ORD-2026-009',
      customerID: 'CUS-002',
      date: '26 Mar 2026',
      dateISO: '2026-03-26',
      lines: [{ product: 'Traffic Black longspan 0.24mm', qty: 95, unit: 'm' }],
      totalNgn: 650000,
      status: 'Pending',
      quotationRef: 'QT-2026-002',
    },
  ],
  interactions: [
    {
      id: 'INT-101',
      customerID: 'CUS-001',
      kind: 'call',
      title: 'Follow-up on partial payment',
      detail: 'Customer confirmed bank transfer for ₦400k; balance before dispatch.',
      dateISO: '2026-03-28T09:30:00',
    },
    {
      id: 'INT-102',
      customerID: 'CUS-001',
      kind: 'email',
      title: 'Quotation QT-2026-001 sent',
      detail: 'PDF sent to musa.roofing@example.com with Net 30 terms.',
      dateISO: '2026-03-27T14:00:00',
    },
    {
      id: 'INT-103',
      customerID: 'CUS-002',
      kind: 'meeting',
      title: 'Site visit — Jos Liberty',
      detail: 'Measured roof; agreed on Traffic Black gauge.',
      dateISO: '2026-03-25T11:00:00',
    },
  ],
  salesTrendByCustomer: {
    'CUS-001': [
      { month: 'Oct', amountNgn: 1_100_000 },
      { month: 'Mar', amountNgn: 2_650_000 },
    ],
    'CUS-002': [
      { month: 'Oct', amountNgn: 220_000 },
      { month: 'Mar', amountNgn: 890_000 },
    ],
  },
};
