import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  createMaintenanceVendor,
  getMaintenanceVendor,
  listMaintenanceVendors,
  listMaintenanceTechnicians,
  updateMaintenanceVendor,
  updateStaffTechnicianFlags,
  seedTechniciansFromDesignations,
} from './maintenanceVendorsOps.js';

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

describe.skipIf(!mysqlOk)('maintenanceVendorsOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    // audit_log.actor_user_id is a FK to app_users, so the acting BM must exist.
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES ('USR-BM', 'bm.user', 'BM', 'x', 'sales_manager', 'active', ?)`
    ).run(new Date().toISOString());
  });

  afterEach(() => {
    db?.close?.();
  });

  it('creates and lists vendors with specialty and branches', () => {
    const actor = { id: 'USR-BM', displayName: 'BM', roleKey: 'sales_manager' };
    const created = createMaintenanceVendor(
      db,
      {
        name: 'Musa Engineering',
        contactPerson: 'Alhaji Musa',
        phone: '08012345678',
        specialty: 'mechanical',
        branchesServed: ['BR-KD', 'BR-YL'],
        bankDetails: { payeeName: 'Musa Eng', accountNo: '123', bankName: 'UBA' },
      },
      actor,
      'BR-KD'
    );
    expect(created.ok).toBe(true);
    expect(created.vendor.id).toMatch(/^MVN/);
    expect(created.vendor.specialty).toBe('mechanical');
    expect(created.vendor.branchesServed).toEqual(['BR-KD', 'BR-YL']);

    const listed = listMaintenanceVendors(db, { branchId: 'BR-KD' });
    expect(listed.some((v) => v.id === created.vendor.id)).toBe(true);

    const maiduguriOnly = listMaintenanceVendors(db, { branchId: 'BR-MDG' });
    expect(maiduguriOnly.some((v) => v.id === created.vendor.id)).toBe(false);
  });

  it('updates vendor status', () => {
    const actor = { id: 'USR-BM', roleKey: 'sales_manager' };
    const created = createMaintenanceVendor(db, { name: 'Gen Tech' }, actor, 'BR-KD');
    const updated = updateMaintenanceVendor(db, created.vendor.id, { status: 'inactive' }, actor);
    expect(updated.ok).toBe(true);
    expect(updated.vendor.status).toBe('inactive');
    expect(getMaintenanceVendor(db, created.vendor.id)?.status).toBe('inactive');
  });

  it('seeds technicians from designations and lists them', () => {
    const iso = new Date().toISOString();
    const uid = `USR-TECH-${Date.now()}`;
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, department, status, permissions_json, created_at_iso)
       VALUES (?, ?, 'Tech One', 'x', 'operations_officer', 'operations', 'active', '[]', ?)`
    ).run(uid, `tech.${Date.now()}`, iso);
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, designation_id, is_technician, updated_at_iso)
       VALUES (?, 'BR-KD', 'desig_mtech', 0, ?)`
    ).run(uid, iso);

    const seeded = seedTechniciansFromDesignations(db);
    expect(seeded.updated).toBeGreaterThanOrEqual(1);

    const techs = listMaintenanceTechnicians(db, { branchId: 'BR-KD' });
    expect(techs.some((t) => t.userId === uid && t.isTechnician)).toBe(true);

    const flipped = updateStaffTechnicianFlags(
      db,
      uid,
      { isTechnician: false, specialty: 'electrical' },
      { id: 'USR-BM' }
    );
    expect(flipped.ok).toBe(true);
    expect(listMaintenanceTechnicians(db, { branchId: 'BR-KD' }).some((t) => t.userId === uid)).toBe(false);
  });
});

describe('maintenanceVendorsOps pure helpers (no DB)', () => {
  it('exports specialty seed designation ids', async () => {
    const { TECHNICIAN_SEED_DESIGNATION_IDS, normalizeMaintenanceSpecialty } = await import(
      '../shared/maintenanceRegistry.js'
    );
    expect(TECHNICIAN_SEED_DESIGNATION_IDS).toContain('desig_mtech');
    expect(normalizeMaintenanceSpecialty('Electrical')).toBe('electrical');
    expect(normalizeMaintenanceSpecialty('nope')).toBe('general');
  });
});
