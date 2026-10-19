import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';

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

describe.skipIf(!mysqlOk)('listMdAttentionInbox — every item carries the shared sentence', () => {
  /** @type {any} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
  });

  it('pending refund: sentence, all flags, and both deep links', () => {
    db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-1', 'Test Customer', ?)`).run(DEFAULT_BRANCH_ID);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-ATT-1', 'CUS-1', 'Test Customer', 1500000, 1500000, 'Paid', 'Approved', '{}', '2026-10-01', '${DEFAULT_BRANCH_ID}');
    `);
    db.exec(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso, branch_id
      ) VALUES (
        'RF-ATT-1', 'CUS-1', 'Tahir Musa', 'QT-ATT-1', '—', '["Overpayment"]',
        'Overpaid', 1408453, 0, 0, 'Pending', 'Sales', '2026-10-16', '${DEFAULT_BRANCH_ID}'
      )
    `);
    const inbox = listMdAttentionInbox(db, 'ALL');
    const it = inbox.items.find((x) => x.id === 'refund:RF-ATT-1');
    expect(it).toBeTruthy();
    expect(it.attention.ruleIds).toEqual(['refund_pending', 'refund_above_limit']);
    expect(it.attention.sentence).toMatch(
      /^Refund ₦1,408,453 to Tahir Musa \(Overpayment\) requested 16 Oct(?: 2026)? is waiting for approval — \d+ days?$/
    );
    expect(it.attention.links.exec).toBe('/exec?tab=decide&attention=refund%3ARF-ATT-1');
    expect(it.attention.links.manager).toBe('/manager?inbox=cash_out&refundId=RF-ATT-1&attention=refund%3ARF-ATT-1');
    for (const row of inbox.items) {
      expect(row.attention?.sentence, row.id).toBeTruthy();
    }
  });
});
