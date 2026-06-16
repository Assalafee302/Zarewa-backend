import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { insertExpenseEntry, payPaymentRequest } from './writeOps.js';
import { listFixedAssets } from './accountingPhase2Ops.js';
import { syncFixedAssetFromCapexExpense, expenseTreasuryPaidNgn } from './fixedAssetAutomationOps.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';

describe('fixedAssetAutomationOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('auto-registers a fixed asset when a capex expense is paid from treasury', () => {
    const r = insertExpenseEntry(
      db,
      {
        expenseType: 'Hydraulic press',
        category: 'Plant and machinery',
        amountNgn: 4_500_000,
        date: '2025-03-10',
        paymentMethod: 'Transfer',
        reference: 'CAPEX-PRESS-01',
        treasuryAccountId: 1,
        actor: { id: 'u1' },
      },
      'BR-KD'
    );
    expect(r.ok).toBe(true);

    const assets = listFixedAssets(db, 'BR-KD');
    expect(assets.assets).toHaveLength(1);
    expect(assets.assets[0].name).toBe('Hydraulic press');
    expect(assets.assets[0].costNgn).toBe(4_500_000);
    expect(assets.assets[0].category).toBe('plant');
    expect(assets.assets[0].sourceExpenseId).toBe(r.expenseID);

    const je = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'CAPEX_CAPITALIZE' AND source_id = ?`)
      .get(r.expenseID);
    expect(je?.id).toBeTruthy();
  });

  it('skips non-capex expenses', () => {
    const r = insertExpenseEntry(
      db,
      {
        category: 'Rent & utilities',
        amountNgn: 50_000,
        date: '2025-03-10',
        treasuryAccountId: 1,
      },
      'BR-KD'
    );
    expect(r.ok).toBe(true);
    expect(listFixedAssets(db, 'ALL').assets).toHaveLength(0);
  });

  it('waits until payment request is fully paid', () => {
    const exp = insertExpenseEntry(
      db,
      {
        expenseType: 'Office desks',
        category: 'Furniture & fittings',
        amountNgn: 800_000,
        date: '2025-04-01',
      },
      'BR-KD'
    );
    expect(exp.ok).toBe(true);
    expect(expenseTreasuryPaidNgn(db, exp.expenseID)).toBe(0);

    db.prepare(
      `INSERT INTO payment_requests (request_id, expense_id, amount_requested_ngn, request_date, approval_status, description, paid_amount_ngn)
       VALUES (?,?,?,?,?,?,?)`
    ).run('PR-CAPEX-1', exp.expenseID, 800_000, '2025-04-01', 'Approved', 'Office desks', 0);

    const partial = payPaymentRequest(db, 'PR-CAPEX-1', {
      treasuryAccountId: 1,
      amountNgn: 300_000,
      paidAtISO: '2025-04-05',
      actor: { id: 'u1' },
      workspaceBranchId: 'BR-KD',
    });
    expect(partial.ok).toBe(true);
    expect(partial.fullyPaid).toBe(false);
    expect(listFixedAssets(db, 'ALL').assets).toHaveLength(0);

    const full = payPaymentRequest(db, 'PR-CAPEX-1', {
      treasuryAccountId: 1,
      amountNgn: 500_000,
      paidAtISO: '2025-04-10',
      actor: { id: 'u1' },
      workspaceBranchId: 'BR-KD',
    });
    expect(full.ok).toBe(true);
    expect(full.fullyPaid).toBe(true);

    const assets = listFixedAssets(db, 'BR-KD');
    expect(assets.assets).toHaveLength(1);
    expect(assets.assets[0].costNgn).toBe(800_000);
    expect(assets.assets[0].acquisitionDateIso).toBe('2025-04-10');
  });

  it('is idempotent for the same expense', () => {
    const exp = insertExpenseEntry(
      db,
      {
        category: 'Generator',
        amountNgn: 1_200_000,
        date: '2025-05-01',
        treasuryAccountId: 1,
      },
      'BR-KD'
    );
    const again = syncFixedAssetFromCapexExpense(db, exp.expenseID, { acquisitionDateIso: '2025-05-01' });
    expect(again.ok).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(listFixedAssets(db, 'ALL').assets).toHaveLength(1);
  });
});
