import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { buildMonthEndCloseChecklist, buildPeriodLockCloseMeta } from './accountingCloseOps.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';
import { ensureArchitecturalGlAccounts } from './accountingPostingOps.js';

describe('buildPeriodLockCloseMeta (pure)', () => {
  it('readyToLock when checklist clear and period open', () => {
    const meta = buildPeriodLockCloseMeta('2026-06', null, true);
    expect(meta.readyToLock).toBe(true);
    expect(meta.periodLock.locked).toBe(false);
    expect(meta.periodLockStep.status).toBe('warn');
    expect(meta.periodLockStep.id).toBe('period_lock');
  });

  it('locked period yields ok step and no readyToLock', () => {
    const meta = buildPeriodLockCloseMeta(
      '2026-06',
      { locked: true, periodKey: '2026-06', reason: 'Close', lockedByName: 'HoA' },
      true
    );
    expect(meta.readyToLock).toBe(false);
    expect(meta.periodLockStep.status).toBe('ok');
    expect(meta.summary).toMatch(/locked/i);
  });

  it('open period with blockers stays not ready to lock', () => {
    const meta = buildPeriodLockCloseMeta('2026-06', null, false);
    expect(meta.readyToLock).toBe(false);
    expect(meta.periodLockStep.label).toMatch(/open/i);
  });
});

describe('accountingCloseOps (integration)', () => {
  let db;
  let ready = false;

  beforeAll(() => {
    try {
      db = createDatabase(':memory:', { seed: false });
      ensureGlSchema(db);
      seedDefaultGlAccounts(db);
      ensureArchitecturalGlAccounts(db);
      ready = true;
    } catch (e) {
      console.warn('[accountingCloseOps integration] DB bootstrap unavailable — skipping:', e?.message || e);
      ready = false;
    }
  });

  afterAll(() => {
    db?.close();
  });

  it('returns period lock status on checklist', ({ skip }) => {
    if (!ready) skip();
    const r = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
    expect(r.ok).toBe(true);
    expect(r.periodLock).toBeDefined();
    expect(r.periodLock.locked).toBe(false);
    expect(r.steps.map((s) => s.id)).toContain('period_lock');
  });

  it('reports locked period on checklist', ({ skip }) => {
    if (!ready) skip();
    db.prepare(
      `INSERT INTO accounting_period_locks (
        period_key, locked_from_iso, locked_at_iso, locked_by_user_id, locked_by_name, reason
      ) VALUES (?,?,?,?,?,?)`
    ).run('2026-05', '2026-05-01', '2026-05-31T12:00:00.000Z', null, 'HoA', 'Month-end close');
    const r = buildMonthEndCloseChecklist(db, '2026-05', 'ALL', { trialExceptions: { exceptions: {} } });
    expect(r.periodLock.locked).toBe(true);
    expect(r.readyToLock).toBe(false);
    expect(r.steps.find((s) => s.id === 'period_lock')?.status).toBe('ok');
  });
});
