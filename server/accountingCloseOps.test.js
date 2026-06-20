import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';
import { ensureArchitecturalGlAccounts } from './accountingPostingOps.js';

describe('accountingCloseOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
    ensureArchitecturalGlAccounts(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns period lock status on checklist', () => {
    const r = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
    expect(r.ok).toBe(true);
    expect(r.periodLock).toBeDefined();
    expect(r.periodLock.locked).toBe(false);
    expect(r.steps.map((s) => s.id)).toContain('period_lock');
  });

  it('marks readyToLock when checks pass and period is open', () => {
    const r = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
    if (r.ready) {
      expect(r.readyToLock).toBe(true);
    } else {
      expect(r.readyToLock).toBe(false);
    }
  });

  it('reports locked period on checklist', () => {
    db.prepare(
      `INSERT INTO accounting_period_locks (
        period_key, locked_from_iso, locked_at_iso, locked_by_user_id, locked_by_name, reason
      ) VALUES (?,?,?,?,?,?)`
    ).run('2026-06', '2026-06-01', '2026-06-30T12:00:00.000Z', null, 'HoA', 'Month-end close');
    const r = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
    expect(r.periodLock.locked).toBe(true);
    expect(r.readyToLock).toBe(false);
    const lockStep = r.steps.find((s) => s.id === 'period_lock');
    expect(lockStep?.status).toBe('ok');
  });
});
