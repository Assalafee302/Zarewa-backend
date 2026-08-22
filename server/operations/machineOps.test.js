import { describe, expect, it } from 'vitest';
import { buildMachineDossierNextActions } from './machineOps.js';

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
