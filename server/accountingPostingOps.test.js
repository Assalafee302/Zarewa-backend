import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireIntegrationHarness,
  closeIntegrationHarness,
  isMysqlAvailableForTests,
} from './testIntegrationHarness.js';
import { seedDefaultGlAccounts } from './glOps.js';
import {
  ensureArchitecturalGlAccounts,
  postOpeningBalanceJournal,
  tryPostExpensePaymentGlTx,
  tryPostSupplierPaymentGlTx,
} from './accountingPostingOps.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';

const mysqlOk = isMysqlAvailableForTests();
let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

describe.skipIf(!mysqlOk)('accountingPostingOps', () => {
  let db;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    seedDefaultGlAccounts(db);
    ensureArchitecturalGlAccounts(db);
  });

  afterAll(() => {
    closeIntegrationHarness();
  });

  it('ensureArchitecturalGlAccounts adds trade AP and equity', () => {
    const ap = db.prepare(`SELECT code FROM gl_accounts WHERE code = '2000'`).get();
    const cap = db.prepare(`SELECT code FROM gl_accounts WHERE code = '3100'`).get();
    const paye = db.prepare(`SELECT code FROM gl_accounts WHERE code = '2300'`).get();
    expect(ap?.code).toBe('2000');
    expect(cap?.code).toBe('3100');
    expect(paye?.code).toBe('2300');
  });

  it('glAccountForExpenseCategory maps carriage inward', () => {
    expect(glAccountForExpenseCategory('Carriage inward').accountCode).toBe('5050');
  });

  it('posts opening balance journal when balanced', () => {
    const r = postOpeningBalanceJournal(db, {
      entryDateISO: '2026-07-01',
      sourceId: uid('TEST-OPENING'),
      lines: [
        { accountCode: '1000', debitNgn: 500_000 },
        { accountCode: '3100', creditNgn: 500_000 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.journalId).toBeTruthy();
  });

  it('tryPostSupplierPaymentGlTx is idempotent by movement id', () => {
    const sid = uid('TM-TEST');
    db.prepare(
      `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES ('acc-cash-9','1009','Cash test','asset',1,19)`
    ).run();
    const first = tryPostSupplierPaymentGlTx(db, {
      treasuryAccountId: 9,
      amountNgn: 50_000,
      entryDateISO: '2026-07-02',
      sourceKind: 'SUPPLIER_PAYMENT_GL',
      sourceId: sid,
      forceDebitCode: '2000',
    });
    expect(first.ok).toBe(true);
    const dup = tryPostSupplierPaymentGlTx(db, {
      treasuryAccountId: 9,
      amountNgn: 50_000,
      entryDateISO: '2026-07-02',
      sourceKind: 'SUPPLIER_PAYMENT_GL',
      sourceId: sid,
      forceDebitCode: '2000',
    });
    expect(dup.duplicate).toBe(true);
  });

  it('tryPostExpensePaymentGlTx posts fuel to 5010', () => {
    const sid = uid('TM-EXP');
    db.prepare(
      `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES ('acc-cash-8','1008','Cash ops','asset',1,18)`
    ).run();
    const r = tryPostExpensePaymentGlTx(db, {
      treasuryAccountId: 8,
      amountNgn: 12_000,
      entryDateISO: '2026-07-03',
      sourceId: sid,
      expenseCategory: 'Fuel & lubricant',
    });
    expect(r.ok).toBe(true);
    const line = db
      .prepare(
        `SELECT ga.code FROM gl_journal_lines jl
         JOIN gl_accounts ga ON ga.id = jl.account_id
         JOIN gl_journal_entries je ON je.id = jl.journal_id
         WHERE je.source_id = ? AND jl.debit_ngn > 0`
      )
      .get(sid);
    expect(line?.code).toBe('5010');
  });
});
