import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { listAccountingMoneyEvents } from './accountingEventExportOps.js';

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

describe('accountingEventExportOps (no db)', () => {
  it('requires startDate', () => {
    const r = listAccountingMoneyEvents(null, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EXPORT_DATE');
  });

  it('rejects inverted date range', () => {
    const r = listAccountingMoneyEvents(null, { startDate: '2026-07-10', endDate: '2026-07-01' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EXPORT_DATE');
  });
});

describe.skipIf(!mysqlOk)('accountingEventExportOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-X', 'Export Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('GTB Ops', 'GTBank', 0, 'Bank', 'GTB-X', ?, 0)`
    ).run(DEFAULT_BRANCH_ID);
    const treasuryId = Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'GTB-X'`).get()?.id);
    db.prepare(
      `INSERT INTO treasury_movements (
         id, posted_at_iso, type, treasury_account_id, amount_ngn, reference,
         counterparty_kind, counterparty_id, source_kind, source_id
       ) VALUES ('TM-1', '2026-07-02T09:00:00.000Z', 'CUSTOMER_RECEIPT', ?, 250000, 'R-1',
         'customer', 'CUS-X', 'LEDGER', 'LE-1')`
    ).run(treasuryId);
    db.prepare(
      `INSERT INTO ledger_entries (id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref, branch_id)
       VALUES ('LE-1', '2026-07-02T09:00:00.000Z', 'receipt', 'CUS-X', 'Export Customer', 250000, 'QT-1', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO coil_lots (coil_no, product_id, qty_received, qty_remaining, received_at_iso, landed_cost_ngn, supplier_name)
       VALUES ('COIL-1', 'P-ALU', 1, 1, '2026-07-03T12:00:00.000Z', 800000, 'Alu Co')`
    ).run();
    db.prepare(
      `INSERT INTO production_jobs (
         job_id, quotation_ref, customer_id, customer_name, status, created_at_iso, completed_at_iso, actual_meters
       ) VALUES ('JOB-1', 'QT-1', 'CUS-X', 'Export Customer', 'Completed', '2026-07-04T08:00:00.000Z',
         '2026-07-04T11:00:00.000Z', 40)`
    ).run();
    db.prepare(
      `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, created_at_iso)
       VALUES ('PR-1', '2026-07', 'paid', 0, 0, '2026-07-05T16:00:00.000Z')`
    ).run();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('exports layer-1 cash and ops events in time order', () => {
    const r = listAccountingMoneyEvents(db, { startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('layer1');
    const kinds = r.events.map((e) => e.eventKind);
    expect(kinds).toEqual([
      'LEDGER_ENTRY',
      'TREASURY_MOVEMENT',
      'INVENTORY_RECEIPT',
      'PRODUCTION_COMPLETE',
      'PAYROLL_RUN',
    ]);
    expect(r.events[0].payload.customerId).toBe('CUS-X');
    expect(r.events.find((e) => e.eventKind === 'TREASURY_MOVEMENT')?.amountNgn).toBe(250000);
    expect(r.events.find((e) => e.eventKind === 'INVENTORY_RECEIPT')?.payload.coilNo).toBe('COIL-1');
  });

  it('filters by kind and paginates with after cursor', () => {
    const page1 = listAccountingMoneyEvents(db, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      kinds: 'TREASURY_MOVEMENT,LEDGER_ENTRY',
      limit: 1,
    });
    expect(page1.ok).toBe(true);
    expect(page1.events).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = listAccountingMoneyEvents(db, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      kinds: 'TREASURY_MOVEMENT,LEDGER_ENTRY',
      limit: 10,
      after: page1.nextCursor,
    });
    expect(page2.ok).toBe(true);
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0].eventId).not.toBe(page1.events[0].eventId);
    expect(page2.hasMore).toBe(false);
  });
});
