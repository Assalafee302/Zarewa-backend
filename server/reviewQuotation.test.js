import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { reviewQuotation } from './controlOps.js';

describe('reviewQuotation manager holds', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('u1', 'manager.user', 'Manager', 'test-hash', 'branch_manager', '2026-01-01T00:00:00.000Z');
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('md1', 'md.user', 'MD', 'test-hash', 'md', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-1', 'Test', 'BR1');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-PARTIAL', 'CUS-1', 'Test', 21725, 2725, 'Partial', 'Pending', '{}', '2026-05-16');
    `);
  }, 120_000);

  beforeEach(() => {
    db.exec(`
      UPDATE quotations
      SET paid_ngn = 2725, total_ngn = 21725, payment_status = 'Partial', status = 'Pending',
          manager_cleared_at_iso = NULL, manager_flagged_at_iso = NULL, manager_flag_reason = NULL
      WHERE id = 'QT-PARTIAL'
    `);
  });

  afterAll(() => {
    db?.close();
  });

  const actor = { id: 'u1', displayName: 'Manager', roleKey: 'branch_manager' };

  it('blocks manager clear when balance is still due', () => {
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/balance due/i);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeNull();
  });

  it('release_payments clears manager cleared and flagged holds', () => {
    const mdActor = { id: 'md1', displayName: 'MD', roleKey: 'md' };
    reviewQuotation(db, 'QT-PARTIAL', { decision: 'flag', note: 'audit' }, mdActor);
    let row = db.prepare(
      `SELECT manager_cleared_at_iso, manager_flagged_at_iso, manager_flag_reason FROM quotations WHERE id = ?`
    ).get('QT-PARTIAL');
    expect(row.manager_flagged_at_iso).toBeTruthy();

    const rel = reviewQuotation(db, 'QT-PARTIAL', { decision: 'release_payments' }, mdActor);
    expect(rel.ok).toBe(true);
    row = db.prepare(
      `SELECT manager_cleared_at_iso, manager_flagged_at_iso, manager_flag_reason FROM quotations WHERE id = ?`
    ).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeNull();
    expect(row.manager_flagged_at_iso).toBeNull();
    expect(row.manager_flag_reason).toBeNull();
  });

  it('allows manager clear when quotation is at least 99.5% paid', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 21617, total_ngn = 21725 WHERE id = ?`).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeTruthy();
  });

  it('waive_balance clears accounting receivable for small round-off', () => {
    db.prepare(
      `UPDATE quotations SET paid_ngn = 1250000, total_ngn = 1250300, payment_balance_waived_ngn = 0 WHERE id = ?`
    ).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'waive_balance', note: 'Round-off' }, actor);
    expect(r.ok).toBe(true);
    expect(r.waivedAmountNgn).toBe(300);
    const row = db.prepare(
      `SELECT payment_balance_waived_ngn, payment_balance_waived_at_iso, manager_cleared_at_iso FROM quotations WHERE id = ?`
    ).get('QT-PARTIAL');
    expect(row.payment_balance_waived_ngn).toBe(300);
    expect(row.payment_balance_waived_at_iso).toBeTruthy();
    expect(row.manager_cleared_at_iso).toBeTruthy();
  });

  it('blocks waive_balance when balance is material underpayment', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 800000, total_ngn = 1000000, payment_balance_waived_ngn = 0 WHERE id = ?`).run(
      'QT-PARTIAL'
    );
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'waive_balance', note: 'Try skip payment' }, actor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/round-off|MD/i);
  });

  it('blocks waive_balance when no payment recorded', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 0, total_ngn = 1250300 WHERE id = ?`).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'waive_balance' }, actor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/round-off|MD|payment/i);
  });

  it('write_off_receivable requires MD', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 800000, total_ngn = 1000000, payment_balance_waived_ngn = 0 WHERE id = ?`).run(
      'QT-PARTIAL'
    );
    const bm = reviewQuotation(
      db,
      'QT-PARTIAL',
      { decision: 'write_off_receivable', note: 'Customer insolvent — board approved write-off' },
      actor
    );
    expect(bm.ok).toBe(false);
    expect(bm.code).toBe('FORBIDDEN');

    const mdActor = { id: 'md1', displayName: 'MD', roleKey: 'md' };
    const md = reviewQuotation(
      db,
      'QT-PARTIAL',
      { decision: 'write_off_receivable', note: 'Customer insolvent — board approved write-off' },
      mdActor
    );
    expect(md.ok).toBe(true);
    expect(md.waivedAmountNgn).toBe(200_000);
  });

  it('allows manager clear when quotation is fully paid', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 21725 WHERE id = ?`).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeTruthy();
  });

  it('blocks sales officer from quotation clearance', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 21725 WHERE id = ?`).run('QT-PARTIAL');
    const salesActor = { id: 's1', displayName: 'Sales', roleKey: 'sales_staff' };
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, salesActor);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });

  it('blocks branch manager from release_payments', () => {
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'release_payments' }, actor);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });
});

describe('reviewQuotation production gate override', () => {
  let db;
  const bmActor = { id: 'bm1', displayName: 'Branch Manager', roleKey: 'branch_manager' };
  const mdActor = { id: 'md1', displayName: 'Managing Director', roleKey: 'md' };
  const salesActor = { id: 's1', displayName: 'Sales Officer', roleKey: 'sales_staff' };

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('bm1', 'bm.user', 'Branch Manager', 'test-hash', 'branch_manager', '2026-01-01T00:00:00.000Z'),
             ('md1', 'md.user', 'MD', 'test-hash', 'md', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-2', 'Low Pay', 'BR1'), ('CUS-3', 'Zero Pay', 'BR1');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES
        ('QT-LOW', 'CUS-2', 'Low Pay', 1000000, 200000, 'Partial', 'Approved', '{}', '2026-06-01'),
        ('QT-ZERO', 'CUS-3', 'Zero Pay', 1000000, 0, 'Unpaid', 'Approved', '{}', '2026-06-01');
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  beforeEach(() => {
    db.exec(`
      UPDATE quotations
      SET manager_production_approved_at_iso = NULL,
          manager_production_approved_by_user_id = NULL,
          manager_production_approval_note = NULL,
          manager_production_approval_level = NULL
      WHERE id IN ('QT-LOW', 'QT-ZERO')
    `);
  });

  it('allows branch manager override when some payment exists', () => {
    const r = reviewQuotation(db, 'QT-LOW', {
      decision: 'approve_production',
      note: 'Trusted customer — partial deposit received',
    }, bmActor);
    expect(r.ok).toBe(true);
    const row = db.prepare(
      `SELECT manager_production_approval_level FROM quotations WHERE id = ?`
    ).get('QT-LOW');
    expect(row.manager_production_approval_level).toBe('branch_manager');
  });

  it('blocks branch manager override at zero payment', () => {
    const r = reviewQuotation(db, 'QT-ZERO', {
      decision: 'approve_production',
      note: 'BM trying zero-payment override',
    }, bmActor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Managing Director/i);
  });

  it('allows md override at zero payment', () => {
    const r = reviewQuotation(db, 'QT-ZERO', {
      decision: 'approve_production',
      note: 'Strategic customer — MD approved start without deposit',
    }, mdActor);
    expect(r.ok).toBe(true);
    const row = db.prepare(
      `SELECT manager_production_approval_level FROM quotations WHERE id = ?`
    ).get('QT-ZERO');
    expect(row.manager_production_approval_level).toBe('md');
  });

  it('blocks sales officer from production override', () => {
    const r = reviewQuotation(db, 'QT-LOW', {
      decision: 'approve_production',
      note: 'Sales officer trying override',
    }, salesActor);
    expect(r.ok).toBe(false);
  });

  it('requires override reason of at least 8 characters', () => {
    const r = reviewQuotation(db, 'QT-LOW', { decision: 'approve_production', note: 'short' }, bmActor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/8 characters/i);
  });
});
