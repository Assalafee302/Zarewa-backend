import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  quotationAgeCalendarDays,
  expireQuotationsPastValidity,
  voidRecentQuotationsAfterMasterPriceChange,
  quotationHasCommitment,
  QUOTATION_VALIDITY_DAYS,
} from './quotationLifecycleOps.js';

function memDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE quotations (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      date_iso TEXT,
      payment_status TEXT,
      paid_ngn INTEGER DEFAULT 0,
      status TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      quotation_lifecycle_note TEXT,
      manager_production_approved_at_iso TEXT,
      lines_json TEXT
    );
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY,
      quotation_ref TEXT,
      amount_ngn INTEGER,
      type TEXT
    );
    CREATE TABLE cutting_lists (
      id TEXT PRIMARY KEY,
      quotation_ref TEXT
    );
  `);
  return db;
}

describe('quotationLifecycleOps', () => {
  it('computes calendar day delta', () => {
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-01')).toBe(0);
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-10')).toBe(9);
    expect(quotationAgeCalendarDays('2026-01-01', '2026-01-11')).toBe(10);
  });

  it('expires uncommitted quotations on day ' + QUOTATION_VALIDITY_DAYS, () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q1','C1','Test','2026-01-01','Unpaid',0,'Pending',0)`
    ).run();
    const r = expireQuotationsPastValidity(db, 'ALL', '2026-01-11');
    expect(r.expired).toBe(1);
    const row = db.prepare(`SELECT status, archived FROM quotations WHERE id='Q1'`).get();
    expect(row.status).toBe('Expired');
    expect(row.archived).toBe(1);
  });

  it('does not expire when there is payment on quote', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q1','C1','Test','2026-01-01','Partial',1000,'Approved',0)`
    ).run();
    const r = expireQuotationsPastValidity(db, 'ALL', '2026-02-01');
    expect(r.expired).toBe(0);
  });

  it('voids recent quotes on master price change rule', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q1','C1','Test','2026-04-03','Unpaid',0,'Pending',0)`
    ).run();
    const r = voidRecentQuotationsAfterMasterPriceChange(db, 'ALL', '2026-04-04');
    expect(r.voided).toBe(1);
    const row = db.prepare(`SELECT status FROM quotations WHERE id='Q1'`).get();
    expect(row.status).toBe('Void');
  });

  it('does not void when age >= PRICE_CHANGE_VOID_MAX_AGE_DAYS', () => {
    const db = memDb();
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, payment_status, paid_ngn, status, archived)
       VALUES ('Q1','C1','Test','2026-04-01','Unpaid',0,'Pending',0)`
    ).run();
    const r = voidRecentQuotationsAfterMasterPriceChange(db, 'ALL', '2026-04-04');
    expect(r.voided).toBe(0);
  });

  it('quotationHasCommitment detects ledger receipt', () => {
    const db = memDb();
    const row = {
      id: 'Q1',
      paid_ngn: 0,
      payment_status: 'Unpaid',
      manager_production_approved_at_iso: '',
    };
    expect(quotationHasCommitment(db, row)).toBe(false);
    db.prepare(`INSERT INTO ledger_entries (id, quotation_ref, amount_ngn, type) VALUES ('L1','Q1',5000,'RECEIPT')`).run();
    expect(quotationHasCommitment(db, row)).toBe(true);
  });
});
