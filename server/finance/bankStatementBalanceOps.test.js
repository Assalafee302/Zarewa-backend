import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import { buildBankReconStatementReport } from './bankReconStatementSourceOps.js';
import { listStatementBalances, upsertStatementBalance } from './bankStatementBalanceOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

// DB-backed: skips on machines without MySQL (release checklist: run against a real database).
describe.skipIf(!mysqlAvailable())('bank statement balances (round 2, C)', () => {
  let db;
  let account;
  const user = { id: 'USR-FIN', displayName: 'Finance Officer', roleKey: 'finance_manager' };
  beforeEach(() => {
    db = createDatabase(':memory:');
    account = db.prepare(`SELECT id, branch_id FROM treasury_accounts WHERE type <> 'Cash' ORDER BY id LIMIT 1`).get();
  });
  afterEach(() => db?.close());

  it('saves opening and closing with kobo, who and when; a second save replaces it and both are audited', () => {
    const r = upsertStatementBalance(db, { treasuryAccountId: account.id, periodKey: '2026-08', openingNgn: '12,924,292.56', closingNgn: 132311.01 }, user);
    expect(r.ok).toBe(true);
    expect(r.balance).toMatchObject({ openingNgn: 12_924_292.56, closingNgn: 132_311.01, enteredByName: 'Finance Officer' });
    expect(r.balance.enteredAtISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    upsertStatementBalance(db, { treasuryAccountId: account.id, periodKey: '2026-08', openingNgn: 1, closingNgn: 2 }, user);
    expect(listStatementBalances(db, { periodKey: '2026-08' })).toHaveLength(1);
    const audits = db.prepare(`SELECT * FROM audit_log WHERE action = 'bank_statement_balance.save' ORDER BY occurred_at_iso`).all();
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1].details_json || audits[1].details || '{}').before).toMatchObject({ openingNgn: 12_924_292.56 });
  });

  it('rejects a bad period, an unknown account or a missing figure', () => {
    expect(upsertStatementBalance(db, { treasuryAccountId: account.id, periodKey: '2026-8', openingNgn: 1, closingNgn: 1 }, user).ok).toBe(false);
    expect(upsertStatementBalance(db, { treasuryAccountId: 99999, periodKey: '2026-08', openingNgn: 1, closingNgn: 1 }, user).ok).toBe(false);
    expect(upsertStatementBalance(db, { treasuryAccountId: account.id, periodKey: '2026-08', openingNgn: '', closingNgn: 1 }, user).ok).toBe(false);
  });

  it('the bank reconciliation statement reads the stored month: closing from the statement, gap shown', async () => {
    upsertStatementBalance(db, { treasuryAccountId: account.id, periodKey: '2026-08', openingNgn: 1000.5, closingNgn: 1500.5 }, user);
    db.prepare(
      `INSERT INTO bank_reconciliation_lines (id, bank_date_iso, description, amount_ngn, system_match, status, branch_id, treasury_account_id)
       VALUES ('BKR-T-1', '2026-08-10', 'x', 300, 'NOT IN ERP', 'Review', ?, ?)`
    ).run(account.branch_id, account.id);
    const report = await buildBankReconStatementReport(db, { branchScope: 'ALL', startDate: '2026-08-01', endDate: '2026-08-31' });
    const page = report.pages.find((p) => p.account.id === account.id);
    expect(page.bank).toMatchObject({ openingNgn: 1000.5, closingNgn: 1500.5, closingSource: 'statement', linesNetNgn: 300, statementGapNgn: 200 });
    expect(page.statementBalance).toMatchObject({ enteredByName: 'Finance Officer' });
  });
});
