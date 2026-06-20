import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import {
  createRegisterSettlement,
  decideRegisterSettlement,
  ensureAccountingRegisterSettlementSchema,
  registerLineSettlementCapacity,
  reservedSettlementNgnOnLine,
} from './accountingRegisterSettlementOps.js';
import { ensureAccountingRegisterSchema } from './accountingSubledgerOps.js';

describe('accountingRegisterSettlementOps capacity', () => {
  it('reservedSettlementNgnOnLine runs without SQL errors', () => {
    const db = createDatabase(':memory:', { seed: false });
    ensureAccountingRegisterSchema(db);
    ensureAccountingRegisterSettlementSchema(db);
    const lineId = 'REG-TEST-MAMIA';
    db.prepare(
      `INSERT INTO accounting_register_lines (
        id, register_side, branch_id, party_name, party_ref, amount_ngn, status,
        category, as_at_date_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      lineId,
      'debtor',
      'BR-KD',
      'Mamia Seed Oil Ltd',
      '',
      8_710_000,
      'open',
      'project_overpayment',
      '2026-07-01',
      new Date().toISOString()
    );

    expect(reservedSettlementNgnOnLine(db, lineId)).toBe(0);
    const cap = registerLineSettlementCapacity(db, lineId);
    expect(cap.ok).toBe(true);
    expect(cap.openNgn).toBe(8_710_000);
    expect(cap.availableNgn).toBe(8_710_000);

    const req = createRegisterSettlement(
      db,
      { registerLineId: lineId, amountNgn: 8_000_000, reason: 'Bonus payout' },
      { id: 'acct-1', displayName: 'Accountant' }
    );
    expect(req.ok).toBe(true);

    const cap2 = registerLineSettlementCapacity(db, lineId);
    expect(cap2.reservedNgn).toBe(8_000_000);
    expect(cap2.availableNgn).toBe(710_000);
    expect(cap2.blockingItems).toHaveLength(1);
    db.close();
  });

  it('MD can approve pending withdrawal above executive threshold', () => {
    const db = createDatabase(':memory:', { seed: false });
    ensureAccountingRegisterSchema(db);
    ensureAccountingRegisterSettlementSchema(db);
    const lineId = 'REG-TEST-MD-APPROVE';
    db.prepare(
      `INSERT INTO accounting_register_lines (
        id, register_side, branch_id, party_name, party_ref, amount_ngn, status,
        category, as_at_date_iso, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      lineId,
      'debtor',
      'BR-KD',
      'Mamia Seed Oil Ltd',
      '',
      8_710_000,
      'open',
      'project_overpayment',
      '2026-06-01',
      new Date().toISOString()
    );

    const req = createRegisterSettlement(
      db,
      { registerLineId: lineId, amountNgn: 8_000_000, reason: 'Bonus payout' },
      { id: 'acct-1', displayName: 'Accountant', roleKey: 'finance_manager' }
    );
    expect(req.ok).toBe(true);
    const settlementId = req.settlement.settlementId;
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, role_key, status, created_at_iso)
       VALUES (?, ?, ?, ?, 'active', ?)`
    ).run('md-1', 'md', 'Managing Director', 'md', new Date().toISOString());

    const mdDecision = decideRegisterSettlement(
      db,
      settlementId,
      { status: 'Approved', approvedAmountNgn: 8_000_000, note: 'MD approval' },
      {
        id: 'md-1',
        displayName: 'Managing Director',
        roleKey: 'md',
        permissions: ['refunds.approve', 'finance.approve'],
      }
    );
    expect(mdDecision.ok).toBe(true);
    expect(mdDecision.settlement?.status).toBe('Approved');
    expect(mdDecision.settlement?.approvedAmountNgn).toBe(8_000_000);
    db.close();
  });
});
