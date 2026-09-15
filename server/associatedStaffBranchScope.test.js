import { describe, it, expect } from 'vitest';
import { insertAssociatedStaff } from './writeOps.js';
import { listAssociatedStaff } from './readModel.js';
import { assertAssociatedStaffIdInWorkspace } from './workspaceBranchGuards.js';

/** Minimal better-sqlite3 harness (package may be absent in MySQL-only installs). */
async function tryMemDb() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE associated_staff (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      staff_type TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      bank_account_name TEXT,
      bank_name TEXT,
      bank_account_no TEXT,
      profile_json TEXT,
      branch_id TEXT NOT NULL
    );
  `);
  return db;
}

describe('associated staff (drivers/installers) per branch', () => {
  it('listAssociatedStaff filters by workspace branch scope', async () => {
    const db = await tryMemDb();
    if (!db) return;
    insertAssociatedStaff(
      db,
      { id: 'AS-YL-1', name: 'Yola Driver', staffType: 'Driver', status: 'Active' },
      'BR-YL'
    );
    insertAssociatedStaff(
      db,
      { id: 'AS-MDG-1', name: 'Maiduguri Installer', staffType: 'Installer', status: 'Active' },
      'BR-MDG'
    );

    const yola = listAssociatedStaff(db, 'BR-YL');
    const mdg = listAssociatedStaff(db, 'BR-MDG');
    const all = listAssociatedStaff(db, 'ALL');

    expect(yola).toHaveLength(1);
    expect(yola[0].name).toBe('Yola Driver');
    expect(yola[0].branchId).toBe('BR-YL');
    expect(yola[0].staffType).toBe('Driver');

    expect(mdg).toHaveLength(1);
    expect(mdg[0].name).toBe('Maiduguri Installer');
    expect(mdg[0].branchId).toBe('BR-MDG');
    expect(mdg[0].staffType).toBe('Installer');

    expect(all).toHaveLength(2);
  });

  it('insertAssociatedStaff stamps workspace branch (not company-wide empty)', async () => {
    const db = await tryMemDb();
    if (!db) return;
    const id = insertAssociatedStaff(db, { name: 'Yola Driver Two', staffType: 'Driver' }, 'BR-YL');
    const row = db.prepare(`SELECT branch_id FROM associated_staff WHERE id = ?`).get(id);
    expect(row.branch_id).toBe('BR-YL');
    expect(listAssociatedStaff(db, 'BR-KD').some((s) => s.id === id)).toBe(false);
    expect(listAssociatedStaff(db, 'BR-YL').some((s) => s.id === id)).toBe(true);
  });

  it('includes legacy empty branch_id only on default Kaduna workspace', async () => {
    const db = await tryMemDb();
    if (!db) return;
    db.prepare(
      `INSERT INTO associated_staff (id, name, staff_type, status, branch_id)
       VALUES ('AS-LEGACY', 'Legacy Driver', 'Driver', 'Active', '')`
    ).run();
    expect(listAssociatedStaff(db, 'BR-KD').some((s) => s.id === 'AS-LEGACY')).toBe(true);
    expect(listAssociatedStaff(db, 'BR-YL').some((s) => s.id === 'AS-LEGACY')).toBe(false);
  });

  it('assertAssociatedStaffIdInWorkspace blocks cross-branch edits', async () => {
    const db = await tryMemDb();
    if (!db) return;
    insertAssociatedStaff(db, { id: 'AS-YL-9', name: 'Yola', staffType: 'Driver' }, 'BR-YL');
    const kadunaReq = {
      user: { id: 'u1', roleKey: 'cashier', permissions: [] },
      workspaceBranchId: 'BR-KD',
      workspaceViewAll: false,
    };
    const g = assertAssociatedStaffIdInWorkspace(db, kadunaReq, 'AS-YL-9');
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });
});
