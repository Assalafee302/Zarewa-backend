import { describe, expect, it, vi } from 'vitest';
import { buildMachineDossierNextActions, updateMachine } from './machineOps.js';

vi.mock('../controlOps.js', () => ({
  appendAuditLog: () => {},
}));

vi.mock('../workItems.js', () => ({
  createMachine: () => ({ ok: true }),
  linkMachineAsset: () => ({ ok: true }),
  listMachineLinkableAssets: () => [],
  listMachines: (_db, { branchId }) => [
    { id: 'MACH-1', branchId, name: 'Line 1' },
  ],
}));
vi.mock('../maintenanceInsightsOps.js', () => ({ buildMaintenanceMachineInsights: () => ({}) }));
vi.mock('../maintenanceWorkOrderOps.js', () => ({
  attachWorkOrderFinance: () => ({}),
  listMaintenanceEventsForMachine: () => [],
  listWorkOrdersForMachine: () => [],
}));
vi.mock('./machineFuelOps.js', () => ({ listMachineFuelLogs: () => [] }));
vi.mock('./maintenancePlanOps.js', () => ({ listPlansForMachine: () => [] }));

const MACHINE_ROW = {
  id: 'MACH-1',
  branch_id: 'BR-KD',
  name: 'Line 1',
  machine_type: 'generator',
  status: 'active',
};

function makeMachineDb(row = MACHINE_ROW) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get: () => (s.includes('FROM machines WHERE id') ? row : null),
        run: () => ({ changes: 1 }),
      };
    },
  };
}

describe('buildMachineDossierNextActions', () => {
  it('asks BM to acknowledge and assign an unclaimed open fault', () => {
    const actions = buildMachineDossierNextActions(
      { status: 'under_maintenance' },
      [
        {
          id: 'MWO-1',
          referenceNo: 'MWO-1',
          status: 'open',
          symptom: 'Belt slip',
          estimatedCostNgn: 0,
          envelope: { shopFloorOpen: true, costOpen: true, machineBackOnLine: false },
        },
      ]
    );
    expect(actions.map((a) => a.key)).toEqual(
      expect.arrayContaining(['acknowledge', 'assign', 'estimate', 'return', 'spend'])
    );
  });

  it('returns no job actions when the machine is clear', () => {
    expect(buildMachineDossierNextActions({ status: 'active' }, [])).toEqual([]);
  });

  it('keeps spend actions when status is closed but the money clock is still open', () => {
    const actions = buildMachineDossierNextActions(
      { status: 'active' },
      [
        {
          id: 'MWO-1',
          status: 'closed',
          symptom: 'Belt',
          envelope: { shopFloorOpen: false, costOpen: true, machineBackOnLine: true },
        },
      ]
    );
    expect(actions.map((a) => a.key)).toContain('spend');
  });
});

describe('updateMachine date validation', () => {
  it('rejects a malformed installed date', () => {
    const db = makeMachineDb();
    const r = updateMachine(db, 'MACH-1', { installedAtIso: 'whenever' }, { id: 'USR-BM' });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed commissioned date', () => {
    const db = makeMachineDb();
    const r = updateMachine(db, 'MACH-1', { commissionedAtIso: '31-02-2026' }, { id: 'USR-BM' });
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed installed date', () => {
    const db = makeMachineDb();
    const r = updateMachine(db, 'MACH-1', { installedAtIso: '2026-01-15' }, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
  });
});
