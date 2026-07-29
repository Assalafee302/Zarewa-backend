import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  createCustomerComplaint,
  findBranchManagerForBranch,
  getCustomerComplaint,
  listBranchesMissingBranchManager,
  listCustomerComplaints,
  updateCustomerComplaint,
} from './customerComplaintsOps.js';

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

describe.skipIf(!mysqlOk)('customerComplaintsOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  const iso = () => new Date().toISOString();

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES ('USR-SALES', 'sales.user', 'Sales Desk', 'x', 'sales', 'active', ?)`
    ).run(iso());
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status, created_at_iso)
       VALUES ('CUS-1', 'Acme Roofing', 'BR-KD', 'Active', ?)`
    ).run(iso());
  });

  afterEach(() => {
    db?.close?.();
  });

  it('assigns Branch Manager when sales_manager is on the customer branch', () => {
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso, workspace_branch_id)
       VALUES ('USR-BM', 'bm.kd', 'Branch Manager KD', 'x', 'sales_manager', 'active', ?, 'BR-KD')`
    ).run(iso());

    const bm = findBranchManagerForBranch(db, 'BR-KD');
    expect(bm?.userId).toBe('USR-BM');

    const created = createCustomerComplaint(
      db,
      {
        customerId: 'CUS-1',
        channel: 'phone',
        category: 'delivery_delay',
        severity: 'high',
        description: 'Truck late by two days',
      },
      { id: 'USR-SALES', displayName: 'Sales Desk' },
      'BR-KD'
    );
    expect(created.ok).toBe(true);
    expect(created.assignmentFallback).toBe(false);
    expect(created.missingBranchManager).toBe(false);
    expect(created.complaint.id).toMatch(/^CMP/);
    expect(created.complaint.assignedToUserId).toBe('USR-BM');
    expect(created.complaint.status).toBe('open');
  });

  it('falls back to opener when no Branch Manager and flags missing BM', () => {
    const created = createCustomerComplaint(
      db,
      {
        customerId: 'CUS-1',
        channel: 'whatsapp',
        category: 'billing_dispute',
        severity: 'urgent',
        description: 'Double charged on invoice',
      },
      { id: 'USR-SALES', displayName: 'Sales Desk' },
      'BR-KD'
    );
    expect(created.ok).toBe(true);
    expect(created.assignmentFallback).toBe(true);
    expect(created.missingBranchManager).toBe(true);
    expect(created.complaint.assignedToUserId).toBe('USR-SALES');
    expect(created.complaint.assignmentFallback).toBe(true);

    const missing = listBranchesMissingBranchManager(db);
    expect(missing.some((b) => b.branchId === 'BR-KD')).toBe(true);
  });

  it('lists open complaints for a branch and updates status', () => {
    const created = createCustomerComplaint(
      db,
      {
        customerId: 'CUS-1',
        channel: 'in_person',
        category: 'service',
        description: 'Rude delivery crew',
      },
      { id: 'USR-SALES', displayName: 'Sales Desk' },
      'BR-KD'
    );
    expect(created.ok).toBe(true);

    const open = listCustomerComplaints(db, { branchId: 'BR-KD', openOnly: true });
    expect(open.some((c) => c.id === created.complaint.id)).toBe(true);

    const ack = updateCustomerComplaint(
      db,
      created.complaint.id,
      { action: 'acknowledge' },
      { id: 'USR-SALES' }
    );
    expect(ack.ok).toBe(true);
    expect(ack.complaint.status).toBe('acknowledged');

    const resolved = updateCustomerComplaint(
      db,
      created.complaint.id,
      { action: 'resolve', resolutionNote: 'Apologised; follow-up call done.' },
      { id: 'USR-SALES' }
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.complaint.status).toBe('resolved');
    expect(getCustomerComplaint(db, created.complaint.id)?.resolutionNote).toMatch(/Apologised/);

    const stillOpen = listCustomerComplaints(db, { branchId: 'BR-KD', openOnly: true });
    expect(stillOpen.some((c) => c.id === created.complaint.id)).toBe(false);
  });
});
