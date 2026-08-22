import { describe, expect, it } from 'vitest';
import {
  normalizeMaintenanceSpecialty,
  userMayEditMachines,
  userMayEditMaintenanceVendors,
  userMayViewMaintenanceVendors,
  TECHNICIAN_SEED_DESIGNATION_IDS,
} from './maintenanceRegistry.js';

describe('maintenanceRegistry', () => {
  it('normalizes specialty', () => {
    expect(normalizeMaintenanceSpecialty('Hydraulics')).toBe('hydraulics');
    expect(normalizeMaintenanceSpecialty('')).toBe('general');
  });

  it('gates vendor edit to BM / MD / admin', () => {
    expect(userMayEditMaintenanceVendors('sales_manager')).toBe(true);
    expect(userMayEditMaintenanceVendors('branch_manager')).toBe(true);
    expect(userMayEditMaintenanceVendors('md')).toBe(true);
    expect(userMayEditMaintenanceVendors('admin')).toBe(true);
    expect(userMayEditMaintenanceVendors('ceo')).toBe(true);
    expect(userMayEditMaintenanceVendors('operations_officer')).toBe(false);
    expect(userMayEditMaintenanceVendors('chairman')).toBe(false);
  });

  it('allows ops to view vendors', () => {
    expect(userMayViewMaintenanceVendors('operations_officer')).toBe(true);
    expect(userMayViewMaintenanceVendors('viewer', [])).toBe(false);
    expect(userMayViewMaintenanceVendors('viewer', ['operations.view'])).toBe(true);
  });

  it('keeps technician seed designation ids', () => {
    expect(TECHNICIAN_SEED_DESIGNATION_IDS).toContain('desig_mtech');
  });

  it('lets BM and above register machines, not operations', () => {
    expect(userMayEditMachines('operations_officer')).toBe(false);
    expect(userMayEditMachines('sales_manager')).toBe(true);
    expect(userMayEditMachines('branch_manager')).toBe(true);
    expect(userMayEditMachines('md')).toBe(true);
    expect(userMayEditMachines('storekeeper')).toBe(false);
  });
});
