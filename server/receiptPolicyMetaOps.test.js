import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { tryPostCustomerReceiptGl } from './glOps.js';
import {
  backfillReceiptPolicyMeta,
  classifyFromReceiptPolicyMeta,
  findReceiptGlCreditedAccountFromLines,
  getReceiptPolicyMetaByJournalId,
  mapReceiptPolicyMetaRow,
  migrateGlReceiptPolicyMeta,
  receiptPolicyMetaTableExists,
  resolveReceiptPolicyBasis,
} from './receiptPolicyMetaOps.js';
import { buildAp1cDryRunReport } from './ap1cDryRunOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

function seedReceiptGlFixture(db, { creditCode = '1200', receiptDate = '2026-06-01', prodComplete = '2026-06-15' } = {}) {
  db.exec(`
    INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
    VALUES ('QT-META', 'C1', 'Hidden Name', 100000, 50000, 'Partial', 'Approved', '{"products":[{"qty":100}]}', '2026-06-01', 'BR-001');
    INSERT INTO gl_accounts (id, code, name, type, sort_order) VALUES
      ('acc-cash','1000','Cash','asset',10),
      ('acc-ar','1200','AR','asset',20),
      ('acc-adv','2500','Deposits','liability',75);
    INSERT INTO ledger_entries (id, customer_id, quotation_ref, type, amount_ngn, at_iso)
    VALUES ('LE-M1','C1','QT-META','RECEIPT',50000,'2026-06-01T10:00:00.000Z');
    INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, ledger_entry_id, branch_id)
    VALUES ('SR-M1','C1','Hidden Name','QT-META','${receiptDate}',50000,'Confirmed','LE-M1','BR-001');
    INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso, branch_id)
    VALUES ('J-M1','${receiptDate}','2026-06','Receipt','CUSTOMER_RECEIPT_GL','LE-M1','2026-06-01T12:00:00.000Z','BR-001');
    INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn, memo)
    VALUES ('JL-M1a','J-M1','acc-cash',50000,0,'LE-M1'),
           ('JL-M1b','J-M1','acc-ar',0,50000,'LE-M1');
    INSERT INTO production_jobs (id, quotation_ref, status, actual_meters, completed_at_iso, branch_id)
    VALUES ('PJ-M1','QT-META','Completed',50,'${prodComplete}T10:00:00.000Z','BR-001');
  `);
  if (creditCode === '2500') {
    db.prepare(`UPDATE gl_journal_lines SET account_id = 'acc-adv' WHERE id = 'JL-M1b'`).run();
  }
}

describe('receiptPolicyMetaOps (pure)', () => {
  it('findReceiptGlCreditedAccountFromLines detects 1200 and 2500', () => {
    expect(
      findReceiptGlCreditedAccountFromLines([{ accountCode: '1200', creditNgn: 10_000 }]).creditedAccountCode
    ).toBe('1200');
    expect(
      findReceiptGlCreditedAccountFromLines([{ accountCode: '2500', creditNgn: 5_000 }]).creditedAccountCode
    ).toBe('2500');
    expect(findReceiptGlCreditedAccountFromLines([]).creditedAccountCode).toBeNull();
  });

  it('resolveReceiptPolicyBasis marks legacy pre-prod 1200', () => {
    expect(
      resolveReceiptPolicyBasis({
        creditedAccountCode: '1200',
        productionCompletedAtReceipt: false,
      })
    ).toBe('legacy_ar_at_receipt');
    expect(
      resolveReceiptPolicyBasis({
        creditedAccountCode: '2500',
        productionCompletedAtReceipt: false,
      })
    ).toBe('policy_v1_deposit_before_production');
    expect(
      resolveReceiptPolicyBasis({
        creditedAccountCode: '1200',
        productionCompletedAtReceipt: true,
      })
    ).toBe('policy_v1_ar_after_production');
    expect(
      resolveReceiptPolicyBasis({
        creditedAccountCode: '1200',
        productionCompletedAtReceipt: null,
      })
    ).toBe('unknown');
  });

  it('AP1c posting flags remain off by default', () => {
    const f = readFinanceFeatureFlags();
    expect(f.accountingPolicyV1ReceiptGl).toBe(false);
    expect(f.accountingPolicyV1ProductionRelease).toBe(false);
  });
});

describe.skipIf(!mysqlTestReady)('receiptPolicyMetaOps (integration)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    migrateGlReceiptPolicyMeta(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('metadata table exists after migration', () => {
    expect(receiptPolicyMetaTableExists(db)).toBe(true);
    const cols = db.prepare(`PRAGMA table_info(gl_receipt_policy_meta)`).all();
    expect(cols.some((c) => c.name === 'policy_basis')).toBe(true);
  });

  it('backfill detects 1200 receipt GL before production as legacy', () => {
    seedReceiptGlFixture(db);
    db.prepare(`DELETE FROM gl_receipt_policy_meta`).run();
    const r = backfillReceiptPolicyMeta(db);
    expect(r.inserted).toBe(1);
    const meta = getReceiptPolicyMetaByJournalId(db, 'J-M1');
    expect(meta.credited_account_code).toBe('1200');
    expect(meta.policy_basis).toBe('legacy_ar_at_receipt');
    expect(meta.production_completed_at_receipt).toBe(0);
    const lines = db
      .prepare(`SELECT credit_ngn FROM gl_journal_lines WHERE journal_id = 'J-M1' AND account_id = 'acc-ar'`)
      .get();
    expect(lines.credit_ngn).toBe(50_000);
  });

  it('backfill detects 2500 credit line', () => {
    seedReceiptGlFixture(db, { creditCode: '2500' });
    db.prepare(`DELETE FROM gl_receipt_policy_meta`).run();
    backfillReceiptPolicyMeta(db);
    const meta = getReceiptPolicyMetaByJournalId(db, 'J-M1');
    expect(meta.credited_account_code).toBe('2500');
    expect(meta.policy_basis).toBe('policy_v1_deposit_before_production');
  });

  it('unknown production date does not crash backfill', () => {
    seedReceiptGlFixture(db);
    db.prepare(`DELETE FROM production_jobs`).run();
    db.prepare(`DELETE FROM gl_receipt_policy_meta`).run();
    const r = backfillReceiptPolicyMeta(db);
    expect(r.ok).toBe(true);
    const meta = getReceiptPolicyMetaByJournalId(db, 'J-M1');
    expect(meta).toBeTruthy();
    expect(['unknown', 'legacy_ar_at_receipt']).toContain(meta.policy_basis);
  });

  it('tryPostCustomerReceiptGl creates metadata without changing journal credit account', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, total_ngn, paid_ngn, status, lines_json, date_iso)
      VALUES ('QT-NEW','C9',100000,0,'Approved','{}','2026-06-20');
      INSERT INTO ledger_entries (id, customer_id, quotation_ref, type, amount_ngn, at_iso)
      VALUES ('LE-NEW','C9','QT-NEW','RECEIPT',25000,'2026-06-20T10:00:00.000Z');
    `);
    const glR = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-NEW',
      amountNgn: 25_000,
      entryDateISO: '2026-06-20',
      branchId: 'BR-001',
      quotationRef: 'QT-NEW',
      customerId: 'C9',
    });
    expect(glR.ok).toBe(true);
    const crLine = db
      .prepare(
        `SELECT ga.code, jl.credit_ngn FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.credit_ngn > 0`
      )
      .get(glR.journalId);
    expect(crLine.code).toBe('1200');
    expect(crLine.credit_ngn).toBe(25_000);
    const meta = getReceiptPolicyMetaByJournalId(db, glR.journalId);
    expect(meta).toBeTruthy();
    expect(meta.credited_account_code).toBe('1200');
  });

  it('AP1c dry-run prefers metadata for legacy count', () => {
    seedReceiptGlFixture(db);
    backfillReceiptPolicyMeta(db);
    const report = buildAp1cDryRunReport(db, {});
    expect(report.summary.receiptsBeforeProductionCredited1200Count).toBeGreaterThanOrEqual(1);
    expect(report.samples.receiptsBeforeProductionCredited1200[0]?.dataSource).toBe('metadata');
  });

  it('classifyFromReceiptPolicyMeta flags legacy bridge', () => {
    seedReceiptGlFixture(db);
    backfillReceiptPolicyMeta(db);
    const row = getReceiptPolicyMetaByJournalId(db, 'J-M1');
    const mapped = classifyFromReceiptPolicyMeta(mapReceiptPolicyMetaRow(row));
    expect(mapped.isLegacyPreProd1200).toBe(true);
    expect(mapped.legacyBridgeNgn).toBe(50_000);
  });
});
