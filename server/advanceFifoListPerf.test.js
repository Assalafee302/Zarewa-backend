import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { listAdvanceInEvents, listLedgerEntriesForAdvanceBalance } from './readModel.js';
import { insertCustomer } from './writeOps.js';
import { buildBootstrap, buildShellBootstrap } from './bootstrap.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('advance FIFO list performance', () => {
  it('listLedgerEntriesForAdvanceBalance returns only advance-related types ASC', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C-ADV', name: 'Advance Cust' }, 'BR-KD');
    db.exec(`
      INSERT INTO ledger_entries (id, at_iso, type, customer_id, customer_name, amount_ngn, branch_id)
      VALUES
        ('LE-R1', '2026-07-01T10:00:00Z', 'RECEIPT', 'C-ADV', 'Advance Cust', 1000, 'BR-KD'),
        ('LE-A1', '2026-07-01T11:00:00Z', 'ADVANCE_IN', 'C-ADV', 'Advance Cust', 5000, 'BR-KD'),
        ('LE-AP1', '2026-07-02T09:00:00Z', 'ADVANCE_APPLIED', 'C-ADV', 'Advance Cust', 2000, 'BR-KD'),
        ('LE-A2', '2026-07-03T09:00:00Z', 'ADVANCE_IN', 'C-ADV', 'Advance Cust', 1000, 'BR-KD');
    `);
    const rows = listLedgerEntriesForAdvanceBalance(db, 'BR-KD');
    expect(rows.every((r) => ['ADVANCE_IN', 'ADVANCE_APPLIED', 'ADVANCE_REVERSAL', 'REFUND_ADVANCE'].includes(r.type))).toBe(
      true
    );
    expect(rows.map((r) => r.id)).toEqual(['LE-A1', 'LE-AP1', 'LE-A2']);

    const forCustomer = listLedgerEntriesForAdvanceBalance(db, 'BR-KD', { customerId: 'C-ADV' });
    expect(forCustomer).toHaveLength(3);

    const open = listAdvanceInEvents(db, 'BR-KD');
    expect(open.find((a) => a.ledgerEntryId === 'LE-A1')?.amountNgn).toBe(3000);
    expect(open.find((a) => a.ledgerEntryId === 'LE-A2')?.amountNgn).toBe(1000);
    db.close();
  });

  it('full bootstrap defers advanceInEvents; shell stays empty', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C-ADV', name: 'Advance Cust' }, 'BR-KD');
    db.exec(`
      INSERT INTO ledger_entries (id, at_iso, type, customer_id, customer_name, amount_ngn, branch_id)
      VALUES ('LE-A1', '2026-07-01T11:00:00Z', 'ADVANCE_IN', 'C-ADV', 'Advance Cust', 5000, 'BR-KD');
    `);
    const user = { id: 1, roleKey: 'md', displayName: 'MD' };
    const session = { authenticated: true, user, permissions: ['dashboard.view', 'sales.view', 'finance.view'] };
    const full = buildBootstrap(db, { user, session, branchScope: 'BR-KD', skipSideEffects: true });
    expect(full.advanceInEvents).toEqual([]);
    expect(full.bootstrapMeta?.truncated?.advanceInEvents).toBe(true);
    expect(full.bootstrapMeta?.deferredDeskArrays).toEqual(expect.arrayContaining(['advanceInEvents']));

    const shell = buildShellBootstrap(db, { user, session, branchScope: 'BR-KD' });
    expect(shell.advanceInEvents).toEqual([]);
    db.close();
  });
});
