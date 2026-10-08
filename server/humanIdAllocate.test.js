import { describe, it, expect } from 'vitest';
import { createDatabase } from './db.js';
import {
  allocateHumanId,
  getBranchCodeUpper,
  nextLedgerEntryId,
  nextQuotationHumanId,
} from './humanId.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysql = mysqlAvailable();

describe.skipIf(!mysql)('human id allocation (live numbering)', () => {
  it('allocates first quotation as PREFIX-BRANCH-YY-0001 for Kaduna workspace', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const yy = String(new Date().getFullYear()).slice(-2);
      expect(getBranchCodeUpper(db, 'BR-KD')).toBe('KD');
      const qid = nextQuotationHumanId(db, 'BR-KD');
      expect(qid).toMatch(new RegExp(`^QT-KD-${yy}-0001$`));

      const qid2 = nextQuotationHumanId(db, 'BR-KD');
      expect(qid2).toMatch(new RegExp(`^QT-KD-${yy}-0002$`));
    } finally {
      db.close();
    }
  });

  it('allocates ledger receipts with same branch-year pattern (LE-…)', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const yy = String(new Date().getFullYear()).slice(-2);
      const lid = nextLedgerEntryId(db, 'BR-KD');
      expect(lid).toMatch(new RegExp(`^LE-KD-${yy}-0001$`));
    } finally {
      db.close();
    }
  });

  it('resyncs when sequence lags behind an existing row (manual insert)', () => {
    const db = createDatabase(':memory:', { seed: false });
    try {
      const yy = String(new Date().getFullYear()).slice(-2);
      const year = new Date().getFullYear();
      const stuckId = `RCR-KD-${yy}-0117`;
      db.prepare(
        `INSERT INTO refund_company_retention_entries (
           id, branch_id, entry_type, amount_ngn, open_ngn,
           source_kind, source_id, refund_id, available_after_iso,
           withdrawal_id, note, created_at_iso, created_by_user_id, created_by_name
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        stuckId,
        'BR-KD',
        'credit',
        100,
        100,
        'REFUND_COMPANY_CUT',
        'RF-LAG-TEST',
        'RF-LAG-TEST',
        null,
        null,
        'lag test',
        new Date().toISOString(),
        null,
        null
      );
      db.prepare(`INSERT INTO human_id_sequences (scope, \`last_value\`) VALUES (?, ?)`).run(
        `RCR|KD|${year}`,
        116
      );
      const next = allocateHumanId(db, 'RCR', 'BR-KD', {
        table: 'refund_company_retention_entries',
        idColumn: 'id',
      });
      expect(next).toBe(`RCR-KD-${yy}-0118`);
    } finally {
      db.close();
    }
  });
});
