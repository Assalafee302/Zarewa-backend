import { describe, expect, it, vi } from 'vitest';

vi.mock('../controlOps.js', () => ({
  insertPaymentRequest: (_db, payload) => {
    if (!payload?.lineItems?.length) return { ok: false, error: 'lines required' };
    return { ok: true, requestID: 'PR-FUEL-1' };
  },
}));

vi.mock('../humanId.js', () => ({
  nextMachineFuelLogHumanId: () => 'MFL-1',
}));

vi.mock('../ap2ReceivedBasisOps.js', () => ({
  hasColumn: (_db, _table, col) => col === 'maintenance_machine_id' || col === 'maintenance_cost_kind',
}));

import { createMachineFuelRequest, listMachineFuelLogs } from './machineFuelOps.js';

function makeDb({ machine, logs = [] } = {}) {
  const fuelLogs = [...logs];
  const stamped = [];
  return {
    fuelLogs,
    stamped,
    prepare(sql) {
      const s = String(sql);
      return {
        get: () => {
          if (s.includes('FROM machines WHERE id')) return machine || null;
          return null;
        },
        all: () => {
          if (s.includes('FROM machine_fuel_logs')) return fuelLogs;
          return [];
        },
        run: (...args) => {
          if (s.includes('INSERT INTO machine_fuel_logs')) {
            fuelLogs.push({
              id: args[0],
              machine_id: args[1],
              branch_id: args[2],
              fuel_kind: args[3],
              litres: args[4],
              amount_ngn: args[5],
              payment_request_id: args[6],
              payee_name: args[7],
              note: args[8],
              posted_at_iso: args[9],
              created_at_iso: args[10],
            });
            return { changes: 1 };
          }
          if (s.includes('UPDATE payment_requests')) {
            stamped.push({ machineId: args[0], kind: args[1], requestId: args[2] });
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    },
  };
}

const GEN = {
  id: 'MACH-GEN',
  branch_id: 'BR-KD',
  name: 'Standby generator',
  machine_code: 'GEN-1',
  machine_type: 'generator',
  status: 'active',
};

describe('createMachineFuelRequest', () => {
  it('rejects corrugation and empty litres', () => {
    const mill = makeDb({
      machine: { ...GEN, id: 'MACH-CL', machine_type: 'corrugation', name: 'Line 1' },
    });
    expect(createMachineFuelRequest(mill, { machineId: 'MACH-CL', litres: 40, amountNgn: 80_000 }, { id: 'USR-1' }).ok).toBe(
      false
    );
    const gen = makeDb({ machine: GEN });
    expect(createMachineFuelRequest(gen, { machineId: 'MACH-GEN', litres: 0, amountNgn: 80_000 }, { id: 'USR-1' }).ok).toBe(
      false
    );
  });

  it('creates a payment request and a diesel log on the generator', () => {
    const db = makeDb({ machine: GEN });
    const r = createMachineFuelRequest(
      db,
      { machineId: 'MACH-GEN', litres: 200, amountNgn: 180_000, payeeName: 'NNPC depot', fuelKind: 'diesel' },
      { id: 'USR-STORE' }
    );
    expect(r).toMatchObject({ ok: true, requestID: 'PR-FUEL-1', logId: 'MFL-1', machineId: 'MACH-GEN' });
    expect(db.fuelLogs).toHaveLength(1);
    expect(db.fuelLogs[0].litres).toBe(200);
    expect(db.stamped[0]).toEqual({ machineId: 'MACH-GEN', kind: 'fuel', requestId: 'PR-FUEL-1' });
  });

  it('lists fuel logs for the machine file', () => {
    const db = makeDb({
      machine: GEN,
      logs: [
        {
          id: 'MFL-1',
          machine_id: 'MACH-GEN',
          branch_id: 'BR-KD',
          fuel_kind: 'diesel',
          litres: 80,
          amount_ngn: 70_000,
          posted_at_iso: '2026-08-20T10:00:00.000Z',
          created_at_iso: '2026-08-20T10:00:00.000Z',
          machine_name: 'Standby generator',
        },
      ],
    });
    expect(listMachineFuelLogs(db, 'MACH-GEN')[0]).toMatchObject({
      litres: 80,
      amountNgn: 70_000,
      machineName: 'Standby generator',
    });
  });
});
