/**
 * Demo plant register so Report a fault has machines on a fresh legacy pack.
 * Seeds per branch when that branch has no machines (does not overwrite a live register).
 * Also seeds one contractor, a floor technician, and service plans for demo gen/forklift.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { defaultServiceIntervalDays } from '../../shared/maintenanceRegistry.js';
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
  {
    id: 'MACH-DEMO-FL1',
    name: 'Yard forklift',
    machineCode: 'FL-1',
    machineType: 'forklift',
    lineName: 'Yard',
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

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function seedDemoFuelServicePlans(db) {
  let machines;
  try {
    machines = db
      .prepare(
        `SELECT id, branch_id, name, machine_type
         FROM machines
         WHERE id LIKE 'MACH-DEMO-GEN%' OR id LIKE 'MACH-DEMO-FL%'`
      )
      .all();
  } catch {
    return 0;
  }
  let created = 0;
  const now = new Date().toISOString();
  let ins;
  try {
    ins = db.prepare(`
      INSERT OR IGNORE INTO maintenance_plans (
        id, reference_no, branch_id, machine_id, status, plan_kind, summary, calendar_interval_days,
        next_due_date_iso, approval_required, responsible_office_key, notes, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
  } catch {
    return 0;
  }
  for (const m of machines) {
    const existing = tableCount(
      db,
      `SELECT COUNT(*) AS c FROM maintenance_plans WHERE machine_id = ? AND LOWER(COALESCE(status, 'active')) = 'active'`,
      m.id
    );
    if (existing > 0) continue;
    const interval = defaultServiceIntervalDays(m.machine_type);
    const kind = String(m.machine_type || '').toLowerCase() === 'forklift' ? 'forklift' : 'generator';
    const summary = kind === 'forklift' ? 'Forklift service (oil, filters, hydraulics)' : 'Generator service (oil, filters, coolant)';
    const id = `MPL-DEMO-${m.id}`;
    created += ins.run(
      id,
      id,
      m.branch_id,
      m.id,
      'active',
      'preventive',
      summary,
      interval,
      addDaysIso(7),
      1,
      'operations',
      'Demo service plan — Branch Manager opens a job from Shift → Preventive maintenance due.',
      now,
      now
    ).changes;
  }
  return created;
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
  created += seedDemoFuelServicePlans(db);
  return created;
}
