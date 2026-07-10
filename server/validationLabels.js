/** Map API field names to human-readable labels for validation messages. */

const FIELD_LABELS = {
  customerID: 'Customer',
  customerId: 'Customer',
  userId: 'User',
  userID: 'User',
  query: 'Search query',
  branchId: 'Branch',
  branchID: 'Branch',
  quotationID: 'Quotation',
  quotationId: 'Quotation',
  poID: 'Purchase order',
  poId: 'Purchase order',
  amount: 'Amount',
  remark: 'Remark',
  reason: 'Reason',
  startDate: 'Start date',
  endDate: 'End date',
};

/**
 * @param {string} field
 * @returns {string}
 */
export function humanizeFieldName(field) {
  const key = String(field || '').trim();
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/ID$/i, '')
    .trim();
  if (!spaced) return 'This field';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * @param {string} rawMessage e.g. "customerID is required"
 * @returns {string}
 */
export function humanizeValidationMessage(rawMessage) {
  const msg = String(rawMessage || '').trim();
  const requiredMatch = /^(\w+)\s+is\s+required\.?$/i.exec(msg);
  if (requiredMatch) {
    return `${humanizeFieldName(requiredMatch[1])} is required.`;
  }
  const missingMatch = /^(\w+)\s+is\s+missing\.?$/i.exec(msg);
  if (missingMatch) {
    return `${humanizeFieldName(missingMatch[1])} is required.`;
  }
  return msg;
}
