import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildAp1cDryRunReport,
  maskQuotationRefForSample,
} from './ap1cDryRunOps.js';
import { userMayViewAp1cDryRun } from './financeDeskAccess.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe('ap1cDryRunOps (unit)', () => {
  it('maskQuotationRefForSample shortens long refs', () => {
    expect(maskQuotationRefForSample('QT-2026-00012345')).toMatch(/…/);
    expect(maskQuotationRefForSample('QT-1')).toBe('QT-1');
  });

  it('userMayViewAp1cDryRun allows finance_manager, denies cashier-only', () => {
    expect(userMayViewAp1cDryRun({ roleKey: 'finance_manager', permissions: [] })).toBe(true);
    expect(userMayViewAp1cDryRun({ roleKey: 'md', permissions: [] })).toBe(true);
    expect(userMayViewAp1cDryRun({ roleKey: 'cashier', permissions: [] })).toBe(false);
    expect(
      userMayViewAp1cDryRun({
        roleKey: 'cashier',
        permissions: ['accounting.reconciliation.view'],
      })
    ).toBe(true);
  });

  it('AP1c posting flags default off', () => {
    const f = readFinanceFeatureFlags();
    expect(f.accountingPolicyV1ReceiptGl).toBe(false);
    expect(f.accountingPolicyV1ProductionRelease).toBe(false);
    expect(f.accountingPolicyV1LegacyBridge).toBe(false);
    expect(f.reclassPreProductionReceipts).toBe(false);
  });
});

describe.skipIf(!mysqlTestReady)('ap1cDryRunOps (integration)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-PAID-NP', 'C1', 'Secret Customer', 100000, 100000, 'Paid', 'Approved', '{"products":[{"qty":100}]}', '2026-06-01', 'BR-001');
      INSERT INTO gl_accounts (id, code, name, type, sort_order) VALUES
        ('acc-cash','1000','Cash','asset',10),
        ('acc-ar','1200','AR','asset',20),
        ('acc-adv','2500','Deposits','liability',75),
        ('acc-rev','4000','Revenue','income',100);
      INSERT INTO ledger_entries (id, customer_id, quotation_ref, type, amount_ngn, at_iso)
      VALUES ('LE-1','C1','QT-LEG','RECEIPT',50000,'2026-06-01T10:00:00.000Z');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, ledger_entry_id, branch_id)
      VALUES ('SR-1','C1','Secret Customer','QT-LEG','2026-06-01',50000,'Confirmed','LE-1','BR-001');
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, branch_id)
      VALUES ('J-1','2026-06-01','2026-06','Receipt','CUSTOMER_RECEIPT_GL','LE-1',NULL);
      INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn, memo)
      VALUES ('JL-1','J-1','acc-cash',50000,0,'LE-1'),('JL-2','J-1','acc-ar',0,50000,'LE-1');
      INSERT INTO production_jobs (id, quotation_ref, status, actual_meters, completed_at_iso, branch_id)
      VALUES ('PJ-LEG','QT-LEG','Completed',50,'2026-06-15T10:00:00.000Z','BR-001');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns dry_run_only without customer names in samples', () => {
    const report = buildAp1cDryRunReport(db, { limitSamples: 5 });
    expect(report.status).toBe('dry_run_only');
    expect(report.ok).toBe(true);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/Secret Customer/i);
    for (const bucket of Object.values(report.samples)) {
      for (const row of bucket) {
        expect(row.customerName).toBeUndefined();
        expect(row.customer_name).toBeUndefined();
      }
    }
  });

  it('caps samples to limitSamples', () => {
    const report = buildAp1cDryRunReport(db, { limitSamples: 2 });
    for (const bucket of Object.values(report.samples)) {
      expect(bucket.length).toBeLessThanOrEqual(2);
    }
  });

  it('counts legacy pre-production receipt GL 1200', () => {
    const report = buildAp1cDryRunReport(db, {});
    expect(report.summary.receiptsBeforeProductionCredited1200Count).toBeGreaterThanOrEqual(1);
    expect(report.summary.expected2500InsteadOf1200Ngn).toBeGreaterThanOrEqual(50_000);
  });
});
