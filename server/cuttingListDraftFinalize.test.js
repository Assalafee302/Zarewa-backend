import { describe, it, expect, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { insertCuttingList, updateCuttingList } from './writeOps.js';
import { getCuttingList } from './readModel.js';

describe('cutting list draft finalize', () => {
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
});
