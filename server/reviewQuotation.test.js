import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { reviewQuotation } from './controlOps.js';

describe('reviewQuotation manager holds', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-PARTIAL', 'CUS-1', 'Test', 21725, 2725, 'Partial', 'Pending', '{}', '2026-05-16');
    `);
  });

  afterEach(() => {
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

  it('allows manager clear when quotation is fully paid', () => {
    db.prepare(`UPDATE quotations SET paid_ngn = 21725 WHERE id = ?`).run('QT-PARTIAL');
    const r = reviewQuotation(db, 'QT-PARTIAL', { decision: 'clear' }, actor);
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-PARTIAL');
    expect(row.manager_cleared_at_iso).toBeTruthy();
  });
});
