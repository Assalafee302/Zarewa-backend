import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { deleteCuttingListIfAllowed } from './writeOps.js';

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

describe.skipIf(!mysqlOk)('deleteCuttingListIfAllowed', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function insertList({ id, status, registered = 0, ref = null }) {
    db.prepare(
      `INSERT INTO cutting_lists (
         id, customer_id, customer_name, quotation_ref, date_iso, status, branch_id,
         production_registered, production_register_ref
       ) VALUES (?, 'CUS-1', 'Acme', 'QT-1', '2026-03-29', ?, 'BR-KD', ?, ?)`
    ).run(id, status, registered ? 1 : 0, ref);
  }

  function insertJob({ jobId, cuttingListId, status }) {
    db.prepare(
      `INSERT INTO production_jobs (
         job_id, cutting_list_id, status, branch_id, created_at_iso, customer_name, quotation_ref
       ) VALUES (?, ?, ?, 'BR-KD', '2026-03-29T10:00:00.000Z', 'Acme', 'QT-1')`
    ).run(jobId, cuttingListId, status);
  }

  it('allows delete when the linked job is Cancelled even if list status was not updated', () => {
    insertList({ id: 'CL-A', status: 'In production', registered: 1, ref: 'JOB-A' });
    insertJob({ jobId: 'JOB-A', cuttingListId: 'CL-A', status: 'Cancelled' });

    const r = deleteCuttingListIfAllowed(db, 'CL-A');
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT id FROM cutting_lists WHERE id = ?`).get('CL-A')).toBeFalsy();
    expect(db.prepare(`SELECT job_id FROM production_jobs WHERE job_id = ?`).get('JOB-A')).toBeFalsy();
  });

  it('allows delete when cutting list status is Cancelled with production_registered still set', () => {
    insertList({ id: 'CL-B', status: 'Cancelled', registered: 1, ref: 'JOB-B' });
    insertJob({ jobId: 'JOB-B', cuttingListId: 'CL-B', status: 'Cancelled' });

    expect(deleteCuttingListIfAllowed(db, 'CL-B').ok).toBe(true);
  });

  it('blocks delete while the job is still Planned', () => {
    insertList({ id: 'CL-C', status: 'In production', registered: 1, ref: 'JOB-C' });
    insertJob({ jobId: 'JOB-C', cuttingListId: 'CL-C', status: 'Planned' });

    const r = deleteCuttingListIfAllowed(db, 'CL-C');
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/production activity/i);
  });

  it('blocks delete when production completed / finished', () => {
    insertList({ id: 'CL-D', status: 'Finished', registered: 1, ref: 'JOB-D' });
    insertJob({ jobId: 'JOB-D', cuttingListId: 'CL-D', status: 'Completed' });

    const r = deleteCuttingListIfAllowed(db, 'CL-D');
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/production activity/i);
  });
});
