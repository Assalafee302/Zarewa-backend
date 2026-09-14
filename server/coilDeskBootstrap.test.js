/**
 * Regressions from prior lean-bootstrap attempts:
 * - recent-N coil trim hid live stock (CL-26-2043)
 * - shell deferred masterData / treasury / staff and broke pickers
 * - finance snapshot precomputing creditors/debtors made desks slow
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { buildShellBootstrap, buildBootstrap } from './bootstrap.js';
import {
  buildOperationsDomainSnapshot,
  buildFinanceDomainSnapshot,
  buildSalesDomainSnapshot,
} from './domainBootstrap.js';
import { listCoilLotsForDesk, listEligibleProductionCoils, searchCoilLots } from './readModel.js';
import { coilDeskListOpts } from './listQueryOpts.js';
import { insertAssociatedStaff } from './writeOps.js';

const mysqlOk = isMysqlAvailableForTests();

function seedProduct(db) {
  db.prepare(
    `INSERT INTO products (product_id, name, category, stock_level, unit)
     VALUES ('COIL-ALU', 'Alu coil', 'Raw Material', 0, 'kg')
     ON CONFLICT(product_id) DO UPDATE SET stock_level = excluded.stock_level`
  ).run();
}

function insertCoil(
  db,
  { coilNo, receivedAtISO, qtyRemaining, qtyReserved = 0, status = 'Available' }
) {
  db.prepare(
    `INSERT INTO coil_lots (
      coil_no, product_id, branch_id, gauge_label, colour,
      qty_received, weight_kg, qty_remaining, qty_reserved, current_weight_kg,
      current_status, received_at_iso
    ) VALUES (?, 'COIL-ALU', 'BR-KD', '0.45mm', 'IV', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    coilNo,
    Math.max(qtyRemaining, 1),
    Math.max(qtyRemaining, 1),
    qtyRemaining,
    qtyReserved,
    qtyRemaining,
    status,
    receivedAtISO
  );
}

const opsUser = {
  id: 'ops-1',
  roleKey: 'md',
  displayName: 'Ops',
  permissions: ['operations.view', 'production.manage', 'inventory.view', 'dashboard.view'],
};

describe.skipIf(!mysqlOk)('coil desk bootstrap (past lean-bootstrap lessons)', () => {
  afterEach(() => {
    delete process.env.ZAREWA_COIL_DESK_FULL;
    delete process.env.ZAREWA_COIL_DESK_LIMIT;
  });

  it('keeps old on-hand coils in the desk pack (no recent-N hide like CL-26-2043)', () => {
    const db = createDatabase(':memory:', { seed: false });
    seedProduct(db);
    // Newer consumed history would win a naive take(N) by received_at DESC.
    for (let i = 1; i <= 8; i += 1) {
      insertCoil(db, {
        coilNo: `CL-NEW-${i}`,
        receivedAtISO: `2026-09-${String(i).padStart(2, '0')}`,
        qtyRemaining: 0,
        status: 'Consumed',
      });
    }
    insertCoil(db, {
      coilNo: 'CL-26-2043',
      receivedAtISO: '2024-01-15',
      qtyRemaining: 1200,
      status: 'Available',
    });

    const desk = listCoilLotsForDesk(db, 'BR-KD', coilDeskListOpts());
    expect(desk.mode).toBe('active');
    expect(desk.truncated).toBe(true);
    expect(desk.coilLots.map((c) => c.coilNo)).toContain('CL-26-2043');
    expect(desk.coilLots.every((c) => c.qtyRemaining > 0 || c.qtyReserved > 0)).toBe(true);

    const snap = buildOperationsDomainSnapshot(db, { user: opsUser, branchScope: 'BR-KD' });
    expect(snap.coilLots.map((c) => c.coilNo)).toContain('CL-26-2043');
    expect(snap.bootstrapMeta?.listLimitsApplied?.coilLots).toBe('active');
    expect(snap.bootstrapMeta?.coilLotsRecovery?.search).toBe('/api/coil-lots/search');
    expect(snap.bootstrapMeta?.truncated?.coilLots).toBe(true);

    // Consumed history still reachable via search / eligible stays complete for on-hand.
    expect(searchCoilLots(db, 'BR-KD', '2043').some((c) => c.coilNo === 'CL-26-2043')).toBe(true);
    expect(listEligibleProductionCoils(db, 'BR-KD').some((c) => c.coilNo === 'CL-26-2043')).toBe(true);
    db.close();
  });

  it('shell ships masterData, treasuryAccounts, and associatedStaff for pickers', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertAssociatedStaff(db, {
      id: 'AS-DRV-9',
      name: 'Driver Nine',
      staffType: 'Driver',
      status: 'Active',
    });
    const salesUser = {
      id: 'sales-9',
      roleKey: 'custom',
      displayName: 'Sales',
      permissions: ['sales.manage', 'receipts.post', 'refunds.request'],
    };
    const session = { authenticated: true, user: salesUser, permissions: salesUser.permissions };
    const shell = buildShellBootstrap(db, { user: salesUser, session, branchScope: 'BR-KD' });
    expect(shell.bootstrapMeta?.mode).toBe('shell');
    // Prior lean shell deferred masterData to [] and sales never refilled gauges.
    expect(shell.masterData).toEqual(
      expect.objectContaining({
        gauges: expect.any(Array),
        materialTypes: expect.any(Array),
      })
    );
    expect(Array.isArray(shell.treasuryAccounts)).toBe(true);
    expect(shell.associatedStaff.some((s) => s.id === 'AS-DRV-9')).toBe(true);
    expect(shell.coilLots).toEqual([]);
    expect(shell.customers).toEqual([]);
    db.close();
  });

  it('sales snapshot still ships treasuryAccounts so receipt pickers do not wait on finance', () => {
    const db = createDatabase(':memory:', { seed: false });
    const snap = buildSalesDomainSnapshot(db, { user: null, branchScope: 'ALL' });
    expect(Array.isArray(snap.treasuryAccounts)).toBe(true);
    expect(snap.masterData).toEqual(
      expect.objectContaining({
        gauges: expect.any(Array),
        materialTypes: expect.any(Array),
      })
    );
    db.close();
  });

  it('finance snapshot keeps creditors/debtors lazy (not precomputed)', () => {
    const db = createDatabase(':memory:', { seed: false });
    const user = {
      id: 'fin-1',
      roleKey: 'md',
      displayName: 'Finance',
      permissions: ['finance.view', 'finance.post', 'reports.view', 'accounting.view'],
    };
    const snap = buildFinanceDomainSnapshot(db, { user, branchScope: 'BR-KD' });
    expect(snap.accountingCreditors).toBeNull();
    expect(snap.accountingDebtors).toBeNull();
    db.close();
  });

  it('full bootstrap active coil pack omits consumed history unless escape hatch is set', () => {
    const db = createDatabase(':memory:', { seed: false });
    seedProduct(db);
    insertCoil(db, {
      coilNo: 'CL-LIVE-1',
      receivedAtISO: '2026-01-01',
      qtyRemaining: 500,
    });
    insertCoil(db, {
      coilNo: 'CL-DEAD-1',
      receivedAtISO: '2026-02-01',
      qtyRemaining: 0,
      status: 'Consumed',
    });
    const user = {
      id: 'md-1',
      roleKey: 'md',
      displayName: 'MD',
      permissions: ['operations.view', 'inventory.view', 'dashboard.view', 'production.manage'],
    };
    const session = { authenticated: true, user, permissions: user.permissions };
    const full = buildBootstrap(db, { user, session, branchScope: 'BR-KD', skipSideEffects: true });
    const nos = full.coilLots.map((c) => c.coilNo);
    expect(nos).toContain('CL-LIVE-1');
    expect(nos).not.toContain('CL-DEAD-1');
    expect(full.bootstrapMeta?.listLimitsApplied?.coilLots).toBe('active');

    process.env.ZAREWA_COIL_DESK_FULL = '1';
    const fullHist = buildBootstrap(db, { user, session, branchScope: 'BR-KD', skipSideEffects: true });
    expect(fullHist.coilLots.map((c) => c.coilNo)).toEqual(
      expect.arrayContaining(['CL-LIVE-1', 'CL-DEAD-1'])
    );
    expect(fullHist.bootstrapMeta?.listLimitsApplied?.coilLots).toBe('full');
    db.close();
  });
});
