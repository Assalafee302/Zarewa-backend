import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { permissionsForRole } from '../auth.js';
import {
  acknowledgePurchasePaymentCashierAck,
  ensurePurchasePaymentCashierAckSchema,
  insertPurchasePaymentCashierAckTx,
  listPurchasePaymentCashierAcks,
  listPurchasePaymentCashierAcksPending,
  getPurchasePaymentCashierAck,
  enrichPurchasePaymentCashierAcks,
  mapPurchasePaymentCashierAckRow,
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

function createMockDb({
  acks = [],
  movements = [],
  accounts = [],
  suppliers = [],
  pos = [],
  poLines = [],
  aps = [],
  branches = [],
} = {}) {
  return {
    prepare(sql) {
      const s = String(sql).trim();
      return {
        get(...args) {
          if (/SELECT 1 FROM/i.test(s)) return { 1: 1 };
          if (/FROM purchase_payment_cashier_acks WHERE ack_id = \?/i.test(s)) {
            return acks.find((a) => a.ack_id === args[0]) || null;
          }
          if (/FROM branches WHERE id = \?/i.test(s)) {
            return branches.find((b) => b.id === args[0]) || null;
          }
          return null;
        },
        all(...args) {
          if (/FROM purchase_payment_cashier_acks/i.test(s)) {
            return acks;
          }
          if (/FROM treasury_movements/i.test(s)) {
            return movements.map((m) => {
              const acct = accounts.find((a) => a.id === m.treasury_account_id) || {};
              return {
                movement_id: m.id,
                treasury_account_id: m.treasury_account_id,
                treasury_reference: m.reference,
                treasury_note: m.note,
                treasury_posted_at_iso: m.posted_at_iso,
                treasury_amount_ngn: m.amount_ngn,
                treasury_account_name: acct.name || '',
                treasury_bank_name: acct.bank_name || '',
                treasury_account_no: acct.acc_no || '',
                treasury_account_type: acct.type || '',
              };
            });
          }
          if (/FROM suppliers/i.test(s)) {
            return suppliers;
          }
          if (/FROM purchase_orders/i.test(s)) {
            return pos;
          }
          if (/FROM purchase_order_lines/i.test(s)) {
            return poLines;
          }
          if (/FROM accounts_payable/i.test(s)) {
            return aps;
          }
          return [];
        },
        run() {
          return { changes: 1 };
        },
      };
    },
    exec() {},
  };
}

describe('purchasePaymentCashierAckOps pure enrichment tests', () => {
  it('enriches acknowledgment with rich treasury, PO, lines, and supplier details', () => {
    const rawAck = {
      ack_id: 'PPCA-TEST-1',
      branch_id: 'BR-KD',
      treasury_movement_id: 'TM-PAY-100',
      source_kind: 'PURCHASE_ORDER',
      source_id: 'PO-2026-088',
      po_id: 'PO-2026-088',
      supplier_id: 'SUP-COIL-1',
      supplier_name: 'Standard Steel Ltd',
      amount_ngn: 3500000,
      paid_at_iso: '2026-09-15T14:30:00.000Z',
      paid_by_user_id: 'USR-MD',
      paid_by_name: 'Managing Director',
      status: 'Pending',
      created_at_iso: '2026-09-15T14:30:00.000Z',
    };

    const mockDb = createMockDb({
      acks: [rawAck],
      branches: [{ id: 'BR-KD', name: 'Kaduna Branch' }],
      accounts: [
        { id: 10, name: 'Zenith Main Corporate', bank_name: 'Zenith Bank PLC', acc_no: '1011223344', type: 'Bank' },
      ],
      movements: [
        {
          id: 'TM-PAY-100',
          treasury_account_id: 10,
          amount_ngn: 3500000,
          reference: 'ZEN-TRF-98765',
          note: 'Payment for August coil batch',
          posted_at_iso: '2026-09-15T14:30:00.000Z',
        },
      ],
      suppliers: [
        {
          supplier_id: 'SUP-COIL-1',
          name: 'Standard Steel Ltd',
          city: 'Lagos',
          payment_terms: '30% Advance, 70% on BL',
          notes: 'Top tier supplier',
          supplier_profile_json: JSON.stringify({ phone: '08031234567' }),
        },
      ],
      pos: [
        {
          po_id: 'PO-2026-088',
          supplier_id: 'SUP-COIL-1',
          supplier_name: 'Standard Steel Ltd',
          order_date_iso: '2026-08-20',
          expected_delivery_iso: '2026-09-18',
          status: 'in transit',
          invoice_no: 'INV-SSL-5432',
          invoice_date_iso: '2026-08-25',
          delivery_date_iso: '2026-09-18',
          transport_agent_name: 'Kano Haulage Logistics',
          transport_amount_ngn: 300000,
          transport_paid_ngn: 150000,
          supplier_paid_ngn: 3500000,
        },
      ],
      poLines: [
        {
          po_id: 'PO-2026-088',
          line_key: 'L1',
          product_id: 'COIL-ALU',
          product_name: 'Aluminum Coil',
          color: 'Wine Red',
          gauge: '0.50mm',
          qty_ordered: 5000,
          qty_received: 0,
          unit_price_per_kg_ngn: 1200,
          unit_price_ngn: 0,
          line_type: 'Coil',
        },
        {
          po_id: 'PO-2026-088',
          line_key: 'L2',
          product_id: 'COIL-ALU',
          product_name: 'Aluminum Coil',
          color: 'Traffic Black',
          gauge: '0.45mm',
          qty_ordered: 4000,
          qty_received: 0,
          unit_price_per_kg_ngn: 1100,
          unit_price_ngn: 0,
          line_type: 'Coil',
        },
      ],
    });

    const mapped = mapPurchasePaymentCashierAckRow(rawAck);
    const enriched = enrichPurchasePaymentCashierAcks(mockDb, [mapped])[0];

    // Branch & Source labels
    expect(enriched.branchName).toBe('Kaduna Branch');
    expect(enriched.sourceLabel).toBe('Purchase Order PO-2026-088');

    // Treasury details
    expect(enriched.treasuryAccountId).toBe(10);
    expect(enriched.treasuryAccountName).toBe('Zenith Main Corporate');
    expect(enriched.treasuryBankName).toBe('Zenith Bank PLC');
    expect(enriched.treasuryAccountNo).toBe('1011223344');
    expect(enriched.treasuryAccountType).toBe('Bank');
    expect(enriched.paymentReference).toBe('ZEN-TRF-98765');
    expect(enriched.paymentNote).toBe('Payment for August coil batch');

    // Supplier details
    expect(enriched.supplierCity).toBe('Lagos');
    expect(enriched.supplierPaymentTerms).toBe('30% Advance, 70% on BL');
    expect(enriched.supplierPhone).toBe('08031234567');

    // PO details
    expect(enriched.poStatus).toBe('in transit');
    expect(enriched.poOrderDateISO).toBe('2026-08-20');
    expect(enriched.poExpectedDeliveryISO).toBe('2026-09-18');
    expect(enriched.poInvoiceNo).toBe('INV-SSL-5432');
    expect(enriched.poInvoiceDateISO).toBe('2026-08-25');
    expect(enriched.poLinesCount).toBe(2);
    expect(enriched.poOrderedValueNgn).toBe(10400000);
    expect(enriched.poSupplierPaidNgn).toBe(3500000);
    expect(enriched.poBalanceRemainingNgn).toBe(6900000);
    expect(enriched.transportAgentName).toBe('Kano Haulage Logistics');
    expect(enriched.transportAmountNgn).toBe(300000);
    expect(enriched.transportPaidNgn).toBe(150000);
    expect(enriched.poItemsSummary).toContain('0.50mm Wine Red');
    expect(enriched.poItemsSummary).toContain('0.45mm Traffic Black');
    expect(enriched.poLines).toHaveLength(2);
  });

  it('enriches Accounts Payable acknowledgments with AP invoice details', () => {
    const rawAck = {
      ack_id: 'PPCA-TEST-AP',
      branch_id: 'BR-KD',
      treasury_movement_id: 'TM-AP-1',
      source_kind: 'ACCOUNTS_PAYABLE',
      source_id: 'AP-901',
      ap_id: 'AP-901',
      supplier_name: 'Metal Suppliers Ltd',
      amount_ngn: 1000000,
      paid_at_iso: '2026-09-20T10:00:00.000Z',
      status: 'Pending',
    };

    const mockDb = createMockDb({
      acks: [rawAck],
      aps: [
        {
          ap_id: 'AP-901',
          supplier_name: 'Metal Suppliers Ltd',
          po_ref: 'PO-OLD-1',
          invoice_ref: 'INV-MS-009',
          amount_ngn: 1500000,
          paid_ngn: 1000000,
          due_date_iso: '2026-10-01',
          payment_method: 'Bank Transfer',
        },
      ],
    });

    const mapped = mapPurchasePaymentCashierAckRow(rawAck);
    const enriched = enrichPurchasePaymentCashierAcks(mockDb, [mapped])[0];

    expect(enriched.sourceLabel).toBe('Accounts Payable AP-901 (Inv: INV-MS-009)');
    expect(enriched.apInvoiceRef).toBe('INV-MS-009');
    expect(enriched.apDueDateISO).toBe('2026-10-01');
    expect(enriched.apTotalAmountNgn).toBe(1500000);
    expect(enriched.apPaidNgn).toBe(1000000);
    expect(enriched.apBalanceRemainingNgn).toBe(500000);
    expect(enriched.apPaymentMethod).toBe('Bank Transfer');
  });

  it('enriches supplier overpayment / advance with formatted source label', () => {
    const rawAck = {
      ack_id: 'PPCA-TEST-OVERPAY',
      branch_id: 'BR-KD',
      treasury_movement_id: 'TM-ADV-1',
      source_kind: 'SUPPLIER_OVERPAYMENT',
      source_id: 'PO-ADV-10',
      po_id: 'PO-ADV-10',
      supplier_name: 'Steel Works',
      amount_ngn: 500000,
      paid_at_iso: '2026-09-20T10:00:00.000Z',
      status: 'Pending',
    };

    const mockDb = createMockDb({
      acks: [rawAck],
      pos: [
        {
          po_id: 'PO-ADV-10',
          supplier_name: 'Steel Works',
          status: 'ordered',
        },
      ],
    });

    const mapped = mapPurchasePaymentCashierAckRow(rawAck);
    const enriched = enrichPurchasePaymentCashierAcks(mockDb, [mapped])[0];

    expect(enriched.sourceLabel).toBe('Supplier Advance / Excess Payment (PO-ADV-10)');
    expect(enriched.poStatus).toBe('ordered');
  });

  it('handles missing relations gracefully without crashing', () => {
    const rawAck = {
      ack_id: 'PPCA-TEST-EMPTY',
      branch_id: 'BR-KD',
      treasury_movement_id: 'TM-MISSING',
      source_kind: 'PURCHASE_ORDER',
      source_id: 'PO-MISSING',
      amount_ngn: 10000,
      paid_at_iso: '2026-09-20T10:00:00.000Z',
      status: 'Pending',
    };

    const mockDb = createMockDb();
    const mapped = mapPurchasePaymentCashierAckRow(rawAck);
    const enriched = enrichPurchasePaymentCashierAcks(mockDb, [mapped])[0];

    expect(enriched.ackId).toBe('PPCA-TEST-EMPTY');
    expect(enriched.treasuryAccountName).toBe('');
    expect(enriched.paymentReference).toBe('');
    expect(enriched.supplierPhone).toBe('');
    expect(enriched.poOrderedValueNgn).toBe(0);
    expect(enriched.poLines).toEqual([]);
    expect(enriched.poItemsSummary).toBe('');
  });

  it('formats poItemsSummary with multiple items properly', () => {
    const rawAck = {
      ack_id: 'PPCA-TEST-MULTI',
      branch_id: 'BR-KD',
      treasury_movement_id: 'TM-M',
      source_kind: 'PURCHASE_ORDER',
      source_id: 'PO-MULTI',
      po_id: 'PO-MULTI',
      amount_ngn: 10000,
      paid_at_iso: '2026-09-20T10:00:00.000Z',
    };

    const mockDb = createMockDb({
      acks: [rawAck],
      pos: [{ po_id: 'PO-MULTI' }],
      poLines: [
        { po_id: 'PO-MULTI', line_key: 'L1', product_name: 'Coil A', gauge: '0.50mm', color: 'Blue', qty_ordered: 1000, line_type: 'Coil' },
        { po_id: 'PO-MULTI', line_key: 'L2', product_name: 'Coil B', gauge: '0.45mm', color: 'Red', qty_ordered: 2000, line_type: 'Coil' },
        { po_id: 'PO-MULTI', line_key: 'L3', product_name: 'Ridge Cap', qty_ordered: 50, line_type: 'Accessory' },
        { po_id: 'PO-MULTI', line_key: 'L4', product_name: 'Valley Gutter', qty_ordered: 30, line_type: 'Accessory' },
      ],
    });

    const mapped = mapPurchasePaymentCashierAckRow(rawAck);
    const enriched = enrichPurchasePaymentCashierAcks(mockDb, [mapped])[0];

    expect(enriched.poLinesCount).toBe(4);
    expect(enriched.poItemsSummary).toContain('and 2 more item(s)');
  });
});

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

describe.skipIf(!mysqlOk)('purchasePaymentCashierAckOps integration with DB', () => {
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

  it('lists with status filters', () => {
    const a1 = insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-FL1',
      branchId: 'BR-KD',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: 'PO-FL1',
      amountNgn: 50_000,
      paidAtISO: '2026-09-01T10:00:00.000Z',
    });
    const a2 = insertPurchasePaymentCashierAckTx(db, {
      treasuryMovementId: 'TM-FL2',
      branchId: 'BR-KD',
      sourceKind: 'PURCHASE_ORDER',
      sourceId: 'PO-FL2',
      amountNgn: 75_000,
      paidAtISO: '2026-09-02T10:00:00.000Z',
    });

    acknowledgePurchasePaymentCashierAck(db, a1.ackId, {
      actor: cashierActor(),
      workspaceBranchId: 'BR-KD',
    });

    const pending = listPurchasePaymentCashierAcks(db, 'BR-KD', { status: 'Pending' });
    expect(pending.some((p) => p.ackId === a2.ackId)).toBe(true);

    const acknowledged = listPurchasePaymentCashierAcks(db, 'BR-KD', { status: 'Acknowledged' });
    expect(acknowledged.some((p) => p.ackId === a1.ackId)).toBe(true);

    const all = listPurchasePaymentCashierAcks(db, 'BR-KD', { status: 'ALL' });
    expect(all.length).toBeGreaterThanOrEqual(2);
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
