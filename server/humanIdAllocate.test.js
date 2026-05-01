import { describe, it, expect } from 'vitest';
import { createDatabase } from './db.js';
import {
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
});
