import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  ensureWorkspaceSearchFtsSchema,
  rebuildWorkspaceSearchFts,
  queryWorkspaceSearchFts,
  toFts5MatchQuery,
  logWorkspaceSearchMiss,
  workspaceSearchFtsReady,
} from './workspaceSearchFts.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mysqlAvailable())('workspaceSearchFts', () => {
  /** @type {ReturnType<typeof createDatabase>} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        customer_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone_number TEXT,
        email TEXT,
        company_name TEXT,
        tier TEXT,
        crm_profile_notes TEXT,
        branch_id TEXT
      );
    `);
    db.prepare(
      `INSERT INTO customers (customer_id, name, phone_number, email, company_name, tier, crm_profile_notes, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('CU-1', 'Musa Hassan', '0801', 'm@x.com', 'Musa Co', 'A', '', 'BR-KD');
    ensureWorkspaceSearchFtsSchema(db);
    rebuildWorkspaceSearchFts(db);
  });

  it('toFts5MatchQuery builds prefix tokens', () => {
    expect(toFts5MatchQuery('musa hassan')).toBe('"musa"* "hassan"*');
  });

  it('indexes and finds customers', () => {
    expect(workspaceSearchFtsReady(db)).toBe(true);
    const hits = queryWorkspaceSearchFts(db, 'BR-KD', ['customer'], 'musa', 10);
    expect(hits.some((h) => h.kind === 'customer' && h.id === 'CU-1')).toBe(true);
  });

  it('logs search misses without throwing', () => {
    logWorkspaceSearchMiss(db, { query: 'zzznomatch', contextPath: '/sales', userId: 'U1', branchId: 'BR-KD' });
    const row = db.prepare(`SELECT COUNT(*) AS n FROM workspace_search_misses`).get();
    expect(Number(row?.n ?? 0)).toBeGreaterThan(0);
  });
});
