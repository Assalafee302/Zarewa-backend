import { userHasPermission } from './auth.js';

/** Customer, quote, receipt, cutting-list domain */
export const SALES_DOMAIN_PERMS = [
  'sales.view',
  'sales.manage',
  'customers.manage',
  'quotations.manage',
  'receipts.post',
];

/** Suppliers, PO catalog, transport */
export const PROCUREMENT_DOMAIN_PERMS = [
  'procurement.view',
  'procurement.manage',
  'purchase_orders.manage',
  'suppliers.manage',
];

/** Stock, production, deliveries, coil yard (operational) */
export const OPERATIONS_DOMAIN_PERMS = [
  'operations.view',
  'operations.manage',
  'production.manage',
  'inventory.receive',
  'inventory.adjust',
  'deliveries.manage',
];

export const FINANCE_DOMAIN_PERMS = [
  'finance.view',
  'finance.post',
  'finance.pay',
  'finance.approve',
  'finance.reverse',
  'treasury.manage',
];

/** Cash/bank account pickers on receipts, advances, refunds — not full treasury history */
export const TREASURY_ACCOUNTS_VISIBLE_PERMS = [
  ...FINANCE_DOMAIN_PERMS,
  'receipts.post',
  'refunds.request',
];

/** Ledger & advance-in (customer money) */
export const LEDGER_RELATED_PERMS = [
  ...FINANCE_DOMAIN_PERMS,
  'receipts.post',
  'refunds.request',
  'refunds.approve',
];

export const REFUNDS_VISIBLE_PERMS = [
  'refunds.request',
  'refunds.approve',
  ...FINANCE_DOMAIN_PERMS,
  'manager.dashboard',
];

export const PAYMENT_REQUESTS_VISIBLE_PERMS = [...FINANCE_DOMAIN_PERMS, 'manager.dashboard'];

export const COIL_REQUESTS_VISIBLE_PERMS = [...OPERATIONS_DOMAIN_PERMS, 'manager.dashboard'];

/** Customer profile + receivables summary (sales CRM + finance AR) */
export const CUSTOMER_AND_AR_READ_PERMS = [...SALES_DOMAIN_PERMS, ...FINANCE_DOMAIN_PERMS];

/** Master data / setup rows used by sales, procurement, or ops UIs */
export const MASTER_DATA_PERMS = [
  'settings.view',
  'audit.view',
  'period.manage',
  ...SALES_DOMAIN_PERMS,
  ...PROCUREMENT_DOMAIN_PERMS,
  ...OPERATIONS_DOMAIN_PERMS,
];

/** Product SKU list — inventory and pricing context */
export const PRODUCTS_CATALOG_PERMS = [
  ...MASTER_DATA_PERMS,
  ...FINANCE_DOMAIN_PERMS,
  'manager.dashboard',
];

export function canAnyPermission(user, perms) {
  if (!user) return false;
  return userHasPermission(user, '*') || perms.some((p) => userHasPermission(user, p));
}

export function canReadSalesDomain(user) {
  return canAnyPermission(user, SALES_DOMAIN_PERMS);
}

export function canReadProcurementDomain(user) {
  return canAnyPermission(user, PROCUREMENT_DOMAIN_PERMS);
}

export function canReadOperationsDomain(user) {
  return canAnyPermission(user, OPERATIONS_DOMAIN_PERMS);
}

export function canReadFinanceDomain(user) {
  return canAnyPermission(user, FINANCE_DOMAIN_PERMS);
}

export function canListTreasuryAccounts(user) {
  return canAnyPermission(user, TREASURY_ACCOUNTS_VISIBLE_PERMS);
}

export function canReadLedgerRelated(user) {
  return canAnyPermission(user, LEDGER_RELATED_PERMS);
}

export function canSeeRefundsList(user) {
  return canAnyPermission(user, REFUNDS_VISIBLE_PERMS);
}

export function canSeePaymentRequests(user) {
  return canAnyPermission(user, PAYMENT_REQUESTS_VISIBLE_PERMS);
}

export function canSeeCoilRequests(user) {
  return canAnyPermission(user, COIL_REQUESTS_VISIBLE_PERMS);
}

export function canReadMasterData(user) {
  return canAnyPermission(user, MASTER_DATA_PERMS);
}

export function canReadProductsCatalog(user) {
  return canAnyPermission(user, PRODUCTS_CATALOG_PERMS);
}

/** Production / WIP panels (manager + ops + cutting owners) */
export function canReadProductionSnapshot(user) {
  return (
    canAnyPermission(user, OPERATIONS_DOMAIN_PERMS) ||
    userHasPermission(user, 'manager.dashboard') ||
    userHasPermission(user, 'sales.manage')
  );
}

/** Coil lots & stock movements — receiving, production, or sales management */
export function canReadCoilAndMovements(user) {
  return (
    canAnyPermission(user, OPERATIONS_DOMAIN_PERMS) ||
    canAnyPermission(user, PROCUREMENT_DOMAIN_PERMS) ||
    userHasPermission(user, 'sales.manage')
  );
}

/** Yard register — sales floor + ops + procurement */
export function canReadYardRegister(user) {
  return canReadSalesDomain(user) || canReadProcurementDomain(user) || canReadOperationsDomain(user);
}

export const EMPTY_MASTER_DATA = {
  quoteItems: [],
  colours: [],
  gauges: [],
  materialTypes: [],
  profiles: [],
  priceList: [],
  expenseCategories: [],
};
