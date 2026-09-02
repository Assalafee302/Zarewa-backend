import { describe, expect, it, vi } from 'vitest';

vi.mock('../controlOps.js', () => ({
  appendAuditLog: () => {},
}));

vi.mock('../workItems.js', () => ({
  createMaintenanceWorkOrder: (_db, body) => ({ ok: true, workOrderId: `MWO-${body.machineId}` }),
}));

import { openWorkOrderFromPlan, stampPlanService } from './maintenancePlanOps.js';

function makeDb({ plan, workOrders = [] } = {}) {
  let current = plan;
  const updates = [];
  return {
    updates,
    prepare(sql) {
      const s = String(sql);
      return {
        get: () => {
          if (s.includes('FROM maintenance_plans p') || s.includes('FROM maintenance_plans')) return current;
          return null;
        },
        all: () => {
          if (s.includes('FROM maintenance_work_orders')) return workOrders;
          return [];
        },
        run: (...args) => {
          if (s.includes('UPDATE maintenance_plans')) {
            updates.push(args);
            current = {
              ...current,
              last_service_at_iso: args[0],
              last_service_meter: args[1],
              next_due_date_iso: args[2],
              next_due_meter: args[3],
            };
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    },
  };
}

const PLAN = {
  id: 'MPL-1',
  reference_no: 'MPL-1',
  branch_id: 'BR-KD',
  machine_id: 'MACH-GEN',
  machine_name: 'Standby generator',
  machine_code: 'GEN-1',
  machine_type: 'generator',
  status: 'active',
  plan_kind: 'preventive',
  summary: 'Generator service',
  calendar_interval_days: 30,
  next_due_date_iso: '2026-08-29',
  approval_required: 1,
};

describe('maintenancePlanOps', () => {
  it('opens a preventive work order from a due plan', () => {
    const db = makeDb({ plan: PLAN });
    const r = openWorkOrderFromPlan(db, 'MPL-1', { id: 'USR-BM' });
    expect(r).toEqual({ ok: true, workOrderId: 'MWO-MACH-GEN', reused: false });
  });

  it('reuses an open service job instead of opening a second one', () => {
    const db = makeDb({
      plan: PLAN,
      workOrders: [{ id: 'MWO-EXISTING', status: 'assigned', returned_to_production_at_iso: null }],
    });
    const r = openWorkOrderFromPlan(db, 'MPL-1', { id: 'USR-BM' });
    expect(r).toEqual({ ok: true, workOrderId: 'MWO-EXISTING', reused: true });
  });

  it('stamps last service and rolls next due by the calendar interval', () => {
    const db = makeDb({ plan: PLAN });
    const r = stampPlanService(db, 'MPL-1', { lastServiceAtIso: '2026-08-22T10:00:00.000Z' }, { id: 'USR-BM' });
    expect(r.ok).toBe(true);
    expect(r.plan.lastServiceAtIso).toBe('2026-08-22');
    expect(r.plan.nextDueDateIso).toBe('2026-09-21');
  });

  it('rejects a malformed last service date instead of silently falling back to today', () => {
    const db = makeDb({ plan: PLAN });
    const r = stampPlanService(db, 'MPL-1', { lastServiceAtIso: 'not-a-date' }, { id: 'USR-BM' });
    expect(r.ok).toBe(false);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects a malformed next due date', () => {
    const db = makeDb({ plan: PLAN });
    const r = stampPlanService(
      db,
      'MPL-1',
      { lastServiceAtIso: '2026-08-22', nextDueDateIso: 'soon-ish' },
      { id: 'USR-BM' }
    );
    expect(r.ok).toBe(false);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects a next due date more than 5 years out (likely typo)', () => {
    const db = makeDb({ plan: PLAN });
    const r = stampPlanService(
      db,
      'MPL-1',
      { lastServiceAtIso: '2026-08-22', nextDueDateIso: '2099-01-01' },
      { id: 'USR-BM' }
    );
    expect(r.ok).toBe(false);
    expect(db.updates).toHaveLength(0);
  });
});
