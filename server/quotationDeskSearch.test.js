/**
 * Sales quotations browse sends ?q= and trusts the server. Search must filter
 * in SQL before LIMIT so older quotes remain findable by id or customer name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { countQuotations, listQuotations } from './readModel.js';

const mysqlOk = isMysqlAvailableForTests();

function insertTestCustomer(db, customerId, name = 'Test Customer') {
  db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?, ?, ?)`).run(
    customerId,
    name,
    DEFAULT_BRANCH_ID
  );
}

describe.skipIf(!mysqlOk)('quotation desk search beyond recent page', () => {
  /** @type {import('better-sqlite3').Database | null} */
  let db = null;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
  });

  it('listQuotations ?q= finds id and customer outside the recent-N page', () => {
    db = createDatabase(':memory:', { seed: false });
    insertTestCustomer(db, 'C-OLD', 'Amina Older');
    insertTestCustomer(db, 'C-NEW', 'Newer Customer');

    db.prepare(
      `INSERT INTO quotations (
         id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, status, payment_status, branch_id
       ) VALUES (?, ?, ?, ?, 10000, 0, 'Open', 'Unpaid', ?)`
    ).run('QT-OLD-HIDDEN', 'C-OLD', 'Amina Older', '2025-01-01', DEFAULT_BRANCH_ID);

    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO quotations (
           id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, status, payment_status, branch_id
         ) VALUES (?, ?, ?, ?, 5000, 0, 'Open', 'Unpaid', ?)`
      ).run(
        `QT-NEW-${i}`,
        'C-NEW',
        'Newer Customer',
        `2026-09-${String(10 + i).padStart(2, '0')}`,
        DEFAULT_BRANCH_ID
      );
    }

    const deskPage = listQuotations(db, DEFAULT_BRANCH_ID, { limit: 5, includeLines: false });
    expect(deskPage).toHaveLength(5);
    expect(deskPage.some((row) => row.id === 'QT-OLD-HIDDEN')).toBe(false);

    const byId = listQuotations(db, DEFAULT_BRANCH_ID, {
      q: 'QT-OLD-HIDDEN',
      limit: 5,
      includeLines: false,
    });
    expect(byId.some((row) => row.id === 'QT-OLD-HIDDEN')).toBe(true);
    expect(countQuotations(db, DEFAULT_BRANCH_ID, { q: 'QT-OLD-HIDDEN' })).toBe(1);

    const byName = listQuotations(db, DEFAULT_BRANCH_ID, {
      q: 'Amina',
      limit: 5,
      includeLines: false,
    });
    expect(byName.some((row) => row.id === 'QT-OLD-HIDDEN')).toBe(true);
  });
});
