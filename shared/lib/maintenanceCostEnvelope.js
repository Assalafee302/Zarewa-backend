/**
 * Maintenance work-order cost envelope: kinds, estimate vs spent, shop-floor vs money clocks.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/maintenanceCostEnvelope.js
 */

export const MAINTENANCE_COST_KINDS = Object.freeze([
  'parts',
  'labour',
  'feeding',
  'accommodation',
  'transport',
  'contractor',
  'other',
]);

export const MAINTENANCE_COST_KIND_LABELS = Object.freeze({
  parts: 'Spare parts',
  labour: 'Labour',
  feeding: 'Feeding',
  accommodation: 'Accommodation',
  transport: 'Transport',
  contractor: 'Contractor / vendor',
  other: 'Other',
});

export const MAINTENANCE_WO_KINDS = Object.freeze(['corrective', 'preventive', 'overhaul']);

export const MAINTENANCE_WO_KIND_LABELS = Object.freeze({
  corrective: 'Corrective',
  preventive: 'Preventive',
  overhaul: 'Overhaul (project)',
});

export const MAINTENANCE_WO_STATUS_LABELS = Object.freeze({
  open: 'Reported',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  in_progress: 'In progress',
  returned_to_production: 'Back on line · costs open',
  closed: 'Closed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
});

export const MAINTENANCE_PRIORITY_LABELS = Object.freeze({
  low: 'Low — still running',
  normal: 'Normal — still running',
  high: 'High — still running',
  machine_down: 'Machine down — off the line now',
});

export const MAINTENANCE_EVENT_KIND_LABELS = Object.freeze({
  opened: 'Fault reported',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  envelope_updated: 'Estimate updated',
  expense_linked: 'Spend linked',
  returned_to_production: 'Back on the line',
  costs_closed: 'Finances closed',
  closed: 'Job closed',
  note: 'Note',
});

export function maintenanceEventKindLabel(kind) {
  const key = String(kind || '')
    .trim()
    .toLowerCase();
  return MAINTENANCE_EVENT_KIND_LABELS[key] || (key ? key.replace(/_/g, ' ') : 'Event');
}

/**
 * @param {unknown} raw
 * @returns {(typeof MAINTENANCE_COST_KINDS)[number]}
 */
export function normalizeMaintenanceCostKind(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'vendor') return 'contractor';
  if (MAINTENANCE_COST_KINDS.includes(s)) return s;
  return 'other';
}

/** Contractor invoices need a vendor on the work order; feeding/lodging/parts do not. */
export function maintenanceCostKindRequiresVendor(kind) {
  return normalizeMaintenanceCostKind(kind) === 'contractor';
}

/**
 * @param {unknown} raw
 * @returns {(typeof MAINTENANCE_WO_KINDS)[number]}
 */
export function normalizeMaintenanceWorkOrderKind(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (MAINTENANCE_WO_KINDS.includes(s)) return s;
  return 'corrective';
}

/**
 * @param {{
 *   estimatedCostNgn?: unknown,
 *   spentNgn?: unknown,
 *   returnedToProductionAtIso?: unknown,
 *   costClosedAtIso?: unknown,
 *   status?: unknown,
 * }} input
 */
export function buildMaintenanceEnvelope(input = {}) {
  const estimatedNgn = Math.max(0, Math.round(Number(input.estimatedCostNgn) || 0));
  const spentNgn = Math.max(0, Math.round(Number(input.spentNgn) || 0));
  const remainingNgn = estimatedNgn > 0 ? estimatedNgn - spentNgn : null;
  const status = String(input.status || '')
    .trim()
    .toLowerCase();
  const cancelled = status === 'cancelled' || status === 'rejected';
  const returnedToProductionAtIso = String(input.returnedToProductionAtIso || '').trim();
  const costClosedAtIso = String(input.costClosedAtIso || '').trim();
  const shopFloorOpen = !cancelled && !returnedToProductionAtIso;
  const costOpen = !cancelled && !costClosedAtIso;
  return {
    estimatedNgn,
    spentNgn,
    remainingNgn,
    overEnvelope: estimatedNgn > 0 && spentNgn > estimatedNgn,
    shopFloorOpen,
    costOpen,
    machineBackOnLine: Boolean(returnedToProductionAtIso),
    financiallyClosed: Boolean(costClosedAtIso),
  };
}

/**
 * @param {Array<{ costKind?: unknown, cost_kind?: unknown, amountNgn?: unknown, amount_ngn?: unknown }>} lines
 * @returns {Record<string, number>}
 */
export function sumCostLinesByKind(lines) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of MAINTENANCE_COST_KINDS) out[k] = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const k = normalizeMaintenanceCostKind(line?.costKind || line?.cost_kind);
    out[k] = (out[k] || 0) + Math.max(0, Math.round(Number(line?.amountNgn ?? line?.amount_ngn) || 0));
  }
  return out;
}

export function looksLikeMaintenanceWorkOrderRef(raw) {
  return /^MWO[-_]/i.test(String(raw || '').trim());
}

export function maintenanceCostKindLabel(kind) {
  const k = normalizeMaintenanceCostKind(kind);
  return MAINTENANCE_COST_KIND_LABELS[k] || MAINTENANCE_COST_KIND_LABELS.other;
}

/**
 * @param {unknown} priority
 * @param {{ short?: boolean }} [opts]
 */
export function maintenancePriorityLabel(priority, opts = {}) {
  const key = String(priority || 'normal')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (opts.short) {
    if (key === 'machine_down') return 'Machine down';
    if (key === 'high' || key === 'low' || key === 'normal') {
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
  }
  return MAINTENANCE_PRIORITY_LABELS[key] || MAINTENANCE_PRIORITY_LABELS.normal;
}

/**
 * Desk label for a work-order status, using the two clocks when timestamps are present.
 * @param {string|{ status?: unknown, returnedToProductionAtIso?: unknown, costClosedAtIso?: unknown }} input
 */
export function maintenanceWorkOrderStatusLabel(input = {}) {
  if (typeof input === 'string') {
    const status = input.trim().toLowerCase();
    return MAINTENANCE_WO_STATUS_LABELS[status] || (status ? status.replace(/_/g, ' ') : 'Reported');
  }
  const status = String(input?.status || '')
    .trim()
    .toLowerCase();
  const env = buildMaintenanceEnvelope(input);
  if (env.financiallyClosed && env.machineBackOnLine) return 'Closed';
  if (env.machineBackOnLine && env.costOpen) return 'Back on line · costs open';
  if (!env.machineBackOnLine && env.financiallyClosed) return 'Off the line · finances closed';
  return MAINTENANCE_WO_STATUS_LABELS[status] || 'Reported';
}

/**
 * Shop-floor hours off the line. Stored `downtimeHours` wins; otherwise opened → returned/closed/now.
 * @param {{
 *   downtimeHours?: unknown,
 *   openedAtIso?: unknown,
 *   incidentDateIso?: unknown,
 *   returnedToProductionAtIso?: unknown,
 *   closedAtIso?: unknown,
 *   nowMs?: number,
 * }} input
 */
export function maintenanceDowntimeHours(input = {}) {
  const stored = Number(input.downtimeHours);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored * 100) / 100;
  const start = Date.parse(String(input.openedAtIso || input.incidentDateIso || '').trim());
  const endRaw = String(input.returnedToProductionAtIso || input.closedAtIso || '').trim();
  const end = endRaw ? Date.parse(endRaw) : Number(input.nowMs) || Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round(((end - start) / 36e5) * 100) / 100;
}
