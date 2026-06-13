import { describe, it, expect } from 'vitest';
import { repairDashboardProductionJoins, repairDashboardReceivablePurchaseOrders } from './bootstrap.js';

describe('repairDashboardReceivablePurchaseOrders', () => {
  it('re-adds receivable POs dropped by dashboard purchaseOrders trim', () => {
    const receivable = {
      poID: 'PO-KD-26-0027',
      status: 'In Transit',
      supplierName: 'Supplier A',
      lines: [{ lineKey: 'L1', productID: 'COIL-ALU', qtyOrdered: 5000, qtyReceived: 0 }],
    };
    const closed = {
      poID: 'PO-KD-26-0001',
      status: 'Received',
      lines: [{ lineKey: 'L0', productID: 'COIL-ALU', qtyOrdered: 1000, qtyReceived: 1000 }],
    };
    const full = { purchaseOrders: [receivable, closed] };
    const partial = { purchaseOrders: [] };
    repairDashboardReceivablePurchaseOrders(full, partial);
    expect(partial.purchaseOrders.map((p) => p.poID)).toEqual(['PO-KD-26-0027']);
  });
});

describe('repairDashboardProductionJoins', () => {
  it('adds a cutting list from full when a trimmed job references a CL outside the trim window', () => {
    const oldRegistered = { id: 'CL_OLD', productionRegistered: true, date_iso: '2020-01-01' };
    const newer = { id: 'CL_NEW', productionRegistered: false, date_iso: '2026-04-04' };
    const full = {
      cuttingLists: [newer, oldRegistered],
      productionJobs: [{ jobID: 'JOB1', cuttingListId: 'CL_OLD', status: 'Planned' }],
      productionJobCoils: [{ id: 1, jobID: 'JOB1', coilNo: 'C1' }],
    };
    const partial = {
      cuttingLists: [newer],
      productionJobs: [{ jobID: 'JOB1', cuttingListId: 'CL_OLD', status: 'Planned' }],
      productionJobCoils: [],
    };
    repairDashboardProductionJoins(full, partial);
    expect(partial.cuttingLists.map((c) => c.id).sort()).toEqual(['CL_NEW', 'CL_OLD'].sort());
    expect(partial.productionJobs).toHaveLength(1);
    expect(partial.productionJobCoils).toHaveLength(1);
    expect(partial.productionJobCoils[0].coilNo).toBe('C1');
  });

  it('adds a production job from full when a registered CL is trimmed but its job is outside the trim window', () => {
    const registered = { id: 'CL_REG', productionRegistered: true, date_iso: '2026-04-01' };
    const full = {
      cuttingLists: [registered],
      productionJobs: [
        { jobID: 'JOB_NEW', cuttingListId: 'CL_OTHER', status: 'Planned' },
        { jobID: 'JOB_FOR_REG', cuttingListId: 'CL_REG', status: 'Planned' },
      ],
      productionJobCoils: [],
    };
    const partial = {
      cuttingLists: [registered],
      productionJobs: [{ jobID: 'JOB_NEW', cuttingListId: 'CL_OTHER', status: 'Planned' }],
      productionJobCoils: [],
    };
    repairDashboardProductionJoins(full, partial);
    const ids = partial.productionJobs.map((j) => j.jobID).sort();
    expect(ids).toEqual(['JOB_FOR_REG', 'JOB_NEW'].sort());
  });
});
