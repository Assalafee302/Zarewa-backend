/**
 * Maintenance vendor + technician specialty constants.
 * Frontend copies via `npm run sync:shared` → src/shared/maintenanceRegistry.js
 */

export const MAINTENANCE_SPECIALTIES = Object.freeze([
  'electrical',
  'mechanical',
  'hydraulics',
  'generator',
  'general',
]);

export const MAINTENANCE_SPECIALTY_LABELS = Object.freeze({
  electrical: 'Electrical',
  mechanical: 'Mechanical',
  hydraulics: 'Hydraulics',
  generator: 'Generator',
  general: 'General',
});

/** Designations that seed is_technician=1 on migrate. */
export const TECHNICIAN_SEED_DESIGNATION_IDS = Object.freeze([
  'desig_mtech',
  'desig_amtech',
  'desig_msup',
]);

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMaintenanceSpecialty(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (MAINTENANCE_SPECIALTIES.includes(s)) return s;
  return 'general';
}

export const MACHINE_TYPES = Object.freeze([
  'corrugation',
  'roll_former',
  'slitter',
  'cut_to_length',
  'generator',
  'crane',
  'compressor',
  'other',
]);

export const MACHINE_TYPE_LABELS = Object.freeze({
  corrugation: 'Corrugation line',
  roll_former: 'Roll former',
  slitter: 'Slitter',
  cut_to_length: 'Cut-to-length',
  generator: 'Generator',
  crane: 'Crane',
  compressor: 'Compressor',
  other: 'Other',
});

export const MACHINE_STATUSES = Object.freeze(['active', 'under_maintenance', 'decommissioned']);

export const MACHINE_STATUS_LABELS = Object.freeze({
  active: 'Running',
  under_maintenance: 'Under repair',
  decommissioned: 'Decommissioned',
});

/** Roles that may create/edit maintenance vendors. */
export function userMayEditMaintenanceVendors(roleKey) {
  const rk = String(roleKey || '')
    .trim()
    .toLowerCase();
  return rk === 'sales_manager' || rk === 'branch_manager' || rk === 'md' || rk === 'admin' || rk === 'ceo';
}

/** BM (`sales_manager`) and above may register plant machines. Operations and store report faults only. */
export function userMayEditMachines(roleKey) {
  const rk = String(roleKey || '')
    .trim()
    .toLowerCase();
  return (
    rk === 'sales_manager' ||
    rk === 'branch_manager' ||
    rk === 'md' ||
    rk === 'admin' ||
    rk === 'ceo'
  );
}

/** Ops / BM / exec may list vendors (ops read-only in UI). */
export function userMayViewMaintenanceVendors(roleKey, permissions = []) {
  if (userMayEditMaintenanceVendors(roleKey)) return true;
  const rk = String(roleKey || '')
    .trim()
    .toLowerCase();
  if (rk === 'operations_officer' || rk === 'ceo' || rk === 'chairman') return true;
  const perms = Array.isArray(permissions) ? permissions : [];
  return perms.includes('operations.view') || perms.includes('operations.manage') || perms.includes('*');
}
