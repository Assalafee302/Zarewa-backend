/**
 * Demo plant register so Report a fault has machines on a fresh legacy pack.
 * Seeds per branch when that branch has no machines (does not overwrite a live register).
 * Also seeds one contractor and a floor technician so BM Issues can assign.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  seedTechniciansFromDesignations,
  updateStaffTechnicianFlags,
} from '../maintenanceVendorsOps.js';

const DEMO_PLANT_MACHINES = Object.freeze([
  {
    id: 'MACH-DEMO-CL1',
    name: 'Corrugation line 1',
    machineCode: 'CL-1',
    machineType: 'corrugation',
    lineName: 'Hall A',
  },
  {
    id: 'MACH-DEMO-RF1',
    name: 'Roll former 1',
    machineCode: 'RF-1',
    machineType: 'roll_former',
    lineName: 'Hall A',
  },
  {
    id: 'MACH-DEMO-GEN1',
    name: 'Standby generator',
    machineCode: 'GEN-1',
    machineType: 'generator',
    lineName: 'Power house',
  },
]);

function activeBranchIds(db) {
  try {
    const rows = db.prepare(`SELECT id FROM branches WHERE COALESCE(active, 1) = 1`).all();
    const ids = rows.map((r) => String(r.id || '').trim()).filter(Boolean);
    if (ids.length) return ids;
  } catch {
    /* table missing on incomplete test DBs */
  }
  return [DEFAULT_BRANCH_ID];
}

function tableCount(db, sql, ...args) {
  try {
    return Number(db.prepare(sql).get(...args)?.c) || 0;
  } catch {
    return -1;
  }
}

function seedDemoVendor(db, branchIds) {
  if (tableCount(db, `SELECT COUNT(*) AS c FROM maintenance_vendors`) !== 0) return 0;
  const now = new Date().toISOString();
  const id = 'MVN-DEMO-PLANT';
  try {
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO maintenance_vendors (
          id, name, contact_person, phone, specialty, branches_served_json, bank_details_json,
          status, notes, created_at_iso, updated_at_iso
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        'Plant mechanical contractor',
        'Workshop desk',
        '',
        'mechanical',
        JSON.stringify(branchIds),
        JSON.stringify({ payeeName: 'Plant mechanical contractor', accountNo: '', bankName: '' }),
        'active',
        'Demo contractor — replace with the real plant vendor on Expenses → Machines.',
        now,
        now
      );
    return Number(r.changes) || 0;
  } catch {
    return 0;
  }
}

function seedDemoTechnician(db) {
  try {
    seedTechniciansFromDesignations(db);
  } catch {
    /* designations / HR table may be missing */
  }
  if (tableCount(db, `SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE COALESCE(is_technician, 0) = 1`) > 0) {
    return 0;
  }
  let user = null;
  try {
    user = db
      .prepare(
        `SELECT id FROM app_users
         WHERE LOWER(COALESCE(role_key, '')) IN ('operations_officer', 'storekeeper', 'store_keeper')
           AND LOWER(COALESCE(status, 'active')) = 'active'
         ORDER BY display_name COLLATE NOCASE
         LIMIT 1`
      )
      .get();
  } catch {
    return 0;
  }
  if (!user?.id) return 0;
  const r = updateStaffTechnicianFlags(
    db,
    user.id,
    { isTechnician: true, specialty: 'mechanical' },
    { id: 'USR-SYSTEM' }
  );
  return r.ok ? 1 : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {number} rows inserted (machines + vendor + technician flags)
 */
export function ensurePlantRegisterDemo(db) {
  const branchIds = activeBranchIds(db);
  let created = 0;

  const now = new Date().toISOString();
  let ins = null;
  try {
    ins = db.prepare(`
      INSERT OR IGNORE INTO machines (
        id, reference_no, branch_id, name, machine_code, line_name, machine_type, status,
        notes, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
  } catch {
    return 0;
  }

  for (const branchId of branchIds) {
    const existing = tableCount(db, `SELECT COUNT(*) AS c FROM machines WHERE branch_id = ?`, branchId);
    if (existing > 0) continue;
    for (const m of DEMO_PLANT_MACHINES) {
      const id = `${m.id}-${branchId}`;
      created += ins.run(
        id,
        id,
        branchId,
        m.name,
        m.machineCode,
        m.lineName,
        m.machineType,
        'active',
        'Demo plant file — replace serial and asset link with the real machine.',
        now,
        now
      ).changes;
    }
  }

  created += seedDemoVendor(db, branchIds);
  created += seedDemoTechnician(db);
  return created;
}
