import { describe, expect, it } from 'vitest';
import {
  createMaintenanceCostLine,
  listOpenMaintenanceIssues,
} from './maintenanceWorkOrderOps.js';

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
