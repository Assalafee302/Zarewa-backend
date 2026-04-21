import { describe, it, expect } from 'vitest';
import {
  quotationAgeCalendarDays,
  expireQuotationsPastValidity,
  voidRecentQuotationsAfterMasterPriceChange,
  quotationHasCommitment,
  QUOTATION_VALIDITY_DAYS,
} from './quotationLifecycleOps.js';
import { createDatabase } from './db.js';

function memDb() {
  return createDatabase(':memory:');
}

describe('quotationLifecycleOps', () => {
  it('computes calendar day delta', () => {
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-01')).toBe(0);
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-10')).toBe(9);
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-11')).toBe(10);
  });

  it('expires uncommitted quotations on day ' + QUOTATION_VALIDITY_DAYS, () => {
    const db = memDb();
    const cid =
      db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1`).get()?.customer_id || 'C1';
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q-LCYCLE-EXP',?,?, '2026-01-01','Unpaid',0,'Pending',0)`
    ).run(cid, 'Test');
    const r = expireQuotationsPastValidity(db, 'ALL', '2026-01-11');
    expect(r.expired).toBe(1);
    const row = db.prepare(`SELECT status, archived FROM quotations WHERE id='Q-LCYCLE-EXP'`).get();
    expect(row.status).toBe('Expired');
    expect(row.archived).toBe(1);
    db.close();
  });

  it('does not expire when there is payment on quote', () => {
    const db = memDb();
    const cid =
      db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1`).get()?.customer_id || 'C1';
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q-LCYCLE-PAY',?,?, '2026-01-01','Partial',1000,'Approved',0)`
    ).run(cid, 'Test');
    const r = expireQuotationsPastValidity(db, 'ALL', '2026-02-01');
    expect(r.expired).toBe(0);
    db.close();
  });

  it('voids recent quotes on master price change rule', () => {
    const db = memDb();
    const cid =
      db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1`).get()?.customer_id || 'C1';
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q-LCYCLE-VOID',?,?, '2026-04-03','Unpaid',0,'Pending',0)`
    ).run(cid, 'Test');
    const r = voidRecentQuotationsAfterMasterPriceChange(db, 'ALL', '2026-04-04');
    expect(r.voided).toBe(1);
    const row = db.prepare(`SELECT status FROM quotations WHERE id='Q-LCYCLE-VOID'`).get();
    expect(row.status).toBe('Void');
    db.close();
  });

  it('does not void when age >= PRICE_CHANGE_VOID_MAX_AGE_DAYS', () => {
    const db = memDb();
    const cid =
      db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1`).get()?.customer_id || 'C1';
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q-LCYCLE-OLD',?,?, '2026-04-01','Unpaid',0,'Pending',0)`
    ).run(cid, 'Test');
    const r = voidRecentQuotationsAfterMasterPriceChange(db, 'ALL', '2026-04-04');
    expect(r.voided).toBe(0);
    db.close();
  });

  it('quotationHasCommitment detects ledger receipt', () => {
    const db = memDb();
    const cid =
      db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1`).get()?.customer_id || 'C1';
    const row = {
      id: 'Q-LCYCLE-COMM',
      paid_ngn: 0,
      payment_status: 'Unpaid',
      manager_production_approved_at_iso: '',
    };
    expect(quotationHasCommitment(db, row)).toBe(false);
    db.prepare(
      `INSERT INTO ledger_entries (id, at_iso, type, customer_id, amount_ngn, quotation_ref)
       VALUES ('L-LCYCLE-1','2026-04-19T12:00:00.000Z','RECEIPT',?,5000,'Q-LCYCLE-COMM')`
    ).run(cid);
    expect(quotationHasCommitment(db, row)).toBe(true);
    db.close();
  });
});
