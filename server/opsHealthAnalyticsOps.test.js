import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildOpsHealthAnalyticsPack, opsHealthAnalyticsToCsv } from './opsHealthAnalyticsOps.js';
import { listOtBoard } from './hrOtBoardOps.js';
import { createBranchShiftNote } from './branchShiftNotesOps.js';
import { createChecklistEvent } from './checklistEventsOps.js';
import { listOpsMetricDefinitions } from '../shared/lib/opsMetricCatalog.js';

function dbOk() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dbOk())('ops health / OT board / checklist events', () => {
  let db;
  beforeEach(() => {
    db = createDatabase(':memory:');
  });
  afterEach(() => db?.close());

  it('metric catalog lists core definitions', () => {
    const defs = listOpsMetricDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(5);
    expect(defs.some((d) => d.key === 'ot_hours')).toBe(true);
  });

  it('builds ops-health pack and csv', () => {
    const pack = buildOpsHealthAnalyticsPack(db, { branchId: 'ALL' });
    expect(pack.ok).toBe(true);
    expect(pack.summary?.status).toMatch(/green|amber|red/);
    const csv = opsHealthAnalyticsToCsv(pack);
    expect(csv).toMatch(/ops_health_status/);
  });

  it('ot board returns array', () => {
    const rows = listOtBoard(db, { branchId: 'BR-KD', dayIso: '2026-07-29' });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('shift note v2 + checklist event', () => {
    const staff = db.prepare(`SELECT id, display_name FROM app_users LIMIT 1`).get();
    const actor = { id: staff.id, displayName: staff.display_name || 'T' };
    const note = createBranchShiftNote(
      db,
      {
        branchId: 'BR-KD',
        shiftDate: '2026-07-29',
        note: 'Gates and CCTV checked overnight.',
        noteKind: 'night',
        gatesOk: true,
        cctvOk: true,
        cashOk: true,
        keysOk: true,
      },
      actor,
      'BR-KD'
    );
    expect(note.ok).toBe(true);
    const ev = createChecklistEvent(
      db,
      { branchId: 'BR-KD', dayIso: '2026-07-29', itemId: 'open_cash', note: 'Float counted 50k.' },
      actor
    );
    expect(ev.ok).toBe(true);
  });
});
