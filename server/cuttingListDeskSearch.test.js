/**
 * Production register / Sales browse must find cutting lists older than the
 * recent desk page — search filters in SQL before LIMIT.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  listCuttingLists,
  searchCuttingLists,
  searchProductionJobs,
} from './readModel.js';

const mysqlOk = isMysqlAvailableForTests();

function insertTestCustomer(db, customerId, name = 'Test Customer') {
  db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?, ?, ?)`).run(
    customerId,
    name,
    DEFAULT_BRANCH_ID
  );
}

describe.skipIf(!mysqlOk)('cutting list desk search beyond recent page', () => {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
  });

  it('searchCuttingLists finds a list outside the recent-N desk page', () => {
    db = createDatabase(':memory:', { seed: false });
    insertTestCustomer(db, 'C-OLD', 'Older Customer');
    insertTestCustomer(db, 'C-NEW', 'Newer Customer');

    db.prepare(
      `INSERT INTO cutting_lists (
         id, customer_id, customer_name, quotation_ref, date_iso, date_label,
         status, branch_id, sheets_to_cut, total_meters, production_registered
       ) VALUES (?, ?, ?, ?, ?, ?, 'Waiting', ?, 1, 10, 1)`
    ).run(
      'CL-OLD-HIDDEN',
      'C-OLD',
      'Older Customer',
      'QT-OLD-1',
      '2025-01-01',
      '1 Jan 2025',
      DEFAULT_BRANCH_ID
    );

    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO cutting_lists (
           id, customer_id, customer_name, quotation_ref, date_iso, date_label,
           status, branch_id, sheets_to_cut, total_meters, production_registered
         ) VALUES (?, ?, ?, ?, ?, ?, 'Waiting', ?, 1, 5, 1)`
      ).run(
        `CL-NEW-${i}`,
        'C-NEW',
        'Newer Customer',
        `QT-NEW-${i}`,
        `2026-09-${String(10 + i).padStart(2, '0')}`,
        `Sep ${10 + i}`,
        DEFAULT_BRANCH_ID
      );
    }

    const deskPage = listCuttingLists(db, DEFAULT_BRANCH_ID, { limit: 5 });
    expect(deskPage).toHaveLength(5);
    expect(deskPage.some((row) => row.id === 'CL-OLD-HIDDEN')).toBe(false);

    const hits = searchCuttingLists(db, DEFAULT_BRANCH_ID, 'CL-OLD-HIDDEN', 20);
    expect(hits.some((row) => row.id === 'CL-OLD-HIDDEN')).toBe(true);

    const byCustomer = searchCuttingLists(db, DEFAULT_BRANCH_ID, 'Older Customer', 20);
    expect(byCustomer.some((row) => row.id === 'CL-OLD-HIDDEN')).toBe(true);

    const byQuote = listCuttingLists(db, DEFAULT_BRANCH_ID, { q: 'QT-OLD-1', limit: 5 });
    expect(byQuote.some((row) => row.id === 'CL-OLD-HIDDEN')).toBe(true);
  });

  it('searchProductionJobs finds a job linked to an older cutting list', () => {
    db = createDatabase(':memory:', { seed: false });
    insertTestCustomer(db, 'C1', 'Job Customer');
    db.prepare(
      `INSERT INTO cutting_lists (
         id, customer_id, customer_name, quotation_ref, date_iso,
         status, branch_id, production_registered, production_register_ref
       ) VALUES ('CL-JOB-OLD', 'C1', 'Job Customer', 'QT-JOB-1', '2025-02-01',
                 'Finished', ?, 1, 'PJ-OLD-1')`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_jobs (
         job_id, cutting_list_id, quotation_ref, customer_id, customer_name,
         status, created_at_iso, branch_id, planned_meters
       ) VALUES ('PJ-OLD-1', 'CL-JOB-OLD', 'QT-JOB-1', 'C1', 'Job Customer',
                 'Completed', '2025-02-02T10:00:00.000Z', ?, 12)`
    ).run(DEFAULT_BRANCH_ID);

    const hits = searchProductionJobs(db, DEFAULT_BRANCH_ID, 'CL-JOB-OLD', 20);
    expect(hits.some((row) => row.jobID === 'PJ-OLD-1')).toBe(true);
  });
});
