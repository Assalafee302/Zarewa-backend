import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { migrateGlReceiptPolicyMeta } from './receiptPolicyMetaOps.js';
import { tryPostCustomerReceiptGl, tryPostCustomerReceiptReversalGl } from './glOps.js';
import {
  evaluateRefundPayoutGlPolicy,
  resolveReceiptReversalAccountFromMetaOrJournalLines,
} from './ap1cReversalRefundOps.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

const AP1C_FLAGS = [
  'ACCOUNTING_POLICY_V1_RECEIPT_GL',
  'ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE',
  'ACCOUNTING_POLICY_V1_LEGACY_BRIDGE',
];

describe('ap1cReversalRefund (pure)', () => {
  it('evaluateRefundPayoutGlPolicy without quote is deposit 2500', () => {
    const r = evaluateRefundPayoutGlPolicy(null, {});
    expect(r.glTreatment).toBe('deposit_2500');
    expect(r.needsRevenueReview).toBe(false);
  });
});

describe.skipIf(!mysqlTestReady)('ap1cReversalRefund (integration)', () => {
  let db;
  const prev = {};

  beforeEach(() => {
    for (const k of AP1C_FLAGS) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    db = createDatabase(':memory:');
    migrateGlReceiptPolicyMeta(db);
    db.exec(`
      INSERT INTO gl_accounts (id, code, name, type, sort_order) VALUES
        ('acc-cash','1000','Cash','asset',10),
        ('acc-ar','1200','AR','asset',20),
        ('acc-adv','2500','Deposits','liability',75);
    `);
  });

  afterEach(() => {
    db?.close();
    for (const k of AP1C_FLAGS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function seedQuoteWithProd(quoteId = 'QT-REV4') {
    db.exec(`
      INSERT INTO quotations (id, customer_id, total_ngn, paid_ngn, status, lines_json, date_iso)
      VALUES ('${quoteId}', 'C1', 5000000, 0, 'Approved', '{"products":[{"qty":100}]}', '2026-06-01');
      INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters, completed_at_iso, created_at_iso)
      VALUES ('PJ-R4','${quoteId}','Completed',100,'2026-06-15T10:00:00.000Z','2026-06-15T10:00:00.000Z');
    `);
  }

  it('Policy v1 pre-production receipt reversal reverses 2500', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    seedQuoteWithProd('QT-PRE-R');
    tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-PRE-R',
      amountNgn: 3_000_000,
      entryDateISO: '2026-06-01',
      quotationRef: 'QT-PRE-R',
    });
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, 'LE-PRE-R');
    expect(resolved.ok).toBe(true);
    expect(resolved.accountCode).toBe('2500');
    const rev = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-PRE-R',
      reversalLedgerId: 'LE-PRE-R-REV',
      amountNgn: 3_000_000,
      entryDateISO: '2026-06-02',
    });
    expect(rev.ok).toBe(true);
    const dr = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ? AND jl.debit_ngn > 0`
      )
      .get(rev.journalId);
    expect(dr.code).toBe('2500');
  });

  it('Policy v1 post-production receipt reversal reverses 1200', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    seedQuoteWithProd('QT-POST-R');
    tryPostCustomerReceiptGl(db, {
      ledgerEntryId: 'LE-POST-R',
      amountNgn: 1_000_000,
      entryDateISO: '2026-06-20',
      quotationRef: 'QT-POST-R',
    });
    const rev = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-POST-R',
      reversalLedgerId: 'LE-POST-R-REV',
      amountNgn: 1_000_000,
      entryDateISO: '2026-06-21',
    });
    expect(rev.ok).toBe(true);
    expect(rev.reversalAccountCode).toBe('1200');
  });

  it('legacy 1200 receipt reversal works with journal inference', () => {
    db.exec(`
      INSERT INTO ledger_entries (id, customer_id, quotation_ref, type, amount_ngn, at_iso)
      VALUES ('LE-LEG-R','C1','QT-LEG-R','RECEIPT',500000,'2026-06-01T10:00:00.000Z');
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso)
      VALUES ('J-LEG-R','2026-06-01','2026-06','R','CUSTOMER_RECEIPT_GL','LE-LEG-R','2026-06-01T12:00:00.000Z');
      INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn)
      VALUES ('JL-L1','J-LEG-R','acc-cash',500000,0),('JL-L2','J-LEG-R','acc-ar',0,500000);
    `);
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, 'LE-LEG-R');
    expect(resolved.ok).toBe(true);
    expect(resolved.source).toBe('journal_inference');
    expect(resolved.accountCode).toBe('1200');
  });

  it('metadata missing but journal lines available resolves 2500', () => {
    db.exec(`
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso)
      VALUES ('J-INF','2026-06-01','2026-06','R','CUSTOMER_RECEIPT_GL','LE-INF','2026-06-01T12:00:00.000Z');
      INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn)
      VALUES ('JL-I1','J-INF','acc-cash',100,0),('JL-I2','J-INF','acc-adv',0,100);
    `);
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, 'LE-INF');
    expect(resolved.ok).toBe(true);
    expect(resolved.accountCode).toBe('2500');
    expect(resolved.source).toBe('journal_inference');
  });

  it('AP1c flags on + no meta and no lines returns safe error', () => {
    process.env.ACCOUNTING_POLICY_V1_RECEIPT_GL = '1';
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, 'LE-MISSING');
    expect(resolved.ok).toBe(false);
    expect(resolved.reasonCode).toBe('missing_receipt_policy_meta');
    const rev = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-MISSING',
      reversalLedgerId: 'LE-MISSING-REV',
      amountNgn: 100,
      entryDateISO: '2026-06-02',
    });
    expect(rev.ok).toBe(false);
    expect(rev.requiresManualReview).toBe(true);
  });

  it('flags off defaults to legacy 1200 when unresolvable', () => {
    const resolved = resolveReceiptReversalAccountFromMetaOrJournalLines(db, 'LE-NOGL');
    expect(resolved.ok).toBe(true);
    expect(resolved.source).toBe('legacy_default');
    expect(resolved.accountCode).toBe('1200');
  });

  it('duplicate reversal journal is idempotent', () => {
    db.exec(`
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso)
      VALUES ('J-DUP','2026-06-01','2026-06','R','CUSTOMER_RECEIPT_GL','LE-DUP','2026-06-01T12:00:00.000Z');
      INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn)
      VALUES ('JL-D1','J-DUP','acc-cash',100,0),('JL-D2','J-DUP','acc-ar',0,100);
      INSERT INTO gl_receipt_policy_meta (
        id, journal_id, ledger_entry_id, policy_basis, credited_account_code,
        production_completed_at_receipt, amount_ngn, created_at_iso
      ) VALUES (
        'RPM-J-DUP','J-DUP','LE-DUP','legacy_ar_at_receipt','1200',0,100,'2026-06-01T12:00:00.000Z'
      );
    `);
    const r1 = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-DUP',
      reversalLedgerId: 'LE-DUP-REV',
      amountNgn: 100,
      entryDateISO: '2026-06-02',
    });
    const r2 = tryPostCustomerReceiptReversalGl(db, {
      originalReceiptLedgerId: 'LE-DUP',
      reversalLedgerId: 'LE-DUP-REV',
      amountNgn: 100,
      entryDateISO: '2026-06-02',
    });
    expect(r1.ok).toBe(true);
    expect(r2.duplicate).toBe(true);
  });

  it('post-production refund flags revenue review', () => {
    seedQuoteWithProd('QT-REF-PP');
    db.exec(`
      INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso)
      VALUES ('J-REV','2026-06-15','2026-06','Production revenue PJ-R4 (QT-REF-PP)','PRODUCTION_RECOGNITION_GL','PJ-R4','2026-06-15T12:00:00.000Z');
    `);
    const evald = evaluateRefundPayoutGlPolicy(db, { quotationRef: 'QT-REF-PP' });
    expect(evald.needsRevenueReview).toBe(true);
  });

  it('refund before production does not require revenue review', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, total_ngn, paid_ngn, status, lines_json, date_iso)
      VALUES ('QT-NOPROD', 'C1', 1000000, 0, 'Approved', '{}', '2026-06-01');
    `);
    const evald = evaluateRefundPayoutGlPolicy(db, { quotationRef: 'QT-NOPROD' });
    expect(evald.needsRevenueReview).toBe(false);
  });
});
