/**
 * Customer complaint enums and display labels.
 * SQL/create/update stay in `server/customerComplaintsOps.js`.
 * Frontend copies via `npm run sync:shared` → src/shared/customerComplaints.js
 */

export const COMPLAINT_CHANNELS = Object.freeze(['phone', 'whatsapp', 'in_person', 'email', 'delivery']);
export const COMPLAINT_CATEGORIES = Object.freeze([
  'product_quality',
  'delivery_delay',
  'billing_dispute',
  'service',
  'other',
]);
export const COMPLAINT_SEVERITIES = Object.freeze(['low', 'high', 'urgent']);
export const COMPLAINT_STATUSES = Object.freeze([
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'closed',
]);

export const COMPLAINT_OPEN_STATUSES = Object.freeze(['open', 'acknowledged', 'in_progress']);

export const COMPLAINT_CHANNEL_LABELS = Object.freeze({
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  in_person: 'In person',
  email: 'Email',
  delivery: 'Delivery',
});

export const COMPLAINT_CATEGORY_LABELS = Object.freeze({
  product_quality: 'Product quality',
  delivery_delay: 'Delivery delay',
  billing_dispute: 'Billing dispute',
  service: 'Service',
  other: 'Other',
});

export const COMPLAINT_SEVERITY_LABELS = Object.freeze({
  low: 'Low',
  high: 'High',
  urgent: 'Urgent',
});

export const COMPLAINT_STATUS_LABELS = Object.freeze({
  open: 'Open',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
});

/**
 * @param {Record<string, string>} map
 * @param {string} value
 */
export function complaintLabel(map, value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return map[key] || String(value || '').replace(/_/g, ' ') || '—';
}
