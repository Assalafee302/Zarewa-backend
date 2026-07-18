import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { insertCuttingList, updateCuttingList } from './writeOps.js';
import { getCuttingList } from './readModel.js';

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

describe.skipIf(!mysqlOk)('cutting list draft finalize', () => {
  let db;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('insertCuttingList upgrades an existing draft when saving without draft flag', () => {
    db = createDatabase(':memory:');
    const draft = insertCuttingList(db, {
      quotationRef: 'QT-2026-006',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      draft: true,
      lines: [{ sheets: 2, lengthM: 5, lineType: 'Roof' }],
    });
    expect(draft.ok).toBe(true);
    expect(getCuttingList(db, draft.id)?.status).toBe('Draft');

    const finalized = insertCuttingList(db, {
      quotationRef: 'QT-2026-006',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      lines: [{ sheets: 2, lengthM: 5, lineType: 'Roof' }],
      totalMeters: 10,
    });
    expect(finalized.ok).toBe(true);
    expect(finalized.id).toBe(draft.id);
    const row = getCuttingList(db, draft.id);
    expect(row?.status).toBe('Waiting');
    expect(row?.totalMeters).toBe(10);
  });

  it('updateCuttingList finalize moves draft to Waiting', () => {
    db = createDatabase(':memory:');
    const draft = insertCuttingList(db, {
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      draft: true,
      lines: [{ sheets: 1, lengthM: 6, lineType: 'Roof' }],
    });
    expect(draft.ok).toBe(true);

    const finalized = updateCuttingList(db, draft.id, {
      finalize: true,
      lines: [{ sheets: 1, lengthM: 6, lineType: 'Roof' }],
      totalMeters: 6,
    });
    expect(finalized.ok).toBe(true);
    expect(getCuttingList(db, draft.id)?.status).toBe('Waiting');
  });

  it('updateCuttingList finalize accepts fractional total metres', () => {
    db = createDatabase(':memory:');
    const draft = insertCuttingList(db, {
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      draft: true,
      lines: [{ sheets: 3, lengthM: 4.5, lineType: 'Roof' }],
    });
    expect(draft.ok).toBe(true);

    const finalized = updateCuttingList(db, draft.id, {
      finalize: true,
      lines: [{ sheets: 3, lengthM: 4.5, lineType: 'Roof' }],
      totalMeters: 13.5,
    });
    expect(finalized.ok).toBe(true);
    expect(getCuttingList(db, draft.id)?.totalMeters).toBe(13.5);
  });

  it('rejects finalize when roof metres exceed quoted roofing metres', () => {
    db = createDatabase(':memory:');
    const draft = insertCuttingList(db, {
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      draft: true,
      lines: [{ sheets: 10, lengthM: 10, lineType: 'Roof' }],
    });
    expect(draft.ok).toBe(true);

    const blocked = updateCuttingList(db, draft.id, {
      finalize: true,
      lines: [{ sheets: 10, lengthM: 10, lineType: 'Roof' }],
      totalMeters: 100,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toMatch(/cutting_list/);
  });

  it('blocks non-admin edits after production completed, allows admin/MD', () => {
    db = createDatabase(':memory:');
    const created = insertCuttingList(db, {
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      lines: [{ sheets: 2, lengthM: 5, lineType: 'Roof' }],
      totalMeters: 10,
    });
    expect(created.ok).toBe(true);

    db.prepare(
      `INSERT INTO production_jobs (job_id, cutting_list_id, status, branch_id, created_at_iso)
       VALUES (?, ?, 'Completed', 'BR-YL', ?)`
    ).run('JOB-CL-DONE-1', created.id, new Date().toISOString());
    db.prepare(
      `UPDATE cutting_lists
       SET production_registered = 1, production_register_ref = ?, status = 'Finished'
       WHERE id = ?`
    ).run('JOB-CL-DONE-1', created.id);

    const blocked = updateCuttingList(
      db,
      created.id,
      { lines: [{ sheets: 3, lengthM: 5, lineType: 'Roof' }], totalMeters: 15 },
      { roleKey: 'sales_staff' }
    );
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error || '')).toMatch(/cannot be edited after production/i);

    const allowedAdmin = updateCuttingList(
      db,
      created.id,
      { lines: [{ sheets: 3, lengthM: 5, lineType: 'Roof' }], totalMeters: 15 },
      { roleKey: 'admin' }
    );
    expect(allowedAdmin.ok).toBe(true);
    expect(getCuttingList(db, created.id)?.totalMeters).toBe(15);

    const allowedMd = updateCuttingList(
      db,
      created.id,
      { lines: [{ sheets: 4, lengthM: 5, lineType: 'Roof' }], totalMeters: 20 },
      { roleKey: 'md' }
    );
    expect(allowedMd.ok).toBe(true);
    expect(getCuttingList(db, created.id)?.totalMeters).toBe(20);
  });
});
