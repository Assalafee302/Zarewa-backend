import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import {
  listQuotations,
  listRefunds,
  listSalesReceiptsForDesk,
  listProductionJobs,
} from './readModel.js';
import { buildSalesDomainSnapshot, buildFinanceDomainSnapshot } from './domainBootstrap.js';
import { unclearedReceiptsListOpts, DEFAULT_UNCLEARED_RECEIPTS_LIMIT } from './listQueryOpts.js';
import { insertCustomer } from './writeOps.js';

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

describe.skipIf(!mysqlOk)('desk performance hotfixes', () => {
  it('uncleared receipts list opts default to a finite cap', () => {
    expect(unclearedReceiptsListOpts().limit).toBe(DEFAULT_UNCLEARED_RECEIPTS_LIMIT);
    expect(DEFAULT_UNCLEARED_RECEIPTS_LIMIT).toBeGreaterThan(0);
  });

  it('listQuotations(includeLines:false) returns headers without quotationLines', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C-PERF', name: 'Perf Customer' }, 'BR-KD');
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, status, branch_id, total_ngn, lines_json)
       VALUES ('Q-PERF', 'C-PERF', 'Perf Customer', '2026-09-01', 'Open', 'BR-KD', 5000, ?)`
    ).run(
      JSON.stringify({
        materialGauge: '0.35',
        materialColor: 'Blue',
        materialTypeId: 'MT-ALU',
        products: Array.from({ length: 40 }, (_, i) => ({ name: `P${i}`, qty: '10', unitPrice: '100' })),
      })
    );
    const rows = listQuotations(db, 'BR-KD', { includeLines: false, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].quotationLines).toBeUndefined();
    expect(rows[0].materialGauge).toBe('0.35');
    expect(rows[0].materialColor).toBe('Blue');
    db.close();
  });

  it('listRefunds does not require heal writes to return rows', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C-RF', name: 'Refund Customer' }, 'BR-KD');
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, status, branch_id, total_ngn, paid_ngn)
       VALUES ('Q-RF', 'C-RF', 'Refund Customer', '2026-09-01', 'Open', 'BR-KD', 10000, 10000)`
    ).run();
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, amount_ngn, status,
         requested_at_iso, branch_id, approved_amount_ngn
       ) VALUES ('RF-PERF', 'C-RF', 'Refund Customer', 'Q-RF', 1000, 'Approved',
                 '2026-09-02T10:00:00Z', 'BR-KD', 1000)`
    ).run();
    const rows = listRefunds(db, 'BR-KD', { limit: 50, includePreviewSnapshot: false });
    expect(rows.some((r) => r.refundID === 'RF-PERF' || r.refundId === 'RF-PERF' || r.refund_id === 'RF-PERF')).toBe(
      true
    );
    const mapped = rows.find((r) => String(r.refundID || r.refundId || '') === 'RF-PERF');
    expect(mapped?.status).toBe('Approved');
    db.close();
  });

  it('sales and finance domain snapshots defer advanceInEvents', () => {
    const db = createDatabase(':memory:', { seed: false });
    const user = { id: 1, roleKey: 'md', displayName: 'MD' };
    const sales = buildSalesDomainSnapshot(db, { user, branchScope: 'BR-KD' });
    const finance = buildFinanceDomainSnapshot(db, { user, branchScope: 'BR-KD' });
    expect(sales.advanceInEvents).toEqual([]);
    expect(finance.advanceInEvents).toEqual([]);
    expect(sales.bootstrapMeta?.truncated?.advanceInEvents).toBe(true);
    expect(finance.bootstrapMeta?.truncated?.advanceInEvents).toBe(true);
    db.close();
  });

  it('listSalesReceiptsForDesk merges uncleared without requiring unlimited', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C-RC', name: 'Receipt Customer' }, 'BR-KD');
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, date_iso, amount_ngn, status, branch_id)
       VALUES ('RC-OPEN', 'C-RC', 'Receipt Customer', '2026-09-01', 1000, 'pending', 'BR-KD')`
    ).run();
    const desk = listSalesReceiptsForDesk(db, 'BR-KD', [], { limit: 10 });
    expect(desk.some((r) => String(r.id || r.receiptID || '') === 'RC-OPEN')).toBe(true);
    db.close();
  });

  it('listProductionJobs runs with scoped FG adjustments', () => {
    const db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, status, created_at_iso, branch_id, actual_meters)
       VALUES ('JOB-PERF', 'Q-X', 'Completed', '2026-09-01T12:00:00Z', 'BR-KD', 10)`
    ).run();
    const jobs = listProductionJobs(db, 'BR-KD', { limit: 50 });
    expect(jobs.some((j) => j.jobID === 'JOB-PERF')).toBe(true);
    db.close();
  });
});
