/**
 * Phase 3 controls — one short case per control on the local test schema (zarewa_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import {
  confirmGrn,
  insertCustomer,
  insertPurchaseOrder,
  insertSupplier,
  validateQuotationProductionPaymentGate,
} from './writeOps.js';
import { appendAuditLog } from './controlOps.js';
import { listBalanceDueAfterProduction, listLockedPeriodChanges, receiptAdvanceRepeats } from './controlsPhase3Ops.js';
import { listCoilLots, getPurchaseOrder } from './readModel.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';

const mysqlOk = isMysqlAvailableForTests();
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!mysqlOk)('Phase 3 controls (local test schema)', () => {
  let db;
  let cust;
  let acct;

  beforeAll(() => {
    db = createDatabase(':memory:', { seed: false });
    cust = insertCustomer(db, { name: 'Mal Sani', phoneNumber: '08030000001' }, 'BR-KD');
    acct = Number(
      db
        .prepare(`INSERT INTO treasury_accounts (name, type, branch_id) VALUES ('GTB Kaduna', 'Bank', 'BR-KD')`)
        .run().lastInsertRowid
    );
    if (!acct) acct = Number(db.prepare(`SELECT MAX(id) AS id FROM treasury_accounts`).get().id);
    insertSupplier(db, { supplierID: 'S-KD', name: 'Kaduna Mill' });
    for (const [id, name] of [
      ['COIL-ALU', 'Aluminium coil'],
      ['PRD-102', 'Aluzinc coil'],
    ]) {
      db.prepare(`INSERT INTO products (product_id, name, stock_level, unit, branch_id) VALUES (?, ?, 0, 'kg', '')`).run(
        id,
        name
      );
    }
  }, 180000);

  afterAll(() => db?.close?.());

  const quote = (id, total) =>
    db
      .prepare(
        `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, status, branch_id, lines_json)
         VALUES (?, ?, 'Mal Sani', '2026-10-01', ?, ?, 'Approved', 'BR-KD', '{}')`
      )
      .run(id, cust, total, total);
  const receipt = (id, qid, amount) => {
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, ledger_entry_id, branch_id)
       VALUES (?, ?, 'Mal Sani', ?, '2026-10-02', ?, 'Posted', ?, 'BR-KD')`
    ).run(id, cust, qid, amount, `LE-${id}`);
  };
  const tm = (id, type, amount, sourceId, reverses = null) =>
    db
      .prepare(
        `INSERT INTO treasury_movements (id, posted_at_iso, type, treasury_account_id, amount_ngn, counterparty_id, source_kind, source_id, reverses_movement_id)
         VALUES (?, '2026-10-02T12:00:00', ?, ?, ?, ?, 'LEDGER_RECEIPT', ?, ?)`
      )
      .run(id, type, acct, amount, cust, sourceId, reverses);

  it('1. gate: paid net of a treasury reversal blocks below 70%; BM override with reason lets it through', () => {
    quote('QT-P3-1', 1000000);
    receipt('RC-P3-1', 'QT-P3-1', 800000);
    tm('TM-P3-1', 'RECEIPT_IN', 500000, 'LE-RC-P3-1');
    tm('TM-P3-2', 'RECEIPT_IN', 300000, 'LE-RC-P3-1');
    expect(validateQuotationProductionPaymentGate(db, 'QT-P3-1').ok).toBe(true);

    // quotations.paid_ngn still says ₦1,000,000; the reversal takes paid to ₦500,000 = 50%.
    tm('TM-P3-3', 'RECEIPT_REVERSAL_OUT', -300000, 'LE-RC-P3-1', 'TM-P3-2');
    const blocked = validateQuotationProductionPaymentGate(db, 'QT-P3-1');
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('PRODUCTION_GATE_BELOW_MIN_PAID');
    expect(blocked.paidNgn).toBe(500000);

    db.prepare(
      `UPDATE quotations SET manager_production_approved_at_iso = ?, manager_production_approval_level = 'branch_manager',
       manager_production_approval_note = 'Customer pays balance on delivery' WHERE id = 'QT-P3-1'`
    ).run(`${today}T09:00:00`);
    expect(validateQuotationProductionPaymentGate(db, 'QT-P3-1').ok).toBe(true);
  });

  it('1b. balance due after production lists the produced job with the amount owed', () => {
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, customer_name, status, created_at_iso, completed_at_iso, branch_id)
       VALUES ('PRO-P3-1', 'QT-P3-1', 'Mal Sani', 'Completed', '2026-10-03', '2026-10-04T15:00:00', 'BR-KD')`
    ).run();
    const { rows } = listBalanceDueAfterProduction(db, 'BR-KD');
    const r = rows.find((x) => x.quotationRef === 'QT-P3-1');
    expect(r).toMatchObject({ totalNgn: 1000000, paidNgn: 500000, owedNgn: 500000, jobIDs: ['PRO-P3-1'] });
  });

  it('2. receipt line repeating an unapplied advance is caught (TM-KD-26-1499)', () => {
    db.prepare(
      `INSERT INTO ledger_entries (id, at_iso, type, customer_id, customer_name, amount_ngn, branch_id)
       VALUES ('LE-ADV-1', '2026-06-25T12:00:00', 'ADVANCE_IN', ?, 'Mal Sani', 1500000, 'BR-KD')`
    ).run(cust);
    tm('TM-ADV-1', 'ADVANCE_IN', 1500000, 'LE-ADV-1');
    const hits = receiptAdvanceRepeats(db, {
      customerID: cust,
      branchId: 'BR-KD',
      lines: [{ amountNgn: 1500000 }, { amountNgn: 1282980 }],
    });
    expect(hits).toEqual([expect.objectContaining({ lineIndex: 0, movementId: 'TM-ADV-1' })]);
  });

  it('3–5. GRN: weighed kg required, backdate needs a reason, 2% warning, metre cost, spool', () => {
    insertPurchaseOrder(
      db,
      {
        poID: 'PO-P3-1',
        supplierID: 'S-KD',
        supplierName: 'Kaduna Mill',
        orderDateISO: '2026-10-01',
        status: 'Approved',
        lines: [
          { lineKey: 'L1', productID: 'PRD-102', productName: 'Aluzinc coil', qtyOrdered: 1000, unitPricePerKgNgn: 1738, unitPriceNgn: 1738 },
          {
            lineKey: 'L2',
            productID: 'COIL-ALU',
            productName: 'Aluminium coil',
            purchaseUnit: 'metre',
            qtyOrdered: 300,
            unitPricePerKgNgn: 12000,
            unitPriceNgn: 12000,
            conversionKgPerM: 1.25,
          },
        ],
      },
      'BR-KD'
    );
    const po = getPurchaseOrder(db, 'PO-P3-1');
    expect(po.lines.find((l) => l.lineKey === 'L2')).toMatchObject({
      purchaseUnit: 'metre',
      metersOrdered: 300,
      unitPricePerMeterNgn: 12000,
    });

    const noWeight = confirmGrn(db, 'PO-P3-1', [{ lineKey: 'L1', productID: 'PRD-102', qtyReceived: 1000 }], 'S-KD', 'Kaduna Mill', 'BR-KD');
    expect(noWeight.code).toBe('GRN_WEIGHT_REQUIRED');

    const entries = [
      { lineKey: 'L1', productID: 'PRD-102', qtyReceived: 960, weightKg: 960, materialTypeName: 'Aluzinc', receivedAtISO: '2026-10-10' },
      { lineKey: 'L2', productID: 'COIL-ALU', qtyReceived: 380, weightKg: 380, supplierExpectedMeters: 300, materialTypeName: 'Aluminium', receivedAtISO: '2026-10-10' },
    ];
    const noReason = confirmGrn(db, 'PO-P3-1', entries, 'S-KD', 'Kaduna Mill', 'BR-KD', { allowConversionMismatch: true });
    expect(noReason.code).toBe('GRN_BACKDATE_REASON_REQUIRED');

    const ok = confirmGrn(db, 'PO-P3-1', entries, 'S-KD', 'Kaduna Mill', 'BR-KD', {
      allowConversionMismatch: true,
      backdateReason: 'Truck offloaded 10 Oct, storekeeper on leave',
    });
    expect(ok.ok).toBe(true);
    // 960 kg vs 1,000 kg open = −4% → warning; 380 kg vs 300 m × 1.25 = 375 kg = +1.3% → none.
    expect(ok.weightWarnings).toEqual([expect.objectContaining({ lineKey: 'L1', variancePct: -4 })]);

    const coils = listCoilLots(db, 'BR-KD', { unlimited: true }).filter((c) => c.poID === 'PO-P3-1');
    const zinc = coils.find((c) => c.productID === 'PRD-102');
    const alu = coils.find((c) => c.productID === 'COIL-ALU');
    expect(zinc).toMatchObject({ unitCostNgnPerKg: 1738, spoolKg: 65, netWeightKg: 895, purchaseUnit: 'kg' });
    // ₦12,000/m × 300 m = ₦3,600,000 ÷ 380 kg (old rule: 380 × 12,000 = ₦4,560,000).
    expect(alu).toMatchObject({ landedCostNgn: 3600000, unitCostNgnPerKg: 9474, spoolKg: 0, netWeightKg: 380, purchaseUnit: 'metre' });
    expect(Number(db.prepare(`SELECT qty_received FROM purchase_order_lines WHERE po_id = 'PO-P3-1' AND line_key = 'L2'`).get().qty_received)).toBe(300);

    const audit = db.prepare(`SELECT action FROM audit_log WHERE entity_id = 'PO-P3-1'`).all().map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['inventory.grn_backdated', 'inventory.grn_weight_variance']));
  });

  it('6. an edit to a record in a locked month is flagged and listed', () => {
    db.prepare(
      `INSERT INTO accounting_period_locks (period_key, locked_from_iso, locked_at_iso, reason) VALUES ('2026-09', '2026-09-01', ?, 'Sep close')`
    ).run(`${today}T08:00:00`);
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, branch_id, qty_received, qty_remaining, current_weight_kg, weight_kg, received_at_iso, current_status)
       VALUES ('CL-P3-SEP', 'PRD-102', 'BR-KD', 900, 900, 900, 900, '2026-09-12', 'Available')`
    ).run();
    appendAuditLog(db, { action: 'coil_lot.update', entityKind: 'coil_lot', entityId: 'CL-P3-SEP', note: 'Gauge corrected' });
    appendAuditLog(db, { action: 'coil_lot.update', entityKind: 'coil_lot', entityId: zincCoilNo(), note: 'Location changed' });

    const { rows } = listLockedPeriodChanges(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: 'CL-P3-SEP', periodKey: '2026-09', recordDateISO: '2026-09-12' });
    expect(rows[0].note).toMatch(/^\[Locked-period change\]/);
  });

  function zincCoilNo() {
    return db.prepare(`SELECT coil_no FROM coil_lots WHERE po_id = 'PO-P3-1' AND product_id = 'PRD-102'`).get().coil_no;
  }
});
