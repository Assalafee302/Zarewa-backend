import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildAp2ApRebuildPreview,
  applyAp2ReceivedBasisRebuild,
} from './ap2ApRebuildOps.js';
import { syncAccountsPayableFromPurchaseOrder } from './writeOps.js';
import * as featureFlags from './financeFeatureFlags.js';

function seedPo(db) {
  db.exec(`
    INSERT INTO purchase_orders (
      po_id, supplier_id, supplier_name, order_date_iso, status, branch_id, supplier_paid_ngn
    ) VALUES (
      'PO-AP2B-1', 'SUP-1', 'Steel Co', '2026-06-01', 'Approved', 'BR-KD', 500000
    );
    INSERT INTO purchase_order_lines (
      po_id, line_key, product_id, product_name, unit_price_ngn, qty_ordered, qty_received, line_type
    ) VALUES (
      'PO-AP2B-1', 'L1', 'P1', 'Coil', 100000, 10, 6, 'coil'
    );
    INSERT INTO accounts_payable (
      ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso
    ) VALUES (
      'AP-PO-PO-AP2B-1', 'Steel Co', 'PO-AP2B-1', 'INV-1', 1000000, 500000, '2026-06-30'
    );
    INSERT INTO accounts_payable (
      ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso
    ) VALUES (
      'AP-MANUAL-1', 'Steel Co', 'PO-AP2B-1', 'INV-M', 50000, 0, '2026-06-30'
    );
  `);
}

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('ap2ApRebuild', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    seedPo(db);
    vi.spyOn(featureFlags, 'readFinanceFeatureFlags').mockReturnValue({
      apReceivedBasisEnabled: false,
      apReceivedBasisRebuildEnabled: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it('preview calculates ordered and received values', () => {
    const p = buildAp2ApRebuildPreview(db, {});
    expect(p.status).toBe('preview_only');
    const row = p.rows.find((r) => r.poId === 'PO-AP2B-1');
    expect(row.orderedValueNgn).toBe(1_000_000);
    expect(row.receivedValueNgn).toBe(600_000);
  });

  it('preview calculates expected AP from received value', () => {
    const p = buildAp2ApRebuildPreview(db, {});
    const row = p.rows.find((r) => r.poId === 'PO-AP2B-1');
    expect(row.expectedApNgn).toBe(100_000);
    expect(row.proposedApNgn).toBe(600_000);
  });

  it('preview detects supplier advance when paid exceeds received', () => {
    db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = 800000 WHERE po_id = 'PO-AP2B-1'`).run();
    const p = buildAp2ApRebuildPreview(db, {});
    const row = p.rows.find((r) => r.poId === 'PO-AP2B-1');
    expect(row.supplierAdvanceNgn).toBe(200_000);
    expect(row.proposedApNgn).toBe(0);
    expect(row.riskFlags).toContain('supplier_advance');
  });

  it('preview detects AP amount delta', () => {
    const p = buildAp2ApRebuildPreview(db, {});
    const row = p.rows.find((r) => r.poId === 'PO-AP2B-1');
    expect(row.apDifferenceNgn).toBe(400_000);
    expect(p.summary.affectedPoCount).toBe(1);
  });

  it('rebuild requires preview hash', () => {
    const result = applyAp2ReceivedBasisRebuild(db, { id: 'u1', displayName: 'HoA' }, {
      confirmPreviewHash: 'bad',
      approvalNote: 'Reviewed',
      dryRunAccepted: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PREVIEW_STALE');
  });

  it('rebuild requires approval note', () => {
    const preview = buildAp2ApRebuildPreview(db, {});
    const result = applyAp2ReceivedBasisRebuild(db, { id: 'u1', displayName: 'HoA' }, {
      confirmPreviewHash: preview.previewHash,
      approvalNote: '',
      dryRunAccepted: true,
    });
    expect(result.ok).toBe(false);
  });

  it('rebuild updates only AP-PO rows not manual AP', () => {
    const preview = buildAp2ApRebuildPreview(db, {});
    const result = applyAp2ReceivedBasisRebuild(db, { id: 'u1', displayName: 'HoA' }, {
      confirmPreviewHash: preview.previewHash,
      approvalNote: 'Head of Accounts approved received basis.',
      dryRunAccepted: true,
    });
    expect(result.ok).toBe(true);
    const auto = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE ap_id = 'AP-PO-PO-AP2B-1'`).get();
    const manual = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE ap_id = 'AP-MANUAL-1'`).get();
    expect(auto.amount_ngn).toBe(600_000);
    expect(manual.amount_ngn).toBe(50_000);
    const audit = db
      .prepare(`SELECT action FROM audit_log WHERE action = 'ap.received_basis.rebuilt'`)
      .all();
    expect(audit.length).toBe(1);
  });

  it('paid greater than received sets AP amount zero', () => {
    db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = 900000 WHERE po_id = 'PO-AP2B-1'`).run();
    const preview = buildAp2ApRebuildPreview(db, {});
    applyAp2ReceivedBasisRebuild(db, { id: 'u1', displayName: 'HoA' }, {
      confirmPreviewHash: preview.previewHash,
      approvalNote: 'Advance risk noted.',
      dryRunAccepted: true,
    });
    const auto = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE ap_id = 'AP-PO-PO-AP2B-1'`).get();
    expect(auto.amount_ngn).toBe(0);
  });

  it('flag off sync uses ordered basis', () => {
    vi.spyOn(featureFlags, 'readFinanceFeatureFlags').mockReturnValue({
      apReceivedBasisEnabled: false,
      apReceivedBasisRebuildEnabled: false,
    });
    syncAccountsPayableFromPurchaseOrder(db, 'PO-AP2B-1');
    const auto = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE ap_id = 'AP-PO-PO-AP2B-1'`).get();
    expect(auto.amount_ngn).toBe(1_000_000);
  });

  it('flag on sync uses received basis', () => {
    vi.spyOn(featureFlags, 'readFinanceFeatureFlags').mockReturnValue({
      apReceivedBasisEnabled: true,
      apReceivedBasisRebuildEnabled: false,
    });
    syncAccountsPayableFromPurchaseOrder(db, 'PO-AP2B-1');
    const auto = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE ap_id = 'AP-PO-PO-AP2B-1'`).get();
    expect(auto.amount_ngn).toBe(600_000);
  });

  it('rebuild does not insert GL journals', () => {
    const preview = buildAp2ApRebuildPreview(db, {});
    applyAp2ReceivedBasisRebuild(db, { id: 'u1', displayName: 'HoA' }, {
      confirmPreviewHash: preview.previewHash,
      approvalNote: 'OK',
      dryRunAccepted: true,
    });
    let glCount = 0;
    try {
      glCount = db.prepare(`SELECT COUNT(*) AS c FROM gl_journal_entries`).get()?.c ?? 0;
    } catch {
      glCount = 0;
    }
    expect(glCount).toBe(0);
  });
});
