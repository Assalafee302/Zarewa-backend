/**
 * A mistyped coil number stays put until a different branch manager approves the correction.
 */
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import { isMysqlAvailableForTests } from '../testIntegrationHarness.js';
import {
  decideCoilNumberCorrection,
  listCoilNumberCorrections,
  previewCoilNumberChange,
  requestCoilNumberCorrection,
  withdrawCoilNumberCorrection,
} from './coilNumberCorrectionOps.js';

const mysqlOk = isMysqlAvailableForTests();

const store = { id: 'u-store', roleKey: 'operations_officer', displayName: 'Yola Store' };
const manager = { id: 'u-bm', roleKey: 'sales_manager', displayName: 'Yola Manager' };

function seedCoil(db, coilNo, branchId = 'BR-YL') {
  db.prepare(
    `INSERT INTO coil_lots (
       coil_no, product_id, branch_id, qty_received, qty_remaining, current_weight_kg, weight_kg, current_status
     ) VALUES (?, 'COIL-ALU', ?, 1000, 1000, 1000, 1000, 'Available')`
  ).run(coilNo, branchId);
}

function openDb() {
  const db = createDatabase(':memory:', { seed: false });
  db.prepare(
    `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
     VALUES ('COIL-ALU', 'Aluminium coil', 0, 'kg', '')`
  ).run();
  return db;
}

describe.skipIf(!mysqlOk)('coil number correction', () => {
  it('renames the coil and its references only after a branch manager confirms', () => {
    const db = openDb();
    seedCoil(db, 'CL-WRONG');
    db.prepare(
      `INSERT INTO coil_control_events (
         id, branch_id, event_kind, coil_no, kg_coil_delta, date_iso, created_at_iso
       ) VALUES ('CCR-1', 'BR-YL', 'note', 'CL-WRONG', 0, '2026-09-28', '2026-09-28T12:00:00')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (job_id, created_at_iso) VALUES ('JOB-1', '2026-09-28T12:00:00')`
    ).run();
    db.prepare(
      `INSERT INTO production_job_coils (id, job_id, sequence_no, coil_no, allocated_at_iso)
       VALUES ('PJC-1', 'JOB-1', 1, 'CL-WRONG', '2026-09-28T12:00:00')`
    ).run();
    db.prepare(
      `INSERT INTO stock_movements (id, at_iso, type, ref, detail, branch_id)
       VALUES ('SM-1', '2026-09-28T12:00:00', 'STORE_GRN', 'CL-WRONG', 'CL-WRONG · received', 'BR-YL')`
    ).run();

    const blocked = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-WRONG', reason: 'Typed the mill number wrong' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(blocked.ok).toBe(false);

    const otherBranch = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-RIGHT', reason: 'Mill tag is CL-RIGHT' },
      { actor: store, workspaceBranchId: 'BR-KD' }
    );
    expect(otherBranch.ok).toBe(false);

    const pending = requestCoilNumberCorrection(
      db,
      'cl-wrong',
      { toCoilNo: 'cl-right', reason: 'Mill tag is CL-RIGHT' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(pending.ok).toBe(true);
    expect(pending.correction.toCoilNo).toBe('CL-RIGHT');
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeTruthy();

    const duplicate = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-OTHER', reason: 'Second try' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(duplicate.ok).toBe(false);

    const wrongBranch = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve', confirmCoilNo: 'CL-RIGHT' },
      { actor: manager, workspaceBranchId: 'BR-KD' }
    );
    expect(wrongBranch.ok).toBe(false);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeTruthy();

    const self = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve', confirmCoilNo: 'CL-RIGHT' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(self.ok).toBe(false);

    const unconfirmed = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve' },
      { actor: manager, workspaceBranchId: 'BR-YL' }
    );
    expect(unconfirmed.ok).toBe(false);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-RIGHT'`).get()).toBeFalsy();

    const approved = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'approve', note: 'Checked the mill tag', confirmCoilNo: 'cl-right' },
      { actor: manager, workspaceBranchId: 'BR-YL' }
    );
    expect(approved.ok).toBe(true);
    expect(approved.coilNo).toBe('CL-RIGHT');
    const lot = db.prepare(`SELECT branch_id, qty_remaining FROM coil_lots WHERE coil_no = 'CL-RIGHT'`).get();
    expect(lot.branch_id).toBe('BR-YL');
    expect(Number(lot.qty_remaining)).toBe(1000);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT coil_no FROM coil_control_events WHERE id = 'CCR-1'`).get().coil_no).toBe('CL-RIGHT');
    expect(db.prepare(`SELECT coil_no FROM production_job_coils WHERE id = 'PJC-1'`).get().coil_no).toBe('CL-RIGHT');
    const movement = db.prepare(`SELECT ref, detail FROM stock_movements WHERE id = 'SM-1'`).get();
    expect(movement.ref).toBe('CL-RIGHT');
    expect(movement.detail).toBe('CL-RIGHT · received');
    db.close();
  });

  it('rejects a taken number, leaves the coil on reject, and lets store withdraw', () => {
    const db = openDb();
    seedCoil(db, 'CL-WRONG');
    seedCoil(db, 'CL-TAKEN');

    const previewTaken = previewCoilNumberChange(db, 'CL-WRONG', 'cl-taken', { workspaceBranchId: 'BR-YL' });
    expect(previewTaken.ok).toBe(true);
    expect(previewTaken.taken).toBe(true);
    expect(previewTaken.available).toBe(false);

    const taken = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-TAKEN', reason: 'Mill tag' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(taken.ok).toBe(false);

    const previewFree = previewCoilNumberChange(db, 'CL-WRONG', 'CL-FREE', { workspaceBranchId: 'BR-YL' });
    expect(previewFree.available).toBe(true);
    expect(previewFree.impact.onHandKg).toBe(1000);

    const pending = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-FREE', reason: 'Mill tag is CL-FREE' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(pending.ok).toBe(true);

    const queue = listCoilNumberCorrections(db, 'BR-YL', { actor: manager });
    expect(queue).toHaveLength(1);
    expect(queue[0].canApprove).toBe(true);
    expect(queue[0].impact.onHandKg).toBe(1000);

    const storeQueue = listCoilNumberCorrections(db, 'BR-YL', { actor: store, fromCoilNo: 'cl-wrong' });
    expect(storeQueue[0].canWithdraw).toBe(true);
    expect(storeQueue[0].canApprove).toBe(false);

    const bareReject = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'reject' },
      { actor: manager, workspaceBranchId: 'BR-YL' }
    );
    expect(bareReject.ok).toBe(false);

    const rejected = decideCoilNumberCorrection(
      db,
      pending.correction.id,
      { decision: 'reject', note: 'Tag is unreadable' },
      { actor: manager, workspaceBranchId: 'BR-YL' }
    );
    expect(rejected.ok).toBe(true);
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeTruthy();

    const again = requestCoilNumberCorrection(
      db,
      'CL-WRONG',
      { toCoilNo: 'CL-FREE', reason: 'Mill tag is CL-FREE' },
      { actor: store, workspaceBranchId: 'BR-YL' }
    );
    expect(again.ok).toBe(true);
    const pulled = withdrawCoilNumberCorrection(db, again.correction.id, {
      actor: manager,
      workspaceBranchId: 'BR-YL',
    });
    expect(pulled.ok).toBe(false);
    const withdrawn = withdrawCoilNumberCorrection(db, again.correction.id, {
      actor: store,
      workspaceBranchId: 'BR-YL',
    });
    expect(withdrawn.ok).toBe(true);
    expect(withdrawn.correction.status).toBe('withdrawn');
    expect(db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = 'CL-WRONG'`).get()).toBeTruthy();
    db.close();
  });
});
