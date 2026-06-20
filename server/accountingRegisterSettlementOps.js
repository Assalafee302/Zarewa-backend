/**
 * Register settlement workflow — accountant requests, MD/finance approves, cashier pays,
 * register line balance reduces automatically.
 * @param {import('better-sqlite3').Database} db
 */

import { actorMayApproveRefundAmount } from '../shared/workspaceGovernance.js';
import { effectiveOutstandingNgn } from '../shared/lib/paymentOutstandingTolerance.js';
import {
  latestPayoutDay,
  payoutLinePostedAtISO,
  payoutLinePostedDay,
} from '../shared/lib/treasuryPayoutDates.js';
import { userHasPermission } from './auth.js';
import { appendAuditLog, assertPeriodOpen, recordApprovalAction } from './controlOps.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { nextPostingBatchHumanId, nextRegisterSettlementHumanId } from './humanId.js';
import { insertTreasuryMovementTx } from './writeOps.js';
import {
  clearAccountingRegisterLine,
  ensureAccountingRegisterSchema,
  updateAccountingRegisterLine,
} from './accountingSubledgerOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function actorName(user) {
  return String(user?.displayName || user?.display_name || user?.username || user?.id || 'User').trim();
}

function normalizeIsoTimestamp(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00.000Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function mapSettlementRow(row) {
  if (!row) return null;
  return {
    settlementId: row.settlement_id,
    registerLineId: row.register_line_id,
    registerSide: row.register_side,
    branchId: row.branch_id ?? '',
    partyName: row.party_name,
    partyRef: row.party_ref ?? '',
    amountNgn: roundMoney(row.amount_ngn),
    approvedAmountNgn: roundMoney(row.approved_amount_ngn),
    paidAmountNgn: roundMoney(row.paid_amount_ngn),
    status: row.status,
    reason: row.reason ?? '',
    payeeName: row.payee_name ?? '',
    payeeBankDetails: row.payee_bank_details ?? '',
    requestedAtIso: row.requested_at_iso,
    requestedByUserId: row.requested_by_user_id ?? '',
    requestedByName: row.requested_by_name ?? '',
    approvedAtIso: row.approved_at_iso ?? '',
    approvedByUserId: row.approved_by_user_id ?? '',
    approvedByName: row.approved_by_name ?? '',
    approvalNote: row.approval_note ?? '',
    paidAtIso: row.paid_at_iso ?? '',
    paidByUserId: row.paid_by_user_id ?? '',
    paidByName: row.paid_by_name ?? '',
    paymentNote: row.payment_note ?? '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

/** @param {import('better-sqlite3').Database} db */
export function ensureAccountingRegisterSettlementSchema(db) {
  ensureAccountingRegisterSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_register_settlements (
      settlement_id TEXT PRIMARY KEY,
      register_line_id TEXT NOT NULL,
      register_side TEXT NOT NULL,
      branch_id TEXT,
      party_name TEXT NOT NULL,
      party_ref TEXT,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      approved_amount_ngn INTEGER NOT NULL DEFAULT 0,
      paid_amount_ngn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending',
      reason TEXT,
      payee_name TEXT,
      payee_bank_details TEXT,
      requested_at_iso TEXT NOT NULL,
      requested_by_user_id TEXT,
      requested_by_name TEXT,
      approved_at_iso TEXT,
      approved_by_user_id TEXT,
      approved_by_name TEXT,
      approval_note TEXT,
      paid_at_iso TEXT,
      paid_by_user_id TEXT,
      paid_by_name TEXT,
      payment_note TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acct_settle_line ON accounting_register_settlements(register_line_id);
    CREATE INDEX IF NOT EXISTS idx_acct_settle_status ON accounting_register_settlements(status);
  `);
}

/** @param {import('better-sqlite3').Database} db @param {string} lineId */
export function reservedSettlementNgnOnLine(db, lineId) {
  ensureAccountingRegisterSettlementSchema(db);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE
           WHEN status = 'Pending' THEN amount_ngn
           WHEN status = 'Approved' THEN MAX(0, COALESCE(NULLIF(approved_amount_ngn, 0), amount_ngn) - paid_amount_ngn)
           ELSE 0
         END
       ), 0) AS reserved
       FROM accounting_register_settlements
       WHERE register_line_id = ? AND status IN ('Pending', 'Approved')`
    )
    .get(lineId);
  return roundMoney(row?.reserved);
}

/** @param {import('better-sqlite3').Database} db @param {string} lineId */
export function registerLineSettlementCapacity(db, lineId) {
  ensureAccountingRegisterSchema(db);
  ensureAccountingRegisterSettlementSchema(db);
  const line = db
    .prepare(`SELECT amount_ngn, status FROM accounting_register_lines WHERE id = ?`)
    .get(lineId);
  if (!line || line.status !== 'open') {
    return { ok: true, openNgn: 0, reservedNgn: 0, availableNgn: 0, blockingItems: [] };
  }
  const openNgn = roundMoney(line.amount_ngn);
  const reservedNgn = reservedSettlementNgnOnLine(db, lineId);
  const blockingItems = db
    .prepare(
      `SELECT * FROM accounting_register_settlements
       WHERE register_line_id = ? AND status IN ('Pending', 'Approved')
       ORDER BY requested_at_iso DESC, settlement_id DESC`
    )
    .all(lineId)
    .map(mapSettlementRow)
    .map((row) => ({
      ...row,
      reservedNgn:
        row.status === 'Pending'
          ? roundMoney(row.amountNgn)
          : Math.max(
              0,
              roundMoney(row.approvedAmountNgn || row.amountNgn) - roundMoney(row.paidAmountNgn)
            ),
    }))
    .filter((row) => row.reservedNgn > 0);
  return {
    ok: true,
    openNgn,
    reservedNgn,
    availableNgn: Math.max(0, openNgn - reservedNgn),
    blockingItems,
  };
}

/** @param {import('better-sqlite3').Database} db @param {string} lineId */
export function registerLineAvailableSettlementNgn(db, lineId) {
  return registerLineSettlementCapacity(db, lineId).availableNgn;
}

/** @param {import('better-sqlite3').Database} db @param {{ registerLineId?: string; status?: string; branchId?: string }} [opts] */
export function listRegisterSettlements(db, opts = {}) {
  ensureAccountingRegisterSettlementSchema(db);
  let sql = `SELECT * FROM accounting_register_settlements WHERE 1=1`;
  const args = [];
  const lineId = String(opts.registerLineId || '').trim();
  if (lineId) {
    sql += ` AND register_line_id = ?`;
    args.push(lineId);
  }
  const status = String(opts.status || '').trim();
  if (status && status !== 'ALL') {
    sql += ` AND status = ?`;
    args.push(status);
  }
  const branchId = String(opts.branchId || '').trim();
  if (branchId && branchId !== 'ALL' && !lineId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  sql += ` ORDER BY requested_at_iso DESC, settlement_id DESC`;
  const items = db.prepare(sql).all(...args).map(mapSettlementRow);
  return { ok: true, items };
}

/** @param {import('better-sqlite3').Database} db @param {string} settlementId */
export function getRegisterSettlement(db, settlementId) {
  ensureAccountingRegisterSettlementSchema(db);
  const row = db.prepare(`SELECT * FROM accounting_register_settlements WHERE settlement_id = ?`).get(settlementId);
  if (!row) return { ok: false, error: 'Settlement not found.' };
  return { ok: true, settlement: mapSettlementRow(row) };
}

/** @param {import('better-sqlite3').Database} db */
export function createRegisterSettlement(db, body, user) {
  ensureAccountingRegisterSettlementSchema(db);
  const lineId = String(body?.registerLineId || body?.lineId || '').trim();
  if (!lineId) return { ok: false, error: 'Register line is required.' };

  const line = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(lineId);
  if (!line) return { ok: false, error: 'Register line not found.' };
  if (line.status !== 'open') return { ok: false, error: 'Only open register lines can be settled.' };
  if (String(line.register_side || '').toLowerCase() !== 'debtor') {
    return { ok: false, error: 'Withdrawals are supported on Debtors register lines only (amounts owed by the company).' };
  }

  const amountNgn = roundMoney(body?.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Settlement amount must be greater than zero.' };

  const available = registerLineAvailableSettlementNgn(db, lineId);
  if (amountNgn > available) {
    return {
      ok: false,
      error: `Amount exceeds available balance (₦${available.toLocaleString('en-NG')}) after other pending settlements.`,
    };
  }

  const reason = String(body?.reason || body?.description || '').trim();
  if (!reason) return { ok: false, error: 'Reason / description is required.' };

  const branchId = String(body?.branchId || line.branch_id || '').trim() || null;
  const settlementId = nextRegisterSettlementHumanId(db, branchId);
  const tiso = nowIso();
  const uid = user?.id ? String(user.id) : null;

  db.prepare(
    `INSERT INTO accounting_register_settlements (
      settlement_id, register_line_id, register_side, branch_id, party_name, party_ref,
      amount_ngn, approved_amount_ngn, paid_amount_ngn, status, reason, payee_name, payee_bank_details,
      requested_at_iso, requested_by_user_id, requested_by_name, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    settlementId,
    lineId,
    line.register_side,
    branchId,
    line.party_name,
    line.party_ref ?? '',
    amountNgn,
    0,
    0,
    'Pending',
    reason,
    String(body?.payeeName || line.party_name || '').trim() || line.party_name,
    String(body?.payeeBankDetails || '').trim() || null,
    tiso,
    uid,
    actorName(user),
    tiso,
    tiso
  );

  appendAuditLog(db, {
    action: 'register_settlement.request',
    entityType: 'accounting_register_settlement',
    entityId: settlementId,
    userId: uid,
    userName: actorName(user),
    detail: `Requested ₦${amountNgn.toLocaleString('en-NG')} withdrawal on ${lineId} (${line.party_name})`,
  });

  return getRegisterSettlement(db, settlementId);
}

/** @param {import('better-sqlite3').Database} db */
export function decideRegisterSettlement(db, settlementId, body, actor) {
  ensureAccountingRegisterSettlementSchema(db);
  const row = db.prepare(`SELECT * FROM accounting_register_settlements WHERE settlement_id = ?`).get(settlementId);
  if (!row) return { ok: false, error: 'Settlement not found.' };
  if (String(row.status || '') !== 'Pending') {
    return { ok: false, error: 'Only pending settlements can be reviewed.' };
  }

  const hasPerm = (p) => userHasPermission(actor, p);
  if (!hasPerm('finance.approve') && !hasPerm('refunds.approve') && !hasPerm('*')) {
    return { ok: false, error: 'You do not have permission to approve register settlements.' };
  }
  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  if (rk === 'cashier' && !hasPerm('*')) {
    return { ok: false, error: 'Cashiers cannot approve settlements — request manager or MD review.' };
  }
  if (String(row.requested_by_user_id || '') && String(row.requested_by_user_id) === String(actor?.id || '')) {
    if (!hasPerm('*')) {
      return { ok: false, error: 'You cannot approve a settlement you requested.' };
    }
  }

  const status = String(body?.status ?? '').trim();
  if (!['Approved', 'Rejected'].includes(status)) {
    return { ok: false, error: 'Decision status must be Approved or Rejected.' };
  }

  const note = String(body?.note ?? body?.approvalNote ?? '').trim();
  const actedAtISO = String(body?.actedAtISO ?? body?.approvalDate ?? '').trim().slice(0, 10) || nowIso().slice(0, 10);
  const approvedAmountNgn =
    status === 'Approved' ? roundMoney(body?.approvedAmountNgn ?? row.amount_ngn) : 0;

  if (status === 'Approved' && approvedAmountNgn <= 0) {
    return { ok: false, error: 'Approved amount must be positive.' };
  }
  if (status === 'Approved' && approvedAmountNgn > roundMoney(row.amount_ngn)) {
    return { ok: false, error: 'Approved amount cannot exceed the requested amount.' };
  }

  if (status === 'Approved') {
    const available = registerLineAvailableSettlementNgn(db, row.register_line_id);
    const reservedThis = roundMoney(row.amount_ngn);
    const effectiveAvailable = available + reservedThis;
    if (approvedAmountNgn > effectiveAvailable) {
      return {
        ok: false,
        error: `Approved amount exceeds register line available balance (₦${effectiveAvailable.toLocaleString('en-NG')}).`,
      };
    }
    const gov = getOrgGovernanceLimits(db);
    if (!actorMayApproveRefundAmount(actor, hasPerm, approvedAmountNgn, gov)) {
      const hi = gov.refundExecutiveThresholdNgn;
      return {
        ok: false,
        error: `Settlements above ₦${hi.toLocaleString('en-NG')} require managing director approval.`,
      };
    }
  }

  try {
    assertPeriodOpen(db, actedAtISO, 'Approval date');
    db.transaction(() => {
      db.prepare(
        `UPDATE accounting_register_settlements SET
          status = ?, approved_amount_ngn = ?, approved_at_iso = ?, approved_by_user_id = ?,
          approved_by_name = ?, approval_note = ?, updated_at_iso = ?
         WHERE settlement_id = ?`
      ).run(
        status,
        approvedAmountNgn,
        actedAtISO,
        actor?.id ? String(actor.id) : null,
        actorName(actor),
        note,
        nowIso(),
        settlementId
      );
      recordApprovalAction(db, {
        entityKind: 'register_settlement',
        entityId: settlementId,
        action: status === 'Approved' ? 'approve' : 'reject',
        status,
        actor,
        note,
        actedAtISO,
      });
    });
    appendAuditLog(db, {
      action: `register_settlement.${status.toLowerCase()}`,
      entityType: 'accounting_register_settlement',
      entityId: settlementId,
      userId: actor?.id ? String(actor.id) : null,
      userName: actorName(actor),
      detail: `${status} ₦${approvedAmountNgn.toLocaleString('en-NG')} on ${row.register_line_id}`,
    });
    return getRegisterSettlement(db, settlementId);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function applyRegisterLinePayment(db, lineId, paidNgn, settlementId, actor) {
  const line = db.prepare(`SELECT * FROM accounting_register_lines WHERE id = ?`).get(lineId);
  if (!line || line.status !== 'open') throw new Error('Register line is not open.');

  const remaining = roundMoney(line.amount_ngn) - roundMoney(paidNgn);
  const stamp = `[${settlementId} paid ₦${paidNgn.toLocaleString('en-NG')} on ${nowIso().slice(0, 10)}]`;
  const notes = [String(line.notes || '').trim(), stamp].filter(Boolean).join('\n');

  if (remaining <= 0) {
    db.prepare(`UPDATE accounting_register_lines SET notes = ? WHERE id = ?`).run(notes, lineId);
    clearAccountingRegisterLine(db, lineId, actor);
  } else {
    updateAccountingRegisterLine(
      db,
      lineId,
      {
        amountNgn: remaining,
        notes,
        partyName: line.party_name,
        asAtDateIso: line.as_at_date_iso,
      },
      actor
    );
  }
}

/** @param {import('better-sqlite3').Database} db */
export function payRegisterSettlement(db, settlementId, payload) {
  ensureAccountingRegisterSettlementSchema(db);
  const row = db.prepare(`SELECT * FROM accounting_register_settlements WHERE settlement_id = ?`).get(settlementId);
  if (!row) return { ok: false, error: 'Settlement not found.' };
  if (String(row.status || '') !== 'Approved') {
    return { ok: false, error: 'Only approved settlements can be paid.' };
  }

  const approvedAmountNgn = roundMoney(row.approved_amount_ngn || row.amount_ngn);
  const paidAmountNgn = roundMoney(row.paid_amount_ngn);
  const outstandingAmountNgn = effectiveOutstandingNgn(approvedAmountNgn, paidAmountNgn);
  if (outstandingAmountNgn <= 0) {
    return { ok: false, error: 'Settlement has already been fully paid.' };
  }

  const defaultPaidDay =
    String(payload.paidAtISO ?? payload.dateISO ?? '').trim().slice(0, 10) || nowIso().slice(0, 10);
  const paidBy = String(payload.paidBy ?? '').trim() || actorName(payload.actor);

  const fromExplicit = Array.isArray(payload.paymentLines)
    ? payload.paymentLines
        .map((line) => ({
          treasuryAccountId: Number(line?.treasuryAccountId),
          amountNgn: roundMoney(line?.amountNgn),
          reference: String(line?.reference ?? '').trim(),
          note: String(line?.note ?? '').trim(),
          postedAtISO: payoutLinePostedAtISO(line, defaultPaidDay, normalizeIsoTimestamp),
        }))
        .filter((line) => line.treasuryAccountId && line.amountNgn > 0)
    : [];

  const paymentLines =
    fromExplicit.length > 0
      ? fromExplicit
      : payload.treasuryAccountId
        ? [
            {
              treasuryAccountId: Number(payload.treasuryAccountId),
              amountNgn: outstandingAmountNgn,
              reference: String(payload.reference ?? '').trim(),
              note: String(payload.note ?? '').trim(),
              postedAtISO: payoutLinePostedAtISO(payload, defaultPaidDay, normalizeIsoTimestamp),
            },
          ]
        : [];

  const payoutAmountNgn = paymentLines.reduce((sum, line) => sum + line.amountNgn, 0);
  if (!paymentLines.length || payoutAmountNgn <= 0) {
    return { ok: false, error: 'Add at least one treasury payout line.' };
  }
  if (payoutAmountNgn > outstandingAmountNgn) {
    return { ok: false, error: 'Payout exceeds the approved settlement balance.' };
  }

  const actor = payload.actor;
  if (String(row.requested_by_user_id || '') && String(row.requested_by_user_id) === String(actor?.id || '')) {
    if (!userHasPermission(actor, '*')) {
      return { ok: false, error: 'You cannot pay a settlement you requested.' };
    }
  }
  if (String(row.approved_by_user_id || '') && String(row.approved_by_user_id) === String(actor?.id || '')) {
    if (!userHasPermission(actor, '*')) {
      return { ok: false, error: 'You cannot pay a settlement you approved.' };
    }
  }

  const paidAtISO = latestPayoutDay(paymentLines, (line) => payoutLinePostedDay(line, defaultPaidDay));
  const paymentNote = String(payload.paymentNote ?? payload.note ?? '').trim();

  try {
    for (const day of new Set(paymentLines.map((line) => payoutLinePostedDay(line, defaultPaidDay)))) {
      assertPeriodOpen(db, day, 'Settlement payout date');
    }

    const result = db.transaction(() => {
      const fresh = db.prepare(`SELECT * FROM accounting_register_settlements WHERE settlement_id = ?`).get(settlementId);
      if (!fresh || String(fresh.status || '') !== 'Approved') {
        throw new Error('Only approved settlements can be paid.');
      }
      const approvedFresh = roundMoney(fresh.approved_amount_ngn || fresh.amount_ngn);
      const paidFresh = roundMoney(fresh.paid_amount_ngn);
      const outstandingFresh = effectiveOutstandingNgn(approvedFresh, paidFresh);
      if (payoutAmountNgn > outstandingFresh) {
        throw new Error('Payout exceeds the approved settlement balance.');
      }

      const batchId = nextPostingBatchHumanId(db);
      for (const line of paymentLines) {
        insertTreasuryMovementTx(db, {
          type: 'REGISTER_SETTLEMENT_OUT',
          treasuryAccountId: line.treasuryAccountId,
          amountNgn: -line.amountNgn,
          reference: line.reference || settlementId,
          note: line.note || paymentNote || fresh.reason || 'Register settlement payout',
          postedAtISO: line.postedAtISO,
          counterpartyKind: 'REGISTER_LINE',
          counterpartyId: fresh.register_line_id,
          counterpartyName: fresh.party_name,
          sourceKind: 'REGISTER_SETTLEMENT',
          sourceId: settlementId,
          batchId,
          createdBy: paidBy,
          workspaceBranchId: payload.workspaceBranchId,
          workspaceViewAll: Boolean(payload.workspaceViewAll),
          actor,
        });
      }

      const nextPaid = paidFresh + payoutAmountNgn;
      const fullyPaid = nextPaid >= approvedFresh;
      db.prepare(
        `UPDATE accounting_register_settlements SET
          status = ?, paid_amount_ngn = ?, paid_at_iso = ?, paid_by_user_id = ?, paid_by_name = ?,
          payment_note = ?, updated_at_iso = ?
         WHERE settlement_id = ?`
      ).run(
        fullyPaid ? 'Paid' : 'Approved',
        nextPaid,
        paidAtISO,
        actor?.id ? String(actor.id) : null,
        paidBy,
        paymentNote,
        nowIso(),
        settlementId
      );

      applyRegisterLinePayment(db, fresh.register_line_id, payoutAmountNgn, settlementId, actor);

      return { payoutAmountNgn, fullyPaid, nextPaid };
    });

    appendAuditLog(db, {
      action: 'register_settlement.pay',
      entityType: 'accounting_register_settlement',
      entityId: settlementId,
      userId: actor?.id ? String(actor.id) : null,
      userName: paidBy,
      detail: `Paid ₦${result.payoutAmountNgn.toLocaleString('en-NG')} on ${row.register_line_id}`,
    });

    return { ok: true, settlement: getRegisterSettlement(db, settlementId).settlement, ...result };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
