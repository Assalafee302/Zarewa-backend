import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { listSalesReceipts } from '../readModel.js';
import { receiptsRegisterReportRows } from '../../shared/lib/standardReportsSales.js';
import { loadReportPeriodSource } from './reportPeriodSourceOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mysqlAvailable())('report period source', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-R', 'Period Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, status, branch_id)
       VALUES ('QT-R', 'CUS-R', 'Period Customer', '2026-01-10', 10000, 10000, 'Pending', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, branch_id)
       VALUES ('LE-OLD', 'CUS-R', 'Period Customer', 'QT-R', '2026-01-15', 10000, 'Cleared', ?)`
    ).run(DEFAULT_BRANCH_ID);
    const insertRecent = db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, branch_id)
       VALUES (?, 'CUS-R', 'Period Customer', 'QT-R', '2026-09-20', 1000, 'Cleared', ?)`
    );
    for (let i = 0; i < 160; i += 1) {
      insertRecent.run(`LE-NEW-${String(i).padStart(3, '0')}`, DEFAULT_BRANCH_ID);
    }
  });

  afterEach(() => {
    db?.close();
  });

  it('includes older period receipts that the desk recent-N list drops', () => {
    const desk = listSalesReceipts(db, DEFAULT_BRANCH_ID);
    expect(desk.some((r) => r.id === 'LE-OLD')).toBe(false);

    const source = loadReportPeriodSource(db, {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      branchScope: DEFAULT_BRANCH_ID,
    });
    expect(source.ok).toBe(true);
    expect(source.receipts.some((r) => r.id === 'LE-OLD')).toBe(true);

    const rows = receiptsRegisterReportRows(
      source.receipts,
      source.ledgerEntries,
      source.treasuryMovements,
      '2026-01-01',
      '2026-01-31',
      []
    );
    expect(rows.some((r) => r.receiptIdFull === 'LE-OLD')).toBe(true);
    expect(rows.length).toBe(1);
  });

  it('rejects an inverted period', () => {
    const source = loadReportPeriodSource(db, {
      startDate: '2026-02-01',
      endDate: '2026-01-01',
      branchScope: DEFAULT_BRANCH_ID,
    });
    expect(source.ok).toBe(false);
  });
});
