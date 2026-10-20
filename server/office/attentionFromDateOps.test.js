import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID, invalidateBranchListCache } from '../branches.js';
import { listMdAttentionInbox } from '../mdAttentionOps.js';
import { listStockRegisterInbox } from '../stockRegisterOps.js';
import { ATTENTION_FROM_DATE_DEFAULT } from '../../shared/lib/attentionFromDate.js';
import {
  resolveAttentionFromDateWindow,
  setBranchAttentionFromDate,
} from './attentionFromDateOps.js';

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

describe.skipIf(!mysqlOk)('ATTENTION_FROM_DATE', () => {
  /** @type {any} */
  let db;

  beforeEach(() => {
    invalidateBranchListCache();
    db = createDatabase(':memory:', { seed: false });
    const hasBranches = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='branches'`).get();
    if (!hasBranches) {
      db.exec(
        `CREATE TABLE branches (id TEXT PRIMARY KEY, code TEXT, name TEXT, active INTEGER, sort_order INTEGER)`
      );
    }
    const branch = db.prepare(`SELECT 1 FROM branches WHERE id = ?`).get(DEFAULT_BRANCH_ID);
    if (!branch) {
      db.prepare(
        `INSERT INTO branches (id, code, name, active, sort_order) VALUES (?, 'KD', 'Kaduna', 1, 1)`
      ).run(DEFAULT_BRANCH_ID);
    }
    invalidateBranchListCache();
    db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-AFD', 'Test Customer', ?)`).run(
      DEFAULT_BRANCH_ID
    );
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES ('QT-OLD', 'CUS-AFD', 'Test Customer', 42900, 34000, 'Partial', 'Approved', '{}', '2026-05-26', ?),
              ('QT-NEW', 'CUS-AFD', 'Test Customer', 100000, 100000, 'Paid', 'Approved', '{}', '2026-10-01', ?)`
    ).run(DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    invalidateBranchListCache();
    db?.close();
  });

  it('defaults to 1 Aug 2026 and the MD can store another date on the branch', () => {
    expect(resolveAttentionFromDateWindow(db, DEFAULT_BRANCH_ID).dateISO).toBe(ATTENTION_FROM_DATE_DEFAULT);
    const bad = setBranchAttentionFromDate(db, DEFAULT_BRANCH_ID, 'August', { id: 'u1', displayName: 'MD' });
    expect(bad.ok).toBe(false);
    const saved = setBranchAttentionFromDate(db, DEFAULT_BRANCH_ID, '2026-09-01', { id: 'u1', displayName: 'MD' });
    expect(saved.ok).toBe(true);
    expect(resolveAttentionFromDateWindow(db, DEFAULT_BRANCH_ID).dateISO).toBe('2026-09-01');
  });

  it('drops orders dated before the start date from the list and counts them', () => {
    const inbox = listMdAttentionInbox(db, 'ALL');
    const ids = inbox.items.map((it) => it.id);
    expect(ids).toContain('clearance:QT-NEW');
    expect(ids).not.toContain('clearance:QT-OLD');
    expect(inbox.attentionFromDate).toBe('2026-08-01');
    expect(inbox.hiddenOlderCount).toBeGreaterThanOrEqual(1);
    expect(inbox.hiddenOlderByType.orders).toBeGreaterThanOrEqual(1);
    expect(inbox.summary.total).toBe(inbox.items.length);

    const hidden = listMdAttentionInbox(db, 'ALL', { dateMode: 'hidden' });
    expect(hidden.items.some((it) => it.id === 'clearance:QT-OLD')).toBe(true);
    expect(hidden.items.some((it) => it.id === 'clearance:QT-NEW')).toBe(false);
    expect(hidden.items.find((it) => it.id === 'clearance:QT-OLD')?.readOnly).toBe(true);
  });

  it('hides a stock review whose period ends before the start date', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_register_periods (
        id TEXT PRIMARY KEY,
        branch_id TEXT,
        period_key TEXT,
        period_end_iso TEXT,
        status TEXT,
        printed_at_iso TEXT,
        store_confirmed_at_iso TEXT,
        store_confirmed_by_name TEXT,
        bm_approved_at_iso TEXT,
        bm_approved_by_name TEXT,
        md_approved_at_iso TEXT,
        md_approved_by_name TEXT,
        locked_at_iso TEXT,
        count_notes TEXT,
        updated_at_iso TEXT,
        forwarded_to_manager_at_iso TEXT,
        procurement_costed_at_iso TEXT,
        procurement_costed_by_name TEXT,
        bm_adjustments_json TEXT,
        procurement_pricing_json TEXT,
        line_clearance_json TEXT,
        store_checklist_json TEXT,
        count_cutoff_iso TEXT,
        print_version INTEGER
      )
    `);
    db.prepare(
      `INSERT INTO stock_register_periods (id, branch_id, period_key, period_end_iso, status)
       VALUES ('SRP-MAY', ?, '2026-05', '2026-05-30', 'store_confirmed'),
              ('SRP-AUG', ?, '2026-08', '2026-08-31', 'store_confirmed')`
    ).run(DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID);
    const inbox = listStockRegisterInbox(db, DEFAULT_BRANCH_ID, 'manager');
    expect(inbox.items.map((r) => r.periodKey)).toEqual(['2026-08']);
    expect(inbox.hiddenOlderCount).toBe(1);
    expect(inbox.hiddenOlderItems.map((r) => r.periodKey)).toEqual(['2026-05']);
  });
});
