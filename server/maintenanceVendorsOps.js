/**
 * Maintenance vendors registry + technician flags on hr_staff_profiles.
 */
import { appendAuditLog } from './controlOps.js';
import { nextMaintenanceVendorHumanId } from './humanId.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  normalizeMaintenanceSpecialty,
  TECHNICIAN_SEED_DESIGNATION_IDS,
} from '../shared/maintenanceRegistry.js';

function nowIso() {
  return new Date().toISOString();
}

function parseBranchesServed(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
    } catch {
      return raw
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function mapVendorRow(row) {
  if (!row) return null;
  let branchesServed = [];
  try {
    branchesServed = JSON.parse(row.branches_served_json || '[]');
    if (!Array.isArray(branchesServed)) branchesServed = [];
  } catch {
    branchesServed = [];
  }
  let bankDetails = null;
  try {
    bankDetails = row.bank_details_json ? JSON.parse(row.bank_details_json) : null;
  } catch {
    bankDetails = null;
  }
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person || '',
    phone: row.phone || '',
    specialty: row.specialty || 'general',
    branchesServed,
    bankDetails: bankDetails || {
      payeeName: '',
      accountNo: '',
      bankName: '',
    },
    status: row.status || 'active',
    notes: row.notes || '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    createdByUserId: row.created_by_user_id || '',
    updatedByUserId: row.updated_by_user_id || '',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, status?: string, includeAllBranches?: boolean }} [opts]
 */
export function listMaintenanceVendors(db, opts = {}) {
  const status = String(opts.status || '').trim().toLowerCase();
  const branchId = String(opts.branchId || '').trim();
  const includeAll = Boolean(opts.includeAllBranches);
  let rows = db
    .prepare(
      `SELECT * FROM maintenance_vendors
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC`
    )
    .all();
  if (status === 'active' || status === 'inactive') {
    rows = rows.filter((r) => String(r.status || '').toLowerCase() === status);
  }
  if (branchId && !includeAll) {
    rows = rows.filter((r) => {
      const served = parseBranchesServed(r.branches_served_json);
      if (!served.length) return true;
      return served.includes(branchId);
    });
  }
  return rows.map(mapVendorRow);
}

export function getMaintenanceVendor(db, vendorId) {
  const id = String(vendorId || '').trim();
  if (!id) return null;
  const row = db.prepare(`SELECT * FROM maintenance_vendors WHERE id = ?`).get(id);
  return mapVendorRow(row);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {{ id?: string, displayName?: string, username?: string }} actor
 * @param {string} [workspaceBranchId]
 */
export function createMaintenanceVendor(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const name = String(body?.name || '').trim();
  if (!name) return { ok: false, error: 'Vendor name is required.' };
  const specialty = normalizeMaintenanceSpecialty(body?.specialty);
  const branchesServed = parseBranchesServed(body?.branchesServed ?? body?.branches_served);
  if (!branchesServed.length && workspaceBranchId) {
    branchesServed.push(String(workspaceBranchId).trim());
  }
  const status = String(body?.status || 'active').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active';
  const bank =
    body?.bankDetails && typeof body.bankDetails === 'object'
      ? body.bankDetails
      : {
          payeeName: body?.payeeName || '',
          accountNo: body?.accountNo || body?.payeeAccountNo || '',
          bankName: body?.bankName || body?.payeeBankName || '',
        };
  const id = nextMaintenanceVendorHumanId(db, workspaceBranchId || DEFAULT_BRANCH_ID);
  const iso = nowIso();
  db.prepare(
    `INSERT INTO maintenance_vendors (
      id, name, contact_person, phone, specialty, branches_served_json, bank_details_json,
      status, notes, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    String(body?.contactPerson || body?.contact_person || '').trim() || null,
    String(body?.phone || '').trim() || null,
    specialty,
    JSON.stringify(branchesServed),
    JSON.stringify({
      payeeName: String(bank.payeeName || '').trim(),
      accountNo: String(bank.accountNo || '').trim(),
      bankName: String(bank.bankName || '').trim(),
    }),
    status,
    String(body?.notes || '').trim() || null,
    iso,
    iso,
    String(actor?.id || '').trim() || null,
    String(actor?.id || '').trim() || null
  );
  appendAuditLog(db, {
    actor,
    action: 'maintenance_vendor.create',
    entityKind: 'maintenance_vendor',
    entityId: id,
    note: name,
  });
  return { ok: true, vendor: getMaintenanceVendor(db, id) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} vendorId
 * @param {object} body
 * @param {{ id?: string }} actor
 */
export function updateMaintenanceVendor(db, vendorId, body, actor) {
  const existing = getMaintenanceVendor(db, vendorId);
  if (!existing) return { ok: false, error: 'Vendor not found.' };
  const name = String(body?.name != null ? body.name : existing.name).trim();
  if (!name) return { ok: false, error: 'Vendor name is required.' };
  const specialty = normalizeMaintenanceSpecialty(
    body?.specialty != null ? body.specialty : existing.specialty
  );
  const branchesServed =
    body?.branchesServed != null || body?.branches_served != null
      ? parseBranchesServed(body?.branchesServed ?? body?.branches_served)
      : existing.branchesServed;
  const statusRaw = body?.status != null ? body.status : existing.status;
  const status = String(statusRaw || 'active').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active';
  const bankIn =
    body?.bankDetails && typeof body.bankDetails === 'object' ? body.bankDetails : existing.bankDetails;
  const iso = nowIso();
  db.prepare(
    `UPDATE maintenance_vendors SET
      name = ?, contact_person = ?, phone = ?, specialty = ?, branches_served_json = ?,
      bank_details_json = ?, status = ?, notes = ?, updated_at_iso = ?, updated_by_user_id = ?
     WHERE id = ?`
  ).run(
    name,
    String(body?.contactPerson != null ? body.contactPerson : existing.contactPerson || '').trim() || null,
    String(body?.phone != null ? body.phone : existing.phone || '').trim() || null,
    specialty,
    JSON.stringify(branchesServed),
    JSON.stringify({
      payeeName: String(bankIn?.payeeName || '').trim(),
      accountNo: String(bankIn?.accountNo || '').trim(),
      bankName: String(bankIn?.bankName || '').trim(),
    }),
    status,
    String(body?.notes != null ? body.notes : existing.notes || '').trim() || null,
    iso,
    String(actor?.id || '').trim() || null,
    existing.id
  );
  appendAuditLog(db, {
    actor,
    action: 'maintenance_vendor.update',
    entityKind: 'maintenance_vendor',
    entityId: existing.id,
    note: name,
  });
  return { ok: true, vendor: getMaintenanceVendor(db, existing.id) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, activeOnly?: boolean }} [opts]
 */
export function listMaintenanceTechnicians(db, opts = {}) {
  const branchId = String(opts.branchId || '').trim();
  const activeOnly = opts.activeOnly !== false;
  let sql = `
    SELECT u.id AS user_id, u.display_name, u.username, u.role_key, u.status AS user_status,
           u.workspace_branch_id, p.branch_id AS profile_branch_id, p.job_title,
           p.designation_id, p.is_technician, p.technician_specialty
    FROM app_users u
    LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
    WHERE COALESCE(p.is_technician, 0) = 1
  `;
  const params = [];
  if (activeOnly) {
    sql += ` AND LOWER(COALESCE(u.status, 'active')) = 'active'`;
  }
  if (branchId) {
    sql += ` AND (
      TRIM(COALESCE(p.branch_id, '')) = ?
      OR TRIM(COALESCE(u.workspace_branch_id, '')) = ?
      OR TRIM(COALESCE(p.branch_id, '')) = ''
    )`;
    params.push(branchId, branchId);
  }
  sql += ` ORDER BY u.display_name COLLATE NOCASE ASC`;
  return db.prepare(sql).all(...params).map((r) => ({
    userId: r.user_id,
    displayName: r.display_name || r.username || r.user_id,
    username: r.username || '',
    roleKey: r.role_key || '',
    userStatus: r.user_status || 'active',
    branchId: r.profile_branch_id || r.workspace_branch_id || '',
    jobTitle: r.job_title || '',
    designationId: r.designation_id || '',
    isTechnician: Boolean(r.is_technician),
    specialty: normalizeMaintenanceSpecialty(r.technician_specialty),
  }));
}

/**
 * Ensure profile row exists, then set technician flags.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ isTechnician?: boolean, specialty?: string }} body
 * @param {{ id?: string }} actor
 */
export function updateStaffTechnicianFlags(db, userId, body, actor) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'userId is required.' };
  const user = db.prepare(`SELECT id FROM app_users WHERE id = ?`).get(uid);
  if (!user) return { ok: false, error: 'User not found.' };
  const iso = nowIso();
  const existing = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(uid);
  if (!existing) {
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, is_technician, technician_specialty, updated_at_iso, updated_by_user_id)
       VALUES (?, 0, 'general', ?, ?)`
    ).run(uid, iso, String(actor?.id || '').trim() || null);
  }
  const isTech =
    body?.isTechnician != null ? (body.isTechnician ? 1 : 0) : null;
  const specialty =
    body?.specialty != null ? normalizeMaintenanceSpecialty(body.specialty) : null;
  if (isTech == null && specialty == null) {
    return { ok: false, error: 'Provide isTechnician and/or specialty.' };
  }
  if (isTech != null && specialty != null) {
    db.prepare(
      `UPDATE hr_staff_profiles SET is_technician = ?, technician_specialty = ?, updated_at_iso = ?, updated_by_user_id = ?
       WHERE user_id = ?`
    ).run(isTech, specialty, iso, String(actor?.id || '').trim() || null, uid);
  } else if (isTech != null) {
    db.prepare(
      `UPDATE hr_staff_profiles SET is_technician = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`
    ).run(isTech, iso, String(actor?.id || '').trim() || null, uid);
  } else {
    db.prepare(
      `UPDATE hr_staff_profiles SET technician_specialty = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`
    ).run(specialty, iso, String(actor?.id || '').trim() || null, uid);
  }
  appendAuditLog(db, {
    actor,
    action: 'staff.technician_flags.update',
    entityKind: 'hr_staff_profile',
    entityId: uid,
    details: { isTechnician: isTech, specialty },
  });
  const tech = listMaintenanceTechnicians(db, { activeOnly: false }).find((t) => t.userId === uid);
  return {
    ok: true,
    technician: tech || {
      userId: uid,
      isTechnician: Boolean(isTech),
      specialty: specialty || 'general',
    },
  };
}

/** Seed is_technician from maintenance designations (idempotent). */
export function seedTechniciansFromDesignations(db) {
  const ids = TECHNICIAN_SEED_DESIGNATION_IDS;
  if (!ids.length) return { updated: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const iso = nowIso();
  const result = db
    .prepare(
      `UPDATE hr_staff_profiles
       SET is_technician = 1,
           technician_specialty = COALESCE(NULLIF(TRIM(technician_specialty), ''), 'general'),
           updated_at_iso = ?
       WHERE designation_id IN (${placeholders})
         AND COALESCE(is_technician, 0) = 0`
    )
    .run(iso, ...ids);
  return { updated: Number(result.changes) || 0 };
}
