/**
 * Incident financial recovery schedules — payroll deduction (mirrors loan pattern).
 * @module server/hrIncidentRecoveryOps
 */

import crypto from 'node:crypto';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function recoverySchedulesTableReady(db) {
  return hrTableExists(db, 'hr_incident_recovery_schedules');
}

export function mapRecoveryScheduleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    userId: row.user_id,
    registryId: row.registry_id || null,
    totalAmountNgn: Math.round(Number(row.total_amount_ngn) || 0),
    installmentAmountNgn: Math.round(Number(row.installment_amount_ngn) || 0),
    durationMonths: Math.round(Number(row.duration_months) || 0),
    principalOutstandingNgn: Math.round(Number(row.principal_outstanding_ngn) || 0),
    monthsDeducted: Math.round(Number(row.months_deducted) || 0),
    deductionsActive: Boolean(row.deductions_active),
    status: row.status,
    activatedAtIso: row.activated_at_iso || null,
    closedAtIso: row.closed_at_iso || null,
    caseNumber: row.case_number || null,
    createdAtIso: row.created_at_iso,
  };
}

export function listRecoverySchedulesForCase(db, caseId) {
  if (!recoverySchedulesTableReady(db)) return [];
  return db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       WHERE s.case_id = ? ORDER BY s.created_at_iso ASC`
    )
    .all(String(caseId || '').trim())
    .map(mapRecoveryScheduleRow);
}

export function listRecoverySchedulesForUser(db, userId) {
  if (!recoverySchedulesTableReady(db)) return [];
  return db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       WHERE s.user_id = ? AND s.status IN ('active','draft') ORDER BY s.created_at_iso DESC`
    )
    .all(String(userId || '').trim())
    .map(mapRecoveryScheduleRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function activeIncidentRecoveryBreakdown(db, userId) {
  if (!recoverySchedulesTableReady(db)) return { total: 0, recoveries: [] };
  const rows = db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       WHERE s.user_id = ? AND s.deductions_active = 1 AND s.status = 'active'`
    )
    .all(userId);
  const recoveries = [];
  for (const row of rows) {
    const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
    if (outstanding <= 0) continue;
    const monthsTotal = Math.round(Number(row.duration_months) || 0);
    const cur = Math.round(Number(row.months_deducted) || 0);
    if (monthsTotal > 0 && cur >= monthsTotal) continue;
    let amountNgn = Math.round(Number(row.installment_amount_ngn) || 0);
    if (amountNgn <= 0) continue;
    amountNgn = Math.min(amountNgn, outstanding);
    if (amountNgn <= 0) continue;
    recoveries.push({
      scheduleId: row.id,
      amountNgn,
      title: `Recovery ${row.case_number || row.case_id}`,
      caseNumber: row.case_number || row.case_id,
    });
  }
  const total = recoveries.reduce((s, x) => s + x.amountNgn, 0);
  return { total, recoveries };
}

export function createRecoverySchedulesFromCase(db, actor, caseId, opts = {}) {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Case not found.' };
  const lossNgn = Math.round(Number(row.loss_value_ngn) || 0);
  if (lossNgn <= 0) return { ok: false, error: 'loss_value_ngn must be set on the case.' };

  const parties = db
    .prepare(`SELECT * FROM incident_responsibility_map WHERE case_id = ?`)
    .all(row.id);
  if (!parties.length) return { ok: false, error: 'Responsibility map required before recovery schedules.' };

  const durationMonths = Math.max(1, Math.round(Number(opts.durationMonths) || 12));
  const now = nowIso();
  const activate = opts.activate !== false;
  const schedules = [];

  db.transaction(() => {
    for (const p of parties) {
      const weight = Number(p.responsibility_weight) || 0;
      const totalAmountNgn = Math.round((lossNgn * weight) / 100);
      if (totalAmountNgn <= 0) continue;
      const installmentAmountNgn = Math.max(1, Math.round(totalAmountNgn / durationMonths));
      const existing = db
        .prepare(`SELECT id FROM hr_incident_recovery_schedules WHERE case_id = ? AND user_id = ? AND status != 'cancelled'`)
        .get(row.id, p.user_id);
      if (existing?.id) continue;

      const id = newId('HRRcv');
      db.prepare(
        `INSERT INTO hr_incident_recovery_schedules (
          id, case_id, user_id, registry_id, total_amount_ngn, installment_amount_ngn, duration_months,
          principal_outstanding_ngn, months_deducted, deductions_active, status,
          activated_at_iso, created_at_iso, created_by_user_id, approved_by_user_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        row.id,
        p.user_id,
        row.registry_id || null,
        totalAmountNgn,
        installmentAmountNgn,
        durationMonths,
        totalAmountNgn,
        0,
        activate ? 1 : 0,
        activate ? 'active' : 'draft',
        activate ? now : null,
        now,
        actor?.id || null,
        actor?.id || null
      );
      schedules.push(mapRecoveryScheduleRow(db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(id)));
    }
  });

  if (!schedules.length) return { ok: false, error: 'No recovery schedules created (check weights and loss amount).' };

  return { ok: true, schedules };
}

export function activateRecoverySchedulesForCase(db, actor, caseId) {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET status = 'active', deductions_active = 1, activated_at_iso = ?, approved_by_user_id = ?
     WHERE case_id = ? AND status = 'draft'`
  ).run(now, actor?.id || null, String(caseId || '').trim());
  return { ok: true, schedules: listRecoverySchedulesForCase(db, caseId) };
}

export function cancelRecoverySchedule(db, actor, scheduleId, reason = '') {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const row = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(String(scheduleId || '').trim());
  if (!row) return { ok: false, error: 'Schedule not found.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET status = 'cancelled', deductions_active = 0, closed_at_iso = ?, cancel_reason = ? WHERE id = ?`
  ).run(now, String(reason || '').trim() || null, row.id);
  return { ok: true, schedule: mapRecoveryScheduleRow(db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(row.id)) };
}

export function settleRecoveryAfterPayrollDeduction(db, scheduleId, userId, deductedNgn) {
  if (!recoverySchedulesTableReady(db)) return;
  const row = db
    .prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ? AND user_id = ? AND status = 'active'`)
    .get(scheduleId, userId);
  if (!row || !row.deductions_active) return;
  const ded = Math.max(0, Math.round(Number(deductedNgn) || 0));
  const monthsTotal = Math.round(Number(row.duration_months) || 0);
  const cur = Math.round(Number(row.months_deducted) || 0);
  const nextMonths = cur + 1;
  const pr = Math.max(0, Math.round(Number(row.principal_outstanding_ngn) || 0) - ded);
  let status = row.status;
  let active = row.deductions_active;
  let closedAt = row.closed_at_iso;
  if (pr <= 0 || (monthsTotal > 0 && nextMonths >= monthsTotal)) {
    status = 'completed';
    active = 0;
    closedAt = nowIso();
  }
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET
      principal_outstanding_ngn = ?, months_deducted = ?, deductions_active = ?, status = ?, closed_at_iso = ?
     WHERE id = ?`
  ).run(pr, nextMonths, active ? 1 : 0, status, closedAt, row.id);
}

export function incrementRecoveriesFromPayrollRun(db, runId) {
  if (!recoverySchedulesTableReady(db)) return;
  if (!hrTableExists(db, 'hr_payroll_line_recoveries')) return;
  const items = db
    .prepare(`SELECT user_id, schedule_id, amount_ngn FROM hr_payroll_line_recoveries WHERE run_id = ? AND amount_ngn > 0`)
    .all(runId);
  for (const it of items) {
    settleRecoveryAfterPayrollDeduction(db, it.schedule_id, it.user_id, it.amount_ngn);
  }
}
