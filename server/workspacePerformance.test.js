import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { buildWorkspaceRevision } from './workspaceRevision.js';
import { buildBootstrap } from './bootstrap.js';
import { buildSalesDomainSnapshot, buildFinanceDomainSnapshot, buildProcurementDomainSnapshot } from './domainBootstrap.js';
import { jsonWeakEtag } from './httpEtag.js';
import { insertAssociatedStaff, insertSupplier } from './writeOps.js';

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

  it('buildWorkspaceRevision changes when a cutting list leaves Draft', () => {
    const db = createDatabase(':memory:');
    const before = buildWorkspaceRevision(db, 'ALL').revision;
    const id = 'CL-REV-DRAFT-1';
    db.prepare(
      `INSERT INTO cutting_lists (
        id, customer_id, customer_name, quotation_ref, date_label, date_iso,
        sheets_to_cut, total_meters, total_label, status, handled_by, branch_id
      ) VALUES (?, 'CUS-001', 'Test', 'QT-2026-005', '29 Mar', '2026-03-29', 1, 6, '6 m', 'Draft', 'Sales', 'BR-YL')`
    ).run(id);
    const asDraft = buildWorkspaceRevision(db, 'ALL').revision;
    expect(asDraft).not.toBe(before);
    db.prepare(`UPDATE cutting_lists SET status = 'Waiting' WHERE id = ?`).run(id);
    const asWaiting = buildWorkspaceRevision(db, 'ALL').revision;
    expect(asWaiting).not.toBe(asDraft);
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
    expect(snap.bootstrapMeta?.sort?.customers).toBe('recent');
    expect(snap.bootstrapMeta?.backgroundHydrate).toEqual(
      expect.objectContaining({
        strategy: 'recent_first',
        enabled: expect.any(Boolean),
        resources: expect.any(Array),
      })
    );
    db.close();
  });

  it('finance domain snapshot includes receipts for cashier confirmation', () => {
    const db = createDatabase(':memory:', { seed: false });
    const snap = buildFinanceDomainSnapshot(db, { user: null, branchScope: 'ALL' });
    expect(snap.ok).toBe(true);
    expect(snap.domain).toBe('finance');
    expect(Array.isArray(snap.receipts)).toBe(true);
    expect(Array.isArray(snap.cuttingLists)).toBe(true);
    expect(Array.isArray(snap.purchasePaymentCashierAcksPending)).toBe(true);
    db.close();
  });

  it('procurement snapshot ships open AP lines for Purchases outstanding payments', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertSupplier(db, { supplierID: 'S1', name: 'Supplier 1' });
    db.exec(`
      INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id, supplier_paid_ngn)
      VALUES ('PO-AP-1', 'S1', 'Supplier 1', '2026-07-01', 'Approved', 'BR-KD', 10000);
      INSERT INTO purchase_order_lines (po_id, line_key, product_id, product_name, qty_ordered, qty_received, unit_price_ngn)
      VALUES ('PO-AP-1', 'L1', 'P1', 'Coil', 10, 0, 10000);
      INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso, payment_method)
      VALUES
        ('AP-OPEN-1', 'Supplier 1', 'PO-AP-1', 'INV-1', 100000, 10000, '2026-08-01', ''),
        ('AP-PAID-1', 'Supplier 1', 'PO-AP-1', 'INV-2', 50000, 50000, '2026-09-01', '');
    `);
    const user = {
      id: 'proc-1',
      roleKey: 'procurement',
      displayName: 'Procurement',
      permissions: ['procurement.view', 'purchase_orders.manage'],
    };
    const snap = buildProcurementDomainSnapshot(db, { user, branchScope: 'BR-KD' });
    expect(snap.ok).toBe(true);
    expect(snap.domain).toBe('procurement');
    expect(snap.accountsPayable.map((a) => a.apID)).toEqual(['AP-OPEN-1']);
    expect(snap.accountsPayable[0].outstandingNgn).toBe(90_000);
    expect(Array.isArray(snap.accountsPayable[0].lines)).toBe(true);
    expect(snap.outstandingPaymentLines.length).toBeGreaterThan(0);
    expect(snap.bootstrapMeta?.sort?.accountsPayable).toBe('outstanding_then_due_date_desc');
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
