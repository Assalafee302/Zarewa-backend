import { describe, expect, it, vi } from 'vitest';

vi.mock('../maintenanceVendorsOps.js', () => ({
  seedTechniciansFromDesignations: () => ({ updated: 0 }),
  updateStaffTechnicianFlags: () => ({ ok: true }),
}));

import { ensurePlantRegisterDemo } from './plantRegisterSeed.js';

function makeDb({ branches = ['BR-KD', 'BR-AB'], machines = [], vendors = 0 } = {}) {
  const machineRows = [...machines];
  let vendorCount = vendors;
  return {
    machineRows,
    prepare(sql) {
      const s = String(sql);
      return {
        all: () => {
          if (s.includes('FROM branches')) return branches.map((id) => ({ id }));
          return [];
        },
        get: (...args) => {
          if (s.includes('FROM machines WHERE branch_id')) {
            const branchId = args[0];
            return { c: machineRows.filter((m) => m.branch_id === branchId).length };
          }
          if (s.includes('FROM maintenance_vendors')) return { c: vendorCount };
          if (s.includes('FROM hr_staff_profiles')) return { c: 1 };
          if (s.includes('FROM app_users')) return null;
          return { c: 0 };
        },
        run: (...args) => {
          if (s.includes('INSERT OR IGNORE INTO machines')) {
            machineRows.push({ id: args[0], branch_id: args[2] });
            return { changes: 1 };
          }
          if (s.includes('INSERT OR IGNORE INTO maintenance_vendors')) {
            vendorCount += 1;
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    },
  };
}

describe('ensurePlantRegisterDemo', () => {
  it('seeds machines only on branches that have none', () => {
    const db = makeDb({
      machines: [{ branch_id: 'BR-KD' }],
      vendors: 1,
    });
    const created = ensurePlantRegisterDemo(db);
    expect(created).toBe(3);
    expect(db.machineRows.filter((m) => m.branch_id === 'BR-AB')).toHaveLength(3);
    expect(db.machineRows.filter((m) => m.branch_id === 'BR-KD')).toHaveLength(1);
  });

  it('does not overwrite a live plant register', () => {
    const db = makeDb({
      branches: ['BR-KD'],
      machines: [{ branch_id: 'BR-KD' }, { branch_id: 'BR-KD' }],
      vendors: 1,
    });
    expect(ensurePlantRegisterDemo(db)).toBe(0);
    expect(db.machineRows).toHaveLength(2);
  });
});
