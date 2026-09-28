/**
 * A mistyped coil number stays put until a different branch manager approves the correction.
 */
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import { isMysqlAvailableForTests } from '../testIntegrationHarness.js';
import {
  decideCoilNumberCorrection,
  requestCoilNumberCorrection,
} from './coilNumberCorrectionOps.js';

const mysqlOk = isMysqlAvailableForTests();

const store = { id: 'u-store', roleKey: 'operations_officer', displayName: 'Yola Store' };
const manager = { id: 'u-bm', roleKey: 'sales_manager', displayName: 'Yola Manager' };

describe.skipIf(!mysqlOk)('coil number correction', () => {
  it('renames the coil only after a branch manager approves', () => {
    const db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
       VALUES ('COIL-ALU', 'Aluminium coil', 0, 'kg', '')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (
         coil_no, product_id, branch_id, qty_received, qty_remaining, current_weight_kg, weight_kg, current_status
       ) VALUES ('CL-WRONG', 'COIL-ALU', 'BR-YL', 1000, 1000, 1000, 1000, 'Available')`
    ).run();
    db.prepare(
      `INSERT INTO coil_control_events (
         id, branch_id, event_kind, coil_no, kg_coil_delta, date_iso, created_at_iso
       ) VALUES ('CCR-1', 'BR-YL', 'note', 'CL-WRONG', 0, '2026-09-28', '2026-09-28T12:00:00')`
    ).run();

    const blocked = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-WRONG', reason: 'Typed the mill number wrong' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(blocked.ok).toBe(false);

    const pending = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-RIGHT', reason: 'Mill tag is CL-RIGHT' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(pending.ok).toBe(true);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeTruthy();

    const self = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(self.ok).toBe(false);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-RIGHT'`).get()).toBeFalsy();

    const approved = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve', note: 'Checked the mill tag' },
      { actor: manager, workspaceBranchId: 'BR-YL' }
    );
    expect(approved.ok).toBe(true);
    expect(approved.coilNo).toBe('CL-RIGHT');
    const lot = db.prepare(`SELECT branch_id, qty_remaining FROM coil_lots WHERE coil_no = 'CL-RIGHT'`).get();
    expect(lot.branch_id).toBe('BR-YL');
    expect(Number(lot.qty_remaining)).toBe(1000);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT coil_no FROM coil_control_events WHERE id = 'CCR-1'`).get().coil_no).toBe('CL-RIGHT');
    db.close();
  });
});
