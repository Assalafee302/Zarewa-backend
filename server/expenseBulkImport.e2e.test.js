import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildExpenseImportTemplateXlsx,
  parseExpenseImportWorkbook,
  previewExpenseBulkImport,
  commitExpenseBulkImport,
  normalizeExpenseImportRows,
  parseExpenseImportDate,
} from './expenseBulkImport.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

const ACTOR = {
  id: 'usr-expense-import-e2e',
  displayName: 'Import E2E',
  roleKey: 'admin',
  permissions: ['*', 'finance.post', 'expenses.create'],
};

describe('expense bulk import E2E (MySQL)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let treasuryId;

  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
    db = createDatabase(':memory:');
    // Ensure a branch treasury account with balance for EXPENSE outflow.
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('E2E Cash', 'Cash', 50000000, 'Cash', 'E2E-CASH', ?, 50000000)`
    ).run(DEFAULT_BRANCH_ID);
    // Ensure actor exists so audit_log FK succeeds (mirrors a real logged-in finance user).
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES (?, 'import.e2e', 'Import E2E', 'x', 'admin', 'active', ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'`
    ).run(ACTOR.id, new Date().toISOString());
    treasuryId = Number(
      db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'E2E-CASH'`).get()?.id
    );
    expect(treasuryId).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('parses template workbook and never invents today as the date', () => {
    const buf = buildExpenseImportTemplateXlsx();
    const parsed = parseExpenseImportWorkbook(buf);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    for (const row of parsed.rows) {
      expect(row.date).toMatch(/^2026-07-\d{2}$/);
      expect(row.date.startsWith(new Date().toISOString().slice(0, 7))).toBe(false);
    }
  });

  it('preview accepts July dates and resolves branch treasury', () => {
    const preview = previewExpenseBulkImport(
      db,
      [
        {
          date: '15/07/2026',
          amountNgn: 12_500,
          category: 'Fuel & lubricant',
          treasuryAccountId: treasuryId,
          reference: 'E2E-JUL-1',
          description: 'July diesel catch-up',
          paymentMethod: 'Cash',
          include: true,
        },
        {
          date: '',
          amountNgn: 9_000,
          category: 'Office expenses',
          treasuryAccountId: treasuryId,
          include: true,
        },
      ],
      ACTOR,
      { branchId: DEFAULT_BRANCH_ID, requireTreasury: true }
    );
    expect(preview.ok).toBe(true);
    expect(preview.previewTable[0].date).toBe('2026-07-15');
    expect(preview.previewTable[0].status).toBe('ok');
    expect(preview.previewTable[1].status).toBe('incomplete');
    expect(preview.previewTable[1].missingFields).toContain('date');
  });

  it('commits July expenses with exact dates and does not fall back to today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = normalizeExpenseImportRows([
      {
        date: '2026-07-18',
        amountNgn: 33_000,
        category: 'Maintenance',
        treasuryAccountId: treasuryId,
        reference: 'E2E-JUL-MAINT',
        description: 'July maintenance catch-up',
        paymentMethod: 'Transfer',
        include: true,
      },
      {
        date: '28/07/2026',
        amountNgn: 21_000,
        category: 'Fuel & lubricant',
        treasuryAccountId: treasuryId,
        reference: 'E2E-JUL-FUEL',
        description: 'July fuel catch-up',
        paymentMethod: 'Cash',
        include: true,
      },
    ]);

    const committed = commitExpenseBulkImport(db, ACTOR, rows, DEFAULT_BRANCH_ID, {
      requireTreasury: true,
      workspaceViewAll: false,
    });
    expect(committed.ok).toBe(true);
    expect(committed.createdCount).toBe(2);
    expect(committed.created.map((c) => c.date).sort()).toEqual(['2026-07-18', '2026-07-28']);
    expect(committed.created.every((c) => c.date !== today)).toBe(true);
    expect(committed.created.every((c) => c.expenseID)).toBe(true);

    for (const c of committed.created) {
      const row = db
        .prepare(`SELECT date, amount_ngn, category, branch_id FROM expenses WHERE expense_id = ?`)
        .get(c.expenseID);
      expect(row).toBeTruthy();
      expect(row.date).toBe(c.date);
      expect(String(row.date).startsWith('2026-07')).toBe(true);
      expect(row.branch_id).toBe(DEFAULT_BRANCH_ID);
      expect(Number(row.amount_ngn)).toBe(c.amountNgn);

      const tm = db
        .prepare(
          `SELECT amount_ngn FROM treasury_movements WHERE source_kind = 'EXPENSE' AND source_id = ?`
        )
        .get(c.expenseID);
      expect(tm).toBeTruthy();
      expect(Number(tm.amount_ngn)).toBe(-c.amountNgn);
    }
  });

  it('rejects blank dates instead of writing today', () => {
    const committed = commitExpenseBulkImport(
      db,
      ACTOR,
      [
        {
          date: '',
          amountNgn: 5_000,
          category: 'Office expenses',
          treasuryAccountId: treasuryId,
          include: true,
        },
      ],
      DEFAULT_BRANCH_ID,
      { requireTreasury: true }
    );
    expect(committed.ok).toBe(false);
  });

  it('parseExpenseImportDate never invents today', () => {
    expect(parseExpenseImportDate('')).toBe('');
    expect(parseExpenseImportDate('2026-07-01')).toBe('2026-07-01');
  });
});
