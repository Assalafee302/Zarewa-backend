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

  const actor = { id: 'u1', displayName: 'Manager' };

  it('blocks manager clear when balance is still due', () => {
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/balance due/i);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeNull();
  });

  it('release_payments clears manager cleared and flagged holds', () => {
    reviewQuotation(db, 'QT-PARTIAL', { decision: 'flag', note: 'audit' }, actor);
    let row = db.prepare(
      `SELECT manager_cleared_at_iso, manager_flagged_at_iso, manager_flag_reason FROM quotations WHERE id = ?`
    ).get('QT-PARTIAL');
    expect(row.manager_flagged_at_iso).toBeTruthy();

    const rel = reviewQuotation(db, 'QT-PARTIAL', { decision: 'release_payments' }, actor);
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

  it('allows manager clear when quotation is fully paid', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 21725 WHERE id = ?`).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeTruthy();
  });
});

describe('reviewQuotation production gate override', () => {
  let db;
  const bmActor = { id: 'bm1', displayName: 'Branch Manager', roleKey: 'sales_manager' };
  const salesActor = { id: 's1', displayName: 'Sales Officer', roleKey: 'sales_staff' };

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-2', 'Low Pay', 'BR1');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-LOW', 'CUS-2', 'Low Pay', 1000000, 0, 'Unpaid', 'Approved', '{}', '2026-06-01');
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
          manager_production_approval_note = NULL
      WHERE id = 'QT-LOW'
    `);
  });

  it('allows branch manager override with audited reason', () => {
    const r = reviewQuotation(db, 'QT-LOW', {
      decision: 'approve_production',
      note: 'Trusted customer — deposit promised this week',
    }, bmActor);
    expect(r.ok).toBe(true);
    const row = db.prepare(
      `SELECT manager_production_approved_at_iso, manager_production_approval_note FROM quotations WHERE id = ?`
    ).get('QT-LOW');
    expect(row.manager_production_approved_at_iso).toBeTruthy();
    expect(row.manager_production_approval_note).toMatch(/deposit promised/i);
  });

  it('blocks sales officer from production override', () => {
    const r = reviewQuotation(db, 'QT-LOW', {
      decision: 'approve_production',
      note: 'Sales officer trying override',
    }, salesActor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Branch Manager|Managing Director/i);
  });

  it('requires override reason of at least 8 characters', () => {
    const r = reviewQuotation(db, 'QT-LOW', { decision: 'approve_production', note: 'short' }, bmActor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/8 characters/i);
  });
});
