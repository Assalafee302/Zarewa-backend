/**
 * Phase 6 — payroll hold/release, reconciliation, bonus approval workflow.
 * @module server/hrPayrollControl
 */

import crypto from 'node:crypto';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { applyBonusToPayrollRun } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function hrPayrollControlTablesReady(db) {
  return hrTableExists(db, 'hr_bonus_requests');
}

function staffSalaryOnHold(profileExtra) {
  const extra = profileExtra && typeof profileExtra === 'object' ? profileExtra : safeJsonParse(profileExtra, {});
  const status = String(extra?.employmentMeta?.salaryStatus || '').toLowerCase();
  return status === 'held' || status === 'suspended';
}

/**
 * Hold or release a payroll line (draft runs only).
 */
export function setPayrollLineHold(db, runId, userId, { hold = true, reason = '' } = {}, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const run = db.prepare(`SELECT status FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status !== 'draft') return { ok: false, error: 'Only draft runs can have line holds changed.' };
  const line = db.prepare(`SELECT * FROM hr_payroll_lines WHERE run_id = ? AND user_id = ?`).get(runId, userId);
  if (!line) return { ok: false, error: 'Payroll line not found.' };
  try {
    db.prepare(
      `UPDATE hr_payroll_lines SET pay_hold = ?, hold_reason = ?, net_ngn = CASE WHEN ? = 1 THEN 0 ELSE net_ngn END WHERE run_id = ? AND user_id = ?`
    ).run(hold ? 1 : 0, hold ? String(reason || '').trim() || 'Payroll hold' : null, hold ? 1 : 0, runId, userId);
  } catch {
    return { ok: false, error: 'Payroll hold columns not available — run db:migrate.' };
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    actorDisplayName: actor?.displayName,
    action: hold ? 'hr.payroll.line_hold' : 'hr.payroll.line_release',
    entityKind: 'payroll_run',
    entityId: runId,
    details: { userId, reason: reason || null },
  });
  return { ok: true, hold: Boolean(hold) };
}

/**
 * Set staff-level salary hold via profile extra (applies on next compute).
 */
export function setStaffSalaryHold(db, userId, { hold = true, reason = '' } = {}, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const row = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  if (!row) return { ok: false, error: 'Staff profile not found.' };
  const extra = safeJsonParse(row.profile_extra_json, {});
  extra.employmentMeta = {
    ...(extra.employmentMeta || {}),
    salaryStatus: hold ? 'held' : 'active',
    payrollHoldReason: hold ? String(reason || '').trim() || null : null,
    payrollHoldAtIso: hold ? nowIso() : null,
  };
  db.prepare(`UPDATE hr_staff_profiles SET profile_extra_json = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE user_id = ?`).run(
    JSON.stringify(extra),
    nowIso(),
    actor?.id || null,
    userId
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: hold ? 'hr.payroll.salary_hold' : 'hr.payroll.salary_release',
    entityKind: 'staff',
    entityId: userId,
    details: { reason: reason || null },
  });
  return { ok: true, hold: Boolean(hold) };
}

/**
 * Reconcile payroll run totals vs bank export expectations.
 */
export function getPayrollReconciliation(db, runId) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const run = db.prepare(`SELECT * FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  const lines = db
    .prepare(
      `SELECT l.user_id AS userId, l.net_ngn AS netNgn, l.gross_ngn AS grossNgn,
              l.pay_hold AS payHold, u.display_name AS displayName, p.employee_no AS employeeNo
       FROM hr_payroll_lines l
       LEFT JOIN app_users u ON u.id = l.user_id
       LEFT JOIN hr_staff_profiles p ON p.user_id = l.user_id
       WHERE l.run_id = ?`
    )
    .all(runId);
  let payrollTotal = 0;
  let heldCount = 0;
  const heldLines = [];
  for (const l of lines) {
    const net = Math.round(Number(l.netNgn) || 0);
    if (Number(l.payHold) === 1 || net === 0) {
      heldCount += 1;
      heldLines.push(l);
    } else {
      payrollTotal += net;
    }
  }
  const staffCount = lines.length;
  const payCount = staffCount - heldCount;
  let bankExportTotal = payrollTotal;
  try {
    const rec = db.prepare(`SELECT bank_export_total_ngn FROM hr_payroll_reconciliations WHERE run_id = ?`).get(runId);
    if (rec?.bank_export_total_ngn != null) bankExportTotal = Math.round(Number(rec.bank_export_total_ngn) || 0);
  } catch {
    /* table may not exist yet */
  }
  const varianceNgn = payrollTotal - bankExportTotal;
  const anomalies = [];
  if (Math.abs(varianceNgn) > 0) {
    anomalies.push({
      type: 'bank_variance',
      message: `Payroll net (₦${payrollTotal.toLocaleString()}) differs from last bank export (₦${bankExportTotal.toLocaleString()}) by ₦${Math.abs(varianceNgn).toLocaleString()}.`,
      varianceNgn,
    });
  }
  if (heldCount > 0) {
    anomalies.push({
      type: 'held_lines',
      message: `${heldCount} staff on payroll hold — excluded from bank upload.`,
      count: heldCount,
    });
  }
  return {
    ok: true,
    runId,
    periodYyyymm: run.period_yyyymm,
    status: run.status,
    staffCount,
    payCount,
    heldCount,
    payrollTotalNgn: payrollTotal,
    bankExportTotalNgn: bankExportTotal,
    varianceNgn,
    reconciled: Math.abs(varianceNgn) === 0 && run.status === 'paid',
    anomalies,
    heldLines,
  };
}

/**
 * Record bank export total for reconciliation (called after bank CSV export).
 */
export function recordPayrollBankExport(db, runId, totalNgn, actor) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  if (!hrTableExists(db, 'hr_payroll_reconciliations')) {
    return { ok: false, error: 'Reconciliation table not available — run db:migrate.' };
  }
  const now = nowIso();
  const total = Math.round(Number(totalNgn) || 0);
  const existing = db.prepare(`SELECT id FROM hr_payroll_reconciliations WHERE run_id = ?`).get(runId);
  if (existing) {
    db.prepare(
      `UPDATE hr_payroll_reconciliations SET bank_export_total_ngn = ?, exported_at_iso = ?, exported_by_user_id = ? WHERE run_id = ?`
    ).run(total, now, actor?.id || null, runId);
  } else {
    db.prepare(
      `INSERT INTO hr_payroll_reconciliations (id, run_id, bank_export_total_ngn, exported_at_iso, exported_by_user_id, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(newId('HRPREC'), runId, total, now, actor?.id || null, now);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.payroll.bank_export_recorded',
    entityKind: 'payroll_run',
    entityId: runId,
    details: { totalNgn: total },
  });
  return { ok: true, totalNgn: total };
}

/**
 * Request bonus application — requires GMHR approval before apply.
 */
export function requestPayrollBonus(db, runId, body, actor) {
  if (!hrPayrollControlTablesReady(db)) return { ok: false, error: 'Bonus approval module not initialised.' };
  const run = db.prepare(`SELECT status FROM hr_payroll_runs WHERE id = ?`).get(runId);
  if (!run) return { ok: false, error: 'Payroll run not found.' };
  if (run.status !== 'draft' && run.status !== 'locked') {
    return { ok: false, error: 'Bonus can only be requested on draft or locked runs.' };
  }
  const pending = db
    .prepare(`SELECT id FROM hr_bonus_requests WHERE run_id = ? AND status = 'pending'`)
    .get(runId);
  if (pending) return { ok: false, error: 'A bonus request is already pending for this run.' };
  const id = newId('HRBON');
  const bonusType = String(body?.bonusType || 'half_month').trim();
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_bonus_requests (id, run_id, bonus_type, status, notes, requested_at_iso, requested_by_user_id)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, runId, bonusType, 'pending', String(body?.notes || '').trim() || null, now, actor?.id || null);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.payroll.bonus_requested',
    entityKind: 'payroll_run',
    entityId: runId,
    details: { bonusRequestId: id, bonusType },
  });
  return { ok: true, id, status: 'pending' };
}

export function listPayrollBonusRequests(db, runId) {
  if (!hrPayrollControlTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT id, run_id AS runId, bonus_type AS bonusType, status, notes,
              requested_at_iso AS requestedAtIso, requested_by_user_id AS requestedByUserId,
              approved_at_iso AS approvedAtIso, approved_by_user_id AS approvedByUserId,
              rejected_at_iso AS rejectedAtIso, rejection_reason AS rejectionReason
       FROM hr_bonus_requests WHERE run_id = ? ORDER BY requested_at_iso DESC`
    )
    .all(runId);
}

export function approvePayrollBonusRequest(db, requestId, actor) {
  if (!hrPayrollControlTablesReady(db)) return { ok: false, error: 'Bonus approval module not initialised.' };
  const req = db.prepare(`SELECT * FROM hr_bonus_requests WHERE id = ?`).get(requestId);
  if (!req) return { ok: false, error: 'Bonus request not found.' };
  if (req.status !== 'pending') return { ok: false, error: 'Request is not pending.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_bonus_requests SET status = 'approved', approved_at_iso = ?, approved_by_user_id = ? WHERE id = ?`
  ).run(now, actor?.id || null, requestId);
  const apply = applyBonusToPayrollRun(db, req.run_id, req.bonus_type, actor);
  if (!apply.ok) {
    db.prepare(`UPDATE hr_bonus_requests SET status = 'pending', approved_at_iso = NULL, approved_by_user_id = NULL WHERE id = ?`).run(requestId);
    return apply;
  }
  db.prepare(`UPDATE hr_bonus_requests SET status = 'applied', applied_at_iso = ? WHERE id = ?`).run(now, requestId);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.payroll.bonus_approved',
    entityKind: 'payroll_run',
    entityId: req.run_id,
    details: { bonusRequestId: requestId, bonusType: req.bonus_type },
  });
  return { ok: true, applied: apply };
}

export function rejectPayrollBonusRequest(db, requestId, reason, actor) {
  if (!hrPayrollControlTablesReady(db)) return { ok: false, error: 'Bonus approval module not initialised.' };
  const req = db.prepare(`SELECT * FROM hr_bonus_requests WHERE id = ?`).get(requestId);
  if (!req) return { ok: false, error: 'Bonus request not found.' };
  if (req.status !== 'pending') return { ok: false, error: 'Request is not pending.' };
  const r = String(reason || '').trim();
  if (r.length < 3) return { ok: false, error: 'Rejection reason is required.' };
  db.prepare(
    `UPDATE hr_bonus_requests SET status = 'rejected', rejected_at_iso = ?, rejection_reason = ? WHERE id = ?`
  ).run(nowIso(), r, requestId);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.payroll.bonus_rejected',
    entityKind: 'payroll_run',
    entityId: req.run_id,
    details: { bonusRequestId: requestId, reason: r },
  });
  return { ok: true };
}

/** Apply salary hold flags when computing payroll lines. */
export function applySalaryHoldToPayrollLine(db, runId, userId, profileExtraJson) {
  if (staffSalaryOnHold(profileExtraJson)) {
    try {
      db.prepare(
        `UPDATE hr_payroll_lines SET pay_hold = 1, hold_reason = ?, net_ngn = 0 WHERE run_id = ? AND user_id = ?`
      ).run('Salary on hold', runId, userId);
    } catch {
      /* pay_hold column optional on old DBs */
    }
  }
}

export { staffSalaryOnHold };
