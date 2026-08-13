import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { findSimilarOpenBankDeposits, listBankDepositDuplicateExceptions } from './bankDepositOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

function seedPair(db, { depositAmount, depositDate, treasuryAmount, treasuryDate, depositId = 'BD-1', ledgerId = 'LE-1' }) {
  db.prepare(
    `INSERT OR REPLACE INTO bank_deposits (
      id, branch_id, bank_date_iso, amount_ngn, allocated_ngn, description, bank_reference, status, registered_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(depositId, DEFAULT_BRANCH_ID, depositDate, depositAmount, 0, 'Unlinked inflow', 'REF-A', 'OPEN', new Date().toISOString());

  db.prepare(
    `INSERT OR REPLACE INTO ledger_entries (
      id, type, customer_id, customer_name, amount_ngn, at_iso, payment_method, bank_reference, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(ledgerId, 'RECEIPT', 'CUS-1', 'Test Customer', treasuryAmount, `${treasuryDate}T12:00:00.000Z`, 'Transfer', 'REF-A', DEFAULT_BRANCH_ID);

  const tmId = `TM-${ledgerId}`;
  db.prepare(
    `INSERT OR REPLACE INTO treasury_movements (
      id, type, source_kind, source_id, treasury_account_id, amount_ngn, posted_at_iso, reference, reverses_movement_id
    ) VALUES (?,?,?,?,?,?,?,?,NULL)`
  ).run(tmId, 'RECEIPT_IN', 'LEDGER_RECEIPT', ledgerId, 1, treasuryAmount, `${treasuryDate}T12:00:00.000Z`, 'REF-A');
}

describe.skipIf(!mysqlOk)('bank deposit close amount/date suggestions', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('findSimilarOpenBankDeposits includes close date and close amount', () => {
    db.prepare(
      `INSERT OR REPLACE INTO bank_deposits (
        id, branch_id, bank_date_iso, amount_ngn, allocated_ngn, description, bank_reference, status, registered_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('BD-CLOSE', DEFAULT_BRANCH_ID, '2026-08-10', 100_000, 0, 'Near', 'X', 'OPEN', new Date().toISOString());

    const hits = findSimilarOpenBankDeposits(db, {
      branchId: DEFAULT_BRANCH_ID,
      amountNgn: 100_050,
      bankDateISO: '2026-08-11',
      bankReference: '',
    });
    expect(hits.some((h) => h.id === 'BD-CLOSE')).toBe(true);
    const hit = hits.find((h) => h.id === 'BD-CLOSE');
    expect(hit.amountClose).toBe(true);
    expect(hit.dateClose).toBe(true);
    expect(hit.canMergeDuplicate).toBe(false);
  });

  it('lists exact-amount close-date pairs as mergeable exceptions', () => {
    seedPair(db, {
      depositAmount: 250_000,
      depositDate: '2026-08-10',
      treasuryAmount: 250_000,
      treasuryDate: '2026-08-11',
    });
    const rows = listBankDepositDuplicateExceptions(db, DEFAULT_BRANCH_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].canMerge).toBe(true);
    expect(rows[0].dateExact).toBe(false);
    expect(rows[0].dateClose).toBe(true);
    expect(rows[0].matchHints).toEqual(expect.arrayContaining(['exact amount', 'close date']));
  });

  it('lists close-amount pairs as suggest-only exceptions', () => {
    seedPair(db, {
      depositAmount: 250_000,
      depositDate: '2026-08-11',
      treasuryAmount: 250_100,
      treasuryDate: '2026-08-11',
      depositId: 'BD-NEAR',
      ledgerId: 'LE-NEAR',
    });
    const rows = listBankDepositDuplicateExceptions(db, DEFAULT_BRANCH_ID);
    expect(rows.some((r) => r.depositId === 'BD-NEAR')).toBe(true);
    const row = rows.find((r) => r.depositId === 'BD-NEAR');
    expect(row.canMerge).toBe(false);
    expect(row.amountClose).toBe(true);
    expect(row.amountExact).toBe(false);
  });
});
