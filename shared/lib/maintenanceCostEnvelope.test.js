import { describe, expect, it } from 'vitest';
import {
  buildMaintenanceEnvelope,
  looksLikeMaintenanceWorkOrderRef,
  maintenanceCostKindRequiresVendor,
  maintenanceDowntimeHours,
  maintenanceEventKindLabel,
  maintenancePriorityLabel,
  maintenanceWorkOrderStatusLabel,
  normalizeMaintenanceCostKind,
  normalizeMaintenanceWorkOrderKind,
  sumCostLinesByKind,
} from './maintenanceCostEnvelope.js';

describe('maintenanceCostEnvelope', () => {
  it('maps vendor alias to contractor and requires a vendor only then', () => {
    expect(normalizeMaintenanceCostKind('vendor')).toBe('contractor');
    expect(maintenanceCostKindRequiresVendor('vendor')).toBe(true);
    expect(maintenanceCostKindRequiresVendor('feeding')).toBe(false);
    expect(normalizeMaintenanceCostKind('Lodging')).toBe('other');
    expect(normalizeMaintenanceCostKind('accommodation')).toBe('accommodation');
  });

  it('builds estimate vs spent with separate shop-floor and money clocks', () => {
    const open = buildMaintenanceEnvelope({
      estimatedCostNgn: 800_000,
      spentNgn: 312_000,
      status: 'assigned',
    });
    expect(open.remainingNgn).toBe(488_000);
    expect(open.shopFloorOpen).toBe(true);
    expect(open.costOpen).toBe(true);
    expect(open.overEnvelope).toBe(false);

    const running = buildMaintenanceEnvelope({
      estimatedCostNgn: 800_000,
      spentNgn: 900_000,
      status: 'returned_to_production',
      returnedToProductionAtIso: '2026-08-20T10:00:00.000Z',
    });
    expect(running.shopFloorOpen).toBe(false);
    expect(running.costOpen).toBe(true);
    expect(running.machineBackOnLine).toBe(true);
    expect(running.overEnvelope).toBe(true);

    const done = buildMaintenanceEnvelope({
      estimatedCostNgn: 100,
      spentNgn: 80,
      status: 'closed',
      returnedToProductionAtIso: '2026-08-20T10:00:00.000Z',
      costClosedAtIso: '2026-08-21T10:00:00.000Z',
    });
    expect(done.shopFloorOpen).toBe(false);
    expect(done.costOpen).toBe(false);
    expect(done.financiallyClosed).toBe(true);

    const closedStatusMoneyOpen = buildMaintenanceEnvelope({
      status: 'closed',
      spentNgn: 50_000,
    });
    expect(closedStatusMoneyOpen.costOpen).toBe(true);
    expect(closedStatusMoneyOpen.shopFloorOpen).toBe(true);
  });

  it('sums cost lines by kind', () => {
    const byKind = sumCostLinesByKind([
      { costKind: 'parts', amountNgn: 10_000 },
      { cost_kind: 'vendor', amount_ngn: 5_000 },
      { costKind: 'feeding', amountNgn: 2_000 },
    ]);
    expect(byKind.parts).toBe(10_000);
    expect(byKind.contractor).toBe(5_000);
    expect(byKind.feeding).toBe(2_000);
    expect(byKind.labour).toBe(0);
  });

  it('detects work-order refs for cashier tags', () => {
    expect(looksLikeMaintenanceWorkOrderRef('MWO-26-0041')).toBe(true);
    expect(looksLikeMaintenanceWorkOrderRef('PR-1')).toBe(false);
  });

  it('normalizes work-order kind', () => {
    expect(normalizeMaintenanceWorkOrderKind('overhaul')).toBe('overhaul');
    expect(normalizeMaintenanceWorkOrderKind('')).toBe('corrective');
  });

  it('computes downtime from the shop-floor clock when hours were not stored', () => {
    expect(
      maintenanceDowntimeHours({
        downtimeHours: 4.5,
        openedAtIso: '2026-08-01T08:00:00.000Z',
        returnedToProductionAtIso: '2026-08-01T20:00:00.000Z',
      })
    ).toBe(4.5);
    expect(
      maintenanceDowntimeHours({
        openedAtIso: '2026-08-01T08:00:00.000Z',
        returnedToProductionAtIso: '2026-08-01T12:00:00.000Z',
      })
    ).toBe(4);
    expect(
      maintenanceDowntimeHours({
        openedAtIso: '2026-08-01T10:00:00.000Z',
        nowMs: Date.parse('2026-08-01T12:30:00.000Z'),
      })
    ).toBe(2.5);
  });

  it('labels the two clocks instead of raw snake_case status', () => {
    expect(maintenanceWorkOrderStatusLabel('open')).toBe('Reported');
    expect(
      maintenanceWorkOrderStatusLabel({
        status: 'returned_to_production',
        returnedToProductionAtIso: '2026-08-20T10:00:00.000Z',
      })
    ).toBe('Back on line · costs open');
    expect(
      maintenanceWorkOrderStatusLabel({
        status: 'assigned',
        costClosedAtIso: '2026-08-21T10:00:00.000Z',
      })
    ).toBe('Off the line · finances closed');
    expect(maintenancePriorityLabel('machine_down', { short: true })).toBe('Machine down');
  });

  it('labels maintenance event kinds for the machine file timeline', () => {
    expect(maintenanceEventKindLabel('opened')).toBe('Fault reported');
    expect(maintenanceEventKindLabel('returned_to_production')).toBe('Back on the line');
  });
});
