/**
 * Company retention withdrawals — request, BM decide, cashier pay.
 * @module server/finance/refundCompanyRetentionOps
 */
import { actorId, actorName } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { assertEntityBranchForWorkspaceWrite } from '../branchScope.js';
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import { allocateHumanId } from '../humanId.js';
import { insertTreasuryMovementTx } from '../writeOps.js';
import {
  getCompanyRetentionSummary,
  mapWithdrawalRow,
  nextRetentionEntryId,
  refundCompanyRetentionTablesReady,
} from './refundCompanyRetentionLedger.js';

export {
  creditCompanyRetentionFromRefundTx,
  getCompanyRetentionSummary,
  refundCompanyCutHoldDays,
  refundCompanyRetentionTablesReady,
  voidCompanyRetentionForRefundTx,
} from './refundCompanyRetentionLedger.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function trim(v) {
  return String(v ?? '').trim();
}

function nextWithdrawalId(db, branchId) {
  return allocateHumanId(db, 'RCW', branchId || DEFAULT_BRANCH_ID, {
    table: 'refund_company_retention_withdrawals',
    idColumn: 'id',
  });
}

export function requestCompanyRetentionWithdrawal(db, payload = {}) {
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: false, error: 'Company retention tables are not ready. Run migrations.' };
  }
  const branchId = trim(payload.branchId) || DEFAULT_BRANCH_ID;
  const amountNgn = roundMoney(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Withdrawal amount must be positive.' };

  const summary = getCompanyRetentionSummary(db, branchId);
  if (amountNgn > summary.availableNgn) {
    return {
      ok: false,
      error: `Only ₦${summary.availableNgn.toLocaleString('en-NG')} is available after the ${summary.holdDays}-day hold (₦${summary.heldNgn.toLocaleString('en-NG')} still held).`,
    };
  }

  const payeeName = trim(payload.payeeName);
  const payeeBankName = trim(payload.payeeBankName);
  const payeeAccountNo = trim(payload.payeeAccountNo);
  if (!payeeName || !payeeBankName || !payeeAccountNo) {
    return { ok: false, error: 'Company payee bank details are required.' };
  }

  const id = nextWithdrawalId(db, branchId);
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO refund_company_retention_withdrawals (
       id, branch_id, amount_ngn, status,
       payee_name, payee_bank_name, payee_account_no, note,
       requested_by_user_id, requested_by_name, requested_at_iso
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    branchId,
    amountNgn,
    'pending_bm',
    payeeName,
    payeeBankName,
    payeeAccountNo,
    trim(payload.note) || 'Company cut retention withdrawal',
    actorId(payload.actor),
    actorName(payload.actor),
    at
  );

  try {
    appendAuditLog(db, {
      actor: payload.actor,
      action: 'refund_company_retention.withdraw_request',
      entityKind: 'refund_company_retention_withdrawal',
      entityId: id,
      status: 'pending_bm',
      note: `Requested ₦${amountNgn.toLocaleString('en-NG')} company cut withdrawal`,
      details: { amountNgn, branchId },
    });
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    withdrawal: mapWithdrawalRow(
      db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id)
    ),
  };
}

export function decideCompanyRetentionWithdrawal(db, payload = {}) {
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: false, error: 'Company retention tables are not ready.' };
  }
  const id = trim(payload.withdrawalId || payload.id);
  if (!id) return { ok: false, error: 'withdrawalId is required.' };
  const decision = trim(payload.decision || '').toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'decision must be approve or reject.' };
  }

  const row = db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Withdrawal request not found.' };
  if (trim(row.status) !== 'pending_bm') {
    return { ok: false, error: `Request is ${row.status}, not awaiting Branch Manager.` };
  }

  const branchGate = assertEntityBranchForWorkspaceWrite(
    payload.actor,
    row.branch_id,
    payload.workspaceBranchId,
    Boolean(payload.workspaceViewAll)
  );
  if (!branchGate.ok) return { ok: false, error: branchGate.error };

  const at = new Date().toISOString();
  if (decision === 'reject') {
    const reason = trim(payload.note || payload.reason) || 'Rejected by Branch Manager';
    db.prepare(
      `UPDATE refund_company_retention_withdrawals
       SET status = 'rejected',
           approved_by_user_id = ?,
           approved_by_name = ?,
           approved_at_iso = ?,
           approval_note = ?,
           rejected_reason = ?
       WHERE id = ?`
    ).run(actorId(payload.actor), actorName(payload.actor), at, reason, reason, id);
    return {
      ok: true,
      withdrawal: mapWithdrawalRow(
        db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id)
      ),
    };
  }

  const summary = getCompanyRetentionSummary(db, trim(row.branch_id));
  if (roundMoney(row.amount_ngn) > summary.availableNgn) {
    return {
      ok: false,
      error: `Available balance is now ₦${summary.availableNgn.toLocaleString('en-NG')}; cannot approve ₦${roundMoney(row.amount_ngn).toLocaleString('en-NG')}.`,
    };
  }

  db.prepare(
    `UPDATE refund_company_retention_withdrawals
     SET status = 'approved',
         approved_by_user_id = ?,
         approved_by_name = ?,
         approved_at_iso = ?,
         approval_note = ?
     WHERE id = ?`
  ).run(
    actorId(payload.actor),
    actorName(payload.actor),
    at,
    trim(payload.note) || 'Approved by Branch Manager',
    id
  );

  return {
    ok: true,
    withdrawal: mapWithdrawalRow(
      db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id)
    ),
  };
}

export function payCompanyRetentionWithdrawal(db, payload = {}) {
  if (!refundCompanyRetentionTablesReady(db)) {
    return { ok: false, error: 'Company retention tables are not ready.' };
  }
  const id = trim(payload.withdrawalId || payload.id);
  if (!id) return { ok: false, error: 'withdrawalId is required.' };
  const row = db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Withdrawal request not found.' };
  if (trim(row.status) !== 'approved') {
    return { ok: false, error: 'Only BM-approved withdrawals can be paid.' };
  }

  const branchGate = assertEntityBranchForWorkspaceWrite(
    payload.actor,
    row.branch_id,
    payload.workspaceBranchId,
    Boolean(payload.workspaceViewAll)
  );
  if (!branchGate.ok) return { ok: false, error: branchGate.error };

  const amountNgn = roundMoney(row.amount_ngn);
  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!treasuryAccountId) return { ok: false, error: 'treasuryAccountId is required.' };
  const paymentDateISO =
    trim(payload.paymentDateISO || payload.paidAtISO || '').slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  try {
    assertPeriodOpen(db, paymentDateISO, 'Company cut withdrawal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const branchId = trim(row.branch_id) || DEFAULT_BRANCH_ID;
  const now = new Date().toISOString();
  const availableCredits = getCompanyRetentionSummary(db, branchId).credits.filter((c) => c.available);
  let remaining = amountNgn;
  const allocations = [];
  for (const c of availableCredits) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, c.openNgn);
    if (take <= 0) continue;
    allocations.push({ creditId: c.id, amountNgn: take });
    remaining -= take;
  }
  if (remaining > 0) {
    return {
      ok: false,
      error: `Insufficient available company-cut balance to pay ₦${amountNgn.toLocaleString('en-NG')}.`,
    };
  }

  try {
    return db.transaction(() => {
      const movement = insertTreasuryMovementTx(db, {
        type: 'REFUND_COMPANY_CUT_PAYOUT',
        treasuryAccountId,
        amountNgn: -amountNgn,
        postedAtISO: `${paymentDateISO}T12:00:00.000Z`,
        reference: trim(payload.reference) || id,
        counterpartyKind: 'COMPANY',
        counterpartyName: trim(row.payee_name),
        sourceKind: 'REFUND_COMPANY_RETENTION',
        sourceId: id,
        note: trim(payload.note) || `Company cut retention ${id}`,
        createdBy: actorName(payload.actor),
        workspaceBranchId: payload.workspaceBranchId || branchId,
        workspaceViewAll: Boolean(payload.workspaceViewAll),
        actor: payload.actor,
        batchId: id,
      });

      for (const a of allocations) {
        const upd = db
          .prepare(
            `UPDATE refund_company_retention_entries
             SET open_ngn = open_ngn - ?,
                 withdrawal_id = COALESCE(withdrawal_id, ?)
             WHERE id = ? AND open_ngn >= ?`
          )
          .run(a.amountNgn, id, a.creditId, a.amountNgn);
        if (!upd.changes) throw new Error('Concurrent update reduced available company-cut balance.');
      }

      const withdrawEntryId = nextRetentionEntryId(db, branchId);
      db.prepare(
        `INSERT INTO refund_company_retention_entries (
           id, branch_id, entry_type, amount_ngn, open_ngn,
           source_kind, source_id, refund_id, available_after_iso,
           withdrawal_id, note, created_at_iso, created_by_user_id, created_by_name
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        withdrawEntryId,
        branchId,
        'withdrawal',
        amountNgn,
        0,
        'RETENTION_WITHDRAWAL',
        id,
        null,
        null,
        id,
        `Paid company cut withdrawal ${id}`,
        now,
        actorId(payload.actor),
        actorName(payload.actor)
      );

      db.prepare(
        `UPDATE refund_company_retention_withdrawals
         SET status = 'paid',
             paid_by_user_id = ?,
             paid_by_name = ?,
             paid_at_iso = ?,
             treasury_movement_id = ?,
             treasury_account_id = ?
         WHERE id = ?`
      ).run(
        actorId(payload.actor),
        actorName(payload.actor),
        now,
        movement.id || null,
        String(treasuryAccountId),
        id
      );

      return {
        ok: true,
        withdrawal: mapWithdrawalRow(
          db.prepare(`SELECT * FROM refund_company_retention_withdrawals WHERE id = ?`).get(id)
        ),
        treasuryMovementId: movement.id,
        allocations,
      };
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
