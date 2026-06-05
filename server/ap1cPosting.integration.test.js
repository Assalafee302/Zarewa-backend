import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { migrateGlReceiptPolicyMeta } from './receiptPolicyMetaOps.js';
import { resolveCustomerReceiptGlCreditAccount } from './ap1cReceiptGl.js';
import { tryPostCustomerReceiptGl, tryPostCustomerReceiptReversalGl } from './glOps.js';
import { tryPostProductionRecognitionGlTx } from './productionRecognitionGl.js';
import { resolveProductionRecognitionAmounts } from './ap1cProductionRecognition.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

const FLAG_KEYS = [
  'ACCOUNTING_POLICY_V1_RECEIPT_GL',
  'ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE',
  'ACCOUNTING_POLICY_V1_LEGACY_BRIDGE',
];

describe.skipIf(!mysqlTestReady)('AP1c-2/AP1c-3 posting (integration)', () => {
  let db;
  const prev = {};

  beforeEach(() => {
    for (const k of FLAG_KEYS) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    db = createDatabase(':memory:');
    migrateGlReceiptPolicyMeta(db);
    db.exec(`
      INSERT INTO gl_accounts (id, code, name, type, sort_order) VALUES
        ('acc-cash','1000','Cash','asset',10),
        ('acc-ar','1200','AR','asset',20),
        ('acc-adv','2500','Deposits','liability',75),
        ('acc-rev','4000','Revenue','income',100),
        ('acc-cogs','5000','COGS','expense',90),
        ('acc-inv','1300','Inventory','asset',30);
    `);
  });

  afterEach(() => {
    db?.close();
    for (const k of FLAG_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function seedQuote(id = 'QT-AP1C') {
    db.exec(`
      INSERT INTO quotations (id, customer_id, total_ngn, paid_ngn, status, lines_json, date_iso)
      VALUES ('${id}', 'C1', 5000000, 0, 'Approved', '{"products":[{"qty":100}]}', '2026-06-01');
    `);
  }

  it('flag off → receipt GL still credits 1200', () => {
    seedQuote();
    const code = resolveCustomerReceiptGlCreditAccount(db, {
      quotationRef: 'QT-AP1C',
      entryDateISO: '2026-06-01',
    });
    expect(code).toBe('1200');
    const gl = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-OFF',
      amountNgn: 1_000_000,
      entryDateISO: '2026-06-01',
      quotationRef: 'QT-AP1C',
    });
    const line = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.credit_ngn > 0`
      )
      .get(gl.journalId);
    expect(line.code).toBe('1200');
  });

  it('flag on + pre-production → Cr 2500 and metadata', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    seedQuote();
    expect(
      resolveCustomerReceiptGlCreditAccount(db, {
        quotationRef: 'QT-AP1C',
        entryDateISO: '2026-06-01',
      })
    ).toBe('2500');
    const gl = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-PRE',
      amountNgn: 5_000_000,
      entryDateISO: '2026-06-01',
      quotationRef: 'QT-AP1C',
      customerId: 'C1',
    });
    const line = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.credit_ngn > 0`
      )
      .get(gl.journalId);
    expect(line.code).toBe('2500');
    const meta = db
      .prepare(`SELECT policy_basis, credited_account_code FROM gl_receipt_policy_meta WHERE journal_id = ?`)
      .get(gl.journalId);
    expect(meta.credited_account_code).toBe('2500');
    expect(meta.policy_basis).toBe('policy_v1_deposit_before_production');
  });

  it('flag on + post-production → Cr 1200', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    seedQuote();
    db.exec(`
      INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters, completed_at_iso, created_at_iso)
      VALUES ('PJ-1','QT-AP1C','Completed',100,'2026-06-10T10:00:00.000Z','2026-06-10T10:00:00.000Z');
    `);
    const gl = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-POST',
      amountNgn: 2_000_000,
      entryDateISO: '2026-06-15',
      quotationRef: 'QT-AP1C',
    });
    const line = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.credit_ngn > 0`
      )
      .get(gl.journalId);
    expect(line.code).toBe('1200');
  });

  it('production release with full 2500 deposit creates no AR', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    process.env.ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE = '1';
    seedQuote();
    tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-FULL',
      amountNgn: 5_000_000,
      entryDateISO: '2026-06-01',
      quotationRef: 'QT-AP1C',
    });
    const amounts = resolveProductionRecognitionAmounts(db, {
      quotationRef: 'QT-AP1C',
      earnedNgn: 5_000_000,
      totalNgn: 5_000_000,
      excludeJobId: 'PJ-FULL',
    });
    expect(amounts.release2500Ngn).toBe(5_000_000);
    expect(amounts.arPartNgn).toBe(0);

    const gl = tryPostProductionRecognitionGlTx(db, {
      jobID: 'PJ-FULL',
      quotationRef: 'QT-AP1C',
      actualMeters: 100,
      totalCogsNgn: 0,
      completedAtISO: '2026-06-10T10:00:00.000Z',
    });
    expect(gl.ok).toBe(true);
    expect(gl.arDebitNgn).toBe(0);
    const arLine = db
      .prepare(
        `SELECT jl.debit_ngn FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         INNER JOIN gl_journal_entries j ON j.id = jl.journal_id
         WHERE j.source_kind = 'PRODUCTION_RECOGNITION_GL' AND j.source_id = 'PJ-FULL' AND ga.code = '1200'`
      )
      .get();
    expect(arLine).toBeUndefined();
  });

  it('legacy bridge reduces production AR', () => {
    process.env.ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE = '1';
    process.env.ACCOUNTING_POLICY_V1_LEGACY_BRIDGE = '1';
    seedQuote('QT-LEG2');
    db.exec(`
      INSERT INTO ledger_entries (id, customer_id, quotation_ref, type, amount_ngn, at_iso)
      VALUES ('LE-LEG','C1','QT-LEG2','RECEIPT',3000000,'2026-06-01T10:00:00.000Z');
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso)
      VALUES ('J-LEG','2026-06-01','2026-06','R','CUSTOMER_RECEIPT_GL','LE-LEG','2026-06-01T12:00:00.000Z');
      INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn)
      VALUES ('JL-LEG1','J-LEG','acc-cash',3000000,0),('JL-LEG2','J-LEG','acc-ar',0,3000000);
      INSERT INTO gl_receipt_policy_meta (
        id, journal_id, ledger_entry_id, quotation_ref, policy_basis, credited_account_code,
        production_completed_at_receipt, amount_ngn, created_at_iso
      ) VALUES (
        'RPM-J-LEG','J-LEG','LE-LEG','QT-LEG2','legacy_ar_at_receipt','1200',0,3000000,'2026-06-01T12:00:00.000Z'
      );
      INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters, completed_at_iso, created_at_iso)
      VALUES ('PJ-LEG2','QT-LEG2','Completed',100,'2026-06-15T10:00:00.000Z','2026-06-15T10:00:00.000Z');
    `);
    const amounts = resolveProductionRecognitionAmounts(db, {
      quotationRef: 'QT-LEG2',
      earnedNgn: 5_000_000,
      totalNgn: 5_000_000,
      excludeJobId: 'PJ-LEG2',
    });
    expect(amounts.legacyBridgeAppliedNgn).toBe(3_000_000);
    expect(amounts.arPartNgn).toBe(2_000_000);
  });

  it('reversal of 2500 receipt debits 2500 via metadata', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    seedQuote('QT-REV');
    const gl = tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-REV',
      amountNgn: 100_000,
      entryDateISO: '2026-06-01',
      quotationRef: 'QT-REV',
    });
    expect(gl.ok).toBe(true);
    const rev = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-REV',
      reversalLedgerId: 'LE-REV-R',
      amountNgn: 100_000,
      entryDateISO: '2026-06-02',
    });
    expect(rev.ok).toBe(true);
    expect(rev.reversalAccountSource).toBe('metadata');
    const dr = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.debit_ngn > 0`
      )
      .get(rev.journalId);
    expect(dr.code).toBe('2500');
  });

  it('duplicate production recognition is idempotent', () => {
    process.env.ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE = '1';
    seedQuote('QT-DUP');
    const p1 = tryPostProductionRecognitionGlTx(db, {
      jobID: 'PJ-DUP',
      quotationRef: 'QT-DUP',
      actualMeters: 50,
      totalCogsNgn: 0,
      completedAtISO: '2026-06-10',
    });
    const p2 = tryPostProductionRecognitionGlTx(db, {
      jobID: 'PJ-DUP',
      quotationRef: 'QT-DUP',
      actualMeters: 50,
      totalCogsNgn: 0,
      completedAtISO: '2026-06-10',
    });
    expect(p1.ok).toBe(true);
    expect(p2.duplicate).toBe(true);
    const cnt = db
      .prepare(
        `SELECT COUNT(*) AS c FROM gl_journal_entries WHERE source_kind = 'PRODUCTION_RECOGNITION_GL' AND source_id = 'PJ-DUP'`
      )
      .get().c;
    expect(cnt).toBe(1);
  });
});
