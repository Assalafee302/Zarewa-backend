/**
 * Database side of payment-request intake.
 * Asset tick writes the asset register. IOU writes an HR loan so payroll can deduct it.
 * Bending adds the charge to the quote before approval.
 */

import { equipmentRepairMonthAlert, isForkliftRepairText } from '../../shared/lib/paymentRequestIntake.js';

export function duplicatePeersForIntake(db, requestDate, amountNgn, excludeId = '') {
  const day = String(requestDate || '').slice(0, 10);
  const amount = Math.round(Number(amountNgn) || 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || amount <= 0) return [];
  const rows = db
    .prepare(
      `SELECT request_id, request_date, amount_requested_ngn, description, approval_status
       FROM payment_requests
       WHERE request_date = ? AND amount_requested_ngn = ?`
    )
    .all(day, amount);
  const skip = String(excludeId || '').trim();
  return rows
    .filter((row) => String(row.approval_status || '').toLowerCase() !== 'rejected')
    .filter((row) => row.request_id !== skip)
    .map((row) => ({
      id: row.request_id,
      date: row.request_date,
      amountNgn: row.amount_requested_ngn,
      description: row.description,
    }));
}

export function resolvePayrollStaff(db, { staffUserId, staffName } = {}) {
  const id = String(staffUserId || '').trim();
  if (id) {
    const row = db
      .prepare(`SELECT id, display_name FROM app_users WHERE id = ? AND status = 'active'`)
      .get(id);
    return row
      ? { ok: true, user: row }
      : { ok: false, error: 'That staff member is not on the payroll list.' };
  }
  const name = String(staffName || '').trim();
  if (!name) return { ok: false, error: 'IOU / staff loan requires the staff name.' };
  const rows = db
    .prepare(
      `SELECT id, display_name FROM app_users WHERE LOWER(display_name) = LOWER(?) AND status = 'active'`
    )
    .all(name);
  if (rows.length === 1) return { ok: true, user: rows[0] };
  if (!rows.length) {
    return {
      ok: false,
      error: 'IOU / staff loan requires a staff name that matches one person on the payroll list.',
    };
  }
  return {
    ok: false,
    error: 'More than one staff member has that name. Pick the person from the payroll list.',
  };
}

/** Approved HR loan linked to this request. Payroll deducts it after the payout marks it disbursed. */
export function insertApprovedStaffLoanTx(db, { requestId, userId, branchId, amountNgn, repaymentMonth, staffName }) {
  const id = `HR-LOAN-${requestId}`;
  const existing = db.prepare(`SELECT id FROM hr_requests WHERE id = ?`).get(id);
  if (existing) return { ok: true, already: true, id };
  const now = new Date().toISOString();
  const payload = {
    amountNgn: Math.round(Number(amountNgn) || 0),
    repaymentMonths: 1,
    deductionPerMonthNgn: Math.round(Number(amountNgn) || 0),
    repaymentMonth: String(repaymentMonth || '').slice(0, 7),
    financePaymentRequestId: requestId,
    staffName: String(staffName || '').trim(),
    deductionsActive: false,
  };
  db.prepare(
    `INSERT INTO hr_requests (
      id, user_id, branch_id, kind, status, title, body, payload_json, created_at_iso, submitted_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    branchId,
    'loan',
    'approved',
    `IOU / staff loan — ${payload.staffName || userId}`,
    `Repayment month ${payload.repaymentMonth}. Deducted by payroll.`,
    JSON.stringify(payload),
    now,
    now
  );
  return { ok: true, id };
}

export function registerAssetInsteadOfExpense(db, { name, branchId, date, costNgn, location, userId }) {
  const id = `FA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const notes = String(location || '').trim() ? `Location: ${String(location).trim()}` : '';
  db.prepare(
    `INSERT INTO fixed_assets (
      id, name, category, branch_id, acquisition_date_iso, cost_ngn, salvage_ngn, useful_life_months,
      depreciation_method, status, notes, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    String(name || '').trim(),
    'plant',
    branchId,
    String(date || '').slice(0, 10),
    Math.round(Number(costNgn) || 0),
    0,
    60,
    'straight_line',
    'ordered',
    notes,
    now,
    now,
    userId || null,
    userId || null
  );
  return { ok: true, assetId: id };
}

/** Add the outside-work charge onto the quote once. Idempotent per payment request. */
export function appendOutsideWorkChargeTx(db, { quotationRef, amountNgn, requestId, description }) {
  const ref = String(quotationRef || '').trim();
  const q = db.prepare(`SELECT id, lines_json, total_ngn FROM quotations WHERE id = ?`).get(ref);
  if (!q) return { ok: false, error: 'That quote number was not found.' };
  let payload = {};
  try {
    payload = JSON.parse(q.lines_json || '{}') || {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  const services = Array.isArray(payload.services) ? payload.services : [];
  if (services.some((row) => String(row?.sourcePaymentRequestId || '') === requestId)) {
    return { ok: true, already: true };
  }
  const amount = Math.round(Number(amountNgn) || 0);
  if (amount <= 0) return { ok: false, error: 'Outside-work charge must be a positive amount.' };
  services.push({
    name: String(description || 'Outside work').trim() || 'Outside work',
    qty: '1',
    unitPriceNgn: amount,
    sourcePaymentRequestId: requestId,
  });
  payload.services = services;
  const nextTotal = Math.round(Number(q.total_ngn) || 0) + amount;
  db.prepare(`UPDATE quotations SET lines_json = ?, total_ngn = ? WHERE id = ?`).run(
    JSON.stringify(payload),
    nextTotal,
    ref
  );
  return { ok: true, totalNgn: nextTotal };
}

export function forkliftRepairAlertForMonth(db, { branchId, month, extraNgn = 0 } = {}) {
  const key = String(month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(key)) return equipmentRepairMonthAlert([], { month: key });
  const start = `${key}-01`;
  const [y, m] = key.split('-').map(Number);
  const end = `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const rows = db
    .prepare(
      `SELECT e.amount_ngn, e.date, pr.description
       FROM expenses e
       LEFT JOIN payment_requests pr ON pr.expense_id = e.expense_id
       WHERE e.date >= ? AND e.date <= ? AND (? = '' OR e.branch_id = ?)`
    )
    .all(start, end, String(branchId || ''), String(branchId || ''));
  const lines = rows
    .filter((row) => isForkliftRepairText(row.description))
    .map((row) => ({
      assetName: 'Forklift',
      month: key,
      amountNgn: row.amount_ngn,
    }));
  if (Math.round(Number(extraNgn) || 0) > 0) {
    lines.push({ assetName: 'Forklift', month: key, amountNgn: extraNgn });
  }
  return equipmentRepairMonthAlert(lines, { assetName: 'Forklift', month: key });
}
