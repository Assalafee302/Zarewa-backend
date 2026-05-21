import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { insertSupplier } from './writeOps.js';
import {
  buildSupplierMergePlan,
  findSupplierIdentityConflict,
  migrateMergeDuplicateSuppliers,
} from './supplierDedupe.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

describe('supplierDedupe', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('clusters and merges duplicate suppliers by normalized name', () => {
    insertSupplier(db, { name: 'Merge Test Co Ltd', city: 'Kano' }, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id)
       VALUES ('SUP-099', 'Merge Test Company', 'Abuja', 'Credit', 80, '', ?)`
    ).run(DEFAULT_BRANCH_ID);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM suppliers`).get().c).toBe(2);

    const plan = buildSupplierMergePlan(db);
    expect(plan.length).toBe(1);

    const result = migrateMergeDuplicateSuppliers(db);
    expect(result.merged).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM suppliers`).get().c).toBe(1);
    const row = db.prepare(`SELECT name FROM suppliers`).get();
    expect(row.name).toMatch(/Merge Test/i);
  });

  it('findSupplierIdentityConflict blocks duplicate phone on create payload', () => {
    const id = insertSupplier(
      db,
      { name: 'Phone Holder', supplierProfile: { phoneMain: '08021112233' } },
      DEFAULT_BRANCH_ID
    );
    const conflict = findSupplierIdentityConflict(
      db,
      DEFAULT_BRANCH_ID,
      { name: 'Other Vendor', supplierProfile: { phoneMain: '+2348021112233' } },
      null
    );
    expect(conflict?.supplierId).toBe(id);
    expect(conflict?.field).toBe('phone');
  });
});
