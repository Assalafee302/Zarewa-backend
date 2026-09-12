import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { buildWorkspaceRevision } from './workspaceRevision.js';
import { SHELL_DEFERRED_DESK_ARRAYS } from './bootstrap.js';
import { buildSalesDomainSnapshot, buildFinanceDomainSnapshot } from './domainBootstrap.js';
import { jsonWeakEtag } from './httpEtag.js';

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

describe('shell first-paint contract', () => {
  it('ships reference data on the shell rather than deferring it', () => {
    // Regression guard, not a tautology: treasuryAccounts sat in this list alongside the
    // thousand-row registers, so a cashier could not pick a bank until the entire sales
    // desk pack had downloaded. It is a dozen rows of reference data — if it ever goes
    // back in here, the receipt screen silently gets slow again on a mill link.
    expect(SHELL_DEFERRED_DESK_ARRAYS).not.toContain('treasuryAccounts');
    // Same reasoning: a few dozen rows of reference data that every procurement screen
    // needs, and an empty supplier picker reads as "no suppliers exist".
    expect(SHELL_DEFERRED_DESK_ARRAYS).not.toContain('suppliers');
    expect(SHELL_DEFERRED_DESK_ARRAYS).not.toContain('transportAgents');
  });

  it('still defers the registers that actually are large', () => {
    for (const k of ['customers', 'quotations', 'receipts', 'ledgerEntries', 'treasuryMovements']) {
      expect(SHELL_DEFERRED_DESK_ARRAYS).toContain(k);
    }
  });
});

describe('httpEtag', () => {
  it('jsonWeakEtag is deterministic', () => {
    const payload = { ok: true, n: 1 };
    expect(jsonWeakEtag(payload)).toBe(jsonWeakEtag(payload));
  });
});

describe.skipIf(!mysqlOk)('workspace performance helpers', () => {
  it('buildWorkspaceRevision returns revision payload on empty db', () => {
    const db = createDatabase(':memory:', { seed: false });
    const rev = buildWorkspaceRevision(db, 'ALL');
    expect(rev.ok).toBe(true);
    expect(typeof rev.revision).toBe('string');
    expect(rev.revision.length).toBeGreaterThan(8);
    db.close();
  });

  it('sales domain snapshot includes associated staff for refund payout allocation', () => {
    const db = createDatabase(':memory:', { seed: false });
    const snap = buildSalesDomainSnapshot(db, { user: null, branchScope: 'ALL' });
    expect(snap.ok).toBe(true);
    expect(snap.domain).toBe('sales');
    expect(Array.isArray(snap.customers)).toBe(true);
    expect(Array.isArray(snap.associatedStaff)).toBe(true);
    expect(Array.isArray(snap.treasuryAccounts)).toBe(true);
    expect(snap.associatedStaffPolicy).toEqual({ enabled: false });
    expect(snap.masterData).toEqual(
      expect.objectContaining({
        gauges: expect.any(Array),
        materialTypes: expect.any(Array),
      })
    );
    expect(snap).not.toHaveProperty('productionJobs');
    db.close();
  });

  it('finance domain snapshot includes receipts for cashier confirmation', () => {
    const db = createDatabase(':memory:', { seed: false });
    const snap = buildFinanceDomainSnapshot(db, { user: null, branchScope: 'ALL' });
    expect(snap.ok).toBe(true);
    expect(snap.domain).toBe('finance');
    expect(Array.isArray(snap.receipts)).toBe(true);
    expect(Array.isArray(snap.cuttingLists)).toBe(true);
    db.close();
  });
});
