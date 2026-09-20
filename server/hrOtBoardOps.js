import { hrTableExists } from './hrTableChecks.js';
import { parseJsonArray } from './hrCommon.js';

function tableReady(db) {
  return hrTableExists(db, 'hr_daily_roll_calls');
}

/**
 * Explodes daily roll-call JSON into OT rows. This is an attendance visibility board,
 * not a payroll calculation.
 */
export function listOtBoard(db, opts = {}) {
  if (!tableReady(db)) return [];
  const branchId = String(opts.branchId || '').trim();
  const dayIso = String(opts.dayIso || '').trim().slice(0, 10);
  const from = String(opts.from || '').trim().slice(0, 10);
  const to = String(opts.to || '').trim().slice(0, 10);
  const args = [];
  let sql = `SELECT branch_id, day_iso, rows_json FROM hr_daily_roll_calls WHERE 1 = 1`;
  if (branchId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  if (dayIso) {
    sql += ` AND day_iso = ?`;
    args.push(dayIso);
  } else {
    if (from) {
      sql += ` AND day_iso >= ?`;
      args.push(from);
    }
    if (to) {
      sql += ` AND day_iso <= ?`;
      args.push(to);
    }
  }
  sql += ` ORDER BY day_iso DESC`;
  const output = [];
  for (const roll of db.prepare(sql).all(...args)) {
    for (const row of parseJsonArray(roll.rows_json)) {
      const scheduledMinutes = Number(row?.scheduledMinutes ?? row?.scheduled_minutes);
      const workedMinutes = Number(row?.workedMinutes ?? row?.worked_minutes);
      if (!Number.isFinite(scheduledMinutes) || !Number.isFinite(workedMinutes) || workedMinutes <= scheduledMinutes) continue;
      output.push({
        branchId: roll.branch_id,
        dayIso: roll.day_iso,
        userId: String(row?.userId || ''),
        status: String(row?.status || 'present'),
        scheduledMinutes,
        workedMinutes,
        overtimeMinutes: workedMinutes - scheduledMinutes,
        overtimeHours: Math.round(((workedMinutes - scheduledMinutes) / 60) * 100) / 100,
      });
    }
  }
  return output;
}
