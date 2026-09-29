/**
 * In-progress production desk: cutting lists page by date, jobs page by created_at.
 * A Produced list on screen must still carry its job, and older Planned/Running jobs
 * must stay on the live queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { buildOperationsDomainSnapshot } from './domainBootstrap.js';

const mysqlOk = isMysqlAvailableForTests();

const opsUser = {
  id: 'ops-join',
  roleKey: 'md',
  displayName: 'Ops',
  permissions: ['operations.view', 'production.manage', 'inventory.view', 'dashboard.view'],
};

function insertCustomer(db) {
  db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES ('C-JOIN', 'Join Customer', 'BR-KD')`).run();
}

function insertList(db, { id, dateISO, status, registered = 1, ref = '' }) {
  db.prepare(
    `INSERT INTO cutting_lists (
       id, customer_id, customer_name, quotation_ref, date_iso, date_label,
       status, branch_id, sheets_to_cut, total_meters, production_registered, production_register_ref
     ) VALUES (?, 'C-JOIN', 'Join Customer', ?, ?, ?, ?, 'BR-KD', 1, 10, ?, ?)`
  ).run(id, `QT-${id}`, dateISO, dateISO, status, registered, ref);
}

function insertJob(db, { jobId, cuttingListId, status, createdAt }) {
  db.prepare(
    `INSERT INTO production_jobs (
       job_id, cutting_list_id, quotation_ref, customer_id, customer_name,
       status, created_at_iso, branch_id, planned_meters
     ) VALUES (?, ?, ?, 'C-JOIN', 'Join Customer', ?, ?, 'BR-KD', 10)`
  ).run(jobId, cuttingListId, `QT-${cuttingListId}`, status, createdAt);
}

describe.skipIf(!mysqlOk)('operations snapshot production desk join', () => {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;

  afterEach(() => {
    delete process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT;
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
  });

  it('attaches an older Produced job to a visible list and keeps an older Planned job on the queue', () => {
    process.env.ZAREWA_PRODUCTION_HISTORY_LIMIT = '2';
    db = createDatabase(':memory:', { seed: false });
    insertCustomer(db);

    // Recent cutting-list page, but the job was created long before the job page.
    insertList(db, {
      id: 'CL-PRODUCED',
      dateISO: '2026-09-29',
      status: 'Finished',
      ref: 'PJ-PRODUCED',
    });
    insertJob(db, {
      jobId: 'PJ-PRODUCED',
      cuttingListId: 'CL-PRODUCED',
      status: 'Completed',
      createdAt: '2025-06-01T10:00:00.000Z',
    });

    insertList(db, { id: 'CL-NEW-1', dateISO: '2026-09-28', status: 'In production', ref: 'PJ-NEW-1' });
    insertJob(db, {
      jobId: 'PJ-NEW-1',
      cuttingListId: 'CL-NEW-1',
      status: 'Planned',
      createdAt: '2026-09-28T10:00:00.000Z',
    });

    insertList(db, { id: 'CL-NEW-2', dateISO: '2026-09-27', status: 'In production', ref: 'PJ-NEW-2' });
    insertJob(db, {
      jobId: 'PJ-NEW-2',
      cuttingListId: 'CL-NEW-2',
      status: 'Planned',
      createdAt: '2026-09-29T10:00:00.000Z',
    });

    // Open queue row outside both recent pages.
    insertList(db, { id: 'CL-OPEN-OLD', dateISO: '2024-01-01', status: 'In production', ref: 'PJ-OPEN-OLD' });
    insertJob(db, {
      jobId: 'PJ-OPEN-OLD',
      cuttingListId: 'CL-OPEN-OLD',
      status: 'Planned',
      createdAt: '2024-01-02T10:00:00.000Z',
    });

    // Closed history must stay off the desk page.
    insertList(db, {
      id: 'CL-DONE-OLD',
      dateISO: '2023-01-01',
      status: 'Finished',
      ref: 'PJ-DONE-OLD',
    });
    insertJob(db, {
      jobId: 'PJ-DONE-OLD',
      cuttingListId: 'CL-DONE-OLD',
      status: 'Completed',
      createdAt: '2023-01-02T10:00:00.000Z',
    });

    const snap = buildOperationsDomainSnapshot(db, { user: opsUser, branchScope: 'BR-KD' });
    const jobIds = snap.productionJobs.map((j) => j.jobID);
    const listIds = snap.cuttingLists.map((cl) => cl.id);

    expect(jobIds).toContain('PJ-PRODUCED');
    expect(jobIds).toContain('PJ-OPEN-OLD');
    expect(jobIds).not.toContain('PJ-DONE-OLD');
    expect(listIds).toContain('CL-PRODUCED');
    expect(listIds).toContain('CL-OPEN-OLD');
    expect(listIds).not.toContain('CL-DONE-OLD');
  });
});
