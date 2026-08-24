import { describe, expect, it, vi } from 'vitest';
import {
  assignMaintenanceWorkOrder,
  attachWorkOrderFinance,
  closeWorkOrderCosts,
  createMaintenanceCostLine,
  getMaintenanceWorkOrder,
  linkWorkOrderPaymentRequest,
  listMaintenanceEventsForMachine,
  listOpenMaintenanceIssues,
  resolveMaintenanceWorkOrder,
  returnWorkOrderToProduction,
} from './maintenanceWorkOrderOps.js';

vi.mock('./workItems.js', () => ({
  appendMaintenanceEvent: () => ({ ok: true, eventId: 'EV-1' }),
  listMaintenanceWorkOrders: () => [],
}));

vi.mock('./operations/maintenancePlanOps.js', () => ({
  stampPlanServiceFromWorkOrder: () => ({ ok: true, skipped: true }),
}));

vi.mock('./maintenanceVendorsOps.js', () => ({
  getMaintenanceVendor: () => ({ id: 'MVN-1', name: 'FixCo', status: 'active' }),
}));

vi.mock('./humanId.js', () => ({
  nextMaintenanceCostLineHumanId: () => 'MCL-1',
}));

vi.mock('./controlOps.js', () => ({
  appendAuditLog: () => {},
}));

vi.mock('./ap2ReceivedBasisOps.js', () => ({
  hasColumn: () => false,
}));

function woRow(overrides = {}) {
  return {
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
    estimated_cost_ngn: 800000,
    ...overrides,
  };
}

function mockDb(handlers) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get: (...args) => handlers.get?.(s, args) ?? null,
        run: (...args) => handlers.run?.(s, args),
        all: (...args) => handlers.all?.(s, args) ?? [],
      };
    },
  };
}

describe('maintenanceWorkOrderOps cost-line gate', () => {
  it('rejects cost lines without source_id (message contract)', () => {
    const db = mockDb({
      get: (sql) => (sql.includes('FROM maintenance_work_orders') ? woRow() : null),
    });
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

  it('allows feeding cost lines without a vendor when the payment request exists', () => {
    const runs = [];
    const db = mockDb({
      get: (sql) => {
        if (sql.includes('FROM maintenance_work_orders')) return woRow({ vendor_id: null });
        if (sql.includes('FROM payment_requests')) return { request_id: 'PR-1' };
        return null;
      },
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const created = createMaintenanceCostLine(
      db,
      'MWO-1',
      {
        amountNgn: 45000,
        costKind: 'feeding',
        sourceKind: 'payment_request',
        sourceId: 'PR-1',
      },
      { id: 'USR-BM' }
    );
    expect(created.ok).toBe(true);
    expect(runs.some((x) => /INSERT INTO maintenance_cost_lines/i.test(x.sql) && x.args.includes('feeding'))).toBe(
      true
    );
  });
});

describe('listOpenMaintenanceIssues', () => {
  it('maps machine display fields for PAC Issues rows', () => {
    const db = mockDb({
      all: () => [woRow({ priority: 'machine_down', symptom: 'No power' })],
    });
    const issues = listOpenMaintenanceIssues(db, { branchId: 'BR-KD' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'MWO-1',
      machineName: 'Roll former',
      machineCode: 'RF-1',
      priority: 'machine_down',
      openedAtIso: '2026-07-29T09:00:00.000Z',
    });
    expect(issues[0].envelope.shopFloorOpen).toBe(true);
    expect(issues[0].envelope.costOpen).toBe(true);
  });

  it('keeps returned-to-production jobs in the queue while costs are open', () => {
    const db = mockDb({
      all: () => [
        woRow({
          status: 'returned_to_production',
          returned_to_production_at_iso: '2026-08-20T10:00:00.000Z',
          spent_ngn: 120000,
        }),
      ],
    });
    const issues = listOpenMaintenanceIssues(db, { branchId: 'BR-KD' });
    expect(issues).toHaveLength(1);
    expect(issues[0].envelope.shopFloorOpen).toBe(false);
    expect(issues[0].envelope.costOpen).toBe(true);
    expect(issues[0].spentNgn).toBe(120000);
  });

  it('keeps a closed job in the queue while the money clock is still open', () => {
    let seenSql = '';
    const db = mockDb({
      all: (sql) => {
        seenSql = String(sql);
        return [woRow({ status: 'closed', cost_closed_at_iso: null, spent_ngn: 50000 })];
      },
    });
    const issues = listOpenMaintenanceIssues(db, { branchId: 'BR-KD' });
    expect(issues).toHaveLength(1);
    expect(issues[0].envelope.costOpen).toBe(true);
    expect(seenSql).toMatch(/cost_closed_at_iso IS NOT NULL/i);
    expect(seenSql).not.toMatch(/NOT IN \('closed', 'cancelled', 'rejected'\)/i);
  });
});

describe('getMaintenanceWorkOrder / assign', () => {
  it('keeps machineName on get-by-id', () => {
    const db = mockDb({
      get: (sql) => {
        expect(String(sql)).toMatch(/LEFT JOIN machines/i);
        return woRow();
      },
    });
    expect(getMaintenanceWorkOrder(db, 'MWO-1')).toMatchObject({
      id: 'MWO-1',
      machineName: 'Roll former',
      machineCode: 'RF-1',
    });
  });

  it('advances status to assigned when technician is set', () => {
    const runs = [];
    const db = mockDb({
      get: () => woRow({ status: 'assigned', assigned_to_user_id: 'USR-TECH' }),
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = assignMaintenanceWorkOrder(db, 'MWO-1', { assignedToUserId: 'USR-TECH' }, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /status = CASE/i.test(x.sql))).toBe(true);
    expect(r.workOrder?.status).toBe('assigned');
  });
});

describe('envelope and multi-PR', () => {
  it('does not overwrite the first related payment request when linking a second', () => {
    const runs = [];
    const db = mockDb({
      get: (sql) => {
        if (sql.includes('FROM maintenance_work_orders')) {
          return woRow({ related_payment_request_id: 'PR-1', vendor_id: 'MVN-1' });
        }
        if (sql.includes('FROM payment_requests')) {
          return { request_id: 'PR-2', amount_requested_ngn: 12000, paid_amount_ngn: 0 };
        }
        if (sql.includes('FROM maintenance_cost_lines')) return null;
        return null;
      },
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = linkWorkOrderPaymentRequest(db, 'MWO-1', 'PR-2', { id: 'USR-BM' }, { costKind: 'accommodation' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /SET related_payment_request_id/i.test(x.sql))).toBe(false);
    expect(runs.some((x) => /INSERT INTO maintenance_cost_lines/i.test(x.sql) && x.args.includes('accommodation'))).toBe(
      true
    );
  });

  it('builds remaining envelope from cost lines', () => {
    const db = mockDb({
      all: (sql) => {
        if (sql.includes('FROM maintenance_cost_lines')) {
          return [
            { id: 'MCL-1', work_order_id: 'MWO-1', cost_kind: 'parts', amount_ngn: 200000, source_kind: 'expense' },
            { id: 'MCL-2', work_order_id: 'MWO-1', cost_kind: 'feeding', amount_ngn: 112000, source_kind: 'payment_request', source_id: 'PR-9' },
          ];
        }
        return [];
      },
      get: () => null,
    });
    const pack = attachWorkOrderFinance(db, {
      id: 'MWO-1',
      estimatedCostNgn: 800000,
      status: 'assigned',
      returnedToProductionAtIso: '',
      costClosedAtIso: '',
    });
    expect(pack.envelope.spentNgn).toBe(312000);
    expect(pack.envelope.remainingNgn).toBe(488000);
    expect(pack.costByKind.parts).toBe(200000);
    expect(pack.costByKind.feeding).toBe(112000);
  });

  it('marks shop floor closed while cost stays open on return-to-production', () => {
    const runs = [];
    const db = mockDb({
      get: () => woRow({ status: 'assigned' }),
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = returnWorkOrderToProduction(db, 'MWO-1', {}, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /returned_to_production_at_iso/i.test(x.sql))).toBe(true);
    expect(runs.some((x) => /downtime_hours/i.test(x.sql))).toBe(true);
    expect(runs.some((x) => /UPDATE machines SET status/i.test(x.sql) && x.args.includes('active'))).toBe(true);
  });

  it('legacy resolve only returns the machine when both clocks are still open', () => {
    const runs = [];
    const db = mockDb({
      get: () => woRow({ status: 'assigned' }),
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = resolveMaintenanceWorkOrder(db, 'MWO-1', { note: 'Fixed' }, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /returned_to_production_at_iso/i.test(x.sql))).toBe(true);
    expect(runs.some((x) => /cost_closed_at_iso = COALESCE\(cost_closed_at_iso/i.test(x.sql))).toBe(false);
  });

  it('closes money without putting the machine back when shop floor is still open', () => {
    const runs = [];
    const db = mockDb({
      get: () => woRow({ status: 'assigned', returned_to_production_at_iso: null }),
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = closeWorkOrderCosts(db, 'MWO-1', {}, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(runs.some((x) => /cost_closed_at_iso/i.test(x.sql))).toBe(true);
    expect(runs.some((x) => /UPDATE machines SET status/i.test(x.sql))).toBe(false);
  });

  it('closes the job when returning a machine whose finances are already closed', () => {
    const runs = [];
    const db = mockDb({
      get: () => woRow({ status: 'assigned', cost_closed_at_iso: '2026-08-21T10:00:00.000Z' }),
      run: (sql, args) => {
        runs.push({ sql, args });
      },
    });
    const r = returnWorkOrderToProduction(db, 'MWO-1', {}, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    const statusRun = runs.find((x) => /WHEN \? = 1 THEN 'closed'/i.test(x.sql));
    expect(statusRun).toBeTruthy();
    expect(statusRun.args.filter((a) => a === 1).length).toBeGreaterThan(0);
  });
});

describe('listMaintenanceEventsForMachine', () => {
  it('maps timeline fields for the machine file', () => {
    const db = mockDb({
      all: () => [
        {
          id: 'MEV-1',
          work_order_id: 'MWO-1',
          reference_no: 'MWO-1',
          event_kind: 'opened',
          note: 'No power',
          at_iso: '2026-08-20T09:00:00.000Z',
          actor_display_name: 'Store',
          data_json: null,
        },
      ],
    });
    const events = listMaintenanceEventsForMachine(db, 'MAC-1');
    expect(events).toEqual([
      expect.objectContaining({
        id: 'MEV-1',
        workOrderId: 'MWO-1',
        workOrderRef: 'MWO-1',
        eventKind: 'opened',
        note: 'No power',
        actorDisplayName: 'Store',
      }),
    ]);
  });
});
