import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildCutoverActionPlan } from './accountingCutoverPlanOps.js';
import { createDatabase } from './db.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';
import { ensureArchitecturalGlAccounts } from './accountingPostingOps.js';

describe('buildCutoverActionPlan (integration)', () => {
  let db;
  let ready = false;

  beforeAll(() => {
    try {
      db = createDatabase(':memory:', { seed: false });
      ensureGlSchema(db);
      seedDefaultGlAccounts(db);
      ensureArchitecturalGlAccounts(db);
      ready = true;
    } catch {
      ready = false;
    }
  });

  afterAll(() => {
    db?.close();
  });

  it('returns phased cutover plan with progress', ({ skip }) => {
    if (!ready) skip();
    const plan = buildCutoverActionPlan(db, 'ALL');
    expect(plan.ok).toBe(true);
    expect(plan.phases).toHaveLength(3);
    expect(plan.progressPct).toBeGreaterThanOrEqual(0);
    expect(plan.disclaimer).toMatch(/not statutory/i);
    expect(plan.phases[0].items.some((i) => i.id === 'opening_pack_ready')).toBe(true);
  });
});
