/**
 * Company retention withdrawal cancel + BM cash-approve gates (pure / lightweight).
 */
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  actorMayCashApproveCompanyRetentionWithdrawal,
  payCompanyRetentionWithdrawal,
} from './refundCompanyRetentionOps.js';
import {
  companyRetentionAvailability,
  creditCompanyRetentionFromRefundTx,
  refundCompanyRetentionTablesReady,
} from './refundCompanyRetentionLedger.js';

function dbAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const PAYER = { id: 'usr-rcw-pay', displayName: 'Cut Payer', roleKey: 'admin', permissions: ['*'] };

describe.skipIf(!dbAvailable())('payCompanyRetentionWithdrawal', () => {
  it('posts a bank outflow and a refund-payout journal', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      if (!refundCompanyRetentionTablesReady(db)) return;
      const accountId = Number(
        db
          .prepare(
            `INSERT INTO treasury_accounts (name, bank_name, balance, opening_balance_ngn, type, branch_id)
             VALUES ('Moniepoint test', 'Moniepoint', 500000, 500000, 'Bank', ?)`
          )
          .run(DEFAULT_BRANCH_ID).lastInsertRowid
      );
      creditCompanyRetentionFromRefundTx(db, {
        refundId: 'RF-CUT-1',
        branchId: DEFAULT_BRANCH_ID,
        amountNgn: 120000,
      });
      const at = new Date().toISOString();
      db.prepare(
        `INSERT INTO refund_company_retention_withdrawals (
           id, branch_id, amount_ngn, status, payee_name, payee_bank_name, payee_account_no,
           requested_by_user_id, requested_by_name, requested_at_iso,
           approved_by_user_id, approved_by_name, approved_at_iso, cash_confirmed_at_iso
         ) VALUES ('RCW-T-1', ?, 100000, 'approved', 'Owner', 'OPay', '0000000000',
           'usr-req', 'Req', ?, 'usr-bm', 'BM', ?, ?)`
      ).run(DEFAULT_BRANCH_ID, at, at, at);

      expect(payCompanyRetentionWithdrawal(db, { withdrawalId: 'RCW-T-1', actor: PAYER }).ok).toBe(false);

      const r = payCompanyRetentionWithdrawal(db, {
        withdrawalId: 'RCW-T-1',
        treasuryAccountId: accountId,
        reference: 'TRF-1',
        actor: PAYER,
      });
      expect(r.ok).toBe(true);
      expect(r.treasuryMovementId).toBeTruthy();

      const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(r.treasuryMovementId);
      expect(tm).toMatchObject({
        type: 'REFUND_COMPANY_CUT_PAYOUT',
        amount_ngn: -100000,
        source_kind: 'REFUND_COMPANY_RETENTION',
        source_id: 'RCW-T-1',
      });
      expect(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(accountId).balance).toBe(400000);
      expect(
        db.prepare(`SELECT treasury_movement_id, treasury_account_id FROM refund_company_retention_withdrawals WHERE id = 'RCW-T-1'`).get()
      ).toMatchObject({ treasury_movement_id: r.treasuryMovementId, treasury_account_id: accountId });

      const glLines = db
        .prepare(
          `SELECT ga.code, jl.debit_ngn, jl.credit_ngn
           FROM gl_journal_entries je
           JOIN gl_journal_lines jl ON jl.journal_id = je.id
           JOIN gl_accounts ga ON ga.id = jl.account_id
           WHERE je.source_kind = 'COMPANY_CUT_WITHDRAWAL_GL' AND je.source_id = 'RCW-T-1'`
        )
        .all();
      if (glLines.length) {
        expect(glLines.find((l) => l.code === '2500')?.debit_ngn).toBe(100000);
        expect(glLines.find((l) => l.code === '1000')?.credit_ngn).toBe(100000);
        expect(glLines.some((l) => l.code === '4050')).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe('actorMayCashApproveCompanyRetentionWithdrawal', () => {
  it('allows Branch Manager role keys', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'sales_manager' })).toBe(true);
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'branch_manager' })).toBe(true);
  });

  it('allows admin / wildcard', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'admin' })).toBe(true);
    expect(
      actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'cashier', permissions: ['*'] })
    ).toBe(true);
  });

  it('locks an open withdrawal until it is paid or cancelled', () => {
    expect(
      companyRetentionAvailability({ totalOpenNgn: 961_510, reservedNgn: 50_000, cooldownActive: false })
    ).toMatchObject({ availableNgn: 911_510, heldNgn: 50_000, reservedNgn: 50_000 });
    expect(
      companyRetentionAvailability({ totalOpenNgn: 911_510, reservedNgn: 0, cooldownActive: false })
    ).toMatchObject({ availableNgn: 911_510, heldNgn: 0, reservedNgn: 0 });
  });

  it('keeps the open balance available unless a withdrawal freeze is on', () => {
    expect(
      companyRetentionAvailability({
        totalOpenNgn: 1_000_000,
        reservedNgn: 0,
        withdrawalFrozen: false,
      })
    ).toMatchObject({ availableNgn: 1_000_000, excludedNgn: 0, heldNgn: 0 });
    expect(
      companyRetentionAvailability({
        totalOpenNgn: 1_000_000,
        withdrawalFrozen: true,
      })
    ).toMatchObject({ availableNgn: 0, withdrawalFrozen: true });
  });

  it('locks the whole balance during the post-payout cooldown', () => {
    expect(
      companyRetentionAvailability({ totalOpenNgn: 100_000, reservedNgn: 0, cooldownActive: true })
    ).toMatchObject({ availableNgn: 0, heldNgn: 100_000 });
  });

  it('blocks cashier and finance_manager without BM role', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'cashier' })).toBe(false);
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'finance_manager' })).toBe(
      false
    );
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'sales_staff' })).toBe(false);
  });
});
