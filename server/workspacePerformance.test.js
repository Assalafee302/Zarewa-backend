import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { buildWorkspaceRevision } from './workspaceRevision.js';
import { buildBootstrap } from './bootstrap.js';
import { buildSalesDomainSnapshot, buildFinanceDomainSnapshot } from './domainBootstrap.js';
import { jsonWeakEtag } from './httpEtag.js';
import { insertAssociatedStaff } from './writeOps.js';

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

  it('full bootstrap ships associated staff and refund credit apps for refund-only users', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertAssociatedStaff(db, {
      id: 'AS-DRV-1',
      name: 'Driver One',
      staffType: 'Driver',
      status: 'Active',
    });
    const user = {
      id: 'refund-only-1',
      roleKey: 'custom',
      displayName: 'Refund Clerk',
      permissions: ['refunds.request'],
    };
    const session = { authenticated: true, user, permissions: user.permissions };
    const full = buildBootstrap(db, { user, session, branchScope: 'BR-KD', skipSideEffects: true });
    expect(full.ok).toBe(true);
    expect(full.customers).toEqual([]);
    expect(full.associatedStaff.some((s) => s.id === 'AS-DRV-1')).toBe(true);
    expect(Array.isArray(full.refundCreditApplications)).toBe(true);
    db.close();
  });
});
