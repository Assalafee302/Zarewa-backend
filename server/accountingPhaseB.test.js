/**
 * Accounting GL integration tests (Phase A + B) — one seeded MySQL harness per worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireIntegrationHarness,
  closeIntegrationHarness,
  resolveTestActor,
} from './testIntegrationHarness.js';
import { ensureArchitecturalGlAccounts, postOpeningBalanceJournal, tryPostExpensePaymentGlTx, tryPostSupplierPaymentGlTx } from './accountingPostingOps.js';
import { glAccountForExpenseCategory } from '../shared/lib/expenseCategoryGlMap.js';
import { ACCOUNTING_OPENING_DATE_ISO } from '../shared/lib/accountingCutover.js';
import { monthBounds, getAccountingStatementsPack } from './accountingStatementsOps.js';
import { createFixedAsset } from './accountingPhase2Ops.js';
import { previewDepreciationRun } from './depreciationRunOps.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import { computePayrollRunGlAmounts, tryPostPayrollAccrualGlTx, payrollGlStatusForRun } from './payrollGlOps.js';

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function seedPayrollRun(db, runId, periodYyyymm, userId) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, notes, created_at_iso, created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(runId, periodYyyymm, 'locked', 0, 8, null, now, userId);
  db.prepare(
    `INSERT INTO hr_payroll_lines (run_id, user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(runId, userId, 100_000, 0, 0, 0, 10_000, 8_000, 82_000);
}

describe('accounting GL (Phase A + B integration)', () => {
  let db;
  let actor;
  let ready = false;

  beforeAll(() => {
    try {
      db = acquireIntegrationHarness().db;
      actor = resolveTestActor(db);
      ensureArchitecturalGlAccounts(db);
      ready = true;
    } catch (e) {
      console.warn('[accounting integration] MySQL harness unavailable — skipping:', e?.message || e);
      ready = false;
    }
  });

  afterAll(() => {
    closeIntegrationHarness();
  });

  describe('accountingPostingOps', () => {
    it('ensureArchitecturalGlAccounts adds trade AP, equity, and payroll codes', ({ skip }) => {
      if (!ready) skip();
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '2000'`).get()?.code).toBe('2000');
      expect(db.prepare(`SELECT code FROM gl_accounts WHERE code = '6000'`).get()?.code).toBe('6000');
    });

    it('glAccountForExpenseCategory maps carriage inward', () => {
      expect(glAccountForExpenseCategory('Carriage inward').accountCode).toBe('5050');
    });

    it('posts opening balance journal when balanced', ({ skip }) => {
      if (!ready) skip();
      const r = postOpeningBalanceJournal(db, {
        entryDateISO: ACCOUNTING_OPENING_DATE_ISO,
        sourceId: uid('TEST-OPENING'),
        lines: [
          { accountCode: '1000', debitNgn: 500_000 },
          { accountCode: '3100', creditNgn: 500_000 },
        ],
      });
      expect(r.ok).toBe(true);
      expect(r.journalId).toBeTruthy();
    });

    it('tryPostSupplierPaymentGlTx is idempotent by movement id', ({ skip }) => {
      if (!ready) skip();
      const sid = uid('TM-TEST');
      db.prepare(
        `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES ('acc-cash-9','1009','Cash test','asset',1,19)`
      ).run();
      expect(
        tryPostSupplierPaymentGlTx(db, {
          treasuryAccountId: 9,
          amountNgn: 50_000,
          entryDateISO: '2026-06-02',
          sourceKind: 'SUPPLIER_PAYMENT_GL',
          sourceId: sid,
          forceDebitCode: '2000',
        }).ok
      ).toBe(true);
      expect(
        tryPostSupplierPaymentGlTx(db, {
          treasuryAccountId: 9,
          amountNgn: 50_000,
          entryDateISO: '2026-06-02',
          sourceKind: 'SUPPLIER_PAYMENT_GL',
          sourceId: sid,
          forceDebitCode: '2000',
        }).duplicate
      ).toBe(true);
    });

    it('tryPostExpensePaymentGlTx posts fuel to 5010', ({ skip }) => {
      if (!ready) skip();
      const sid = uid('TM-EXP');
      db.prepare(
        `INSERT OR IGNORE INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES ('acc-cash-8','1008','Cash ops','asset',1,18)`
      ).run();
      expect(
        tryPostExpensePaymentGlTx(db, {
          treasuryAccountId: 8,
          amountNgn: 12_000,
          entryDateISO: '2026-06-03',
          sourceId: sid,
          expenseCategory: 'Fuel & lubricant',
        }).ok
      ).toBe(true);
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
      expect(monthBounds('2026-02')?.end).toBe('2026-02-28');
    });

    it('getAccountingStatementsPack returns structure', ({ skip }) => {
      if (!ready) skip();
      const p = getAccountingStatementsPack(db, '2026-01', 'ALL');
      expect(p.ok).toBe(true);
      expect(p.profitAndLoss?.lines).toBeDefined();
      expect(p.balanceSheet?.lines).toBeDefined();
    });
  });

  describe('Phase B — payroll, depreciation, close', () => {
    it('computePayrollRunGlAmounts balances expense and credits', ({ skip }) => {
      if (!ready) skip();
      const runId = `PR-B-${uid('x')}`;
      seedPayrollRun(db, runId, '2026-08', actor.id);
      const amounts = computePayrollRunGlAmounts(db, runId);
      expect(amounts.ok).toBe(true);
      expect(amounts.balanced).toBe(true);
      expect(amounts.expenseDr).toBe(100_000);
    });

    it('tryPostPayrollAccrualGlTx posts Dr 6000 and liability credits', ({ skip }) => {
      if (!ready) skip();
      const runId = `PR-GL-${uid('x')}`;
      seedPayrollRun(db, runId, '2026-09', actor.id);
      const r = tryPostPayrollAccrualGlTx(db, runId, { createdByUserId: actor.id });
      expect(r.ok).toBe(true);
      expect(payrollGlStatusForRun(db, runId).accrualPosted).toBe(true);
    });

    it('previewDepreciationRun excludes land category', ({ skip }) => {
      if (!ready) skip();
      const suffix = uid('FA');
      const branchId = db.prepare(`SELECT id FROM branches LIMIT 1`).get()?.id || 'BR-KD';
      const land = createFixedAsset(
        db,
        { name: `Plot ${suffix}`, category: 'land', branchId, acquisitionDateIso: '2024-01-01', costNgn: 50_000_000, usefulLifeMonths: 600 },
        actor
      );
      const plant = createFixedAsset(
        db,
        {
          name: `Press ${suffix}`,
          category: 'plant',
          branchId,
          acquisitionDateIso: '2024-01-01',
          costNgn: 12_000_000,
          salvageNgn: 0,
          usefulLifeMonths: 120,
        },
        actor
      );
      expect(land.ok).toBe(true);
      expect(plant.ok).toBe(true);
      expect(land.asset?.monthlyDepreciationNgn).toBe(0);
      const names = (previewDepreciationRun(db, '2026-06', 'ALL').rows || []).map((r) => r.name);
      expect(names.some((n) => String(n).includes(`Press ${suffix}`))).toBe(true);
      expect(names.some((n) => String(n).includes(`Plot ${suffix}`))).toBe(false);
    });

    it('buildMonthEndCloseChecklist returns structured steps', ({ skip }) => {
      if (!ready) skip();
      const checklist = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
      expect(checklist.ok).toBe(true);
      expect(checklist.steps.map((s) => s.id)).toContain('statements');
    });
  });
});
