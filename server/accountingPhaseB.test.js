/**
 * Accounting GL integration tests (Phase A + B) — one MySQL DB per worker, no legacy demo seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';
import {
  ensureArchitecturalGlAccounts,
  postOpeningBalanceJournal,
  tryPostExpensePaymentGlTx,
  tryPostSupplierPaymentGlTx,
} from './accountingPostingOps.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import { monthBounds, getAccountingStatementsPack } from './accountingStatementsOps.js';
import { createFixedAsset } from './accountingPhase2Ops.js';
import { previewDepreciationRun } from './depreciationRunOps.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import {
  computePayrollRunGlAmounts,
  tryPostPayrollAccrualGlTx,
  payrollGlStatusForRun,
} from './payrollGlOps.js';

const mysqlOk = isMysqlAvailableForTests();
let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function ensureTestAdmin(db) {
  const row = db.prepare(`SELECT id FROM app_users WHERE id = 'test-admin' LIMIT 1`).get();
  if (row?.id) return 'test-admin';
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO app_users (id, username, password_hash, display_name, role_key, is_active, created_at_iso)
       VALUES ('test-admin','test-admin','x','Test Admin','admin',1,?)`
    ).run(now);
  } catch {
    /* row may exist under different shape on migrated schemas */
  }
  return 'test-admin';
}

function seedPayrollRun(db, runId, periodYyyymm) {
  const userId = ensureTestAdmin(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, notes, created_at_iso, created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(runId, periodYyyymm, 'locked', 0, 8, null, now, userId);
  db.prepare(
    `INSERT INTO hr_payroll_lines (run_id, user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(runId, userId, 100_000, 0, 0, 0, 10_000, 8_000, 82_000);
  return { runId, userId };
}

describe.skipIf(!mysqlOk)('accounting GL (Phase A + B)', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:', { seed: false });
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
    ensureArchitecturalGlAccounts(db);
    ensureTestAdmin(db);
  });

  afterAll(() => {
    db?.close();
  });

  describe('accountingPostingOps', () => {
    it('ensureArchitecturalGlAccounts adds trade AP, equity, and payroll codes', () => {
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '2000'`).get()?.code).toBe('2000');
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '3100'`).get()?.code).toBe('3100');
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '2300'`).get()?.code).toBe('2300');
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '6000'`).get()?.code).toBe('6000');
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

  describe('accountingStatementsOps', () => {
    it('monthBounds parses YYYY-MM', () => {
      expect(monthBounds('bad')).toBeNull();
      const b = monthBounds('2026-02');
      expect(b?.start).toBe('2026-02-01');
      expect(b?.end).toBe('2026-02-28');
    });

    it('getAccountingStatementsPack returns structure', () => {
      const p = getAccountingStatementsPack(db, '2026-01', 'ALL');
      expect(p.ok).toBe(true);
      expect(p.profitAndLoss?.lines).toBeDefined();
      expect(p.balanceSheet?.lines).toBeDefined();
      expect(p.reconciliationHints?.salesReceiptsInPeriodNgn).toBeDefined();
    });
  });

  describe('Phase B — payroll, depreciation, close', () => {
    it('computePayrollRunGlAmounts balances expense and credits', () => {
      const { runId } = seedPayrollRun(db, `PR-B-${Date.now()}`, '2026-08');
      const amounts = computePayrollRunGlAmounts(db, runId);
      expect(amounts.ok).toBe(true);
      expect(amounts.balanced).toBe(true);
      expect(amounts.expenseDr).toBe(100_000);
      expect(amounts.netCr).toBe(82_000);
    });

    it('tryPostPayrollAccrualGlTx posts Dr 6000 and liability credits', () => {
      const runId = `PR-GL-${Date.now()}`;
      seedPayrollRun(db, runId, '2026-09');
      const r = tryPostPayrollAccrualGlTx(db, runId, { createdByUserId: 'test-admin' });
      expect(r.ok).toBe(true);
      expect(r.journalId).toBeTruthy();
      expect(payrollGlStatusForRun(db, runId).accrualPosted).toBe(true);
    });

    it('previewDepreciationRun excludes land category', () => {
      const suffix = Date.now();
      const actor = { id: 'test-admin' };
      createFixedAsset(
        db,
        {
          name: `Plot ${suffix}`,
          category: 'land',
          branchId: 'BR-KD',
          acquisitionDateIso: '2024-01-01',
          costNgn: 50_000_000,
          usefulLifeMonths: 600,
        },
        actor
      );
      createFixedAsset(
        db,
        {
          name: `Press ${suffix}`,
          category: 'plant',
          branchId: 'BR-KD',
          acquisitionDateIso: '2024-01-01',
          costNgn: 12_000_000,
          salvageNgn: 0,
          usefulLifeMonths: 120,
        },
        actor
      );
      const pre = previewDepreciationRun(db, '2026-06', 'ALL');
      expect(pre.ok).toBe(true);
      const names = (pre.rows || []).map((r) => r.name);
      expect(names.some((n) => String(n).includes(`Press ${suffix}`))).toBe(true);
      expect(names.some((n) => String(n).includes(`Plot ${suffix}`))).toBe(false);
    });

    it('buildMonthEndCloseChecklist returns structured steps', () => {
      const checklist = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
      expect(checklist.ok).toBe(true);
      expect(checklist.steps.length).toBeGreaterThanOrEqual(5);
      expect(checklist.steps.map((s) => s.id)).toContain('statements');
    });
  });
});
