/**
 * Maintenance vendor + technician specialty constants (keep frontend mirror in sync).
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
