/**
 * Full dump of operational records entered in the workspace (not period-filtered).
 * HR payroll, passwords, and binary attachments are excluded.
 */
import XLSX from 'xlsx';
import {
  listBankReconciliation,
  listCoilLots,
  listCustomers,
  listCuttingLists,
  listDeliveries,
  listExpenses,
  listLedgerEntries,
  listPaymentRequests,
  listProductionJobs,
  listProducts,
  listPurchaseOrders,
  listQuotations,
  listRefunds,
  listSalesReceipts,
  listStockMovements,
  listSuppliers,
  listTransportAgents,
  listTreasuryAccounts,
  listTreasuryMovements,
} from './readModel.js';

const UNLIMITED = { unlimited: true };
const PO_OPTS = { unlimited: true, skipSideEffects: true };

function cell(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function pick(row, keys) {
  const out = {};
  for (const key of keys) out[key] = cell(row?.[key]);
  return out;
}

function safeList(label, fn) {
  try {
    const rows = fn();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error(`[entered-data-export] ${label}`, e);
    return [];
  }
}

function flattenCustomers(rows) {
  return rows.map((r) =>
    pick(r, [
      'customerID',
      'name',
      'phoneNumber',
      'email',
      'companyName',
      'status',
      'tier',
      'paymentTerms',
      'addressShipping',
      'addressBilling',
      'leadSource',
      'preferredContact',
      'followUpISO',
      'crmTags',
      'crmProfileNotes',
      'createdBy',
      'createdAtISO',
      'lastActivityISO',
      'branchId',
      'staffDisplayName',
      'staffEmployeeNo',
    ])
  );
}

function flattenQuotations(rows) {
  return rows.map((r) => {
    const lines = r.quotationLines || {};
    const lineCount =
      (lines.products?.length || 0) + (lines.accessories?.length || 0) + (lines.services?.length || 0);
    return {
      ...pick(r, [
        'id',
        'customerID',
        'customer',
        'dateISO',
        'dueDateISO',
        'totalNgn',
        'paidNgn',
        'paymentStatus',
        'status',
        'projectName',
        'handledBy',
        'materialGauge',
        'materialColor',
        'materialDesign',
        'materialTypeId',
        'stoneMeterQuote',
        'branchId',
        'archived',
        'lifecycleNote',
      ]),
      lineCount,
    };
  });
}

function flattenQuotationLines(quotations) {
  const out = [];
  for (const q of quotations) {
    const groups = q.quotationLines || {};
    for (const category of ['products', 'accessories', 'services']) {
      for (const line of groups[category] || []) {
        out.push({
          quotationId: cell(q.id),
          customer: cell(q.customer),
          dateISO: cell(q.dateISO),
          category,
          name: cell(line.name),
          qty: cell(line.qty),
          unitPrice: cell(line.unitPrice),
        });
      }
    }
  }
  return out;
}

function flattenReceipts(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'customerID',
      'customer',
      'quotationRef',
      'dateISO',
      'amountNgn',
      'method',
      'status',
      'handledBy',
      'ledgerEntryId',
      'bankConfirmedAtISO',
      'bankReceivedAmountNgn',
      'financeDeliveryClearedAtISO',
    ])
  );
}

function flattenDeliveries(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'quotationRef',
      'customerID',
      'customer',
      'cuttingListId',
      'destination',
      'method',
      'status',
      'trackingNo',
      'shipDate',
      'eta',
      'deliveredDateISO',
      'courierConfirmed',
      'customerSignedPod',
      'fulfillmentPosted',
      'lineCount',
      'totalQty',
    ])
  );
}

function flattenDeliveryLines(deliveries) {
  const out = [];
  for (const d of deliveries) {
    for (const line of d.lines || []) {
      out.push({
        deliveryId: cell(d.id),
        quotationRef: cell(d.quotationRef),
        customer: cell(d.customer),
        lineNo: cell(line.lineNo),
        productID: cell(line.productID),
        productName: cell(line.productName),
        qty: cell(line.qty),
        unit: cell(line.unit),
      });
    }
  }
  return out;
}

function flattenRefunds(rows) {
  return rows.map((r) =>
    pick(r, [
      'refundID',
      'customerID',
      'customer',
      'quotationRef',
      'cuttingListRef',
      'product',
      'reasonCategory',
      'reason',
      'amountNgn',
      'status',
      'requestedBy',
      'requestedAtISO',
      'approvedBy',
      'approvedAmountNgn',
      'paidAmountNgn',
      'paidAtISO',
      'paidBy',
      'payeeName',
      'payeeBankName',
      'creditAppliedNgn',
      'branchId',
    ])
  );
}

function flattenCuttingLists(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'customerID',
      'customer',
      'quotationRef',
      'productID',
      'productName',
      'dateISO',
      'sheetsToCut',
      'totalMeters',
      'status',
      'machineName',
      'operatorName',
      'productionRegistered',
      'handledBy',
      'branchId',
    ])
  );
}

function flattenCuttingListLines(lists) {
  const out = [];
  for (const cl of lists) {
    for (const line of cl.lines || []) {
      out.push({
        cuttingListId: cell(cl.id),
        quotationRef: cell(cl.quotationRef),
        customer: cell(cl.customer),
        lineNo: cell(line.lineNo),
        lineType: cell(line.lineType),
        sheets: cell(line.sheets),
        lengthM: cell(line.lengthM),
        totalM: cell(line.totalM),
      });
    }
  }
  return out;
}

function flattenProductionJobs(rows) {
  return rows.map((r) =>
    pick(r, [
      'jobID',
      'cuttingListId',
      'quotationRef',
      'customerID',
      'customerName',
      'productID',
      'productName',
      'plannedMeters',
      'actualMeters',
      'effectiveOutputMeters',
      'actualWeightKg',
      'status',
      'machineName',
      'operatorName',
      'startDateISO',
      'endDateISO',
      'productionDateISO',
      'completedAtISO',
      'createdAtISO',
      'branchId',
    ])
  );
}

function flattenPurchaseOrders(rows) {
  return rows.map((r) => ({
    ...pick(r, [
      'poID',
      'supplierID',
      'supplierName',
      'orderDateISO',
      'expectedDeliveryISO',
      'status',
      'invoiceNo',
      'invoiceDateISO',
      'deliveryDateISO',
      'procurementKind',
      'supplierPaidNgn',
      'transportAgentName',
      'transportAmountNgn',
      'transportPaidNgn',
    ]),
    lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
  }));
}

function flattenPoLines(pos) {
  const out = [];
  for (const po of pos) {
    for (const line of po.lines || []) {
      out.push({
        poID: cell(po.poID),
        supplierName: cell(po.supplierName),
        orderDateISO: cell(po.orderDateISO),
        lineKey: cell(line.lineKey),
        lineType: cell(line.lineType),
        productID: cell(line.productID),
        productName: cell(line.productName),
        color: cell(line.color),
        gauge: cell(line.gauge),
        qtyOrdered: cell(line.qtyOrdered),
        qtyReceived: cell(line.qtyReceived),
        unitPriceNgn: cell(line.unitPriceNgn),
        unitPricePerKgNgn: cell(line.unitPricePerKgNgn),
        metersOffered: cell(line.metersOffered),
      });
    }
  }
  return out;
}

function flattenProducts(rows) {
  return rows.map((r) => ({
    productID: cell(r.productID),
    name: cell(r.name),
    stockLevel: cell(r.stockLevel),
    unit: cell(r.unit),
    lowStockThreshold: cell(r.lowStockThreshold),
    reorderQty: cell(r.reorderQty),
    gauge: cell(r.dashboardAttrs?.gauge),
    colour: cell(r.dashboardAttrs?.colour),
    materialType: cell(r.dashboardAttrs?.materialType),
    branchId: cell(r.branchId),
  }));
}

function flattenCoilLots(rows) {
  return rows.map((r) =>
    pick(r, [
      'coilNo',
      'productID',
      'colour',
      'gaugeLabel',
      'materialTypeName',
      'weightKg',
      'qtyReceived',
      'qtyRemaining',
      'qtyReserved',
      'currentWeightKg',
      'currentStatus',
      'stockForm',
      'supplierName',
      'poID',
      'receivedAtISO',
      'landedCostNgn',
      'unitCostNgnPerKg',
      'branchId',
    ])
  );
}

function flattenStockMovements(rows) {
  return rows.map((r) =>
    pick(r, ['id', 'dateISO', 'atISO', 'type', 'ref', 'productID', 'qty', 'detail', 'unitPriceNgn', 'valueNgn', 'branchId'])
  );
}

function flattenExpenses(rows) {
  return rows.map((r) =>
    pick(r, ['expenseID', 'date', 'category', 'expenseType', 'amountNgn', 'paymentMethod', 'reference', 'branchId'])
  );
}

function flattenPaymentRequests(rows) {
  return rows.map((r) =>
    pick(r, [
      'requestID',
      'expenseID',
      'requestDate',
      'amountRequestedNgn',
      'approvalStatus',
      'description',
      'approvedBy',
      'approvedAtISO',
      'paidAmountNgn',
      'paidAtISO',
      'paidBy',
      'expenseCategory',
      'requestReference',
      'staffDisplayName',
      'branchId',
    ])
  );
}

function flattenLedger(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'atISO',
      'type',
      'customerID',
      'customerName',
      'amountNgn',
      'quotationRef',
      'paymentMethod',
      'bankReference',
      'purpose',
      'createdByName',
      'note',
      'branchId',
    ])
  );
}

function flattenTreasuryAccounts(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'name',
      'bankName',
      'type',
      'accNo',
      'balance',
      'openingBalanceNgn',
      'accountOfficerName',
      'bankBranch',
      'branchId',
    ])
  );
}

function flattenTreasuryMovements(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'postedAtISO',
      'type',
      'treasuryAccountId',
      'accountName',
      'accountNo',
      'amountNgn',
      'reference',
      'counterpartyKind',
      'counterpartyName',
      'sourceKind',
      'sourceId',
      'note',
      'createdBy',
    ])
  );
}

function flattenBankRecon(rows) {
  return rows.map((r) =>
    pick(r, [
      'id',
      'bankDateISO',
      'description',
      'amountNgn',
      'status',
      'systemMatch',
      'settledAmountNgn',
      'varianceNgn',
      'treasuryAccountId',
      'branchId',
    ])
  );
}

function flattenSuppliers(rows) {
  return rows.map((r) =>
    pick(r, ['supplierID', 'name', 'city', 'paymentTerms', 'qualityScore', 'notes'])
  );
}

function flattenTransportAgents(rows) {
  return rows.map((r) => pick(r, ['id', 'name', 'region', 'phone']));
}

/**
 * Load every entered operational record for the branch scope.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope]
 */
export function collectEnteredDataPack(db, branchScope = 'ALL') {
  const customers = safeList('customers', () => listCustomers(db, branchScope, UNLIMITED));
  const quotations = safeList('quotations', () => listQuotations(db, branchScope, UNLIMITED));
  const receipts = safeList('receipts', () => listSalesReceipts(db, branchScope, UNLIMITED));
  const deliveries = safeList('deliveries', () => listDeliveries(db, branchScope, UNLIMITED));
  const refunds = safeList('refunds', () => listRefunds(db, branchScope, UNLIMITED));
  const cuttingLists = safeList('cuttingLists', () => listCuttingLists(db, branchScope, UNLIMITED));
  const productionJobs = safeList('productionJobs', () => listProductionJobs(db, branchScope, UNLIMITED));
  const purchaseOrders = safeList('purchaseOrders', () => listPurchaseOrders(db, branchScope, PO_OPTS));
  const products = safeList('products', () => listProducts(db, branchScope));
  const coilLots = safeList('coilLots', () => listCoilLots(db, branchScope));
  const stockMovements = safeList('stockMovements', () => listStockMovements(db, branchScope, UNLIMITED));
  const expenses = safeList('expenses', () => listExpenses(db, branchScope, UNLIMITED));
  const paymentRequests = safeList('paymentRequests', () => listPaymentRequests(db, branchScope, UNLIMITED));
  const ledger = safeList('ledger', () => listLedgerEntries(db, branchScope));
  const treasuryAccounts = safeList('treasuryAccounts', () => listTreasuryAccounts(db, branchScope));
  const treasuryMovements = safeList('treasuryMovements', () => listTreasuryMovements(db, branchScope, UNLIMITED));
  const bankRecon = safeList('bankRecon', () => listBankReconciliation(db, branchScope));
  const suppliers = safeList('suppliers', () => listSuppliers(db));
  const transportAgents = safeList('transportAgents', () => listTransportAgents(db));

  const sheets = [
    { name: 'Customers', rows: flattenCustomers(customers) },
    { name: 'Quotations', rows: flattenQuotations(quotations) },
    { name: 'Quotation_lines', rows: flattenQuotationLines(quotations) },
    { name: 'Receipts', rows: flattenReceipts(receipts) },
    { name: 'Deliveries', rows: flattenDeliveries(deliveries) },
    { name: 'Delivery_lines', rows: flattenDeliveryLines(deliveries) },
    { name: 'Refunds', rows: flattenRefunds(refunds) },
    { name: 'Cutting_lists', rows: flattenCuttingLists(cuttingLists) },
    { name: 'Cutting_list_lines', rows: flattenCuttingListLines(cuttingLists) },
    { name: 'Production_jobs', rows: flattenProductionJobs(productionJobs) },
    { name: 'Purchase_orders', rows: flattenPurchaseOrders(purchaseOrders) },
    { name: 'PO_lines', rows: flattenPoLines(purchaseOrders) },
    { name: 'Products', rows: flattenProducts(products) },
    { name: 'Coil_lots', rows: flattenCoilLots(coilLots) },
    { name: 'Stock_movements', rows: flattenStockMovements(stockMovements) },
    { name: 'Expenses', rows: flattenExpenses(expenses) },
    { name: 'Payment_requests', rows: flattenPaymentRequests(paymentRequests) },
    { name: 'Ledger', rows: flattenLedger(ledger) },
    { name: 'Treasury_accounts', rows: flattenTreasuryAccounts(treasuryAccounts) },
    { name: 'Treasury_movements', rows: flattenTreasuryMovements(treasuryMovements) },
    { name: 'Bank_recon', rows: flattenBankRecon(bankRecon) },
    { name: 'Suppliers', rows: flattenSuppliers(suppliers) },
    { name: 'Transport_agents', rows: flattenTransportAgents(transportAgents) },
  ];

  const totals = Object.fromEntries(sheets.map((s) => [s.name, s.rows.length]));
  const recordCount = sheets.reduce((n, s) => n + s.rows.length, 0);

  return {
    ok: true,
    branchScope: branchScope || 'ALL',
    generatedAtISO: new Date().toISOString(),
    recordCount,
    totals,
    sheets,
  };
}

function appendSheet(wb, name, rows) {
  const sheetName = String(name).slice(0, 31);
  if (!rows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['(no rows)']]), sheetName);
    return;
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
}

/**
 * @param {ReturnType<typeof collectEnteredDataPack>} pack
 * @returns {Buffer}
 */
export function buildEnteredDataXlsx(pack) {
  if (!pack?.ok || !Array.isArray(pack.sheets)) {
    throw new Error('Invalid entered-data pack');
  }
  const wb = XLSX.utils.book_new();
  const summary = [
    ['Zarewa — all entered data'],
    ['Branch scope', pack.branchScope],
    ['Generated', pack.generatedAtISO],
    ['Total rows', pack.recordCount],
    [],
    ['This workbook is every operational record currently stored, not a period report.'],
    ['HR payroll and staff files stay on HR Reports. Passwords and file attachments are not included.'],
    [],
    ['Sheet', 'Rows'],
    ...pack.sheets.map((s) => [s.name, s.rows.length]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  for (const sheet of pack.sheets) {
    appendSheet(wb, sheet.name, sheet.rows);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function enteredDataFilename(branchScope, generatedAtISO = new Date().toISOString()) {
  const scope = String(branchScope || 'ALL')
    .replace(/[^a-z0-9_-]/gi, '')
    .slice(0, 24) || 'ALL';
  const day = String(generatedAtISO).slice(0, 10) || 'export';
  return `zarewa-entered-data-${scope}-${day}.xlsx`;
}

/** Flatten helpers exported for unit tests. */
export const enteredDataFlatten = {
  flattenCustomers,
  flattenQuotations,
  flattenQuotationLines,
  flattenReceipts,
};
