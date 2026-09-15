import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { permissionsForRole } from '../auth.js';
import {
  acknowledgePurchasePaymentCashierAck,
  ensurePurchasePaymentCashierAckSchema,
  insertPurchasePaymentCashierAckTx,
  listPurchasePaymentCashierAcksPending,
} from './purchasePaymentCashierAckOps.js';
import { recordSupplierPayment } from '../writeOps.js';

function mdActor() {
  return {
    id: 'USR-MD',
    displayName: 'Managing Director',
    roleKey: 'md',
    permissions: permissionsForRole('md'),
  };
}

function cashierActor() {
  return {
    id: 'USR-CASH',
    displayName: 'Branch Cashier',
    roleKey: 'cashier',
    permissions: permissionsForRole('cashier'),
  };
}

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

describe.skipIf(!mysqlOk)('purchasePaymentCashierAckOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    ensurePurchasePaymentCashierAckSchema(db);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('skips insert without treasury movement or branch', () => {
    expect(
      insertPurchasePaymentCashierAckTx(db, {
        amountNgn: 1000,
        sourceKind: 'PURCHASE_ORDER',
        sourceId: 'PO-1',
      }).skipped
    ).toBe(true);
    expect(listPurchasePaymentCashierAcksPending(db, 'ALL')).toEqual([]);
  });

  it('lists pending by branch and acknowledges once', () => {
    const a = insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-1',
      branchId: 'BR-YOL',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: 'PO-1',
      poId: 'PO-1',
      supplierName: 'Acme Coils',
      amountNgn: 250_000,
      paidAtISO: '2026-09-15T10:00:00.000Z',
      paidByName: 'Managing Director',
    });
    expect(a.ok).toBe(true);
    insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-2',
      branchId: 'BR-KD',
      sourceKind: 'ACCOUNTS_PAYABLE',
      sourceId: 'AP-1',
      apId: 'AP-1',
      supplierName: 'Other',
      amountNgn: 10_000,
      paidAtISO: '2026-09-15T11:00:00.000Z',
    });

    const yol = listPurchasePaymentCashierAcksPending(db, 'BR-YOL');
    expect(yol).toHaveLength(1);
    expect(yol[0].supplierName).toBe('Acme Coils');
    expect(yol[0].amountNgn).toBe(250_000);

    const dup = insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-1',
      branchId: 'BR-YOL',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: 'PO-1',
      amountNgn: 250_000,
    });
    expect(dup.skipped).toBe(true);

    const ack = acknowledgePurchasePaymentCashierAck(db, a.ackId, {
      actor: cashierActor(),
      workspaceBranchId: 'BR-YOL',
    });
    expect(ack.ok).toBe(true);
    expect(ack.ack.status).toBe('Acknowledged');
    expect(listPurchasePaymentCashierAcksPending(db, 'BR-YOL')).toHaveLength(0);

    const again = acknowledgePurchasePaymentCashierAck(db, a.ackId, {
      actor: cashierActor(),
      workspaceBranchId: 'BR-YOL',
    });
    expect(again.ok).toBe(true);
    expect(again.alreadyAcknowledged).toBe(true);
  });

  it('blocks cross-branch acknowledge without cross-branch permission', () => {
    const a = insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-X',
      branchId: 'BR-YOL',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: 'PO-X',
      amountNgn: 5_000,
      paidAtISO: '2026-09-15T12:00:00.000Z',
    });
    const r = acknowledgePurchasePaymentCashierAck(db, a.ackId, {
      actor: cashierActor(),
      workspaceBranchId: 'BR-KD',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('creates Pending ack when supplier payment posts treasury', () => {
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES (?,?,?,?,?,?,?)`
    ).run('HQ Bank', 'Test Bank', 5_000_000, 'Bank', 'ACC-1', 'BR-YOL', 5_000_000);
    const treasuryAccountId = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id DESC LIMIT 1`).get()?.id;
    expect(treasuryAccountId).toBeTruthy();

    db.prepare(
      `INSERT INTO purchase_orders (
        po_id, supplier_id, supplier_name, order_date_iso, status, supplier_paid_ngn, branch_id
      ) VALUES (?,?,?,?,?,?,?)`
    ).run('PO-ACK-1', 'SUP-1', 'Coil Supplier', '2026-09-15', 'ordered', 0, 'BR-YOL');

    const r = recordSupplierPayment(db, 'PO-ACK-1', 100_000, 'Wire', {
      treasuryAccountId,
      dateISO: '2026-09-15',
      actor: mdActor(),
      workspaceBranchId: 'BR-YOL',
      createdBy: 'Managing Director',
    });
    expect(r.ok).toBe(true);
    const pending = listPurchasePaymentCashierAcksPending(db, 'BR-YOL');
    expect(pending.some((p) => p.poId === 'PO-ACK-1' && p.amountNgn === 100_000)).toBe(true);
  });

  it('skips ack when supplier payment has no treasury account', () => {
    db.prepare(
      `INSERT INTO purchase_orders (
        po_id, supplier_id, supplier_name, order_date_iso, status, supplier_paid_ngn, branch_id
      ) VALUES (?,?,?,?,?,?,?)`
    ).run('PO-ACK-2', 'SUP-1', 'Coil Supplier', '2026-09-15', 'ordered', 0, 'BR-YOL');

    const before = listPurchasePaymentCashierAcksPending(db, 'ALL').length;
    const r = recordSupplierPayment(db, 'PO-ACK-2', 50_000, 'Book only', {
      actor: mdActor(),
      workspaceBranchId: 'BR-YOL',
      dateISO: '2026-09-15',
    });
    expect(r.ok).toBe(true);
    expect(listPurchasePaymentCashierAcksPending(db, 'ALL').length).toBe(before);
  });
});
