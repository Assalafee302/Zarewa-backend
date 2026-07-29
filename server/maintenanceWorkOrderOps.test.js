import { describe, expect, it, vi } from 'vitest';
import {
  assignMaintenanceWorkOrder,
  createMaintenanceCostLine,
  getMaintenanceWorkOrder,
  listOpenMaintenanceIssues,
} from './maintenanceWorkOrderOps.js';

vi.mock('./workItems.js', () => ({
  appendMaintenanceEvent: () => ({ ok: true, eventId: 'EV-1' }),
  listMaintenanceWorkOrders: () => [],
}));

vi.mock('./maintenanceVendorsOps.js', () => ({
  getMaintenanceVendor: () => ({ id: 'MVN-1', name: 'FixCo', status: 'active' }),
}));

describe('maintenanceWorkOrderOps cost-line gate', () => {
  it('rejects cost lines without source_id (message contract)', () => {
    const db = {
      prepare(sql) {
        return {
          get: () => {
            if (String(sql).includes('FROM maintenance_work_orders')) {
              return {
                id: 'MWO-1',
                reference_no: 'MWO-1',
                branch_id: 'BR-KD',
                machine_id: 'MAC-1',
                status: 'open',
                priority: 'high',
                kind: 'corrective',
                summary: 'Fault',
                opened_at_iso: new Date().toISOString(),
                downtime_hours: 0,
                data_json: null,
              };
            }
            return null;
          },
          run: () => {},
          all: () => [],
        };
      },
    };
    const missing = createMaintenanceCostLine(db, 'MWO-1', { amountNgn: 1000, costKind: 'vendor' }, {
      id: 'USR-BM',
    });
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toMatch(/sourceKind|sourceId/i);

    const badSource = createMaintenanceCostLine(
      db,
      'MWO-1',
      { amountNgn: 1000, costKind: 'vendor', sourceKind: 'payment_request', sourceId: 'PR-MISSING' },
      { id: 'USR-BM' }
    );
    expect(badSource.ok).toBe(false);
    expect(String(badSource.error)).toMatch(/not found/i);
  });
});

describe('listOpenMaintenanceIssues', () => {
  it('maps machine display fields for PAC Issues rows', () => {
    const db = {
      prepare() {
        return {
          all: () => [
            {
              id: 'MWO-1',
              reference_no: 'MWO-1',
              branch_id: 'BR-KD',
              machine_id: 'MAC-1',
              status: 'open',
              priority: 'machine_down',
              kind: 'corrective',
              summary: 'Down',
              symptom: 'No power',
              opened_at_iso: '2026-07-29T09:00:00.000Z',
              downtime_hours: 0,
              data_json: null,
              machine_name: 'Roll former',
              machine_code: 'RF-1',
            },
          ],
        };
      },
    };
    const issues = listOpenMaintenanceIssues(db, { branchId: 'BR-KD' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'MWO-1',
      machineName: 'Roll former',
      machineCode: 'RF-1',
      priority: 'machine_down',
      openedAtIso: '2026-07-29T09:00:00.000Z',
    });
  });
});

describe('getMaintenanceWorkOrder / assign', () => {
  it('keeps machineName on get-by-id', () => {
    const db = {
      prepare(sql) {
        expect(String(sql)).toMatch(/LEFT JOIN machines/i);
        return {
          get: () => ({
            id: 'MWO-1',
            reference_no: 'MWO-1',
            branch_id: 'BR-KD',
            machine_id: 'MAC-1',
            status: 'open',
            priority: 'high',
            kind: 'corrective',
            summary: 'Fault',
            opened_at_iso: '2026-07-29T09:00:00.000Z',
            downtime_hours: 0,
            data_json: null,
            machine_name: 'Roll former',
            machine_code: 'RF-1',
          }),
        };
      },
    };
    expect(getMaintenanceWorkOrder(db, 'MWO-1')).toMatchObject({
      id: 'MWO-1',
      machineName: 'Roll former',
      machineCode: 'RF-1',
    });
  });

  it('advances status to assigned when technician is set', () => {
    const runs = [];
    const db = {
      prepare(sql) {
        const s = String(sql);
        return {
          get: () => ({
            id: 'MWO-1',
            reference_no: 'MWO-1',
            branch_id: 'BR-KD',
            machine_id: 'MAC-1',
            status: 'assigned',
            priority: 'high',
            kind: 'corrective',
            summary: 'Fault',
            opened_at_iso: '2026-07-29T09:00:00.000Z',
            downtime_hours: 0,
            data_json: null,
            machine_name: 'Roll former',
            machine_code: 'RF-1',
            assigned_to_user_id: 'USR-TECH',
          }),
          run: (...args) => {
            runs.push({ sql: s, args });
          },
        };
      },
    };
    const r = assignMaintenanceWorkOrder(db, 'MWO-1', { assignedToUserId: 'USR-TECH' }, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /status = CASE/i.test(x.sql))).toBe(true);
    expect(r.workOrder?.status).toBe('assigned');
  });
});
