import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { applyAdminDataReset, ADMIN_DATA_RESET_CONFIRM_PHRASE } from './adminDataResetOps.js';
import { ensureHumanIdSequencesTable } from './humanId.js';

describe('admin data reset branch scope', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('rejects reset without a single branch workspace', () => {
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'ALL',
    });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/one branch/i);
  });

  it('rejects reset when workspace view-all is set', () => {
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
      workspaceViewAll: true,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/all branches/i);
  });

  it('clears human_id_sequences only for the target branch code', () => {
    ensureHumanIdSequencesTable(db);
    db.prepare(`INSERT INTO human_id_sequences (scope, \`last_value\`) VALUES (?, 5), (?, 3)`).run(
      'QT|YL|2026',
      'QT|MDG|2026'
    );
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT scope FROM human_id_sequences`).all().map((x) => x.scope)).toEqual(['QT|MDG|2026']);
  });

  it('deletes customers only for the selected branch', () => {
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status, tier, payment_terms)
       VALUES ('C-YL', 'Yola Co', 'BR-YL', 'Active', 'Standard', 'Cash'),
              ('C-MDG', 'Maiduguri Co', 'BR-MDG', 'Active', 'Standard', 'Cash')`
    ).run();
    const r = applyAdminDataReset(db, ['operations_core'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id`).all().map((x) => x.customer_id)).toEqual([
      'C-MDG',
    ]);
  });
});
